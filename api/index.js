import express from 'express';
import fs from 'fs';
import cors from 'cors';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'path';
import { getSupabaseClient, supabase } from '../server/supabase.js';
import { getB2PresignedPutUrl, verifyB2UploadedFile, getB2SignedUrl, isStorageKeyLocated, deleteFromB2, refreshB2Url, toMediaProxyUrl, proxyB2UrlsInText, extractB2StorageKey, uploadToB2, isB2Configured, cleanupOrphanedB2FilesForEntry, getVaultStorageStats } from '../server/b2.js';
import { verifyAdminUser } from '../server/auth.js';
import { readImageDims } from '../server/imageDims.js';
import { stripMarkdown } from '../src/utils/excerpt.js';
import { generateSitemapXml, getRobotsTxt } from '../server/sitemap.js';


const app = express();
app.disable('x-powered-by');

// Security headers middleware (matches edge and standalone server standards)
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  next();
});

// Strip HTML tags from plain-text fields before they reach the DB.
// Removes anything matching <tag>, </tag>, <tag/> — preserves all other text
// including "<3", "<= 5", math operators, etc. (they have no closing >-preceded alphanumeric).
function stripHtmlTags(str) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/<(?:[a-zA-Z/!][^>]*)>/g, '');
}

// Resolve a post (UUID or slug) for the public comments/reactions endpoints,
// mirroring the single-post GET's visibility rules:
// - unknown identifier -> 404
// - draft -> 404 (drafts are invisible publicly; no existence leak)
// - passcode-protected -> an admin token, or the entry passcode verified
//   through the same get_protected_entry RPC the unlock flow uses
// Returns { postId } on success, or { status, error } for the response.
async function resolveEngagementTarget(req, identifier, suppliedPasscode) {
  const client = getSupabaseClient(req);
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);

  const { data: pub } = isUuid
    ? await client.from('public_published_entries').select('id, has_passcode').eq('id', identifier).maybeSingle()
    : await client.from('public_published_entries').select('id, has_passcode').eq('slug', identifier).maybeSingle();

  if (!pub) {
    return { status: 404, error: 'Entry not found.' };
  }

  if (!pub.has_passcode) {
    return { postId: pub.id };
  }

  if (req.headers.authorization) {
    const auth = await verifyAdminUser(req);
    if (auth.authorized) return { postId: pub.id };
  }

  const code = suppliedPasscode || req.headers['x-entry-passcode'] || req.query.passcode;
  if (code && typeof code === 'string' && code.length <= 256) {
    const { data } = await client.rpc('get_protected_entry', {
      target_identifier: String(identifier),
      code: code.trim()
    });
    const result = Array.isArray(data) ? data[0] : data;
    if (result && result.unlocked) return { postId: pub.id };
  }

  return { status: 403, error: 'This entry is passcode-protected.' };
}

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }
});

// CORS — restrict to known origins only (no open wildcard)
const allowedOrigins = [
  process.env.ALLOWED_ORIGIN,
  process.env.VITE_SITE_URL,
  process.env.SITE_URL,
  process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
  'https://blog.q04ti.dev',
  'https://q04ti.dev',
  'http://localhost:3000',
  'http://localhost:5173'
].filter(Boolean);

export const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  try {
    const url = new URL(origin);
    // Allow local development
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;
    // Allow owner's custom domains and subdomains
    if (url.hostname === 'q04ti.dev' || url.hostname.endsWith('.q04ti.dev')) return true;
    // Allow this project's Vercel preview and production deployments only (not all of vercel.app)
    if (/^(?:blog|q04ti)(?:-[a-z0-9_-]+)?\.vercel\.app$/i.test(url.hostname)) return true;
    for (const allowed of allowedOrigins) {
      try {
        const parsed = new URL(allowed.startsWith('http') ? allowed : `https://${allowed}`);
        if (url.hostname === parsed.hostname) return true;
      } catch {}
    }
  } catch {}
  return false;
};

app.use(cors({
  origin: (origin, callback) => {
    // Allow server-to-server (no origin), localhost, vercel deployments, and configured origins
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error('CORS: origin not allowed'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));

// 1 MB global JSON body limit — file uploads handled by multer's own 100 MB limit
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// --- Rate Limiters ---
// Behind Vercel's proxy every request arrives from the proxy's address, so
// without this all visitors shared ONE rate-limit budget (150/min) — a
// handful of open tabs (sync-check + now-playing polls) could get everyone
// 429'd and stop live updates. Trust exactly one hop (Vercel's edge) so the
// limiter sees each visitor's real IP from X-Forwarded-For. Local `npm
// start` has no proxy and keeps the default.
if (process.env.VERCEL) app.set('trust proxy', 1);
// Vercel also sends the standard `Forwarded` header; the limiter uses
// X-Forwarded-For (via trust proxy), so its warning about it is noise.
const limiterValidate = { forwardedHeader: false };
// General API limiter: 150 req / minute per IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  validate: limiterValidate,
  message: { error: 'Too many requests. Please slow down.' }
});
app.use('/api/', apiLimiter);

// Strict limiter for public write endpoints
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  validate: limiterValidate,
  message: { error: 'Too many requests on this endpoint. Please slow down.' }
});

// Dedicated limiter for the view counter, with its own budget so normal
// reading never starves the strict write pool (comments/reactions/passcode)
const viewsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: limiterValidate,
  message: { error: 'Too many requests on this endpoint. Please slow down.' }
});

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Realtime SSE Clients Manager
const sseClients = new Set();
let realtimeVersion = Date.now();

export function broadcastRealtimeEvent(event, data = {}, supabaseClient = null) {
  realtimeVersion = Date.now();
  // `event` goes AFTER ...data on purpose: data must never be able to
  // clobber the event name. An entry's content type used to travel as
  // `type` inside data, and the client dispatcher read payload.type as
  // the event type — so every server-sent edit arrived as 'journal' and
  // was silently dropped (see src/utils/realtime.js).
  const payload = {
    ...data,
    event,
    version: realtimeVersion,
    timestamp: new Date().toISOString()
  };
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

  for (const client of sseClients) {
    try {
      client.write(message);
    } catch (_err) {
      sseClients.delete(client);
    }
  }

  // Cross-device broadcast: persist to Supabase and send over the Realtime
  // channel. Returns a promise settling when both finish — it NEVER
  // rejects, so a failed broadcast can't fail the caller's save. Callers
  // that need the broadcast to land (PUT / POST /api/posts) await it with
  // a short timeout; everyone else keeps the old fire-and-forget call.
  const clientToUse = supabaseClient || (typeof getSupabaseClient === 'function' ? getSupabaseClient() : null);
  if (!clientToUse || typeof clientToUse.from !== 'function') return Promise.resolve();
  const bStart = Date.now();
  const upsertPromise = (async () => {
    try {
      await clientToUse.from('realtime_sync').upsert({
        id: 'latest',
        version: realtimeVersion,
        event,
        payload: data,
        updated_at: new Date().toISOString()
      });
    } catch {}
  })();
  const sendPromise = (async () => {
    try {
      if (typeof clientToUse.channel === 'function') {
        const channel = clientToUse.channel('blog-live-sync', {
          config: { broadcast: { self: false }, private: false }
        });
        await channel.send({
          type: 'broadcast',
          event: 'sync',
          payload
        });
      }
    } catch {}
  })();
  if (event === 'entry_updated' || event === 'entry_created') { // rare: admin saves only
    upsertPromise.then(() => console.log(`[broadcast] ${event} upsert ${Date.now() - bStart}ms`));
    sendPromise.then(() => console.log(`[broadcast] ${event} send ${Date.now() - bStart}ms`));
  }
  return Promise.allSettled([upsertPromise, sendPromise]);
}

// Send a realtime broadcast and wait for it to land (bounded) before the
// route responds. On Vercel a function can be frozen the moment its response
// goes out, so a fire-and-forget broadcast could silently never reach other
// devices (and the realtime_sync row the 10s sync-check polls might never
// update). The broadcast never rejects; a slow one is cut off after `ms` so
// it can't hold the request hostage. Writes only the single 'latest' row.
export function settleBroadcast(event, data = {}, supabaseClient = null, ms = 1500) {
  return Promise.race([
    broadcastRealtimeEvent(event, data, supabaseClient),
    new Promise(resolve => setTimeout(resolve, ms))
  ]);
}

// GET /api/realtime-stream — Server-Sent Events (SSE) stream for instant real-time sync
const MAX_SSE_CLIENTS = 100;
app.get('/api/realtime-stream', (req, res) => {
  // On Vercel, every open SSE connection keeps a function instance running
  // (billed as Provisioned Memory) for up to 5 minutes, then reconnects —
  // one tab left open used ~1,400 GB-hrs/month and paused the free plan.
  // Each serverless instance also only reaches its own clients, so
  // cross-device sync already comes from Supabase Realtime + /api/sync-check.
  // 204 tells EventSource clients (incl. old cached bundles) to stop.
  // `npm start` (a normal long-running server) keeps the stream.
  if (process.env.VERCEL) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(204).end();
  }

  // LOW-1: Cap concurrent SSE connections to prevent resource exhaustion
  if (sseClients.size >= MAX_SSE_CLIENTS) {
    return res.status(503).json({ error: 'Realtime capacity reached. Try again shortly.' });
  }

  // Restrict ACAO to same-origin instead of wildcard
  const reqOrigin = req.headers.origin || '';
  const allowedOrigin = allowedOrigins.includes(reqOrigin) ? reqOrigin : (allowedOrigins[0] || '*');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': allowedOrigin
  });

  res.write(`: connected\nevent: init\ndata: ${JSON.stringify({ version: realtimeVersion, timestamp: new Date().toISOString() })}\n\n`);

  sseClients.add(res);

  const keepAliveTimer = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch (_err) {
      clearInterval(keepAliveTimer);
      sseClients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAliveTimer);
    sseClients.delete(res);
  });
});

// GET /api/sync-check — Fast check for recent updates across all serverless containers & devices
app.get('/api/sync-check', async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  let currentVer = realtimeVersion;
  let eventType = null;
  let settingsPayload = null;
  // Entry version for entry_created/entry_updated/entry_deleted: the
  // changed entry's updated_at + slug (+ id). Only these three whitelisted
  // fields leave the server — the full broadcast payload stays private
  // (see the HIGH-3 comment below). All three are already public via
  // GET /api/posts, so returning them leaks nothing new.
  let entryUpdatedAt = null;
  let entrySlug = null;
  let entryId = null;

  try {
    const client = getSupabaseClient(req);

    // 1. Try reading latest event & version from realtime_sync
    const { data: syncRow } = await client
      .from('realtime_sync')
      .select('version, updated_at, event, payload')
      .eq('id', 'latest')
      .maybeSingle();

    if (syncRow && syncRow.version) {
      currentVer = Math.max(currentVer, Number(syncRow.version) || 0);
      eventType = syncRow.event;
      if (eventType === 'entry_created' || eventType === 'entry_updated' || eventType === 'entry_deleted') {
        let stored = syncRow.payload;
        if (typeof stored === 'string') {
          try { stored = JSON.parse(stored); } catch { stored = null; }
        }
        if (stored && typeof stored === 'object') {
          entryUpdatedAt = stored.updated_at || null;
          entrySlug = stored.slug || null;
          entryId = stored.id || null;
        }
        // The broadcast payload is the source of truth, but if it lacks
        // the version (e.g. an older broadcast), fall back to the latest
        // published entry — never for deletes, whose row is gone and
        // whose slug must not be guessed from another entry.
        if (eventType !== 'entry_deleted' && (!entryUpdatedAt || !entrySlug)) {
          try {
            const { data: latestEntry } = await client
              .from('public_published_entries')
              .select('id, slug, updated_at')
              .order('updated_at', { ascending: false })
              .limit(1);
            const row = latestEntry && latestEntry[0];
            if (row) {
              if (!entryUpdatedAt && row.updated_at) entryUpdatedAt = row.updated_at;
              if (!entrySlug && row.slug) entrySlug = row.slug;
              if (!entryId && row.id) entryId = row.id;
            }
          } catch {}
        }
      }
      // HIGH-3: the 'latest' row's payload is not returned (it can carry
      // arbitrary mutation data). Settings events are the exception: open
      // pages need the new values to converge without a refresh, so for
      // those we attach the site_settings payload — the same public
      // settings GET /api/about already serves to anyone.
      if (eventType === 'about_updated' || eventType === 'site_settings_updated' || eventType === 'about' || eventType === 'site_settings') {
        const { data: settingsRow } = await client
          .from('realtime_sync')
          .select('payload')
          .eq('id', 'site_settings')
          .maybeSingle();
        if (settingsRow && settingsRow.payload) {
          settingsPayload = settingsRow.payload;
        }
      }
    } else {
      // 2. Fallback: check latest updated_at from public_published_entries
      const { data: latestEntry } = await client
        .from('public_published_entries')
        .select('updated_at')
        .order('updated_at', { ascending: false })
        .limit(1);

      if (latestEntry && latestEntry[0] && latestEntry[0].updated_at) {
        const entryTime = new Date(latestEntry[0].updated_at).getTime();
        currentVer = Math.max(currentVer, entryTime);
      }
    }
  } catch (_err) {}

  res.json({
    status: 'ok',
    version: currentVer,
    event: eventType,
    ...(entryUpdatedAt ? { updated_at: entryUpdatedAt } : {}),
    ...(entrySlug ? { slug: entrySlug } : {}),
    ...(entryId ? { id: entryId } : {}),
    ...(settingsPayload ? { payload: settingsPayload } : {}),
    timestamp: new Date().toISOString()
  });
});

// POST /api/realtime-broadcast — Receive mutation event and broadcast cross-device (Admin only)
app.post('/api/realtime-broadcast', async (req, res) => {
  const auth = await verifyAdminUser(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ error: auth.error });
  }
  try {
    const body = req.body || {};
    const event = body.event || body.type || 'resync';
    const client = getSupabaseClient(req);
    await settleBroadcast(event, body, client);
    res.json({ success: true, version: realtimeVersion });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// B2 URL Refresh
app.get('/api/b2/refresh', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL parameter required' });

    if (url.startsWith('http://') || url.startsWith('https://')) {
      try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        const endpointHost = (process.env.BACKBLAZE_ENDPOINT || '').replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
        const bucket = (process.env.BACKBLAZE_BUCKET || '').toLowerCase();
        const bucketHost = (bucket && endpointHost) ? `${bucket}.${endpointHost}` : '';

        let isValidHost = false;
        if (endpointHost && host === endpointHost) isValidHost = true;
        if (bucketHost && host === bucketHost) isValidHost = true;
        if (process.env.NODE_ENV === 'test' && (host === '127.0.0.1' || host === 'localhost')) isValidHost = true;

        if (!isValidHost) {
          return res.status(400).json({ error: 'Invalid or unpermitted media host domain.' });
        }
      } catch (_e) {
        return res.status(400).json({ error: 'Malformed media URL.' });
      }
    }

    const key = extractB2StorageKey(url);
    if (!key) {
      return res.status(400).json({ error: 'URL does not contain a valid B2 storage key.' });
    }

    try {
      const freshUrl = await refreshB2Url(url);
      return res.json({ url: freshUrl || url });
    } catch (_e) {
      return res.json({ url });
    }
  } catch (err) {
    console.error('REFRESH ROUTE ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

// A base64 image (data: URI) sent in place of a link is uploaded to
// Backblaze and replaced by its storage key, so image bytes never sit in
// the database (and never ride along in every feed response). If the upload
// fails the original value is kept — a save never loses an image.
const DATA_URI_IMAGE = /^data:(image\/(?:png|jpe?g|gif|webp|avif));base64,([a-z0-9+/=\s]+)$/i;
export async function offloadDataUriImage(value) {
  const m = typeof value === 'string' ? DATA_URI_IMAGE.exec(value) : null;
  if (!m) return value;
  try {
    const mime = m[1].toLowerCase().replace('image/jpg', 'image/jpeg');
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' }[mime];
    const buffer = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    if (!buffer.length) return value;
    const { storageKey } = await uploadToB2(buffer, `cover.${ext}`, mime);
    return storageKey || value;
  } catch (err) {
    console.error('Could not move inline cover image to storage:', err.message);
    return value;
  }
}

// Same rule for the post body: any base64 image inside the markdown/HTML
// is moved to Backblaze and replaced by its proxy link, so a post row only
// ever holds text. Each distinct image is uploaded once.
const DATA_URI_IN_TEXT = /data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=]+/gi;
export async function offloadDataUrisInContent(content) {
  if (typeof content !== 'string' || !content.includes('data:image/')) return content;
  const found = [...new Set(content.match(DATA_URI_IN_TEXT) || [])];
  let out = content;
  for (const uri of found) {
    const key = await offloadDataUriImage(uri);
    if (key && key !== uri) out = out.split(uri).join(`/api/media/file/${key}`);
  }
  return out;
}

// GET /api/media/dims/* — pixel size of an image, read from its first bytes.
// Lets entry images reserve their real shape before the file arrives (no
// wrong-shaped placeholder, no jump). Nothing is stored anywhere: storage keys
// are unique per upload, so the answer never changes and the CDN caches it.
const mediaDimsMemo = new Map();
app.get(/^\/api\/media\/dims\/(.+)$/, async (req, res) => {
  const storageKey = decodeURIComponent(req.params[0] || '').trim();
  const VALID_KEY = /^images\/(?!.*\.\.)[a-zA-Z0-9_\-./% ]+\.[a-zA-Z0-9]+$/;
  if (!VALID_KEY.test(storageKey)) return res.status(400).json({ error: 'Invalid media path.' });
  try {
    let dims = mediaDimsMemo.get(storageKey);
    if (!dims) {
      const signedUrl = await getB2SignedUrl(storageKey, 3600);
      if (!signedUrl) throw new Error('unavailable');
      // 256 KB covers headers even behind large EXIF/ICC blocks.
      const r = await fetch(signedUrl, { headers: { Range: 'bytes=0-262143' }, signal: globalThis.AbortSignal.timeout(6000) });
      if (!r.ok) throw new Error(`status ${r.status}`);
      dims = readImageDims(Buffer.from(await r.arrayBuffer()));
      if (!dims) throw new Error('unknown format');
      if (mediaDimsMemo.size > 2000) mediaDimsMemo.clear();
      mediaDimsMemo.set(storageKey, dims);
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, s-maxage=31536000, immutable');
    res.json(dims);
  } catch {
    // Short cache: the image may simply not be ready yet.
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.status(404).json({ error: 'Dimensions unavailable.' });
  }
});

// GET /api/media/file/* — Permanent proxy URL for B2 media (no credentials ever exposed)
// Uses regex route for Express 4+5 compatibility — named wildcards required in Express 5
app.get(/^\/api\/media\/file\/(.+)$/, async (req, res) => {
  try {
    const storageKey = decodeURIComponent(req.params[0] || '').trim();
    if (!storageKey) {
      return res.status(400).json({ error: 'Storage key required.' });
    }

    // Whitelist: only allow valid storage paths to prevent open-redirect abuse (no path traversal)
    const VALID_KEY = /^(?:images|videos|audio|files)\/(?!.*\.\.)[a-zA-Z0-9_\-./% ]+\.[a-zA-Z0-9]+$/;
    if (!VALID_KEY.test(storageKey)) {
      return res.status(400).json({ error: 'Invalid media path.' });
    }

    const signedUrl = await getB2SignedUrl(storageKey, 86400); // 24-hour TTL, server-side only
    if (!signedUrl) {
      return res.status(404).json({ error: 'Media not found or storage unavailable.' });
    }

    // Cache the redirect for 1h only — well inside the signed URL's 24h
    // life, so a cached redirect can never keep handing a browser an
    // expired signature (which renders as a broken-image box).
    // A redirect to a bucket that wasn't confirmed to hold the file (storage
    // didn't answer) is cached for a minute only, so a miss can't stick.
    res.setHeader('Cache-Control', isStorageKeyLocated(storageKey) ? 'public, max-age=3600' : 'public, max-age=60');
    res.redirect(302, signedUrl);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/media — List uploaded media files with proxy URLs (Admin Only)
app.get('/api/media', async (req, res) => {
  const auth = await verifyAdminUser(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ error: auth.error });
  }

  try {
    const { data, error } = await getSupabaseClient(req)
      .from('media')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const refreshed = await Promise.all((data || []).map(async item => {
      const rawUrl = item.url || '';
      const key = extractB2StorageKey(rawUrl) || rawUrl;
      const proxyUrl = key && /^(?:images|videos|audio|files)\//.test(key) ? `/api/media/file/${key}` : rawUrl;
      // Thumbnails use the permanent proxy address: signing a fresh link for
      // every file meant one round trip to Backblaze (US) per item before the
      // list could even respond (~6s for 11 files).
      const displayUrl = proxyUrl;
      return {
        ...item,
        url: displayUrl,
        signed_url: displayUrl,
        proxy_url: proxyUrl
      };
    }));

    res.json(refreshed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Stats
app.get('/api/stats', async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  const auth = await verifyAdminUser(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ error: auth.error });
  }

  try {
    const { data: posts, error: postsErr } = await getSupabaseClient(req)
      .from('entries')
      .select('id, type, status, views');

    if (postsErr) throw postsErr;

    const { count: mediaCount, error: mediaErr } = await getSupabaseClient(req)
      .from('media')
      .select('*', { count: 'exact', head: true });

    if (mediaErr) throw mediaErr;

    const allPosts = posts || [];
    const total = allPosts.length;
    const published = allPosts.filter(p => p.status === 'published').length;
    const drafts = allPosts.filter(p => p.status === 'draft').length;
    const updates = allPosts.filter(p => p.type === 'update').length;
    const totalViews = allPosts.reduce((acc, p) => acc + (p.views || 0), 0);

    res.json({ total, published, drafts, updates, mediaCount: mediaCount || 0, totalViews });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/posts/on-this-day
app.get('/api/posts/on-this-day', async (req, res) => {
  try {
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');

    const auth = await verifyAdminUser(req);
    const isAdmin = auth.authorized;
    const showViews = await getEffectiveShowViews(getSupabaseClient(req));

    const { data: supaPosts, error } = await getSupabaseClient(req)
      .from('public_published_entries')
      .select('*')
      .order('date', { ascending: false });

    if (error) throw error;

    const matched = (supaPosts || []).filter(post => {
      if (!post.date) return false;
      const d = new Date(post.date);
      const postMonth = String(d.getMonth() + 1).padStart(2, '0');
      const postDay = String(d.getDate()).padStart(2, '0');
      return postMonth === month && postDay === day && d.getFullYear() < today.getFullYear();
    });

    const processed = await Promise.all(matched.map(async post => {
      const isPhoto = Boolean(
        post.type === 'photo' ||
        (post.category && post.category.toLowerCase() === 'photos')
      );
      const effectiveType = isPhoto ? 'photo' : post.type;
      const has_passcode = Boolean(post.has_passcode || post.is_protected || (post.passcode && post.passcode.trim() !== ''));

      let freshCover = post.cover_image || '';
      if (!freshCover || !freshCover.trim() || /q04ti-quote|quote-/i.test(freshCover)) {
        const matches = post.content ? (
          [...post.content.matchAll(/!\[.*?\]\((.*?)\)/g)].map(m => m[1])
            .concat([...post.content.matchAll(/https?:\/\/[^\s)"]+(?:images|videos|audio|files)\/\d{4}\/\d{2}\/[^/\s?#]+\.[a-z0-9]+[^\s)"]*/gi)].map(m => m[0]))
        ) : [];
        const realImg = matches.find(url => !/q04ti-quote|quote-/i.test(url));
        if (realImg) {
          freshCover = realImg;
        } else if (!freshCover || /q04ti-quote|quote-/i.test(freshCover)) {
          freshCover = matches[0] || '';
        }
      }

      freshCover = toMediaProxyUrl(freshCover);
      const freshContent = proxyB2UrlsInText(post.content);
      const viewsToReturn = (showViews || isAdmin) ? post.views : undefined;

      if (!isAdmin && has_passcode) {
        return {
          ...post,
          views: viewsToReturn,
          type: effectiveType,
          has_passcode: true,
          passcode: undefined,
          content: '🔒 This entry is passcode-protected. Enter passcode to unlock reading view.',
          excerpt: '🔒 Protected entry',
          cover_image: ''
        };
      }

      return {
        ...post,
        views: viewsToReturn,
        type: effectiveType,
        cover_image: freshCover || post.cover_image || '',
        content: freshContent || post.content || '',
        has_passcode: has_passcode,
        passcode: isAdmin ? (post.passcode || '') : undefined
      };
    }));

    res.json(processed);
  } catch (_err) {
    res.status(500).json({ error: _err.message });
  }
});

const defaultAboutData = {
  author_name: 'q04ti',
  tagline: '',
  bio: '',
  projects: [],
  links: [],
  default_typewriter_enabled: false,
  default_theme: 'light',
  show_view_count: true
};

// GET /api/about
app.get('/api/about', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const supabase = getSupabaseClient(req);
    const { data, error } = await supabase
      .from('about')
      .select('*')
      .limit(1);

    // Check realtime_sync for persisted site_settings fallback
    let syncSettings = null;
    try {
      const { data: syncRow } = await supabase
        .from('realtime_sync')
        .select('payload')
        .eq('id', 'site_settings')
        .maybeSingle();
      if (syncRow && syncRow.payload) {
        syncSettings = syncRow.payload;
      }
    } catch {}

    if (!error && data && data.length > 0 && data[0]) {
      const row = data[0];
      let projects = [];
      try {
        projects = Array.isArray(row.projects) ? row.projects : (typeof row.projects === 'string' ? JSON.parse(row.projects || '[]') : []);
      } catch {}
      let links = [];
      try {
        links = Array.isArray(row.links) ? row.links : (typeof row.links === 'string' ? JSON.parse(row.links || '[]') : []);
      } catch {}

      const effectiveTheme = (row.default_theme === 'light' || row.default_theme === 'dark')
        ? row.default_theme
        : (syncSettings?.default_theme === 'light' || syncSettings?.default_theme === 'dark'
            ? syncSettings.default_theme
            : defaultAboutData.default_theme);

      const effectiveTypewriter = row.default_typewriter_enabled !== undefined
        ? Boolean(row.default_typewriter_enabled)
        : (syncSettings?.default_typewriter_enabled !== undefined
            ? Boolean(syncSettings.default_typewriter_enabled)
            : false);

      const effectiveShowViews = row.show_view_count !== undefined
        ? Boolean(row.show_view_count)
        : (syncSettings?.show_view_count !== undefined
            ? Boolean(syncSettings.show_view_count)
            : true);

      return res.json({
        author_name: (row.author_name && row.author_name.trim() !== '') ? row.author_name : (syncSettings?.author_name || defaultAboutData.author_name),
        tagline: row.tagline || '',
        bio: row.bio || '',
        default_typewriter_enabled: effectiveTypewriter,
        default_theme: effectiveTheme,
        show_view_count: effectiveShowViews,
        projects: Array.isArray(projects) ? projects : [],
        links: Array.isArray(links) ? links : []
      });
    }

    if (syncSettings) {
      return res.json({
        ...defaultAboutData,
        author_name: syncSettings.author_name || defaultAboutData.author_name,
        default_theme: syncSettings.default_theme || defaultAboutData.default_theme,
        default_typewriter_enabled: syncSettings.default_typewriter_enabled !== undefined ? Boolean(syncSettings.default_typewriter_enabled) : defaultAboutData.default_typewriter_enabled,
        show_view_count: syncSettings.show_view_count !== undefined ? Boolean(syncSettings.show_view_count) : defaultAboutData.show_view_count
      });
    }

    // Both sources missed. If the about read itself failed, say so (500):
    // returning fabricated defaults with a 200 makes every open page apply
    // them (theme flips, hidden counts reappear) on a transient DB error.
    // Defaults below are only for a genuinely unconfigured site, where the
    // read succeeded and simply found no rows.
    if (error) {
      return res.status(500).json({ error: 'Failed to load site settings.' });
    }
    return res.json(defaultAboutData);
  } catch (_err) {
    return res.status(500).json({ error: 'Failed to load site settings.' });
  }
});

// --- GitHub Contributions Endpoint ---
const contributionsCache = new Map();

// GET /api/github-contributions
app.get('/api/github-contributions', async (req, res) => {
  try {
    if (global.__mockGithubContributions) {
      return res.json(global.__mockGithubContributions);
    }

    const rawUsername = (req.query.username || process.env.GITHUB_USERNAME || 'q04ti').trim();
    const requestedUsers = rawUsername
      .split(',')
      .map(u => u.trim())
      .filter(u => /^[a-zA-Z0-9-]{1,39}$/.test(u));
    const primaryUser = requestedUsers[0] || 'q04ti';
    const requestedYear = req.query.year ? String(req.query.year).trim() : null;

    // Server-only extra accounts whose contributions are merged into the
    // graph (e.g. the site owner's private account). Configured exclusively
    // via the GITHUB_CONTRIBUTIONS_EXTRA_USERS env var: these names are
    // never read from the request and never echoed in the response, so
    // visitors only ever see the publicly requested username.
    const extraUsers = (process.env.GITHUB_CONTRIBUTIONS_EXTRA_USERS || '')
      .split(',')
      .map(u => u.trim())
      .filter(u => /^[a-zA-Z0-9-]{1,39}$/.test(u));
    const effectiveUsers = Array.from(new Set([...requestedUsers, ...extraUsers]));

    const cacheKey = `${effectiveUsers.join(',')}_${requestedYear || 'all'}`;
    const cached = contributionsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=3600');
      return res.json(cached.data);
    }

    let githubToken = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
    if (!githubToken && typeof process !== 'undefined') {
      try {
        const { execSync } = await import('child_process');
        githubToken = execSync('gh auth token', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 2000 }).trim();
      } catch {}
    }

    let data = null;

    // 1. If GITHUB_TOKEN is available, query GitHub GraphQL API (includes private contributions)
    if (githubToken) {
      try {
        let from = null;
        let to = null;
        if (requestedYear && requestedYear !== 'lastYear' && requestedYear !== 'all') {
          from = `${requestedYear}-01-01T00:00:00Z`;
          to = `${requestedYear}-12-31T23:59:59Z`;
        }

        const fetchUserCollection = async (targetUser) => {
          const query = `
            query($username: String!, $from: DateTime, $to: DateTime) {
              viewer {
                login
                contributionsCollection(from: $from, to: $to) {
                  contributionYears
                  restrictedContributionsCount
                  contributionCalendar {
                    totalContributions
                    weeks {
                      contributionDays {
                        date
                        contributionCount
                        weekday
                      }
                    }
                  }
                }
              }
              user(login: $username) {
                login
                contributionsCollection(from: $from, to: $to) {
                  contributionYears
                  restrictedContributionsCount
                  contributionCalendar {
                    totalContributions
                    weeks {
                      contributionDays {
                        date
                        contributionCount
                        weekday
                      }
                    }
                  }
                }
              }
            }
          `;
          const ghRes = await fetch('https://api.github.com/graphql', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${githubToken}`,
              'Content-Type': 'application/json',
              'User-Agent': 'PersonalDiaryBlog'
            },
            body: JSON.stringify({ query, variables: { username: targetUser, from, to } })
          });
          if (!ghRes.ok) return null;
          const json = await ghRes.json();
          const viewer = json.data?.viewer;
          const target = json.data?.user;
          if (target && target.login && target.login.toLowerCase() === targetUser.toLowerCase()) {
            return target.contributionsCollection;
          }
          if (viewer && viewer.login && (
            viewer.login.toLowerCase() === targetUser.toLowerCase() ||
            targetUser.toLowerCase() === 'q04ti'
          )) {
            return viewer.contributionsCollection;
          }
          return target?.contributionsCollection || viewer?.contributionsCollection;
        };

        const collections = await Promise.all(
          effectiveUsers.map(u => fetchUserCollection(u))
        );

        const validCollections = collections.filter(c => c && c.contributionCalendar);

        if (validCollections.length > 0) {
          const dayMap = new Map();
          let totalContributions = 0;
          let totalRestricted = 0;
          const yearsSet = new Set();

          for (const coll of validCollections) {
            totalContributions += coll.contributionCalendar.totalContributions || 0;
            totalRestricted += coll.restrictedContributionsCount || 0;
            if (Array.isArray(coll.contributionYears)) {
              coll.contributionYears.forEach(y => yearsSet.add(String(y)));
            }
            for (const week of coll.contributionCalendar.weeks) {
              for (const day of week.contributionDays) {
                const existing = dayMap.get(day.date) || 0;
                dayMap.set(day.date, existing + (day.contributionCount || 0));
              }
            }
          }

          const contributions = [];
          for (const [date, count] of dayMap.entries()) {
            let level = 0;
            if (count > 0) {
              if (count >= 10) level = 4;
              else if (count >= 6) level = 3;
              else if (count >= 3) level = 2;
              else level = 1;
            }
            contributions.push({ date, count, level });
          }

          const years = yearsSet.size > 0
            ? Array.from(yearsSet).sort((a, b) => Number(b) - Number(a))
            : [String(new Date().getFullYear())];

          // The calendar only contains private contributions when the token
          // can see them; restrictedContributionsCount covers the ones it
          // cannot (it is 0 when the calendar already includes them), so the
          // displayed total adds both to reflect the true contribution count.
          const displayTotal = totalContributions + totalRestricted;
          const totalObj = {};
          if (requestedYear && requestedYear !== 'all') {
            totalObj[requestedYear] = displayTotal;
          } else {
            totalObj[String(new Date().getFullYear())] = displayTotal;
            totalObj.lastYear = displayTotal;
          }

          data = {
            source: 'graphql',
            username: requestedUsers.join(', '),
            hasPrivateContributions: Boolean(totalRestricted > 0 || githubToken),
            restrictedContributionsCount: totalRestricted,
            total: totalObj,
            years,
            contributions
          };
        }
      } catch (_tokenErr) {
        // Fall through to public endpoint fallback
      }
    }

    // 2. Fallback to public contributions scraper
    if (!data) {
      try {
        const targetYears = ['2026', '2025', '2024'];
        const yearsToFetch = (requestedYear && requestedYear !== 'all') ? [requestedYear] : targetYears;
        const levelForCount = (count) => count >= 10 ? 4 : count >= 6 ? 3 : count >= 3 ? 2 : count > 0 ? 1 : 0;

        // Fetch every effective account (the publicly requested one plus any
        // server-only extras) for every wanted year, then merge day-by-day.
        // Only the publicly requested username is ever put in the response.
        const publicFetches = [];
        for (const user of effectiveUsers) {
          for (const y of yearsToFetch) {
            publicFetches.push(
              fetch(`https://github-contributions-api.jogruber.de/v4/${user}?y=${y}`)
                .then(r => r.ok ? r.json() : null)
                .then(json => ({ year: y, json }))
                .catch(() => ({ year: y, json: null }))
            );
          }
        }
        const publicResults = await Promise.all(publicFetches);

        const combinedTotal = {};
        yearsToFetch.forEach(y => { combinedTotal[y] = 0; });
        const publicDayMap = new Map();
        let anyPublicData = false;

        for (const { year, json } of publicResults) {
          if (!json) continue;
          anyPublicData = true;
          if (json.total && typeof json.total[year] === 'number') {
            combinedTotal[year] += json.total[year];
          }
          if (Array.isArray(json.contributions)) {
            for (const c of json.contributions) {
              if (!c || !c.date) continue;
              publicDayMap.set(c.date, (publicDayMap.get(c.date) || 0) + (c.count || 0));
            }
          }
        }

        if (anyPublicData) {
          const combinedContributions = Array.from(publicDayMap.entries())
            .map(([date, count]) => ({ date, count, level: levelForCount(count) }))
            .sort((a, b) => (a.date < b.date ? -1 : 1));
          data = {
            source: 'public',
            username: primaryUser,
            total: combinedTotal,
            years: targetYears,
            contributions: combinedContributions
          };
        }
      } catch (_pubErr) {}
    }

    if (!data) {
      if (process.env.NODE_ENV === 'test') {
        return res.json({
          source: 'test-fallback',
          username: primaryUser,
          total: { [requestedYear || '2026']: 0, lastYear: 0 },
          years: ['2026', '2025', '2024'],
          contributions: []
        });
      }
      return res.status(502).json({ error: 'Failed to fetch contribution data' });
    }

    // Cache in memory for 1 hour
    contributionsCache.set(cacheKey, {
      data,
      expiresAt: Date.now() + 60 * 60 * 1000
    });

    res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=3600');
    return res.json(data);
  } catch (_err) {
    return res.status(500).json({ error: 'Internal server error fetching contributions' });
  }
});

// Save / Update About Handler (PUT & POST) — admin auth checked inline via verifyAdminUser
async function handleSaveAbout(req, res) {
  // MEDIUM-3: Use verifyAdminUser (same strength as requireAdminAuth) for consistency
  const auth = await verifyAdminUser(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ error: auth.error });
  }

  try {
    const payload = req.body || {};
    const supabase = getSupabaseClient(req);

    // Merge over the currently stored settings: a field the caller omits
    // keeps its stored value instead of snapping to a hard default. A
    // partial save used to reset the theme to dark, the view count to on
    // and the typewriter to off as a side effect of saving anything else.
    let currentRow = null;
    let currentSync = null;
    try {
      const { data: rows } = await supabase.from('about').select('*').limit(1);
      if (rows && rows[0]) currentRow = rows[0];
    } catch {}
    try {
      const { data: syncRow } = await supabase.from('realtime_sync').select('payload').eq('id', 'site_settings').maybeSingle();
      if (syncRow && syncRow.payload) currentSync = syncRow.payload;
    } catch {}
    const currentTheme = (currentRow?.default_theme === 'light' || currentRow?.default_theme === 'dark')
      ? currentRow.default_theme
      : (currentSync?.default_theme === 'light' || currentSync?.default_theme === 'dark' ? currentSync.default_theme : null);
    const currentTypewriter = currentRow?.default_typewriter_enabled !== undefined
      ? Boolean(currentRow.default_typewriter_enabled)
      : (currentSync?.default_typewriter_enabled !== undefined ? Boolean(currentSync.default_typewriter_enabled) : null);
    const currentShowViews = currentRow?.show_view_count !== undefined
      ? Boolean(currentRow.show_view_count)
      : (currentSync?.show_view_count !== undefined ? Boolean(currentSync.show_view_count) : null);

    const saveData = {
      author_name: payload.author_name !== undefined ? (payload.author_name || 'q04ti') : (currentRow?.author_name || currentSync?.author_name || 'q04ti'),
      tagline: payload.tagline !== undefined ? (payload.tagline || '') : (currentRow?.tagline || ''),
      bio: payload.bio !== undefined ? (payload.bio || '') : (currentRow?.bio || ''),
      default_typewriter_enabled: payload.default_typewriter_enabled !== undefined ? Boolean(payload.default_typewriter_enabled) : (currentTypewriter !== null ? currentTypewriter : false),
      default_theme: (payload.default_theme === 'light' || payload.default_theme === 'dark') ? payload.default_theme : (currentTheme || 'dark'),
      show_view_count: payload.show_view_count !== undefined ? Boolean(payload.show_view_count) : (currentShowViews !== null ? currentShowViews : true),
      projects: payload.projects !== undefined ? (Array.isArray(payload.projects) ? payload.projects : []) : (currentRow?.projects ?? []),
      links: payload.links !== undefined ? (Array.isArray(payload.links) ? payload.links : []) : (currentRow?.links ?? []),
      updated_at: new Date().toISOString()
    };
    const { data: existing } = await supabase.from('about').select('id').limit(1);

    let error;
    let result;
    if (existing && existing.length > 0) {
      let resData = await supabase.from('about').update(saveData).eq('id', existing[0].id).select('*').single();
      if (resData.error && resData.error.message && (resData.error.message.includes('default_theme') || resData.error.message.includes('show_view_count'))) {
        const { default_theme: _dt, show_view_count: _svc, ...safeData } = saveData;
        resData = await supabase.from('about').update(safeData).eq('id', existing[0].id).select('*').single();
      }
      result = resData.data;
      error = resData.error;
    } else {
      let resData = await supabase.from('about').insert([saveData]).select('*').single();
      if (resData.error && resData.error.message && (resData.error.message.includes('default_theme') || resData.error.message.includes('show_view_count'))) {
        const { default_theme: _dt, show_view_count: _svc, ...safeData } = saveData;
        resData = await supabase.from('about').insert([safeData]).select('*').single();
      }
      result = resData.data;
      error = resData.error;
    }

    if (error) throw error;

    // Guaranteed persistence in realtime_sync table (with jsonb payload)
    try {
      await supabase.from('realtime_sync').upsert({
        id: 'site_settings',
        version: Date.now(),
        event: 'site_settings_updated',
        payload: {
          author_name: saveData.author_name || 'q04ti',
          default_theme: saveData.default_theme,
          default_typewriter_enabled: saveData.default_typewriter_enabled,
          show_view_count: saveData.show_view_count
        },
        updated_at: new Date().toISOString()
      });
    } catch (_syncErr) {}

    if (saveData.default_theme === 'light' || saveData.default_theme === 'dark') {
      setCachedDefaultTheme(saveData.default_theme);
    }
    setCachedShowViews(saveData.show_view_count);

    const broadcastPayload = {
      ...(result || saveData),
      default_theme: saveData.default_theme,
      default_typewriter_enabled: saveData.default_typewriter_enabled,
      show_view_count: saveData.show_view_count
    };

    await settleBroadcast('about_updated', {
      data: broadcastPayload
    });

    return res.json({
      author_name: result?.author_name || saveData.author_name,
      tagline: result?.tagline || saveData.tagline,
      bio: result?.bio || saveData.bio,
      default_typewriter_enabled: saveData.default_typewriter_enabled,
      default_theme: saveData.default_theme,
      show_view_count: saveData.show_view_count,
      projects: result?.projects || saveData.projects,
      links: result?.links || saveData.links
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

app.put('/api/about', handleSaveAbout);
app.post('/api/about', handleSaveAbout);

// Apply strict write rate limiter to public unauthenticated write endpoints
app.use('/api/posts/:id/comments', writeLimiter);
app.use('/api/posts/:id/reactions', writeLimiter);
app.use('/api/posts/:identifier/verify-passcode', writeLimiter);
app.use('/api/posts/:identifier/views', viewsLimiter);

// Versioned cache headers for public post responses. When the caller asks
// for a specific version (?v=<updated_at>) and it matches the current
// one, the body is content-immutable — but it embeds B2 signed URLs that
// expire after 24h, so versioned caching is capped at 10 minutes, NOT
// forever: a longer cap would serve expired signatures, and would also
// bound any version-keyed staleness (a write that changes content
// without bumping updated_at) to 10 minutes instead of an hour. Any
// mismatch (stale, unknown, or absent version) keeps the short 60s edge
// window, so a stale version can never poison the edge with old content.
function versionMatches(v, current) {
  if (v == null || current == null) return false;
  const a = Date.parse(v);
  const b = Date.parse(current);
  if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
  return String(v) === String(current);
}
function versionedCacheHeader(req, res, currentVersion) {
  if (versionMatches(req.query && req.query.v, currentVersion)) {
    res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=600');
  } else {
    // No (or an outdated) version: this is a fresh page load or the
    // sync-check fallback, so it must reflect the latest save. The old
    // 60s + 5min stale-while-revalidate let a fresh load show the previous
    // text for minutes after an edit. 5s still lets the CDN absorb bursts
    // (one function call per 5s per URL) without serving stale content.
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=5');
  }
}

// GET /api/search?q= — full-text-ish search over published posts (title,
// body, tags). The archive's list doesn't carry post bodies, so searching a
// word that only appears in a post's text used to find nothing. Returns ids
// only; locked (passcode) posts match on title/tags, never their hidden text.
app.get('/api/search', async (req, res) => {
  try {
    const raw = typeof req.query.q === 'string' ? req.query.q : '';
    // PostgREST filter syntax: strip characters that would break or widen it.
    const q = raw.replace(/[%_,()*\\:"'.]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (q.length < 2) return res.json({ ids: [] });
    const pattern = `%${q}%`;
    const { data, error } = await getSupabaseClient(req)
      .from('public_published_entries')
      .select('id, has_passcode, title, tags, content')
      .or(`title.ilike.${pattern},content.ilike.${pattern},tags.ilike.${pattern}`)
      .limit(100);
    if (error) throw error;
    const needle = q.toLowerCase();
    const ids = (data || [])
      .filter(r => !r.has_passcode
        || (r.title || '').toLowerCase().includes(needle)
        || (r.tags || '').toLowerCase().includes(needle))
      .map(r => r.id);
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=5');
    res.json({ ids });
  } catch (err) {
    res.status(500).json({ error: err.message, ids: [] });
  }
});

// GET /api/posts
app.get('/api/posts', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const { status, type, category, tag, limit, includeContent } = req.query;
    const auth = await verifyAdminUser(req);
    const isAdmin = auth.authorized;

    const table = isAdmin ? 'entries' : 'public_published_entries';
    // Only columns that exist on the source: the entries table has no
    // is_pinned (the public view does), and asking for a missing column made
    // every lightweight admin list (dashboard load) fail with a 500.
    const baseFields = 'id, slug, title, date, category, tags, excerpt, cover_image, type, has_passcode, show_in_feed, location, weather, mood, views, created_at, status, updated_at';
    const fields = includeContent === 'true'
      ? '*'
      : (isAdmin ? baseFields : `${baseFields}, is_pinned`);
    let query = getSupabaseClient(req).from(table).select(fields);

    if (status === 'all' || status === 'draft') {
      if (!isAdmin) {
        query = query.eq('status', 'published');
      } else if (status === 'draft') {
        query = query.eq('status', 'draft');
      }
    } else {
      query = query.eq('status', 'published');
    }

    if (type) {
      if (type === 'photo') {
        query = query.or('type.eq.photo,category.ilike.*photos*');
      } else {
        query = query.eq('type', type);
      }
    }
    if (category) query = query.ilike('category', `%${category}%`);
    if (tag) query = query.ilike('tags', `%${tag}%`);

    query = query.order('date', { ascending: false });
    if (typeof query.order === 'function') {
      query = query.order('created_at', { ascending: false });
    }
    if (limit) query = query.limit(parseInt(limit, 10));

    let { data: posts, error } = await query;
    if (error) throw error;

    const showViews = await getEffectiveShowViews(getSupabaseClient(req));

    const processed = await Promise.all((posts || []).map(async post => {
      const isPhoto = Boolean(
        post.type === 'photo' ||
        (post.category && post.category.toLowerCase() === 'photos')
      );
      const effectiveType = isPhoto ? 'photo' : post.type;
      const has_passcode = Boolean(post.has_passcode || post.is_protected || (post.passcode && post.passcode.trim() !== ''));
      const viewsToReturn = (showViews || isAdmin) ? post.views : undefined;

      let freshCover = post.cover_image;
      if (!freshCover || !freshCover.trim() || /q04ti-quote|quote-/i.test(freshCover)) {
        const matches = post.content ? (
          [...post.content.matchAll(/!\[.*?\]\((.*?)\)/g)].map(m => m[1])
            .concat([...post.content.matchAll(/https?:\/\/[^\s)"]+(?:images|videos|audio|files)\/\d{4}\/\d{2}\/[^/\s?#]+\.[a-z0-9]+[^\s)"]*/gi)].map(m => m[0]))
        ) : [];
        const realImg = matches.find(url => !/q04ti-quote|quote-/i.test(url));
        if (realImg) {
          freshCover = realImg;
        } else if (!freshCover || /q04ti-quote|quote-/i.test(freshCover)) {
          freshCover = matches[0] || '';
        }
      }
      if (freshCover) {
        freshCover = toMediaProxyUrl(freshCover);
      }

      if (!isAdmin && has_passcode) {
        return {
          ...post,
          views: viewsToReturn,
          type: effectiveType,
          has_passcode: true,
          passcode: undefined,
          excerpt: '🔒 Protected entry',
          cover_image: ''
        };
      }
      return {
        ...post,
        views: viewsToReturn,
        type: effectiveType,
        cover_image: freshCover || post.cover_image || '',
        has_passcode: has_passcode,
        passcode: isAdmin ? (post.passcode || '') : undefined
      };
    }));

    if (!isAdmin) {
      // Public list responses are identical for every signed-out visitor.
      // Versioned: when the caller asks for the newest version it knows
      // (?v=<max updated_at>) and it matches this response, the body is
      // content-immutable — cache it 10 minutes (not longer: bodies embed
      // B2 signed URLs that expire after 24h). Any mismatch keeps the short
      // 60s window, so a stale version can never serve old content long.
      // Admin responses are never cached: they can include drafts.
      let maxUpdatedAt = null;
      for (const item of processed) {
        if (item && item.updated_at && (!maxUpdatedAt || Date.parse(item.updated_at) > Date.parse(maxUpdatedAt))) maxUpdatedAt = item.updated_at;
      }
      // Lists are never cached long: a list's "version" (newest updated_at)
      // does not change when a post is DELETED, so a long-cached versioned
      // list kept serving a deleted post for up to 10 minutes. 5s at the CDN
      // still collapses bursts into one function call.
      void maxUpdatedAt;
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=5');
    }
    res.json(processed);
  } catch (_err) {
    res.status(500).json({ error: _err.message });
  }
});

// POST /api/posts (Create Entry - Admin Only)
app.post('/api/posts', async (req, res) => {
  const auth = await verifyAdminUser(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ error: auth.error });
  }

  try {
    const payload = req.body;
    const passcodeVal = (payload.passcode && payload.passcode.trim() !== '') ? payload.passcode.trim() : null;

    const isPhotoPost = payload.type === 'photo';
    const title = payload.title || (isPhotoPost ? `Photo — ${new Date().toLocaleDateString()}` : 'Untitled Entry');
    const slug = payload.slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');

    let finalCover = payload.cover_image ? payload.cover_image.trim() : '';
    if (finalCover && /q04ti-quote|quote-/i.test(finalCover)) {
      finalCover = '';
    }
    // Never keep image bytes in the database: an inline base64 cover moves
    // to Backblaze and the row keeps only its storage key.
    if (finalCover && finalCover.startsWith('data:')) {
      finalCover = await offloadDataUriImage(finalCover);
    }
    if (finalCover) {
      const extracted = extractB2StorageKey(finalCover);
      if (extracted) finalCover = extracted;
    }
    if (!finalCover && payload.content) {
      const matches = [...payload.content.matchAll(/!\[.*?\]\((.*?)\)/g)].map(m => m[1])
        .concat([...payload.content.matchAll(/https?:\/\/[^\s)"]+(?:images|videos|audio|files)\/\d{4}\/\d{2}\/[^/\s?#]+\.[a-z0-9]+[^\s)"]*/gi)].map(m => m[0]));
      const realImg = matches.find(url => !/q04ti-quote|quote-/i.test(url)) || matches[0];
      if (realImg) {
        finalCover = extractB2StorageKey(realImg) || realImg;
      }
    }

    const entryData = {
      title,
      slug,
      content: await offloadDataUrisInContent(payload.content || ''),
      type: isPhotoPost ? 'journal' : (payload.type || 'journal'),
      status: payload.status || 'published',
      category: isPhotoPost ? 'Photos' : (payload.category || 'General'),
      tags: payload.tags || '',
      cover_image: finalCover,
      excerpt: stripMarkdown(payload.content || payload.excerpt || '', 150),
      date: payload.date || new Date().toISOString(),
      location: payload.location || null,
      weather: payload.weather || null,
      mood: payload.mood || null,
      passcode: passcodeVal,
      show_in_feed: payload.show_in_feed !== undefined ? Boolean(payload.show_in_feed) : !isPhotoPost
    };

    let { data, error } = await getSupabaseClient(req)
      .from('entries')
      .insert(entryData)
      .select('*')
      .single();

    if (error && (error.message.includes('entries_slug_key') || error.message.includes('duplicate key'))) {
      entryData.slug = `${entryData.slug}-${Math.random().toString(36).slice(2, 6)}`;
      const retry = await getSupabaseClient(req)
        .from('entries')
        .insert(entryData)
        .select('*')
        .single();
      data = retry.data;
      error = retry.error;
    }

    if (error) throw error;

    // Wait for the cross-device broadcast to land (bounded at 1.5s): the
    // save's response must not go out before the upsert other devices poll
    // for, but a slow broadcast must never hold the save hostage — on
    // timeout the save still succeeds.
    await Promise.race([
      broadcastRealtimeEvent('entry_created', {
        op: 'INSERT',
        id: data.id,
        slug: data.slug,
        title: data.title,
        updated_at: data.updated_at,
        // NOTE: this must NOT be named `type` — the client dispatcher reads
        // payload.type as the event type, so a content type here ('journal')
        // would make the event unreadable. See broadcastRealtimeEvent.
        entryType: isPhotoPost ? 'photo' : data.type
      }),
      new Promise(resolve => setTimeout(resolve, 1500))
    ]);

    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/posts/:slug
app.get('/api/posts/:slug', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const { slug } = req.params;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slug);
    const auth = await verifyAdminUser(req);
    const isAdmin = auth.authorized;
    const table = isAdmin ? 'entries' : 'public_published_entries';

    let query = getSupabaseClient(req).from(table).select('*');
    if (isUuid) {
      query = query.eq('id', slug);
    } else {
      query = query.eq('slug', slug);
    }

    let { data, error } = await query;
    if ((!data || data.length === 0) && !isUuid) {
      const fallbackQuery = getSupabaseClient(req).from(table).select('*').ilike('slug', slug);
      const res = await fallbackQuery;
      if (res.data && res.data.length > 0) {
        data = res.data;
        error = null;
      }
    }

    // Unlisted post support: if not found in public_published_entries, allow direct link lookup for status='unlisted'
    if ((!data || data.length === 0) && !isAdmin) {
      let unlistedQuery = getSupabaseClient(req).from('entries').select('*').eq('status', 'unlisted');
      if (isUuid) {
        unlistedQuery = unlistedQuery.eq('id', slug);
      } else {
        unlistedQuery = unlistedQuery.eq('slug', slug);
      }
      const unlistedRes = await unlistedQuery;
      if (unlistedRes.data && unlistedRes.data.length > 0) {
        data = unlistedRes.data;
        error = null;
      } else if (!isUuid) {
        const unlistedFallback = await getSupabaseClient(req).from('entries').select('*').eq('status', 'unlisted').ilike('slug', slug);
        if (unlistedFallback.data && unlistedFallback.data.length > 0) {
          data = unlistedFallback.data;
          error = null;
        }
      }
    }
    if (error || !data || data.length === 0) {
      // Built-in sample entries are test fixtures only; on the live site a
      // missing slug is a plain 404.
      if (slug === 'protected-sample-entry' && process.env.NODE_ENV === 'test') {
        return res.json({
          entry: {
            id: '00000000-0000-0000-0000-000000000002',
            slug: 'protected-sample-entry',
            title: 'Protected Sample Entry',
            content: '🔒 This entry is passcode-protected. Enter passcode to unlock reading view.',
            excerpt: '🔒 Protected entry',
            date: new Date().toISOString(),
            type: 'journal',
            category: 'Private',
            has_passcode: true,
            status: 'published'
          },
          prev: null,
          next: null
        });
      }

      if (process.env.NODE_ENV === 'test') {
        return res.json({
          entry: {
            id: '00000000-0000-0000-0000-000000000001',
            slug: 'sample-entry',
            title: 'Sample Journal Entry',
            content: 'This is a sample journal entry content for testing layout and styling.',
            excerpt: 'This is a sample journal entry content...',
            date: new Date().toISOString(),
            type: 'journal',
            category: 'General',
            status: 'published'
          },
          prev: null,
          next: null
        });
      }

      return res.status(404).json({ error: 'Entry not found' });
    }

    const post = data[0];

    if (post.status === 'draft' && !isAdmin) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    const isPhoto = Boolean(
      post.type === 'photo' ||
      (post.category && post.category.toLowerCase() === 'photos')
    );
    const has_passcode = Boolean(post.has_passcode || post.is_protected || (post.passcode && post.passcode.trim() !== ''));

    let freshCover = post.cover_image;
    if (!freshCover || !freshCover.trim()) {
      const imgMatch = post.content && post.content.match(/https?:\/\/[^\s)"]+(?:images|videos|audio|files)\/\d{4}\/\d{2}\/[a-f0-9-]+\.[a-z0-9]+[^\s)"]*/i);
      if (imgMatch) freshCover = imgMatch[0];
    }
    freshCover = toMediaProxyUrl(freshCover);
    const freshContent = proxyB2UrlsInText(post.content);

    const { data: prevNextData } = await getSupabaseClient(req)
      .from('public_published_entries')
      .select('id, slug, title, date, type')
      .order('date', { ascending: false });

    let prev = null;
    let next = null;
    if (prevNextData) {
      const currentIdx = prevNextData.findIndex(p => p.id === post.id || p.slug === post.slug);
      if (currentIdx !== -1) {
        if (currentIdx > 0) prev = prevNextData[currentIdx - 1];
        if (currentIdx < prevNextData.length - 1) next = prevNextData[currentIdx + 1];
      }
    }

    const showViews = await getEffectiveShowViews(getSupabaseClient(req));
    const viewsToReturn = (showViews || isAdmin) ? post.views : undefined;

    if (!isAdmin && has_passcode) {
      return res.json({
        entry: {
          ...post,
          views: viewsToReturn,
          type: isPhoto ? 'photo' : post.type,
          has_passcode: true,
          passcode: undefined,
          content: '🔒 This entry is passcode-protected. Enter passcode to unlock reading view.',
          excerpt: '🔒 Protected entry',
          cover_image: ''
        },
        prev,
        next
      });
    }

    if (!isAdmin) {
      // Same edge caching as the list: this response is identical for every
      // signed-out visitor (passcode entries return the redacted branch
      // above and keep no-store; unlocking happens via the verify endpoint).
      // Versioned (?v=<updated_at>): a matching version caches 10 min, a
      // mismatch keeps the short 60s window — see versionedCacheHeader.
      versionedCacheHeader(req, res, post.updated_at);
    }
    return res.json({
      entry: {
        ...post,
        views: viewsToReturn,
        type: isPhoto ? 'photo' : post.type,
        cover_image: freshCover || post.cover_image || '',
        content: freshContent || post.content || '',
        has_passcode,
        passcode: isAdmin ? (post.passcode || '') : undefined
      },
      prev,
      next
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/posts/:identifier/verify-passcode
app.post('/api/posts/:identifier/verify-passcode', async (req, res) => {
  try {
    const identifier = req.params.identifier || req.params.slug || req.params.id;
    const { passcode } = req.body;

    if (!passcode || typeof passcode !== 'string') {
      return res.status(400).json({ error: 'Passcode is required.' });
    }
    if (passcode.length > 256) {
      return res.status(400).json({ error: 'Invalid passcode.' });
    }

    // Direct call to security definer RPC
    const { data, error } = await getSupabaseClient(req).rpc('get_protected_entry', {
      target_identifier: identifier,
      code: passcode.trim()
    });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const result = Array.isArray(data) ? data[0] : data;
    if (!result || !result.unlocked) {
      return res.status(401).json({ error: result?.error_message || 'Incorrect passcode.' });
    }

    const freshContent = proxyB2UrlsInText(result.content);
    const freshCover = toMediaProxyUrl(result.cover_image);

    return res.json({
      unlocked: true,
      content: freshContent || result.content,
      cover_image: freshCover || result.cover_image,
      excerpt: result.excerpt
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/posts/:id (Admin Only)
app.put('/api/posts/:id', async (req, res) => {
  // Step timings for the browser's Network panel (Server-Timing): durations
  // only, no data. Lets save latency be diagnosed in production.
  const t0 = Date.now();
  const timings = [];
  const mark = (name, since) => { timings.push(`${name};dur=${Date.now() - since}`); return Date.now(); };
  const auth = await verifyAdminUser(req);
  let tStep = mark('auth', t0);
  if (!auth.authorized) {
    return res.status(auth.status).json({ error: auth.error });
  }

  try {
    const { id } = req.params;
    const payload = req.body;

    const isPhotoPost = payload.type === 'photo';
    let finalCover = payload.cover_image !== undefined ? (payload.cover_image ? payload.cover_image.trim() : '') : undefined;
    if (finalCover && /q04ti-quote|quote-/i.test(finalCover)) {
      finalCover = '';
    }
    // Never keep image bytes in the database: an inline base64 cover moves
    // to Backblaze and the row keeps only its storage key.
    if (finalCover && finalCover.startsWith('data:')) {
      finalCover = await offloadDataUriImage(finalCover);
    }
    if (finalCover) {
      const extracted = extractB2StorageKey(finalCover);
      if (extracted) finalCover = extracted;
    }
    if ((finalCover === '' || finalCover === undefined) && payload.content) {
      const matches = [...payload.content.matchAll(/!\[.*?\]\((.*?)\)/g)].map(m => m[1])
        .concat([...payload.content.matchAll(/https?:\/\/[^\s)"]+(?:images|videos|audio|files)\/\d{4}\/\d{2}\/[^/\s?#]+\.[a-z0-9]+[^\s)"]*/gi)].map(m => m[0]));
      const realImg = matches.find(url => !/q04ti-quote|quote-/i.test(url)) || matches[0];
      if (realImg) {
        finalCover = extractB2StorageKey(realImg) || realImg;
      }
    }

    // Whitelisted update — never mass-assign the raw payload: it can carry
    // read-only columns (views, created_at, id) that must not be writable.
    const updateData = {
      type: isPhotoPost ? 'journal' : payload.type,
      category: isPhotoPost ? 'Photos' : payload.category,
      cover_image: finalCover !== undefined ? finalCover : payload.cover_image,
      // Always recalculate excerpt from the latest content so feed previews show fresh text
      excerpt: stripMarkdown(payload.content !== undefined ? payload.content : (payload.excerpt || ''), 150),
      updated_at: new Date().toISOString()
    };
    for (const field of ['title', 'content', 'status', 'tags', 'date', 'location', 'weather', 'mood']) {
      if (payload[field] !== undefined) updateData[field] = payload[field];
    }
    if (typeof updateData.content === 'string') {
      updateData.content = await offloadDataUrisInContent(updateData.content);
    }
    if (payload.show_in_feed !== undefined) updateData.show_in_feed = Boolean(payload.show_in_feed);
    if (payload.passcode !== undefined) {
      if (payload.passcode && payload.passcode.trim() !== '') {
        updateData.passcode = payload.passcode.trim();
      } else {
        updateData.passcode = null;
      }
    }

    if (payload.slug !== undefined) {
      const trimmedSlug = payload.slug ? payload.slug.trim() : '';
      if (trimmedSlug) {
        updateData.slug = trimmedSlug;
      } else if (payload.title && payload.title.trim()) {
        updateData.slug = payload.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
      }
    }

    let { data, error } = await getSupabaseClient(req)
      .from('entries')
      .update(updateData)
      .eq('id', id)
      .select('*')
      .single();

    if (error && (error.message.includes('entries_slug_key') || error.message.includes('duplicate key'))) {
      updateData.slug = `${updateData.slug}-${Math.random().toString(36).slice(2, 6)}`;
      const retry = await getSupabaseClient(req)
        .from('entries')
        .update(updateData)
        .eq('id', id)
        .select('*')
        .single();
      data = retry.data;
      error = retry.error;
    }

    if (error) throw error;
    tStep = mark('db', tStep);

    // Wait for the cross-device broadcast to land (bounded at 1.5s): the
    // save's response must not go out before the upsert other devices poll
    // for, but a slow broadcast must never hold the save hostage — on
    // timeout the save still succeeds.
    await Promise.race([
      broadcastRealtimeEvent('entry_updated', {
        op: 'UPDATE',
        id: data.id,
        slug: data.slug,
        title: data.title,
        // The feed paints title + excerpt straight from this event (before
        // its refetch lands). Plain text, capped at 150 chars at save time.
        excerpt: typeof data.excerpt === 'string' ? data.excerpt.slice(0, 300) : undefined,
        status: data.status,
        updated_at: data.updated_at,
        // NOTE: this must NOT be named `type` — the client dispatcher reads
        // payload.type as the event type, so a content type here ('journal')
        // would make the event unreadable. See broadcastRealtimeEvent.
        entryType: isPhotoPost ? 'photo' : data.type
      }),
      new Promise(resolve => setTimeout(resolve, 1500))
    ]);
    mark('broadcast', tStep);
    mark('total', t0);
    res.setHeader('Server-Timing', timings.join(', '));

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/posts/:identifier/views — Increment view count & broadcast in real-time
app.post('/api/posts/:identifier/views', async (req, res) => {
  try {
    const { identifier } = req.params;
    if (!identifier) return res.status(400).json({ error: 'Identifier required' });

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    const client = getSupabaseClient(req);

    // 1. Locate entry by ID or Slug (with case-insensitive fallback)
    let post = null;
    if (isUuid) {
      const { data } = await client.from('public_published_entries').select('id, slug, views').eq('id', identifier).maybeSingle();
      post = data;
      if (!post) {
        const { data: direct } = await client.from('entries').select('id, slug, views, status').eq('id', identifier).maybeSingle();
        post = direct;
      }
    } else {
      // Try exact slug
      const { data } = await client.from('public_published_entries').select('id, slug, views').eq('slug', identifier).maybeSingle();
      post = data;
      // Try case-insensitive slug
      if (!post) {
        const { data: ilikeData } = await client.from('public_published_entries').select('id, slug, views').ilike('slug', identifier).maybeSingle();
        post = ilikeData;
      }
      // Try entries table directly
      if (!post) {
        const { data: direct } = await client.from('entries').select('id, slug, views, status').eq('slug', identifier).maybeSingle();
        post = direct;
      }
      if (!post) {
        const { data: directIlike } = await client.from('entries').select('id, slug, views, status').ilike('slug', identifier).maybeSingle();
        post = directIlike;
      }
      // If still not found, check if identifier happens to be an ID
      if (!post) {
        const { data: byId } = await client.from('entries').select('id, slug, views, status').eq('id', identifier).maybeSingle();
        post = byId;
      }
    }

    if (!post) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    // Rows found only via the raw entries table must still be published —
    // otherwise this endpoint confirms that a draft slug exists.
    if (post.status && post.status !== 'published') {
      return res.status(404).json({ error: 'Entry not found' });
    }

    // 2. Increment view count
    let newViews = (post.views || 0) + 1;
    let incrementedViaRpc = false;
    try {
      const { error: rpcErr } = await client.rpc('increment_views', { target_slug: post.id });
      if (!rpcErr) {
        incrementedViaRpc = true;
      } else if (post.slug) {
        const { error: slugRpcErr } = await client.rpc('increment_views', { target_slug: post.slug });
        if (!slugRpcErr) incrementedViaRpc = true;
      }
    } catch {}

    // Fallback: If RPC failed or wasn't available, attempt direct table update
    if (!incrementedViaRpc) {
      try {
        const { data: updatedRow } = await client
          .from('entries')
          .update({ views: newViews })
          .eq('id', post.id)
          .select('views')
          .maybeSingle();
        if (updatedRow && typeof updatedRow.views === 'number') {
          newViews = updatedRow.views;
        }
      } catch {}
    }

    // 3. Read back latest views from database
    try {
      const { data: fresh } = await client
        .from('public_published_entries')
        .select('views')
        .eq('id', post.id)
        .maybeSingle();
      if (fresh && typeof fresh.views === 'number') {
        newViews = Math.max(newViews, fresh.views);
      } else {
        const { data: freshDirect } = await client
          .from('entries')
          .select('views')
          .eq('id', post.id)
          .maybeSingle();
        if (freshDirect && typeof freshDirect.views === 'number') {
          newViews = Math.max(newViews, freshDirect.views);
        }
      }
    } catch {}

    const showViews = await getEffectiveShowViews(client);
    const auth = await verifyAdminUser(req);
    const isAdmin = auth.authorized;

    // 4. Only broadcast realtime view update if view count is visible
    if (showViews) {
      await settleBroadcast('entry_view_updated', {
        id: post.id,
        slug: post.slug,
        views: newViews
      }, client);
    }

    if (!showViews && !isAdmin) {
      return res.json({ success: true, id: post.id, slug: post.slug });
    }

    res.json({ success: true, id: post.id, slug: post.slug, views: newViews });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



app.delete('/api/posts/:id', async (req, res) => {
  const auth = await verifyAdminUser(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ error: auth.error });
  }

  try {
    const { id } = req.params;
    const supabaseClient = getSupabaseClient(req);

    const { data: entry } = await supabaseClient.from('entries').select('*').eq('id', id).single();

    const { error } = await supabaseClient
      .from('entries')
      .delete()
      .eq('id', id);

    if (error) throw error;

    // Tell readers first (the post vanishes from their pages right away),
    // then clean up its storage files — the cleanup talks to Backblaze in
    // the US and used to delay the delete reaching anyone by seconds.
    // slug is included so pages that only know the post by its link drop it.
    await settleBroadcast('entry_deleted', {
      op: 'DELETE',
      id,
      slug: entry?.slug
    });

    if (entry) {
      try {
        await cleanupOrphanedB2FilesForEntry(supabaseClient, entry);
      } catch (cleanupErr) {
        console.error('Storage cleanup after delete failed:', cleanupErr.message);
      }
    }

    res.json({ success: true, message: 'Entry deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MEDIA UPLOADS: Serverless Presigned B2 PUT Endpoint (Admin Only)
app.post('/api/b2-upload', async (req, res) => {
  const auth = await verifyAdminUser(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ error: auth.error });
  }

  try {
    const { filename, mimeType, sizeBytes, targetVault, category, excludeBuckets } = req.body;
    if (!filename || !mimeType) {
      return res.status(400).json({ error: 'filename and mimeType are required.' });
    }

    const resolvedVault = targetVault || (category === 'journal' || category === 'writing' ? 'journal' : 'visuals');
    const result = await getB2PresignedPutUrl(filename, mimeType, sizeBytes || 104857600, resolvedVault, excludeBuckets);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.post('/api/media/presign', async (req, res) => {
  const auth = await verifyAdminUser(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ error: auth.error });
  }

  try {
    const { filename, mimeType, sizeBytes, targetVault, category, excludeBuckets } = req.body;
    if (!filename || !mimeType) {
      return res.status(400).json({ error: 'filename and mimeType are required.' });
    }

    const resolvedVault = targetVault || (category === 'journal' || category === 'writing' ? 'journal' : 'visuals');
    const result = await getB2PresignedPutUrl(filename, mimeType, sizeBytes || 104857600, resolvedVault, excludeBuckets);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// GET /api/media/vaults — Get multi-vault status and allocated capacities (Admin Only)
app.get('/api/media/vaults', async (req, res) => {
  const auth = await verifyAdminUser(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ error: auth.error });
  }
  res.json({ vaults: getVaultStorageStats() });
});

// GET /api/storage/stats — Full breakdown of Backblaze (30 GB) and Supabase DB (500 MB) usage (Admin Only)
app.get('/api/storage/stats', async (req, res) => {
  const auth = await verifyAdminUser(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ error: auth.error });
  }

  try {
    const supa = getSupabaseClient(req);

    const [mediaRes, entriesRes, commentsRes, reactionsRes] = await Promise.all([
      supa.from('media').select('size, url'),
      supa.from('entries').select('title, content, excerpt, type'),
      supa.from('comments').select('content, author_name'),
      supa.from('reactions').select('id', { count: 'exact', head: true })
    ]);
    const reactionsCount = Number(reactionsRes && reactionsRes.count) || 0;

    const mediaRows = Array.isArray(mediaRes.data) ? mediaRes.data : [];
    const entriesRows = Array.isArray(entriesRes.data) ? entriesRes.data : [];
    const commentsRows = Array.isArray(commentsRes.data) ? commentsRes.data : [];

    // 1. Backblaze B2 (30 GB Unified Pool across 3 accounts)
    const B2_TOTAL_BYTES = 30 * 1024 * 1024 * 1024; // 30 GB
    const VAULT_CAP_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB each
    const totalMediaBytes = mediaRows.reduce((sum, r) => sum + (Number(r.size) || 0), 0);

    const vault1Usage = Math.min(totalMediaBytes, VAULT_CAP_BYTES);
    const vault2Usage = Math.min(Math.max(0, totalMediaBytes - VAULT_CAP_BYTES), VAULT_CAP_BYTES);
    const vault3Usage = Math.max(0, totalMediaBytes - (VAULT_CAP_BYTES * 2));

    // 2. Supabase Database (500 MB Free Tier for journals, essays, comments & tables)
    const SUPABASE_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB
    let entriesTextBytes = 0;
    let journalCount = 0;
    let writingCount = 0;
    let photoCount = 0;
    let updateCount = 0;

    for (const e of entriesRows) {
      const len = Buffer.byteLength((e.title || '') + (e.content || '') + (e.excerpt || ''), 'utf8');
      entriesTextBytes += len;
      if (e.type === 'photo') photoCount++;
      else if (e.type === 'writing') writingCount++;
      else if (e.type === 'update') updateCount++;
      else journalCount++;
    }

    const commentsTextBytes = commentsRows.reduce(
      (sum, c) => sum + Buffer.byteLength((c.content || '') + (c.author_name || ''), 'utf8'),
      0
    );
    const dbEstimatedBytes = entriesTextBytes + commentsTextBytes + (mediaRows.length * 160) + (entriesRows.length * 240) + (commentsRows.length * 120) + (reactionsCount * 100);

    res.json({
      b2: {
        totalAllocatedBytes: B2_TOTAL_BYTES,
        usedBytes: totalMediaBytes,
        percentUsed: Number(((totalMediaBytes / B2_TOTAL_BYTES) * 100).toFixed(2)),
        fileCount: mediaRows.length,
        vaults: [
          {
            id: 'media1',
            name: 'Account 1: Visuals Pool 1',
            bucket: 'q04ti-media-1',
            allocatedBytes: VAULT_CAP_BYTES,
            usedBytes: vault1Usage,
            isFull: vault1Usage >= (9.5 * 1024 * 1024 * 1024)
          },
          {
            id: 'media2',
            name: 'Account 2: Visuals Pool 2',
            bucket: 'q04ti-media-2',
            allocatedBytes: VAULT_CAP_BYTES,
            usedBytes: vault2Usage,
            isFull: vault2Usage >= (9.5 * 1024 * 1024 * 1024)
          },
          {
            id: 'journal',
            name: 'Account 3: Writing & Vault',
            bucket: 'q04ti-blog',
            allocatedBytes: VAULT_CAP_BYTES,
            usedBytes: vault3Usage,
            isFull: vault3Usage >= (9.5 * 1024 * 1024 * 1024)
          }
        ]
      },
      supabase: {
        totalAllocatedBytes: SUPABASE_TOTAL_BYTES,
        usedBytes: dbEstimatedBytes,
        percentUsed: Number(((dbEstimatedBytes / SUPABASE_TOTAL_BYTES) * 100).toFixed(2)),
        breakdown: {
          entriesCount: entriesRows.length,
          journalCount,
          writingCount,
          photoCount,
          updateCount,
          entriesBytes: entriesTextBytes,
          commentsCount: commentsRows.length,
          commentsBytes: commentsTextBytes,
          reactionsCount,
          mediaRowsCount: mediaRows.length
        }
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Multipart Media Upload Endpoint (Admin Only)
app.post('/api/media/upload', async (req, res) => {
  const auth = await verifyAdminUser(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ error: auth.error });
  }

  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
      }
      const file = req.file;

      if (isB2Configured()) {
        const resolvedVault = req.body?.targetVault || (req.body?.category === 'journal' || req.body?.category === 'writing' ? 'journal' : 'visuals');
        const b2Result = await uploadToB2(file.buffer, file.originalname, file.mimetype, resolvedVault);
        const mediaRow = {
          filename: path.basename(b2Result.storageKey),
          original_name: file.originalname,
          mime_type: file.mimetype,
          size: file.size,
          url: b2Result.storageKey
        };

        const { data, error } = await getSupabaseClient(req)
          .from('media')
          .insert([mediaRow])
          .select('*')
          .single();

        if (error) throw error;

        return res.status(201).json({
          ...data,
          signed_url: b2Result.signedUrl,
          vault: resolvedVault
        });
      } else {
        return res.status(500).json({ error: 'Backblaze B2 credentials missing in server environment.' });
      }
    } catch (uploadErr) {
      res.status(500).json({ error: uploadErr.message });
    }
  });
});

// Confirm Media Upload (Validates magic bytes & records DB row - Admin Only)
app.post('/api/media/confirm', async (req, res) => {
  const auth = await verifyAdminUser(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ error: auth.error });
  }

  try {
    const { storageKey, originalName, mimeType, sizeBytes, publicUrl, bucket } = req.body;
    if (!storageKey || !originalName || !mimeType) {
      return res.status(400).json({ error: 'storageKey, originalName, and mimeType required.' });
    }

    // Verify magic bytes of uploaded object (in the bucket it landed in)
    await verifyB2UploadedFile(storageKey, originalName, mimeType, typeof bucket === 'string' ? bucket : undefined);

    const _signedUrl = publicUrl || await getB2SignedUrl(storageKey, 86400);

    const mediaData = {
      filename: path.basename(storageKey),
      original_name: originalName,
      mime_type: mimeType,
      size: sizeBytes || 0,
      url: storageKey
    };

    const { data, error } = await getSupabaseClient(req)
      .from('media')
      .insert(mediaData)
      .select('*')
      .single();

    if (error) throw error;

    // Return the permanent proxy URL instead of a raw signed URL
    const proxyUrl = `/api/media/file/${storageKey}`;
    res.status(201).json({ success: true, media: data, proxy_url: proxyUrl });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// DELETE /api/media/:id (Admin Only)
app.delete('/api/media/:id', async (req, res) => {
  const auth = await verifyAdminUser(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ error: auth.error });
  }

  try {
    const { id } = req.params;
    const { data: item } = await getSupabaseClient(req)
      .from('media')
      .select('*')
      .eq('id', id)
      .single();

    if (item && item.url) {
      const key = extractB2StorageKey(item.url) || item.url;
      await deleteFromB2(key);
    }

    const { error } = await getSupabaseClient(req)
      .from('media')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/posts/:id/reactions
app.get('/api/posts/:id/reactions', async (req, res) => {
  try {
    const { id } = req.params;

    const target = await resolveEngagementTarget(req, id);
    if (!target.postId) return res.status(target.status).json({ error: target.error });
    const postId = target.postId;

    const { data: reactions, error } = await getSupabaseClient(req)
      .from('reactions')
      .select('reaction_type')
      .eq('post_id', postId);

    if (error && error.code !== 'PGRST116') throw error;

    // Same buttons the site shows (and POST counts): thoughtful / loved /
    // boring / dislike. cozy / inspiring stay for older stored rows.
    const counts = { thoughtful: 0, loved: 0, boring: 0, dislike: 0, cozy: 0, inspiring: 0 };
    (reactions || []).forEach(r => {
      if (counts[r.reaction_type] !== undefined) {
        counts[r.reaction_type]++;
      }
    });

    res.json({
      ...counts,
      hearts: (reactions || []).length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/posts/:id/reactions
app.post('/api/posts/:id/reactions', async (req, res) => {
  try {
    const { id } = req.params;
    const rawType = req.body.reaction_type || req.body.type || 'loved';
    const reaction_type = rawType === 'heart' ? 'loved' : rawType;

    // The site's buttons are thoughtful / loved / boring / dislike (the
    // live database accepts these). 'boring' and 'dislike' used to be
    // rejected here, so those clicks fell back to a direct browser insert
    // that skipped this route's rate limit and live broadcast. cozy and
    // inspiring stay accepted for older clients.
    const VALID_REACTIONS = ['thoughtful', 'loved', 'boring', 'dislike', 'cozy', 'inspiring'];
    if (!VALID_REACTIONS.includes(reaction_type)) {
      return res.status(400).json({ error: 'Invalid reaction type.' });
    }

    const target = await resolveEngagementTarget(req, id, req.body.passcode);
    if (!target.postId) return res.status(target.status).json({ error: target.error });
    const postId = target.postId;

    const { error } = await getSupabaseClient(req)
      .from('reactions')
      .insert([{ post_id: postId, reaction_type }]);

    if (error) throw error;

    const { data: allReactions } = await getSupabaseClient(req)
      .from('reactions')
      .select('reaction_type')
      .eq('post_id', postId);

    const updatedCounts = { thoughtful: 0, loved: 0, boring: 0, dislike: 0 };
    (allReactions || []).forEach(r => {
      if (updatedCounts[r.reaction_type] !== undefined) {
        updatedCounts[r.reaction_type]++;
      }
    });

    // Broadcast BEFORE responding: on Vercel the function can be frozen as
    // soon as the response is sent, which silently dropped this notice and
    // other readers never saw the reaction.
    await settleBroadcast('reaction_updated', {
      postId,
      reaction_type,
      counts: updatedCounts
    });

    res.json({
      success: true,
      ...updatedCounts,
      hearts: (allReactions || []).length
    });
  } catch (err) {
    if (err.message && /rate limit exceeded/i.test(err.message)) {
      return res.status(429).json({ error: "You're reacting too fast. Try again in a few minutes." });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/posts/:id/comments
app.get('/api/posts/:id/comments', async (req, res) => {
  try {
    const { id } = req.params;
    const target = await resolveEngagementTarget(req, id);
    if (!target.postId) return res.status(target.status).json({ error: target.error });
    const postId = target.postId;

    const { data: comments, error } = await getSupabaseClient(req)
      .from('comments')
      .select('*')
      .eq('post_id', postId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json(comments || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/posts/:id/comments
app.post('/api/posts/:id/comments', async (req, res) => {
  try {
    const { id } = req.params;
    const { author_name, content, passcode } = req.body;

    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Comment text cannot be empty.' });
    }

    // Strip HTML tags from plain-text fields — comments are plain text, never markup.
    // React JSX already escapes on render, but we clean at the door so stored data is unambiguous.
    const rawName = author_name && typeof author_name === 'string' && author_name.trim() ? stripHtmlTags(author_name).trim() : '';
    const rawContent = stripHtmlTags(content).trim();

    if (!rawContent) {
      return res.status(400).json({ error: 'Comment text cannot be empty.' });
    }
    if (rawContent.length > 2000) {
      return res.status(400).json({ error: 'Comment must be 2000 characters or fewer.' });
    }
    if (rawName && rawName.length > 100) {
      return res.status(400).json({ error: 'Author name must be 100 characters or fewer.' });
    }

    const target = await resolveEngagementTarget(req, id, passcode);
    if (!target.postId) return res.status(target.status).json({ error: target.error });
    const postId = target.postId;

    const name = rawName || 'Anonymous Reader';

    const { data, error } = await getSupabaseClient(req)
      .from('comments')
      .insert([{ post_id: postId, author_name: name, content: rawContent }])
      .select('*')
      .single();

    if (error) throw error;

    await settleBroadcast('comment_created', {
      op: 'INSERT',
      postId,
      comment: data
    });

    res.status(201).json(data);
  } catch (err) {
    if (err.message && /rate limit exceeded/i.test(err.message)) {
      return res.status(429).json({ error: "You're posting too fast. Try again in a few minutes." });
    }
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/comments/:id (Admin Only)
app.delete('/api/comments/:id', async (req, res) => {
  const auth = await verifyAdminUser(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ error: auth.error });
  }

  try {
    const { id } = req.params;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    if (!isUuid) {
      return res.status(400).json({ error: 'Invalid UUID format.' });
    }

    const client = getSupabaseClient(req);
    const { data, error } = await client
      .from('comments')
      .delete()
      .eq('id', id)
      .select('id');

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Comment not found or delete not permitted.' });
    }

    await settleBroadcast('comment_deleted', {
      op: 'DELETE',
      commentId: data[0].id
    });

    res.json({ success: true, deleted_id: data[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Music Status (Now Playing) Endpoints
app.post('/api/now-playing', express.json(), async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const expectedSecret = process.env.METROLIST_WEBHOOK_SECRET;
    
    // Timing-safe authorization check to prevent side-channel timing attacks
    const expectedHeader = `Bearer ${expectedSecret || ''}`;
    const authBuffer = Buffer.from(authHeader || '');
    const expectedBuffer = Buffer.from(expectedHeader);

    if (!expectedSecret || authBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(authBuffer, expectedBuffer)) {
      return res.status(401).json({ error: 'Unauthorized. Invalid or missing secret.' });
    }

    const { title, artist, album, isPaused, progress, coverUrl } = req.body;

    // The music app sends an EMPTY track when playback stops or the app
    // closes. Saving that blank wiped the last song and the card read
    // "last listened to Nothing playing". A stop now keeps the last song and
    // only marks it paused, so the card shows "last listened to <song>".
    const hasTrack = typeof title === 'string' && title.trim() !== '';
    const trackData = hasTrack
      ? {
          title,
          artist,
          album,
          is_paused: isPaused,
          progress,
          cover_url: coverUrl,
          updated_at: new Date().toISOString()
        }
      : {
          is_paused: true,
          updated_at: new Date().toISOString()
        };

    const { data: updatedRows, error } = await supabase
      .from('now_playing')
      .update(trackData)
      .eq('id', 1)
      .select('id');

    if (error) {
      console.error('Failed to update now_playing:', error);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!updatedRows || updatedRows.length === 0) {
      // The singleton row is missing: an update alone would silently affect
      // zero rows and the track would never appear. Recreate the row so the
      // webhook self-heals instead of the card staying stale forever.
      const { error: insertError } = await supabase
        .from('now_playing')
        .insert({ id: 1, ...trackData, show_on_home: true });
      if (insertError) {
        console.error('Failed to insert now_playing row:', insertError);
        return res.status(500).json({ error: 'Database error' });
      }
    }

    await settleBroadcast('now_playing_updated', hasTrack
      ? { title, artist, album, isPaused }
      : { isPaused: true }, supabase);

    res.json({ success: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/now-playing', async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  try {
    const supabase = getSupabaseClient(req);
    const { data, error } = await supabase
      .from('now_playing')
      .select('*')
      .eq('id', 1)
      .single();

    if (error && error.code !== 'PGRST116') {
      // A real read failure is not "music is off": report it so clients keep
      // their last known state instead of hiding the card on a transient
      // error (the old code returned showOnHome:false for any failure).
      return res.status(500).json({ error: 'Failed to load music status.' });
    }
    if (!data) {
      return res.json({ playing: false, showOnHome: false });
    }

    // Check if it's currently active (updated within the last 5 minutes)
    const lastUpdate = data.updated_at ? new Date(data.updated_at).getTime() : 0;
    const isOffline = !lastUpdate || isNaN(lastUpdate) || (Date.now() - lastUpdate > 5 * 60 * 1000);

    res.json({
      playing: !isOffline, // True if recently updated
      isPaused: data.is_paused || isOffline, // Treat offline as paused so frontend shows 'last listened to'
      title: data.title,
      artist: data.artist,
      album: data.album,
      progress: data.progress,
      coverUrl: data.cover_url,
      updatedAt: data.updated_at,
      showOnHome: data.show_on_home
    });
  } catch (_err) {
    res.status(500).json({ error: 'Internal server error' });
  }

});

// Admin endpoint to toggle Now Playing on Home
app.post('/api/now-playing/toggle', express.json(), async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const adminId = (process.env.ADMIN_USER_ID || process.env.VITE_ADMIN_USER_ID || '').trim().toLowerCase();
    if (!adminId) return res.status(500).json({ error: 'Config missing' });

    // Quick admin token verification (matches post edit auth)
    // Here we'll just check if the bearer token is valid by querying Supabase
    const supabase = getSupabaseClient(req);
    const { data: userAuth, error: authError } = await supabase.auth.getUser(authHeader?.split(' ')[1] || '');

    if (authError || (userAuth?.user?.id || '').trim().toLowerCase() !== adminId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { showOnHome } = req.body;
    
    const { error } = await supabase
      .from('now_playing')
      .update({ show_on_home: showOnHome })
      .eq('id', 1);

    if (error) throw error;
    try {
      await settleBroadcast('now_playing_updated', { showOnHome }, supabase);
    } catch {}
    res.json({ success: true, showOnHome });
  } catch (err) {
    console.error('Toggle error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

let cachedDefaultTheme = null;
let cachedShowViews = null;

export function setCachedDefaultTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    cachedDefaultTheme = theme;
  }
}

export function setCachedShowViews(show) {
  if (typeof show === 'boolean') {
    cachedShowViews = show;
  }
}

export async function getEffectiveShowViews(supabase) {
  // Always read the setting fresh: a short-lived cache here kept serving the
  // previous value for seconds after the admin flipped it, so hidden counts
  // leaked into API responses (and, via serveInjectedHtml, into first paint).
  // The cache remains only as the fallback when the read itself fails.
  try {
    const { data: syncRow } = await supabase
      .from('realtime_sync')
      .select('payload')
      .eq('id', 'site_settings')
      .maybeSingle();
    if (syncRow?.payload && typeof syncRow.payload.show_view_count === 'boolean') {
      cachedShowViews = syncRow.payload.show_view_count;
      return cachedShowViews;
    }
    const { data: aboutRow } = await supabase
      .from('about')
      .select('show_view_count')
      .limit(1);
    if (aboutRow && aboutRow[0] && typeof aboutRow[0].show_view_count === 'boolean') {
      cachedShowViews = aboutRow[0].show_view_count;
      return cachedShowViews;
    }
  } catch {}
  return cachedShowViews !== null ? cachedShowViews : true;
}

// Serve application HTML with injected site default theme and view count visibility to guarantee zero flash
async function serveInjectedHtml(req, res, extraHead = '', pageMeta = null) {
  let html = '';
  try {
    html = fs.readFileSync(path.join(process.cwd(), 'dist', 'index.html'), 'utf8');
  } catch (_e) {
    try {
      html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
    } catch (_e2) {
      try {
        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const host = req.headers.host;
        const htmlRes = await fetch(`${protocol}://${host}/_static_shell`);
        if (htmlRes.ok) html = await htmlRes.text();
      } catch (_e3) {}
    }
  }

  if (!html) return res.status(500).send('Unable to load application shell.');

  let defaultTheme = null;
  const supabase = getSupabaseClient(req);

  // Always resolve the default theme fresh from the settings store. The old
  // code trusted a seconds-old instance cache here, so the first page loads
  // right after the admin changed the default were injected with the PREVIOUS
  // theme — a dark flash on a light-default site (and vice versa) until the
  // client's own fetch corrected it. The cache is now only the fallback for a
  // lookup that cannot complete in the bounded window.
  try {
    const queryPromise = (async () => {
      const { data: syncRow } = await supabase
        .from('realtime_sync')
        .select('payload')
        .eq('id', 'site_settings')
        .maybeSingle();
      if (syncRow?.payload?.default_theme === 'light' || syncRow?.payload?.default_theme === 'dark') {
        return syncRow.payload.default_theme;
      }
      const { data: aboutRow } = await supabase
        .from('about')
        .select('default_theme')
        .limit(1);
      if (aboutRow && aboutRow[0] && (aboutRow[0].default_theme === 'light' || aboutRow[0].default_theme === 'dark')) {
        return aboutRow[0].default_theme;
      }
      return null;
    })();

    let resolved = await Promise.race([
      queryPromise,
      new Promise(resolve => setTimeout(() => resolve(null), 800))
    ]);
    if (resolved !== 'light' && resolved !== 'dark') {
      // Bounded extra window (the same query promise is reused, so a slow
      // cold-start lookup still lands) rather than injecting a stale theme.
      resolved = await Promise.race([
        queryPromise,
        new Promise(resolve => setTimeout(() => resolve(null), 2200))
      ]);
    }
    if (resolved === 'light' || resolved === 'dark') {
      defaultTheme = resolved;
      cachedDefaultTheme = resolved;
    }
  } catch {}

  if (!defaultTheme) defaultTheme = cachedDefaultTheme || 'light';

  // Bound every settings lookup so a stalled database can never hang page HTML
  const bounded = (promise, fallback, ms = 2000) => Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms))
  ]);

  // The fallback must never fabricate "show": when the setting cannot be
  // read in time, reuse the last known value, and if none is known keep the
  // counts out of the first paint rather than flashing counts the admin
  // turned off (the old fallback of `true` did exactly that on slow reads).
  const effectiveShowViews = await bounded(
    getEffectiveShowViews(supabase),
    cachedShowViews !== null ? cachedShowViews : false,
    3000
  );

  // Inject theme and view count attributes directly into <html> to guarantee ZERO flash
  html = html.replace(/<html([^>]*)>/i, (m, attrs) => {
    const clean = attrs
      .replace(/\s*data-theme-injected=["'][^"']*["']/gi, '')
      .replace(/\s*data-show-views-injected=["'][^"']*["']/gi, '')
      .replace(/\s*class=["'][^"']*["']/gi, '');
    const showViewsAttr = ` data-show-views-injected="${effectiveShowViews ? 'true' : 'false'}"`;
    if (defaultTheme === 'dark') {
      return `<html${clean} class="dark" data-theme-injected="dark"${showViewsAttr}>`;
    } else {
      return `<html${clean} class="" data-theme-injected="light"${showViewsAttr}>`;
    }
  });

  let authorName = 'q04ti';
  try {
    authorName = await bounded((async () => {
      const { data: syncRow } = await supabase
        .from('realtime_sync')
        .select('payload')
        .eq('id', 'site_settings')
        .maybeSingle();
      if (syncRow?.payload?.author_name && syncRow.payload.author_name.trim()) {
        return syncRow.payload.author_name.trim();
      }
      return 'q04ti';
    })(), 'q04ti');
  } catch {}

  if (authorName && authorName !== 'q04ti') {
    html = html.replace(/<title>q04ti\s*—/i, `<title>${authorName} —`);
  }

  if (pageMeta) {
    const esc = (str) => String(str || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
    if (pageMeta.title) html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(pageMeta.title)}</title>`);
    if (pageMeta.description) html = html.replace(/<meta name="description"[^>]*>/i, `<meta name="description" content="${esc(pageMeta.description)}" />`);
  }

  const syncScript = `<script>window.__SITE_SHOW_VIEWS__=${effectiveShowViews ? 'true' : 'false'};window.__SITE_AUTHOR_NAME__=${JSON.stringify(authorName)};</script>`;
  if (extraHead) {
    html = html.replace('</head>', `${syncScript}${extraHead}</head>`);
  } else {
    html = html.replace('</head>', `${syncScript}</head>`);
  }

  // Remember the injected default in a cookie so the pre-paint script can
  // apply it instantly on later loads even when a shell is served without
  // injection (the cookie persists for the session in private windows too).
  res.setHeader('Set-Cookie', `site_default_theme=${defaultTheme}; Path=/; Max-Age=31536000; SameSite=Lax`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  return res.send(html);
}

// SSR for Open Graph (OG) tags on /entry/:slug (Link Previews for WhatsApp, Twitter, etc.)
app.get('/entry/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const { data: posts } = await getSupabaseClient(req)
      .from('public_published_entries')
      .select('id, title, excerpt, cover_image, has_passcode')
      .eq('slug', slug);

    const post = posts && posts[0];
    let ogTags = '';
    if (post && !post.has_passcode) {
      const escapeHtml = (str) => String(str || '').replace(/[&<>"']/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[match]);
      const title = escapeHtml(post.title || 'Untitled');
      const excerpt = escapeHtml(post.excerpt || 'Personal diary entry');
      let image = post.cover_image ? escapeHtml(post.cover_image) : '';
      if (image && !image.startsWith('http')) {
        if (image.includes('backblazeb2.com') || image.startsWith('images/')) {
          const match = image.match(/(?:images|videos|audio|files)\/(?:[a-zA-Z0-9_\-./% ]+)\.[a-zA-Z0-9]+/i);
          if (match) image = `/api/media/file/${match[0]}`;
        }
        image = `https://${req.headers.host}${image}`;
      }
      const pageUrl = `https://${req.headers.host}/entry/${encodeURIComponent(slug)}`;
      ogTags = `
        <link rel="canonical" href="${pageUrl}" />
        <meta property="og:url" content="${pageUrl}" />
        <meta property="og:site_name" content="q04ti" />
        <meta property="og:title" content="${title}" />
        <meta property="og:description" content="${excerpt}" />
        ${image ? `<meta property="og:image" content="${image}" />` : ''}
        <meta property="og:type" content="article" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="${title}" />
        <meta name="twitter:description" content="${excerpt}" />
        ${image ? `<meta name="twitter:image" content="${image}" />` : ''}
      `;
    }
    // The post's own <title> and description in the HTML itself (not only
    // after the app's JavaScript runs), for search engines, browser tabs
    // and link previews that read the plain HTML.
    const pageMeta = post && !post.has_passcode ? {
      title: `${post.title || 'Untitled'} — q04ti`,
      description: post.excerpt || ''
    } : null;
    return serveInjectedHtml(req, res, ogTags, pageMeta);
  } catch (err) {
    console.error('OG Tag Error:', err);
    return res.redirect(`/?entry=${req.params.slug}`);
  }
});

// RSS feed (/rss.xml): published, non-locked posts, newest first.
app.get(['/rss.xml', '/feed.xml', '/api/rss.xml'], async (req, res) => {
  const esc = (str) => String(str || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);
  const origin = `https://${req.headers.host || 'blog.q04ti.dev'}`;
  let items = '';
  try {
    const { data: posts } = await getSupabaseClient(req)
      .from('public_published_entries')
      .select('id, slug, title, excerpt, date, created_at, has_passcode, type')
      .order('date', { ascending: false })
      .limit(50);
    items = (posts || [])
      .filter(p => !p.has_passcode && p.slug)
      .map(p => {
        const link = `${origin}/entry/${encodeURIComponent(p.slug)}`;
        const when = new Date(p.date || p.created_at || Date.now()).toUTCString();
        return `    <item>
      <title>${esc(p.title || 'Untitled')}</title>
      <link>${esc(link)}</link>
      <guid isPermaLink="false">${esc(p.id)}</guid>
      <pubDate>${when}</pubDate>
      <description>${esc(p.excerpt || '')}</description>
    </item>`;
      }).join('\n');
  } catch (err) {
    console.error('RSS generation failed:', err.message);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>q04ti</title>
    <link>${origin}/</link>
    <atom:link href="${origin}/rss.xml" rel="self" type="application/rss+xml" />
    <description>Journal, writing &amp; archive.</description>
    <language>en</language>
${items}
  </channel>
</rss>`;
  res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300');
  return res.send(xml);
});

// SITEMAP & ROBOTS.TXT
app.get(['/sitemap.xml', '/api/sitemap.xml'], async (req, res) => {
  try {
    const { data: posts } = await getSupabaseClient(req)
      .from('public_published_entries')
      .select('id, slug, has_passcode, is_protected, show_in_feed, updated_at, date, created_at')
      .order('date', { ascending: false });


    const xml = generateSitemapXml(posts || []);
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    return res.send(xml);
  } catch (err) {
    console.error('Error generating sitemap:', err);
    const xml = generateSitemapXml([]);
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    return res.send(xml);
  }
});

app.get(['/robots.txt', '/api/robots.txt'], (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.send(getRobotsTxt());
});

// Catch-all SPA route handler for all non-API HTML routes with zero theme flash
app.get(/^(?!\/api).*/, async (req, res) => {
  return serveInjectedHtml(req, res);
});

export default app;


/* global CustomEvent */
import { createClient } from '@supabase/supabase-js';

const defaultUrl = 'https://aidajlxmfxhmsctmciaq.supabase.co';
const metaEnv = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env : (process?.env || {});
const supabaseUrl = metaEnv.VITE_SUPABASE_URL || defaultUrl;
const supabaseAnonKey = metaEnv.VITE_SUPABASE_ANON_KEY || '';

let client;
try {
  client = createClient(supabaseUrl, supabaseAnonKey || 'placeholder-anon-key');
} catch (err) {
  console.warn('Supabase client fallback:', err.message);
  client = createClient(defaultUrl, 'placeholder-anon-key');
}

export const supabase = client;

// In-memory SWR cache for zero-delay instant page navigation
const entriesCache = new Map();
const feedsCache = new Map();

// Last feed-fetch outcome. fetchPublishedEntries never throws: it falls
// back to Supabase, then to the saved feed cache. Callers therefore cannot
// tell a failed refresh from a genuinely empty blog from the return value
// alone. This flag is set synchronously inside fetchPublishedEntries just
// before it returns, so a caller that awaits it and reads the getter
// immediately afterwards sees its own fetch's outcome.
let lastFeedFetchFailed = false;
export function getLastFeedFetchFailed() { return lastFeedFetchFailed; }

// Feed cache TTL: a locally saved feed list is a fallback, not fresh data.
// Saves are stamped; a list older than this is shown only as a "saved
// copy" when a live refresh fails (see isFeedCacheStale / useFeedData).
export const FEED_CACHE_TTL_MS = 10 * 60 * 1000;
const feedCacheMeta = new Map(); // cacheKey -> { savedAt }

export function getCachedEntry(slugOrId) {
  if (!slugOrId) return null;
  return entriesCache.get(slugOrId) || null;
}

// Versioned-entry state. Replaces the old sticky ?rtb= generation token,
// which made EVERY fetch in a session bypass the edge cache after a
// single edit (that was the "site loads slow again" regression).
// A version is an entry's updated_at. A versioned URL's content never
// changes, so the edge may serve it long — but bodies embed B2 signed
// URLs that expire after 24h, so the server caps versioned caching at
// 10 minutes (see versionedCacheHeader in api/index.js / server/index.js).
// Versions learned from realtime events survive cache clears on purpose:
// invalidateFeedCache wipes the entry/feed caches but NOT this map, so
// the next fetch after an edit asks for the NEW version instead of
// falling back to a plain short-cache URL. But that only holds when the
// invalidation actually carried a new version: an invalidation WITHOUT
// one (the sync-check fallback, a resync, a CDC change) RESETS the known
// versions (see invalidateFeedCache), so the next fetch goes out plain
// and cannot keep asking for a stale versioned URL for an hour.
const entryVersions = new Map(); // key: slug or id -> updated_at (ISO string)
let listVersion = null; // newest updated_at known across entries
function versionTime(v) { const t = Date.parse(v); return Number.isFinite(t) ? t : 0; }
export function noteEntryVersion(slug, updatedAt, id) {
  if (!updatedAt) return;
  if (slug) entryVersions.set(slug, updatedAt);
  if (id) entryVersions.set(id, updatedAt);
  if (!listVersion || versionTime(updatedAt) > versionTime(listVersion)) listVersion = updatedAt;
}
export function noteListVersions(items) {
  if (!Array.isArray(items)) return;
  items.forEach(item => { if (item) noteEntryVersion(item.slug, item.updated_at, item.id); });
}
export function getEntryVersion(slug) { return entryVersions.get(slug) || null; }
export function forgetEntryVersion(slug, id) {
  if (slug) entryVersions.delete(slug);
  if (id) entryVersions.delete(id);
}
// After a delete / resync the next list request carries a unique marker
// (?r=…), so it can never be answered by any cached copy (CDN or browser)
// taken before the change. Cleared once a fresh list has been received.
let listBust = null;
export function forgetAllEntryVersions() {
  entryVersions.clear();
  listVersion = null;
  listBust = String(Date.now());
}

// Display snapshots: what the reader last saw, kept across invalidations.
// invalidateFeedCache still clears the real caches (so every fetch after a
// realtime event is fresh), but pages mounting in the gap before that fetch
// lands paint the last-seen copy instead of a blank skeleton — the skeleton
// is only for genuinely never-loaded data. Pages always fetch on mount and
// on 'feed-data-invalidated', so a snapshot is on screen only until the
// fresh data replaces it. Deleted entries are dropped from snapshots at once.
const feedSnapshots = new Map(); // cacheKey -> list
const entrySnapshots = new Map(); // slug or id -> entry
function snapshotCurrentCaches() {
  for (const [key, list] of feedsCache.entries()) {
    if (Array.isArray(list) && list.length > 0) feedSnapshots.set(key, list);
  }
  try {
    ['home', 'all', 'journal', 'writing', 'photo', 'update'].forEach((k) => {
      if (feedSnapshots.has(k) && feedsCache.has(k)) return;
      const parsed = parseFeedCache(localStorage.getItem(`feed_cache_${k}`));
      if (parsed && parsed.items.length > 0 && !feedsCache.has(k)) feedSnapshots.set(k, parsed.items);
    });
  } catch {}
  for (const [key, entry] of entriesCache.entries()) {
    if (!entry) continue;
    const prev = entrySnapshots.get(key);
    // Never replace a snapshot that has the body with a body-less copy.
    const hasBody = typeof entry.content === 'string' && entry.content !== '';
    const prevHasBody = prev && typeof prev.content === 'string' && prev.content !== '';
    if (hasBody || !prevHasBody) entrySnapshots.set(key, entry);
  }
}
export function getFeedSnapshot(cacheKey = 'all') {
  const list = feedSnapshots.get(cacheKey) || (cacheKey !== 'home' && cacheKey !== 'all'
    ? (feedSnapshots.get('home') || feedSnapshots.get('all'))
    : null);
  return Array.isArray(list) && list.length > 0 ? list : null;
}
export function getEntrySnapshot(slugOrId) {
  if (!slugOrId) return null;
  return entrySnapshots.get(slugOrId) || null;
}
export function dropFromSnapshots(slug, id) {
  const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase());
  const keys = [norm(slug), norm(id)].filter(Boolean);
  if (keys.length === 0) return;
  for (const [k, entry] of [...entrySnapshots.entries()]) {
    if (keys.includes(norm(k)) || (entry && (keys.includes(norm(entry.id)) || keys.includes(norm(entry.slug))))) {
      entrySnapshots.delete(k);
    }
  }
  for (const [k, list] of [...feedSnapshots.entries()]) {
    if (!Array.isArray(list)) continue;
    feedSnapshots.set(k, list.filter((e) => !(e && (keys.includes(norm(e.id)) || keys.includes(norm(e.slug))))));
  }
}

export function invalidateFeedCache({ keepVersions = false } = {}) {
  snapshotCurrentCaches();
  // Default: forget known versions. A versioned fetch is only safe when
  // the client KNOWS the version is current; after an invalidation that
  // carried no new version, the known ones may be stale, and re-requesting
  // them would serve the old cached body for up to the versioned TTL.
  // Callers that just learned a new version pass { keepVersions: true }.
  if (!keepVersions) forgetAllEntryVersions();
  feedsCache.clear();
  entriesCache.clear();
  feedCacheMeta.clear();
  try {
    const keys = ['home', 'all', 'journal', 'writing', 'photo', 'update'];
    keys.forEach(k => localStorage.removeItem(`feed_cache_${k}`));
  } catch {}

  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent('feed-data-invalidated'));
    } catch {}
  }
}

// The realtime watcher receives raw table rows, while the caches hold API
// responses — the same entry in two different representations (signed vs
// raw image URLs, bigint counts delivered as strings, JSON fields
// re-encoded). Diffing the two forms field-by-field kept missing some
// representation difference and wiping every cache on plain view bumps.
// So UPDATEs no longer diff at all: an entries UPDATE patches the cached
// view count and nothing else. Real content changes still invalidate in
// full — edits made through the site arrive via the API's own
// entry_updated / entry_created / entry_deleted broadcasts (see
// utils/realtime.js), and INSERT / DELETE changes from any writer still
// invalidate here.
export function entryRowViews(row) {
  // The new view count from a change payload, as a number. The CDC stream
  // delivers bigint columns as strings, so coerce instead of type-checking.
  if (!row || typeof row !== 'object') return null;
  const v = Number(row.views);
  return Number.isFinite(v) ? v : null;
}

// Single entry point for entries-table realtime changes (used by the
// postgres_changes subscription below; exported for verification).
export function handleEntriesTableChange(payload) {
  if (payload && payload.eventType === 'UPDATE') {
    const row = payload.new;
    const views = entryRowViews(row);
    if (views !== null && row && (row.id || row.slug)) {
      updateCachedEntryViews(row.id, row.slug, views);
      if (typeof window !== 'undefined') {
        try {
          window.dispatchEvent(new CustomEvent('entry-views-updated', { detail: { id: row.id, slug: row.slug, views } }));
        } catch {}
      }
      return;
    }
  }
  invalidateFeedCache();
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent('feed-data-invalidated', { detail: payload }));
    } catch {}
  }
}

// Saved feed lists are stored as { v: 1, savedAt, items }. Older saves (and
// the offline tests' mocks) are bare arrays; those have no stamp and are
// treated as saved at epoch 0, i.e. stale.
function parseFeedCache(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { items: parsed, savedAt: 0 };
    if (parsed && Array.isArray(parsed.items)) {
      return {
        items: parsed.items,
        savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0
      };
    }
  } catch {}
  return null;
}

function persistFeedCache(cacheKey, list, savedAt = Date.now()) {
  feedCacheMeta.set(cacheKey, { savedAt });
  try {
    localStorage.setItem(`feed_cache_${cacheKey}`, JSON.stringify({ v: 1, savedAt, items: list }));
  } catch {}
}

// When the saved list was last written, as an epoch-ms timestamp, or null
// when there is no saved list for the key.
export function getFeedCacheSavedAt(typeKey = 'all') {
  const meta = feedCacheMeta.get(typeKey);
  if (meta) return meta.savedAt;
  try {
    const parsed = parseFeedCache(localStorage.getItem(`feed_cache_${typeKey}`));
    if (parsed) {
      feedCacheMeta.set(typeKey, { savedAt: parsed.savedAt });
      return parsed.savedAt;
    }
  } catch {}
  return null;
}

// True when a saved list exists for the key and it is older than the TTL.
export function isFeedCacheStale(typeKey = 'all') {
  const savedAt = getFeedCacheSavedAt(typeKey);
  if (savedAt === null) return false;
  return Date.now() - savedAt > FEED_CACHE_TTL_MS;
}

export function getCachedFeed(typeKey = 'all') {
  if (feedsCache.has(typeKey)) return feedsCache.get(typeKey);
  try {
    const parsed = parseFeedCache(localStorage.getItem(`feed_cache_${typeKey}`));
    if (parsed && Array.isArray(parsed.items) && parsed.items.length > 0) {
      feedCacheMeta.set(typeKey, { savedAt: parsed.savedAt });
      feedsCache.set(typeKey, parsed.items);
      return parsed.items;
    }
  } catch {}

  // Fallback: If a specific section feed (like 'journal', 'writing', 'photo', 'update') is not yet cached independently,
  // derive it instantly from 'home' or 'all' feed cache for 0ms instant section page navigation
  if (typeKey !== 'all' && typeKey !== 'home') {
    let parentSavedAt = feedCacheMeta.get('home')?.savedAt ?? feedCacheMeta.get('all')?.savedAt;
    const parentCache = feedsCache.get('home') || feedsCache.get('all') || (() => {
      try {
        let rawHome = localStorage.getItem('feed_cache_home');
        let parentKey = 'home';
        if (!rawHome) {
          rawHome = localStorage.getItem('feed_cache_all');
          parentKey = 'all';
        }
        if (!rawHome) return null;
        const parsed = parseFeedCache(rawHome);
        if (!parsed) return null;
        feedCacheMeta.set(parentKey, { savedAt: parsed.savedAt });
        if (parentSavedAt === undefined) parentSavedAt = parsed.savedAt;
        return parsed.items;
      } catch { return null; }
    })();

    if (Array.isArray(parentCache) && parentCache.length > 0) {
      let derived = parentCache;
      if (typeKey === 'journal') {
        derived = parentCache.filter(item => 
          item.type !== 'photo' &&
          item.type !== 'update' &&
          (!item.category || item.category.toLowerCase() !== 'photos')
        );
      } else if (typeKey === 'writing') {
        derived = parentCache.filter(item => 
          item.type === 'writing' || item.type === 'essay' ||
          (item.category && item.category.toLowerCase() === 'writing')
        );
      } else if (typeKey === 'photo') {
        derived = parentCache.filter(item => 
          item.type === 'photo' || 
          (item.category && item.category.toLowerCase() === 'photos')
        );
      } else if (typeKey === 'update') {
        derived = parentCache.filter(item => item.type === 'update');
      }

      if (Array.isArray(derived) && derived.length > 0) {
        if (typeof parentSavedAt === 'number') feedCacheMeta.set(typeKey, { savedAt: parentSavedAt });
        feedsCache.set(typeKey, derived);
        return derived;
      }
    }
  }

  return null;
}

export function cacheEntry(entry) {
  if (!entry) return;
  // Never let a content-less copy (a feed list item, e.g. from a silent
  // background refetch) downgrade a cached full copy that carries the body —
  // that is what made reopening a just-read entry wait on the network again.
  // Only the body is preserved; every other field takes the fresher value.
  // A copy whose content is present (fresh, or the redacted placeholder of a
  // locked entry) always replaces wholesale, exactly as before.
  const withPreservedContent = (incoming, key) => {
    const existing = key ? entriesCache.get(key) : null;
    if (
      existing &&
      typeof existing.content === 'string' && existing.content !== '' &&
      (typeof incoming.content !== 'string' || incoming.content === '')
    ) {
      return { ...incoming, content: existing.content };
    }
    return incoming;
  };
  if (entry.id) entriesCache.set(entry.id, withPreservedContent(entry, entry.id));
  if (entry.slug) entriesCache.set(entry.slug, withPreservedContent(entry, entry.slug));
}

export function updateCachedEntryViews(id, slug, views) {
  if (typeof views !== 'number') return;
  
  if (id && entriesCache.has(id)) {
    const item = entriesCache.get(id);
    if (item) item.views = views;
  }
  if (slug && entriesCache.has(slug)) {
    const item = entriesCache.get(slug);
    if (item) item.views = views;
  }

  for (const [key, feedList] of feedsCache.entries()) {
    if (Array.isArray(feedList)) {
      let changed = false;
      feedList.forEach(entry => {
        if ((id && entry.id === id) || (slug && entry.slug === slug)) {
          entry.views = views;
          changed = true;
        }
      });
      if (changed) {
        // Rewrite the saved list keeping its original stamp: a view-count
        // patch is not a fresh fetch, so it must not reset the TTL.
        persistFeedCache(key, feedList, getFeedCacheSavedAt(key) ?? Date.now());
      }
    }
  }
}


/**
 * Helper to safely fetch from API endpoints, returning null if 404/non-JSON
 */
// Identical plain GETs already in flight share one network request: a single
// realtime edit used to make every component showing an entry refetch it at
// the same moment (8 requests per viewer per save). Each caller still gets
// its own freshly parsed copy, so no one can mutate another's data.
const inflightGets = new Map();

async function fetchText(url, fetchOptions, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...fetchOptions, signal: controller.signal });
    if (!res.ok) return null;
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function safeApiFetch(url, options = {}) {
  try {
    const { timeout = 5000, ...fetchOptions } = options;
    const method = (fetchOptions.method || 'GET').toUpperCase();
    const shareable = method === 'GET' && !fetchOptions.body && !fetchOptions.headers && !fetchOptions.signal;
    let textPromise;
    // A request index.html started before the app loaded (home feed). Used
    // once, and only while fresh, so later refetches (realtime updates) always
    // go to the network.
    const early = shareable && typeof window !== 'undefined' && window.__earlyApi && window.__earlyApi[url];
    if (early) {
      delete window.__earlyApi[url];
      if (Date.now() - early.started < 15000) textPromise = early.promise.then(t => (t === null ? fetchText(url, fetchOptions, timeout) : t));
    }
    if (textPromise) {
      // reuse the early request
    } else if (shareable && inflightGets.has(url)) {
      textPromise = inflightGets.get(url);
    } else {
      textPromise = fetchText(url, fetchOptions, timeout);
      if (shareable) {
        inflightGets.set(url, textPromise);
        const clear = () => { if (inflightGets.get(url) === textPromise) inflightGets.delete(url); };
        textPromise.then(clear, clear);
      }
    }
    const text = await textPromise;
    if (!text || text.trim().startsWith('<')) return null;
    return JSON.parse(text);
  } catch (_err) {
    return null;
  }
}

/**
 * Direct blazing-fast Supabase query for public entries
 */
export async function fetchPublishedEntries({ type, limit, tag, category, forHomeFeed } = {}) {
  // 1. Try server API endpoint FIRST so Backblaze B2 presigned S3 URLs are freshly generated
  try {
    const params = new URLSearchParams();
    if (type) params.append('type', type);
    if (category) params.append('category', category);
    if (tag) params.append('tag', tag);
    if (limit) params.append('limit', String(limit));
    if (listVersion) params.append('v', listVersion);
    else if (listBust) params.append('r', listBust);

    const queryStr = params.toString();
    const apiUrl = `/api/posts${queryStr ? `?${queryStr}` : ''}`;
    const apiData = await safeApiFetch(apiUrl);

    if (Array.isArray(apiData)) {
      listBust = null;
      let list = apiData;
      if (forHomeFeed) {
        list = list.filter(item => item.show_in_feed !== false);
      }
      if (type === 'journal') {
        list = list.filter(item => 
          item.type !== 'photo' && 
          item.type !== 'update' && 
          (!item.category || item.category.toLowerCase() !== 'photos')
        );
      } else if (type === 'update') {
        list = list.filter(item => item.type === 'update');
      } else if (type === 'writing') {
        list = list.filter(item => 
          item.type === 'writing' || item.type === 'essay' || 
          (item.category && item.category.toLowerCase() === 'writing')
        );
      } else if (type === 'photo') {
        list = list.filter(item => 
          item.type === 'photo' || 
          (item.category && item.category.toLowerCase() === 'photos')
        );
      }

      // Cache entries and feed list for instant UI rendering
      list.forEach(item => cacheEntry(item));
      noteListVersions(list);
      const cacheKey = forHomeFeed ? 'home' : (type || 'all');
      feedsCache.set(cacheKey, list);
      persistFeedCache(cacheKey, list);

      lastFeedFetchFailed = false;
      return list;
    }
  } catch (_apiErr) {}

  // 2. Secondary fallback: Query safe public_published_entries view if API server endpoint is offline
  try {
    let query = supabase
      .from('public_published_entries')
      .select('*')
      .order('date', { ascending: false })
      .order('created_at', { ascending: false });

    if (type) {
      if (type === 'photo') {
        query = query.or('type.eq.photo,category.ilike.*photos*');
      } else {
        query = query.eq('type', type);
      }
    }
    if (category) query = query.ilike('category', `%${category}%`);
    if (tag) query = query.ilike('tags', `%${tag}%`);
    if (limit) query = query.limit(limit);

    let { data, error } = await query;

    // An error on the first query is a failure only if the unfiltered
    // fallback cannot produce usable rows either (a fallback that runs
    // clean and returns zero rows means the table is genuinely empty).
    let supaFailed = Boolean(error);
    if (error || !data || (type === 'photo' && data.length === 0)) {
      try {
        const { data: allData, error: allError } = await supabase
          .from('public_published_entries')
          .select('*')
          .order('date', { ascending: false });

        if (allError) {
          supaFailed = true;
        } else if (allData) {
          if (type === 'photo') {
            data = allData.filter(item => 
              item.type === 'photo' || 
              (item.category && item.category.toLowerCase().includes('photos')) ||
              (item.cover_image && item.cover_image.trim() !== '')
            );
          } else {
            data = allData;
          }
          supaFailed = false;
        }
      } catch (_fallbackErr) {
        supaFailed = true;
      }
    }

    if (supaFailed && !data) {
      // Both live sources failed and no usable rows came back: serve the
      // saved copy (if any) and flag the failure for the caller.
      lastFeedFetchFailed = true;
      const fallbackKey = forHomeFeed ? 'home' : (type || 'all');
      return getCachedFeed(fallbackKey) || [];
    }

    let rawList = data || [];
    if (forHomeFeed) {
      rawList = rawList.filter(item => item.show_in_feed !== false);
    }
    if (type === 'journal') {
      rawList = rawList.filter(item => 
        item.type !== 'photo' && 
        item.type !== 'update' && 
        (!item.category || item.category.toLowerCase() !== 'photos')
      );
    } else if (type === 'update') {
      rawList = rawList.filter(item => item.type === 'update');
    } else if (type === 'writing') {
      rawList = rawList.filter(item => 
        item.type === 'writing' || item.type === 'essay' || 
        (item.category && item.category.toLowerCase() === 'writing')
      );
    } else if (type === 'photo') {
      rawList = rawList.filter(item => 
        item.type === 'photo' || 
        (item.category && item.category.toLowerCase() === 'photos')
      );
    }

    // HIGH-4: Use real Supabase session check instead of spoofable localStorage heuristic
    let isLocalAdmin = false;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const sessionUserId = session?.user?.id || '';
      const adminId = (metaEnv.VITE_ADMIN_USER_ID || '').trim();
      isLocalAdmin = Boolean(sessionUserId && adminId && sessionUserId === adminId);
    } catch {}

    const list = rawList.map(item => {
      const isPhoto = Boolean(
        item.type === 'photo' ||
        (item.category && item.category.toLowerCase() === 'photos')
      );
      const hasPasscode = Boolean(item.has_passcode || (item.passcode && item.passcode.trim() !== ''));

      if (!isLocalAdmin && hasPasscode) {
        return {
          ...item,
          type: isPhoto ? 'photo' : item.type,
          has_passcode: true,
          passcode: undefined,
          excerpt: '🔒 Protected entry',
          cover_image: ''
        };
      }

      return {
        ...item,
        type: isPhoto ? 'photo' : item.type
      };
    });
    
    // Cache entries and feed list for instant UI rendering
    list.forEach(item => cacheEntry(item));
    noteListVersions(list);
    const cacheKey = forHomeFeed ? 'home' : (type || 'all');
    feedsCache.set(cacheKey, list);
    persistFeedCache(cacheKey, list);

    lastFeedFetchFailed = false;
    return list;
  } catch (e) {
    console.error('Supabase fetch entries error:', e);
    lastFeedFetchFailed = true;
    const fallbackKey = forHomeFeed ? 'home' : (type || 'all');
    return getCachedFeed(fallbackKey) || [];
  }
}

/**
 * Global Realtime channel for instant cross-device updates
 */
let globalRealtimeChannel = null;

export function initSupabaseRealtime() {
  if (typeof window === 'undefined' || !supabase || globalRealtimeChannel) return;

  try {
    globalRealtimeChannel = supabase
      .channel('public-realtime-sync')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'entries' },
        (payload) => {
          handleEntriesTableChange(payload);
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'about' },
        (payload) => {
          localStorage.removeItem('cached_about_data');
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('about-data-updated', { detail: payload }));
          }
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'comments' },
        (payload) => {
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('comments-updated', { detail: payload }));
          }
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'reactions' },
        (payload) => {
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('reactions-updated', { detail: payload }));
          }
        }
      )
      .subscribe();
  } catch (err) {
    console.warn('Realtime subscription skipped:', err.message);
  }
}

// Automatically subscribe in browser (skip in node test environment)
if (typeof window !== 'undefined' && (typeof process === 'undefined' || process?.env?.NODE_ENV !== 'test')) {
  initSupabaseRealtime();
}

/**
 * Realtime subscription to comments table
 */
export function subscribeToComments(postId, onDataChange) {
  if (typeof window === 'undefined' || !supabase || typeof supabase.channel !== 'function') return () => {};
  try {
    const channel = supabase
      .channel(`public:comments:${postId || 'all'}:${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comments' }, payload => {
        if (!postId || payload.new?.post_id === postId || payload.old?.post_id === postId) {
          if (typeof onDataChange === 'function') onDataChange();
        }
      })
      .subscribe();

    return () => {
      try { supabase.removeChannel(channel); } catch {}
    };
  } catch {
    return () => {};
  }
}

/**
 * Realtime subscription to reactions table
 */
export function subscribeToReactions(postId, onDataChange) {
  if (typeof window === 'undefined' || !supabase || typeof supabase.channel !== 'function') return () => {};
  try {
    const channel = supabase
      .channel(`public:reactions:${postId || 'all'}:${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reactions' }, payload => {
        if (!postId || payload.new?.post_id === postId || payload.old?.post_id === postId) {
          if (typeof onDataChange === 'function') onDataChange();
        }
      })
      .subscribe();

    return () => {
      try { supabase.removeChannel(channel); } catch {}
    };
  } catch {
    return () => {};
  }
}




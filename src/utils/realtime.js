/* global CustomEvent, EventSource, BroadcastChannel */
import { supabase, invalidateFeedCache, updateCachedEntryViews, noteEntryVersion, forgetEntryVersion, dropFromSnapshots } from '../supabase.js';

let isInitialized = false;
let sseConnection = null;
let broadcastChannel = null;
let supabaseRealtimeChannel = null;
let lastKnownVersion = null;
let isConnected = false;
const statusListeners = new Set();
const recentEvents = new Map();

/**
 * Clean up old deduplication cache entries older than 4 seconds
 */
function cleanupRecentEvents() {
  const now = Date.now();
  for (const [key, timestamp] of recentEvents.entries()) {
    if (now - timestamp > 4000) {
      recentEvents.delete(key);
    }
  }
}

/**
 * Check if an event was already processed recently (deduplication across SSE, Supabase, and BroadcastChannel)
 */
function isDuplicateEvent(key) {
  cleanupRecentEvents();
  if (recentEvents.has(key)) return true;
  recentEvents.set(key, Date.now());
  return false;
}

/**
 * Notify status listeners (e.g. Live pulse indicators)
 */
function notifyStatus(status) {
  isConnected = Boolean(status);
  statusListeners.forEach(fn => {
    try { fn(isConnected); } catch {}
  });
}

export function isRealtimeConnected() {
  return isConnected;
}

export function subscribeToRealtimeStatus(listener) {
  if (typeof listener !== 'function') return () => {};
  statusListeners.add(listener);
  listener(isConnected);
  return () => statusListeners.delete(listener);
}

/**
 * Main event dispatcher for any realtime mutation
 */
export function dispatchRealtimeMutation(payload, { isLocal = false } = {}) {
  if (!payload || typeof payload !== 'object') return;

  const inner = (payload.payload && typeof payload.payload === 'object') ? payload.payload : payload;
  // `event` wins over `type`: server broadcasts carry the event name in
  // `event` and may also carry a content type in `type` (an entry's
  // 'journal'/'photo'). Reading `type` first made every server-sent edit
  // arrive as 'journal' and match no branch, so it was silently dropped.
  // Client-originated events have no `event` field and still fall back
  // to `type`.
  const eventType = payload.event || payload.type || inner.event || inner.type || 'entry';
  const targetId = inner.id || payload.id || inner.data?.id || payload.data?.id || inner.commentId || payload.commentId || inner.postId || payload.postId || '';
  const op = inner.op || payload.op || inner.eventType || payload.eventType || '';
  // broadcastId distinguishes separate updates that share type/op/target —
  // without it, two different settings saves inside the 4s window collapse
  // into one dedupe key and the second is silently dropped on receivers.
  const dedupeKey = `${eventType}:${op}:${targetId}:${payload.version || inner.version || ''}:${payload.broadcastId || inner.broadcastId || ''}`;

  if (!isLocal && isDuplicateEvent(dedupeKey)) {
    return;
  }

  // One save reaches viewers twice: the server's `entry_updated` broadcast
  // and the editor's own `entry` mutation. Same entry + same updated_at is
  // the same content, so the second copy is skipped (no second refetch).
  // A local event still records the key so its server echo is skipped too.
  const ENTRY_FAMILY = ['entry', 'entry_created', 'entry_updated'];
  const versionStamp = inner.updated_at || payload.updated_at || inner.data?.updated_at || payload.data?.updated_at;
  const entryTarget = inner.id || payload.id || inner.data?.id || inner.slug || payload.slug || '';
  if (ENTRY_FAMILY.includes(eventType) && versionStamp && entryTarget) {
    const seen = isDuplicateEvent(`entry-version:${entryTarget}:${versionStamp}`);
    if (seen && !isLocal) return;
  }

  // View counts and now-playing pings are frequent and don't touch the
  // shared sync row the 10s fallback reads, so their version must not move
  // our watermark: a view received right after an edit we MISSED would put
  // the watermark past that edit's version and the fallback would never
  // recover it.
  const HIGH_FREQUENCY = ['entry_view_updated', 'now_playing', 'now_playing_updated'];
  if ((payload.version || inner.version) && !HIGH_FREQUENCY.includes(eventType)) {
    lastKnownVersion = payload.version || inner.version;
  }

  // 1. Entry / Feed changes
  if (
    eventType === 'entry' ||
    eventType === 'entry_created' ||
    eventType === 'entry_updated' ||
    eventType === 'entry_deleted' ||
    eventType === 'resync' ||
    eventType === 'feed'
  ) {
    // Learn the new version BEFORE clearing caches: with { keepVersions },
    // the next fetch asks for the new versioned URL (edge-cached) instead
    // of a plain short-cache URL. Events WITHOUT a version (e.g. the
    // sync-check fallback) invalidate with the default version reset, so
    // the next fetch goes out plain and cannot keep asking for a stale
    // versioned URL for the whole versioned TTL.
    const updatedAt = inner.updated_at || payload.updated_at || null;
    const entrySlug = inner.slug || payload.slug || null;
    const entryId = inner.id || payload.id || null;
    // A deleted (or unpublished) entry must not linger in the last-seen
    // display copy pages paint while their fresh fetch is in flight.
    const isUnpublish = (inner.status || payload.status || inner.data?.status || payload.data?.status) === 'draft';
    const isRowDelete = (inner.op || payload.op) === 'DELETE';
    const shouldDropSnapshot = (eventType === 'entry_deleted' || isUnpublish || isRowDelete) && (entrySlug || entryId);
    if (eventType === 'entry_deleted') {
      if (entrySlug || entryId) forgetEntryVersion(entrySlug, entryId);
      invalidateFeedCache();
    } else if (updatedAt && (entrySlug || entryId)) {
      noteEntryVersion(entrySlug, updatedAt, entryId);
      invalidateFeedCache({ keepVersions: true });
    } else {
      invalidateFeedCache();
    }
    // After the invalidation (which snapshots what was cached), so the
    // removed entry cannot be re-captured into the display copy.
    if (shouldDropSnapshot) dropFromSnapshots(entrySlug, entryId);

    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('feed-data-invalidated', { detail: payload }));
        window.dispatchEvent(new CustomEvent('entry-updated', { detail: payload }));
      } catch {}

    }
  }

  // 1b. Targeted Entry View Count updates (instant update, no feed flicker)
  if (eventType === 'entry_view_updated') {
    const postId = inner.id || payload.id;
    const postSlug = inner.slug || payload.slug;
    const views = (typeof inner.views === 'number') ? inner.views : payload.views;

    if (typeof views === 'number') {
      updateCachedEntryViews(postId, postSlug, views);
      if (typeof window !== 'undefined') {
        try {
          window.dispatchEvent(new CustomEvent('entry-views-updated', { detail: { id: postId, slug: postSlug, views } }));
        } catch {}
      }
    }
    return;
  }

  // 2. About page & Site settings changes (Theme, Typewriter, View count)
  if (
    eventType === 'about' ||
    eventType === 'about_updated' ||
    eventType === 'site_settings' ||
    eventType === 'site_settings_updated'
  ) {
    try {
      localStorage.removeItem('cached_about_data');
    } catch {}

    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('about-data-updated', { detail: payload }));
        window.dispatchEvent(new CustomEvent('site-settings-updated', { detail: payload }));
      } catch {}
    }
  }

  // 3. Reader comments
  if (eventType === 'comment' || eventType === 'comment_created' || eventType === 'comment_deleted') {
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('comments-updated', { detail: payload }));
      } catch {}
    }
  }

  // 4. Reactions
  if (eventType === 'reaction' || eventType === 'reaction_updated') {
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('reactions-updated', { detail: payload }));
      } catch {}
    }
  }

  // 5. Media
  if (eventType === 'media' || eventType === 'media_updated') {
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('media-updated', { detail: payload }));
      } catch {}
    }
  }

  // 6. Now Playing / Music Card
  if (eventType === 'now_playing' || eventType === 'now_playing_updated') {
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('now-playing-updated', { detail: payload }));
      } catch {}
    }
  }
}

/**
 * Publish a mutation originated by the current user (e.g. Admin saves or deletes)
 * Broadcasts to:
 * 1) Local window CustomEvents & cache invalidation
 * 2) Browser BroadcastChannel (syncs all tabs in same browser)
 * 3) Supabase Realtime Broadcast (syncs all devices/visitors across web)
 */
export function publishRealtimeUpdate(payload) {
  if (!payload || typeof payload !== 'object') return;
  const enriched = {
    ...payload,
    timestamp: new Date().toISOString(),
    broadcastId: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  };

  // 1. Process locally first
  dispatchRealtimeMutation(enriched, { isLocal: true });

  // 2. Broadcast to other tabs in the same browser
  if (broadcastChannel) {
    try {
      broadcastChannel.postMessage(enriched);
    } catch {}
  }

  // 3. Broadcast to Supabase Realtime channel for cross-device & cross-user sync
  if (supabaseRealtimeChannel) {
    try {
      supabaseRealtimeChannel.send({
        type: 'broadcast',
        event: 'sync',
        payload: enriched
      }).catch(() => {});
    } catch {}
  }

  // (No call to /api/realtime-broadcast here: it is admin-only and this
  // request never carried the login, so it always failed with 401 — one
  // wasted function call per action. Every write route on the server
  // already broadcasts and updates the sync row itself.)
}

/**
 * Setup Server-Sent Events (SSE) stream connection
 */
const SSE_ENABLED = !(typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_REALTIME_SSE === 'off');

function setupSSEConnection() {
  if (typeof window === 'undefined' || typeof window.EventSource === 'undefined') return;
  // Off on Vercel: an always-open stream keeps a serverless function running
  // around the clock. Supabase Realtime + the sync-check cover live updates.
  if (!SSE_ENABLED) return;

  if (sseConnection) {
    try { sseConnection.close(); } catch {}
  }

  let retryDelay = 2000;
  let retryTimer = null;

  const connect = () => {
    try {
      const es = new EventSource('/api/realtime-stream');
      sseConnection = es;

      es.onopen = () => {
        retryDelay = 2000;
        notifyStatus(true);
      };

      const handleEvent = (e) => {
        try {
          const parsed = JSON.parse(e.data);
          dispatchRealtimeMutation(parsed);
        } catch {}
      };

      es.onmessage = handleEvent;
      es.addEventListener('entry_created', handleEvent);
      es.addEventListener('entry_updated', handleEvent);
      es.addEventListener('entry_deleted', handleEvent);
      es.addEventListener('entry_view_updated', handleEvent);
      es.addEventListener('about_updated', handleEvent);
      es.addEventListener('site_settings_updated', handleEvent);
      es.addEventListener('comment_created', handleEvent);
      es.addEventListener('comment_deleted', handleEvent);
      es.addEventListener('reaction_updated', handleEvent);
      es.addEventListener('media_updated', handleEvent);
      es.addEventListener('now_playing_updated', handleEvent);
      es.addEventListener('init', (e) => {
        try {
          const d = JSON.parse(e.data);
          // Only adopt the server's version on the FIRST connect. A
          // reconnect to a cold-started instance reports Date.now() as its
          // version, which is later than any real edit — adopting it would
          // mark those edits "seen" and blind the sync-check fallback for
          // them. Keep the existing watermark and reconcile below instead.
          if (d.version && lastKnownVersion === null) lastKnownVersion = d.version;
          notifyStatus(true);
          checkSyncVersion();
        } catch {}
      });

      es.onerror = () => {
        notifyStatus(false);
        try { es.close(); } catch {}
        sseConnection = null;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          retryDelay = Math.min(retryDelay * 1.5, 30000);
          connect();
        }, retryDelay);
        if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref();
      };
    } catch {
      notifyStatus(false);
    }
  };

  connect();
}

/**
 * Setup Supabase Realtime (Postgres Changes + Realtime Broadcast Channel)
 */
function setupSupabaseRealtime() {
  if (typeof window === 'undefined' || !supabase) return;

  try {
    supabaseRealtimeChannel = supabase
      .channel('blog-live-sync', {
        config: {
          broadcast: { self: false },
          private: false
        }
      })
      .on('broadcast', { event: 'sync' }, (message) => {
        if (message && message.payload) {
          dispatchRealtimeMutation(message.payload);
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'realtime_sync' }, (payload) => {
        if (payload && payload.new) {
          const innerPayload = (payload.new.payload && typeof payload.new.payload === 'object') ? payload.new.payload : {};
          // The row's event/version go AFTER the spread: the stored payload
          // used to carry the entry's content type as `type`, which
          // overwrote the correct event type here and dropped the event.
          dispatchRealtimeMutation({
            ...innerPayload,
            event: payload.new.event || 'resync',
            type: payload.new.event || 'resync',
            version: payload.new.version
          });
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'entries' }, (payload) => {
        const newViews = payload.new ? Number(payload.new.views) : NaN;
        if (payload.new && Number.isFinite(newViews)) {
          dispatchRealtimeMutation({
            type: 'entry_view_updated',
            id: payload.new.id,
            slug: payload.new.slug,
            views: newViews
          });
        }
        // Only structural changes invalidate the caches. An UPDATE may be
        // nothing more than a view bump — those are handled by the
        // entry_view_updated dispatch above, and treating every UPDATE as
        // a content change wiped every cache on every single read. Content
        // edits made through the site still invalidate via the API's own
        // entry_updated broadcasts.
        if (payload.eventType === 'INSERT' || payload.eventType === 'DELETE') {
          dispatchRealtimeMutation({
            type: 'entry',
            op: payload.eventType,
            id: payload.new?.id || payload.old?.id,
            slug: payload.new?.slug || payload.old?.slug,
            data: payload.new
          });
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'about' }, (payload) => {
        dispatchRealtimeMutation({
          type: 'about',
          op: payload.eventType,
          data: payload.new
        });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comments' }, (payload) => {
        dispatchRealtimeMutation({
          type: 'comment',
          op: payload.eventType,
          postId: payload.new?.post_id || payload.old?.post_id,
          commentId: payload.new?.id || payload.old?.id
        });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reactions' }, (payload) => {
        dispatchRealtimeMutation({
          type: 'reaction',
          op: payload.eventType,
          postId: payload.new?.post_id || payload.old?.post_id
        });
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          notifyStatus(true);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          notifyStatus(false);
          setTimeout(() => {
            if (typeof window !== 'undefined' && document.visibilityState === 'visible') {
              try {
                supabaseRealtimeChannel?.subscribe();
              } catch {}
            }
          }, 4000);
        }
      });
  } catch (err) {
    console.warn('Supabase Realtime setup notice:', err.message);
  }
}

/**
 * Setup Browser Native BroadcastChannel for instant multi-tab sync
 */
function setupBroadcastChannel() {
  if (typeof window === 'undefined' || typeof window.BroadcastChannel === 'undefined') return;

  try {
    broadcastChannel = new BroadcastChannel('blog_sync_realtime');
    broadcastChannel.onmessage = (e) => {
      if (e && e.data) {
        dispatchRealtimeMutation(e.data);
      }
    };
  } catch {}
}

/**
 * Rejoin the Supabase channel if it died while the tab was backgrounded.
 * The error-path retry only fires when the tab is visible at that moment,
 * so a phone tab that errored in the background can stay dead with no
 * further retry scheduled. Called on foreground/focus/online.
 */
function resubscribeSupabaseIfNeeded() {
  try {
    if (supabaseRealtimeChannel && (supabaseRealtimeChannel.state === 'closed' || supabaseRealtimeChannel.state === 'errored')) {
      supabaseRealtimeChannel.subscribe();
    }
  } catch {}
}

/**
 * Fast sync-check to ensure no missed updates across mobile devices & serverless instances
 */
async function checkSyncVersion() {
  try {
    const res = await fetch('/api/sync-check', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.version) {
      if (lastKnownVersion !== null && data.version > lastKnownVersion) {
        const eventType = data.event || 'resync';
        // A newer version here means this device missed at least one live
        // notice, and the row only names the LAST event. If that isn't a
        // post change, an earlier missed edit could hide behind it (e.g. a
        // comment right after an edit), so refresh the posts as well.
        const ENTRY_EVENTS = ['entry', 'entry_created', 'entry_updated', 'entry_deleted', 'resync', 'feed'];
        if (!ENTRY_EVENTS.includes(eventType)) {
          dispatchRealtimeMutation({ type: 'resync', version: data.version, broadcastId: `missed-${data.version}` });
        }
        dispatchRealtimeMutation({
          type: eventType,
          version: data.version,
          // Entry version: the dispatcher notes it and invalidates with
          // { keepVersions: true }, so the refetch asks for the new
          // versioned URL instead of a plain short-cache one. Without
          // these fields every sync-check event fell back to a plain
          // refetch that could sit behind the edge cache for 60s.
          ...(data.updated_at ? { updated_at: data.updated_at } : {}),
          ...(data.slug ? { slug: data.slug } : {}),
          ...(data.id ? { id: data.id } : {}),
          payload: data.payload
        });
      }
      lastKnownVersion = data.version;
    }
  } catch {}
}

/**
 * Initialize unified realtime synchronization
 * Safe to call multiple times (idempotent)
 */
export function initRealtimeSync() {
  if (typeof window === 'undefined' || isInitialized) return;
  isInitialized = true;

  // 1. Browser Native Tab Broadcast
  setupBroadcastChannel();

  // 2. Server-Sent Events (SSE) Stream
  setupSSEConnection();

  // 3. Supabase Realtime (Postgres CDC + Global Broadcast)
  setupSupabaseRealtime();

  // 4. Initial sync version check
  checkSyncVersion();

  // 5. Tab visibility change & background sync-check (every 10s when visible)
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        resubscribeSupabaseIfNeeded();
        checkSyncVersion();
      }
    });

    window.addEventListener('focus', () => {
      resubscribeSupabaseIfNeeded();
      checkSyncVersion();
    });

    window.addEventListener('online', () => {
      resubscribeSupabaseIfNeeded();
      checkSyncVersion();
    });

    // Background sync-check while the tab is visible — a safety net behind
    // Supabase Realtime (which is instant). Every check is a serverless call,
    // so 10s (was 3.5s) keeps a tab left open within the free plan's limits.
    // Focus, visibility and reconnects still check immediately.
    // While the Supabase live connection is up it delivers every change
    // instantly, so the backup only needs to run once a minute (each check
    // is a billed function call — 10s polling from every open tab was the
    // biggest source of Vercel usage). When the connection is down the
    // backup is the only path, so it runs every 10s.
    let lastBackupCheck = 0;
    const syncInterval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const gap = isConnected ? 60000 : 10000;
      if (Date.now() - lastBackupCheck < gap - 500) return;
      lastBackupCheck = Date.now();
      checkSyncVersion();
    }, 10000);
    if (syncInterval && typeof syncInterval.unref === 'function') {
      syncInterval.unref();
    }
  } catch {}
}

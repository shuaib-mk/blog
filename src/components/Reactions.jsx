import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Lightbulb, Heart, Meh, ThumbsDown } from 'lucide-react';
import { supabase, subscribeToReactions } from '../supabase';
import { publishRealtimeUpdate } from '../utils/realtime';
import { useToast } from '../context/ToastContext';

export default function Reactions({ postId, passcode }) {
  const { error: toastError } = useToast();
  const [counts, setCounts] = useState({ thoughtful: 0, loved: 0, boring: 0, dislike: 0 });
  const [userReacted, setUserReacted] = useState({});
  // 'loading' until the first successful load; 'error' only when the
  // counts have never loaded — a failed background refresh keeps showing
  // the last known counts instead of flashing all-zero pills.
  const [loadState, setLoadState] = useState('loading');
  const hasLoadedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadReactions = useCallback(async () => {
    if (!postId) return;
    try {
      let realPostId = postId;
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(postId);
      if (!isUuid) {
        let { data: posts } = await supabase.from('public_published_entries').select('id').eq('slug', postId);
        if (!posts || !posts[0]) {
          const { data: rawPosts } = await supabase.from('entries').select('id').eq('slug', postId);
          if (rawPosts && rawPosts[0]) posts = rawPosts;
        }
        if (posts && posts[0]) realPostId = posts[0].id;
      }

      const { data: reactions, error: reactionsErr } = await supabase
        .from('reactions')
        .select('reaction_type')
        .eq('post_id', realPostId);
      if (reactionsErr) throw reactionsErr;

      const newCounts = { thoughtful: 0, loved: 0, boring: 0, dislike: 0 };
      (reactions || []).forEach(r => {
        if (newCounts[r.reaction_type] !== undefined) {
          newCounts[r.reaction_type]++;
        }
      });

      if (mountedRef.current) {
        setCounts(newCounts);
        hasLoadedRef.current = true;
        setLoadState('ready');
      }
    } catch {
      // A failed load must not masquerade as all-zero counts.
      if (mountedRef.current && !hasLoadedRef.current) {
        setLoadState('error');
      }
    }

    try {
      const stored = localStorage.getItem(`reacted_${postId}`);
      if (stored && mountedRef.current) {
        setUserReacted(JSON.parse(stored));
      }
    } catch (_e) {}
  }, [postId]);

  useEffect(() => {
    if (!postId) return;

    loadReactions();
    const unsubscribe = subscribeToReactions(postId, () => {
      loadReactions();
    });

    const handleReactionEvent = (e) => {
      if (!e.detail?.postId || e.detail.postId === postId) {
        if (e.detail?.counts) {
          setCounts(e.detail.counts);
        } else {
          loadReactions();
        }
      }
    };
    window.addEventListener('reactions-updated', handleReactionEvent);

    return () => {
      unsubscribe();
      window.removeEventListener('reactions-updated', handleReactionEvent);
    };
  }, [postId, loadReactions]);

  const handleReact = async (type) => {
    // One reaction per reader per post: it used to be locked per TYPE, so a
    // single visitor could tap all four and count 4 times.
    if (Object.keys(userReacted).some(k => userReacted[k])) return;

    // Optimistic UI update
    setCounts(prev => ({ ...prev, [type]: (prev[type] || 0) + 1 }));
    const newReacted = { ...userReacted, [type]: true };
    setUserReacted(newReacted);

    try {
      localStorage.setItem(`reacted_${postId}`, JSON.stringify(newReacted));
    } catch (_e) {}

    let updatedCounts = null;
    let posted = false;
    let serverReached = false;
    let serverError = null;

    try {
      const res = await fetch(`/api/posts/${postId}/reactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reaction_type: type, passcode: passcode || undefined })
      });
      serverReached = true;

      if (res.ok) {
        updatedCounts = await res.json();
        posted = true;
      } else {
        const body = await res.json().catch(() => null);
        serverError = body && body.error;
      }
    } catch {
      // The server could not be reached at all: fall back to Supabase below.
    }

    if (posted && updatedCounts && typeof updatedCounts === 'object') {
      setCounts(updatedCounts);
      publishRealtimeUpdate({
        type: 'reaction',
        op: 'INSERT',
        postId,
        counts: updatedCounts
      });
    } else if (posted) {
      // The server accepted the reaction but returned no usable counts;
      // refresh the real counts instead of trusting the optimistic +1.
      loadReactions();
    } else if (!posted && !serverReached) {
      // Direct Supabase fallback — only when the server was unreachable. When
      // it answered "no" (too fast, locked post…), its checks stand.
      try {
        let realPostId = postId;
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(postId);
        if (!isUuid) {
          const { data: posts } = await supabase.from('entries').select('id').eq('slug', postId);
          if (posts && posts[0]) realPostId = posts[0].id;
        }

        // An insert that resolves with an error (e.g. RLS deny) is a
        // failed post, not a silent success — check it.
        const { error: insertErr } = await supabase.from('reactions').insert([{ post_id: realPostId, reaction_type: type }]);
        if (insertErr) throw insertErr;
        posted = true;
        publishRealtimeUpdate({
          type: 'reaction',
          op: 'INSERT',
          postId
        });
      } catch (e) {
        console.error('Failed to post reaction to Supabase:', e);
      }
    }

    if (!posted) {
      // Both backends failed: revert the optimistic update entirely —
      // count, button state, and the persisted reacted flag — so the
      // reader is not left believing the reaction was recorded.
      setCounts(prev => ({ ...prev, [type]: Math.max(0, (prev[type] || 0) - 1) }));
      const reverted = { ...userReacted };
      delete reverted[type];
      setUserReacted(reverted);
      try {
        if (Object.keys(reverted).length === 0) {
          localStorage.removeItem(`reacted_${postId}`);
        } else {
          localStorage.setItem(`reacted_${postId}`, JSON.stringify(reverted));
        }
      } catch (_e) {}
      toastError(serverError || 'Couldn’t save your reaction. Try again.');
    }
  };

  const reactionButtons = [
    { key: 'thoughtful', icon: Lightbulb, label: 'Thoughtful' },
    { key: 'loved', icon: Heart, label: 'Loved' },
    { key: 'boring', icon: Meh, label: 'Boring' },
    { key: 'dislike', icon: ThumbsDown, label: 'Dislike' }
  ];

  return (
    <div className="py-6 border-t border-[var(--border-subtle)] my-10">
      <div className="text-xs font-sans uppercase tracking-widest text-[var(--text-muted)] font-medium text-center mb-3">
        Leave a quiet reaction
      </div>

      {loadState === 'loading' ? (
        <div className="text-xs font-sans text-[var(--text-muted)] italic text-center py-2">
          Loading reactions…
        </div>
      ) : loadState === 'error' ? (
        <div className="text-center py-2">
          <p className="text-xs font-sans text-[var(--text-muted)] mb-2">Couldn&apos;t load reactions.</p>
          <button
            onClick={loadReactions}
            className="quiet-button text-xs font-sans uppercase tracking-wider py-1.5 px-4 rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-hover)] transition-all cursor-pointer"
          >
            Retry
          </button>
        </div>
      ) : (
      <div className="reaction-pills-container">
        {reactionButtons.map(item => {
          const Icon = item.icon;
          const count = counts[item.key] || 0;
          const hasReacted = !!userReacted[item.key];
          const reactedOther = !hasReacted && Object.keys(userReacted).some(k => userReacted[k]);
          return (
            <button
              key={item.key}
              onClick={() => handleReact(item.key)}
              disabled={hasReacted || reactedOther}
              aria-pressed={hasReacted}
              className={`reaction-pill flex items-center gap-1.5 px-3.5 py-2.5 rounded-full border text-xs font-sans transition-all ${
                hasReacted
                  ? 'font-medium scale-105 shadow-sm cursor-default'
                  : reactedOther
                    ? 'border-[var(--border-subtle)] text-[var(--text-primary)] bg-[var(--code-bg)] opacity-50 cursor-default'
                    : 'cursor-pointer border-[var(--border-subtle)] text-[var(--text-primary)] hover:border-[var(--accent-warm)] hover:text-[var(--accent-warm)] bg-[var(--code-bg)]'
              }`}
              style={hasReacted ? { backgroundColor: 'var(--text-primary)', color: 'var(--bg-main)', borderColor: 'var(--text-primary)' } : {}}
              title={`Mark as ${item.label}`}
            >
              <Icon className="w-3.5 h-3.5" style={hasReacted ? { color: 'var(--bg-main)' } : { color: 'var(--accent-warm)' }} />
              <span style={hasReacted ? { color: 'var(--bg-main)' } : {}} className={hasReacted ? 'font-medium' : ''}>{item.label}</span>
              <span style={hasReacted ? { color: 'var(--bg-main)', opacity: 0.9 } : { opacity: 0.75 }} className="text-[10px] font-mono ml-0.5">
                ({count})
              </span>
            </button>
          );
        })}
      </div>
      )}
    </div>
  );
}

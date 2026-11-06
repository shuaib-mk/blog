import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import { fetchPublishedEntries, getCachedFeed, getLastFeedFetchFailed, safeApiFetch } from '../supabase';
import { useEntryPrefetch } from '../hooks/useEntryPrefetch';
import { stripMarkdown } from '../utils/excerpt';
import FeedSkeleton from '../components/FeedSkeleton';
import TypewriterText from '../components/TypewriterText';

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

function buildTree(posts) {
  const tree = {};
  if (!Array.isArray(posts)) return tree;
  posts.forEach(post => {
    if (!post.date) return;
    const d = new Date(post.date);
    const year = d.getFullYear();
    const month = d.toLocaleString('en-US', { month: 'long' });
    const monthNum = String(d.getMonth() + 1).padStart(2, '0');

    if (!tree[year]) tree[year] = {};
    if (!tree[year][monthNum]) tree[year][monthNum] = { name: month, count: 0 };
    tree[year][monthNum].count++;
  });
  return tree;
}

import useDocumentMeta from '../hooks/useDocumentMeta';

export default function Archive() {
  useDocumentMeta({
    title: 'Archive',
    description: 'A full chronological index of everything written and logged.'
  });

  const [searchParams, setSearchParams] = useSearchParams();
  const activeYear = searchParams.get('year');
  const activeMonth = searchParams.get('month');
  const initialQuery = searchParams.get('q') || searchParams.get('tag') || '';

  const cached = getCachedFeed('all');
  const [allPosts, setAllPosts] = useState(() => (Array.isArray(cached) ? cached : []));
  useEntryPrefetch(allPosts);
  const [archiveTree, setArchiveTree] = useState(() => buildTree(cached));
  const [searchResults, setSearchResults] = useState(() => (Array.isArray(cached) ? cached : []));
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [loading, setLoading] = useState(() => !cached || cached.length === 0);
  const [loadError, setLoadError] = useState(false);
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // fetchPublishedEntries never throws: it falls back to Supabase, then to
  // the saved cache. The failure flag tells a failed refresh (show an
  // error / a "saved copy" notice) from a genuinely empty archive.
  const loadArchive = useCallback(async () => {
    const posts = await fetchPublishedEntries();
    if (!mountedRef.current) return;

    const failed = getLastFeedFetchFailed();
    const list = Array.isArray(posts) ? posts : [];
    setAllPosts(list);
    setArchiveTree(buildTree(list));
    setLoading(false);
    setRefreshing(false);
    if (failed) {
      if (list.length === 0) {
        setLoadError(true);
        setStale(false);
      } else {
        setLoadError(false);
        setStale(true);
      }
    } else {
      setLoadError(false);
      setStale(false);
    }
  }, []);

  const handleRetry = useCallback(() => {
    setLoadError(false);
    setRefreshing(true);
    loadArchive();
  }, [loadArchive]);

  // Load the full entry list ONCE (and again only when the feed is invalidated).
  // Search / year-month filtering below is purely local — typing in the search
  // box must not refetch the whole list on every keystroke.
  useEffect(() => {
    loadArchive();

    const handleInvalidate = () => {
      loadArchive();
    };
    window.addEventListener('feed-data-invalidated', handleInvalidate);

    return () => {
      window.removeEventListener('feed-data-invalidated', handleInvalidate);
    };
  }, [loadArchive]);

  // Post bodies aren't in the loaded list, so matches inside a post's text
  // come from the server (debounced); title/tag/excerpt matches are instant.
  const [bodyMatchIds, setBodyMatchIds] = useState(() => new Set());
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) { setBodyMatchIds(new Set()); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      safeApiFetch(`/api/search?q=${encodeURIComponent(q)}`).then((res) => {
        if (!cancelled && res && Array.isArray(res.ids)) setBodyMatchIds(new Set(res.ids));
      });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [searchQuery]);

  // Local filter: search query / year-month selection over the loaded list
  useEffect(() => {
    let filtered = allPosts || [];
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(p =>
        bodyMatchIds.has(p.id) ||
        (p.title && p.title.toLowerCase().includes(q)) ||
        (p.excerpt && p.excerpt.toLowerCase().includes(q)) ||
        (p.content && p.content.toLowerCase().includes(q)) ||
        (p.tags && p.tags.toLowerCase().includes(q)) ||
        (p.category && p.category.toLowerCase().includes(q))
      );
    } else if (activeYear && activeMonth) {
      filtered = filtered.filter(p => {
        const d = new Date(p.date);
        const y = String(d.getFullYear());
        const m = String(d.getMonth() + 1).padStart(2, '0');
        return y === String(activeYear) && m === String(activeMonth);
      });
    }

    setSearchResults(filtered);
  }, [allPosts, searchQuery, activeYear, activeMonth, bodyMatchIds]);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      setSearchParams({ q: searchQuery.trim() });
    } else {
      setSearchParams({});
    }
  };

  const clearFilter = () => {
    setSearchQuery('');
    setSearchParams({});
  };

  return (
    <div className="notebook-container">
      <header className="mb-10">
        <TypewriterText
          text="Archive"
          as="h1"
          className="text-3xl font-serif font-medium tracking-tight mb-2"
        />
        <TypewriterText
          text="A full chronological index of everything written and logged."
          as="p"
          className="text-sm font-sans text-[var(--text-secondary)] mb-6"
        />

        {/* Minimal Search Bar */}
        <form onSubmit={handleSearchSubmit} className="relative max-w-md flex items-center">
          <Search
            className="w-4 h-4 text-[var(--text-muted)] pointer-events-none"
            style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)' }}
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search entries, topics, or tags..."
            style={{ paddingLeft: '2.35rem', paddingRight: searchQuery ? '3.5rem' : '1rem' }}
            className="quiet-input text-sm w-full"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={clearFilter}
              style={{ position: 'absolute', right: '0.75rem', top: '50%', transform: 'translateY(-50%)' }}
              className="text-xs font-sans text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer py-1 px-1.5"
            >
              Clear
            </button>
          )}
        </form>
      </header>

      {/* Saved-copy notice: the list on screen came from cache because the live refresh failed */}
      {stale && !loading && (
        <div className="mb-8 flex flex-wrap items-center justify-between gap-2 text-xs font-sans text-[var(--text-muted)]">
          <span>Showing a saved copy — it may be out of date.</span>
          <button
            onClick={handleRetry}
            disabled={refreshing}
            className="underline hover:text-[var(--text-primary)] cursor-pointer"
          >
            {refreshing ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}

      {/* Active Filter Title */}
      {(searchQuery || (activeYear && activeMonth)) && (
        <div className="mb-8 p-3 rounded border border-[var(--border-subtle)] text-xs font-sans flex justify-between items-center">
          <div>
            Showing results for:{' '}
            <span className="font-medium text-[var(--text-primary)]">
              {searchQuery ? `"${searchQuery}"` : `${activeYear} / Month ${activeMonth}`}
            </span>{' '}
            ({searchResults.length} entries found)
          </div>
          <button onClick={clearFilter} className="underline text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
            Reset view
          </button>
        </div>
      )}

      {/* Results View when filtered */}
      {(searchQuery || (activeYear && activeMonth)) ? (
        <div className="space-y-6">
          {loading ? (
            <FeedSkeleton type="archive" />
          ) : loadError ? (
            <div className="py-8 text-center">
              <p className="text-sm font-sans text-[var(--text-primary)]">Couldn&apos;t load the archive.</p>
              <p className="text-xs font-sans text-[var(--text-muted)] mt-1 mb-4">Check your connection and try again.</p>
              <button
                onClick={handleRetry}
                disabled={refreshing}
                className="quiet-button text-xs font-sans uppercase tracking-wider py-2.5 px-6 rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-hover)] transition-all cursor-pointer"
              >
                {refreshing ? 'Retrying…' : 'Retry'}
              </button>
            </div>
          ) : searchResults.length === 0 ? (
            <div className="py-8 text-center text-sm font-sans text-[var(--text-muted)]">
              No entries found matching your criteria.
            </div>
          ) : (
            searchResults.map((item, idx) => (
              <article key={item.id} className={`pb-4 border-b border-[var(--border-subtle)] animate-content-fade stagger-${Math.min(idx + 1, 6)}`}>
                <div className="text-xs font-sans text-[var(--text-muted)] mb-1">
                  {formatDate(item.date)} · <span className="uppercase">{item.type}</span>
                </div>
                <h3 className="text-xl font-serif font-medium mb-1">
                  <Link to={`/entry/${item.slug || item.id}`} className="hover:text-[var(--accent-warm)] transition-colors">
                    <TypewriterText text={item.title} />
                  </Link>
                </h3>

                <p className="text-sm font-serif text-[var(--text-secondary)] line-clamp-2">
                  <TypewriterText text={stripMarkdown(item.excerpt || item.content)} />
                </p>
              </article>
            ))
          )}
        </div>
      ) : (
        /* Standard Archive Year/Month Tree */
        <div className="space-y-10">
          {loading ? (
            <FeedSkeleton type="archive" />
          ) : loadError ? (
            <div className="py-8 text-center">
              <p className="text-sm font-sans text-[var(--text-primary)]">Couldn&apos;t load the archive.</p>
              <p className="text-xs font-sans text-[var(--text-muted)] mt-1 mb-4">Check your connection and try again.</p>
              <button
                onClick={handleRetry}
                disabled={refreshing}
                className="quiet-button text-xs font-sans uppercase tracking-wider py-2.5 px-6 rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-hover)] transition-all cursor-pointer"
              >
                {refreshing ? 'Retrying…' : 'Retry'}
              </button>
            </div>
          ) : Object.keys(archiveTree).length === 0 ? (
            <div className="py-8 text-center text-sm font-sans text-[var(--text-muted)]">
              Archive is empty.
            </div>
          ) : (
            // Newest first. Object.keys() always lists number-like keys
            // ("2025", "2026") in ascending order, so sort explicitly.
            Object.keys(archiveTree).sort((x, y) => Number(y) - Number(x)).map(year => (
              <div key={year} className="border-b border-[var(--border-subtle)] pb-8">
                <TypewriterText
                  text={year}
                  as="h2"
                  className="text-2xl font-serif font-medium mb-4 text-[var(--text-primary)]"
                />
                <ul className="space-y-2 text-sm font-sans">
                  {Object.keys(archiveTree[year]).sort((x, y) => Number(y) - Number(x)).map(monthNum => {
                    const monthItem = archiveTree[year][monthNum];
                    return (
                      <li key={monthNum} className="flex items-center space-x-3">
                        <Link
                          to={`/archive?year=${year}&month=${monthNum}`}
                          className="hover:text-[var(--accent-warm)] underline underline-offset-4 text-[var(--text-primary)]"
                        >
                          <TypewriterText text={monthItem.name} />
                        </Link>
                        <span className="text-xs text-[var(--text-muted)]">
                          <TypewriterText text={`— ${monthItem.count} ${monthItem.count === 1 ? 'entry' : 'entries'}`} />
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

import React, { useState, useEffect, useCallback } from 'react';
import { X, ChevronLeft, ChevronRight, MapPin, Calendar, Image as ImageIcon } from 'lucide-react';
import { formatDate } from '../utils/date';
import ProtectedEntryModal from '../components/ProtectedEntryModal';
import TypewriterText from '../components/TypewriterText';
import useDocumentMeta from '../hooks/useDocumentMeta';
import { useFeedData } from '../hooks/useFeedData';
import { useEntryPrefetch } from '../hooks/useEntryPrefetch';
import FeedSkeleton from '../components/FeedSkeleton';
import ProgressiveImage from '../components/ProgressiveImage';
import { resolveMediaUrl } from '../utils/media';
import { safeApiFetch } from '../supabase';
import { stripMarkdown } from '../utils/excerpt';

export default function Photos() {
  useDocumentMeta({
    title: 'Photos',
    description: 'Visual journal, moments & film archives.'
  });

  const { displayedEntries: photos, loading, error, stale, refreshing, refetch } = useFeedData({
    type: 'photo',
    pageSize: 12
  });

  useEntryPrefetch(photos);

  // Only show the placeholder tiles if loading is actually slow: an empty
  // gallery has no saved copy, so the skeleton flashed six phantom tiles
  // right before "0 captures" on every visit.
  const [showSkeleton, setShowSkeleton] = useState(false);
  useEffect(() => {
    if (!loading) { setShowSkeleton(false); return; }
    const t = setTimeout(() => setShowSkeleton(true), 350);
    return () => clearTimeout(t);
  }, [loading]);

  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState(null);
  const [passcodeModalPhoto, setPasscodeModalPhoto] = useState(null);

  const activePhoto = selectedPhotoIndex !== null ? photos[selectedPhotoIndex] : null;

  // The gallery list arrives without each post's full text (kept light), so
  // the caption under an opened photo was always empty. Show the short
  // excerpt at once, then fetch the full text for the opened photo. Keyed by
  // id + updated_at, so an edit (realtime) fetches the new text.
  const [fullText, setFullText] = useState({});
  const activeKey = activePhoto ? `${activePhoto.id}:${activePhoto.updated_at || ''}` : null;
  useEffect(() => {
    if (!activePhoto || !activeKey || fullText[activeKey] !== undefined) return;
    if (activePhoto.has_passcode) return;
    if (typeof activePhoto.content === 'string' && activePhoto.content) return;
    let cancelled = false;
    const ident = activePhoto.slug || activePhoto.id;
    const v = activePhoto.updated_at ? `?v=${encodeURIComponent(activePhoto.updated_at)}` : '';
    safeApiFetch(`/api/posts/${encodeURIComponent(ident)}${v}`).then((res) => {
      if (cancelled) return;
      const entry = res && (res.entry || res);
      setFullText(prev => ({ ...prev, [activeKey]: (entry && typeof entry.content === 'string') ? entry.content : '' }));
    });
    return () => { cancelled = true; };
  }, [activePhoto, activeKey, fullText]);

  const navigatePhoto = useCallback((direction) => {
    if (selectedPhotoIndex === null) return;
    const newIdx = selectedPhotoIndex + direction;
    if (newIdx >= 0 && newIdx < photos.length) {
      setSelectedPhotoIndex(newIdx);
    }
  }, [selectedPhotoIndex, photos.length]);

  // Handle keypress for lightbox navigation
  useEffect(() => {
    function handleKeyDown(e) {
      if (selectedPhotoIndex === null) return;
      if (e.key === 'Escape') setSelectedPhotoIndex(null);
      if (e.key === 'ArrowLeft') navigatePhoto(-1);
      if (e.key === 'ArrowRight') navigatePhoto(1);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedPhotoIndex, photos.length, navigatePhoto]);

  // Keep the page behind the photo viewer from scrolling while it is open.
  const isViewerOpen = selectedPhotoIndex !== null;
  useEffect(() => {
    if (!isViewerOpen) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isViewerOpen]);

  // Swipe left/right on the photo to move between photos on touch screens.
  const touchStartRef = React.useRef(null);
  const handleTouchStart = (e) => {
    const t = e.touches && e.touches[0];
    touchStartRef.current = t ? { x: t.clientX, y: t.clientY } : null;
  };
  const handleTouchEnd = (e) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    const t = e.changedTouches && e.changedTouches[0];
    if (!start || !t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      navigatePhoto(dx < 0 ? 1 : -1);
    }
  };

  const openPhoto = (photo, index) => {
    if (photo.has_passcode && photo.content && photo.content.includes('🔒')) {
      setPasscodeModalPhoto(photo);
      return;
    }
    setSelectedPhotoIndex(index);
  };

  const getPhotoSrc = (item) => {
    if (!item) return null;
    let src = item.cover_image && item.cover_image.trim();
    if (src && /q04ti-quote|quote-/i.test(src)) {
      src = null;
    }
    if (!src && item.content) {
      const matches = [...item.content.matchAll(/!\[.*?\]\((.*?)\)/g)].map(m => m[1])
        .concat([...item.content.matchAll(/https?:\/\/[^\s)"]+(?:images|videos|audio|files)\/\d{4}\/\d{2}\/[^/\s?#]+\.[a-z0-9]+[^\s)"]*/gi)].map(m => m[0]));
      src = matches.find(url => !/q04ti-quote|quote-/i.test(url)) || matches[0] || null;
    }
    return resolveMediaUrl(src);
  };

  const getCleanCaption = (item) => {
    if (!item || !item.content) return '';
    if (item.content.startsWith('🔒')) return '';
    const clean = item.content.replace(/!\[.*?\]\(.*?\)/g, '').trim();
    if (clean && !clean.startsWith('http://') && !clean.startsWith('https://')) {
      return clean;
    }
    return '';
  };

  return (
    <div className="notebook-container pb-20">
      {/* Header section */}
      <div className="border-b border-[var(--border-subtle)] pb-6 mb-8">
        <TypewriterText
          text="Photos"
          as="h1"
          className="font-serif text-3xl sm:text-4xl tracking-tight text-[var(--text-primary)] font-normal"
        />
        <p className="font-sans text-xs sm:text-sm text-[var(--text-muted)] mt-1">
          <TypewriterText
            text="Visual journal, moments & film archives"
            as="span"
          />
          {!loading && ` (${photos.length} captures)`}
        </p>
      </div>

      {/* Loading Skeleton */}
      {loading ? (
        showSkeleton ? <FeedSkeleton type="photo" count={6} /> : <div className="min-h-[40vh]" aria-busy="true" />
      ) : error ? (
        <div className="py-16 text-center">
          <p className="font-serif text-lg text-[var(--text-primary)]">Couldn&apos;t load the photos.</p>
          <p className="font-sans text-xs text-[var(--text-muted)] mt-1 mb-4">
            Check your connection and try again.
          </p>
          <button
            onClick={refetch}
            disabled={refreshing}
            className="quiet-button text-xs font-sans uppercase tracking-wider py-2.5 px-6 rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-hover)] transition-all cursor-pointer"
          >
            {refreshing ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      ) : photos.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-[var(--border-subtle)] rounded-lg">
          <ImageIcon className="w-10 h-10 text-[var(--text-muted)] mx-auto mb-3 opacity-50" />
          <TypewriterText text="No photos published yet" as="p" className="font-serif text-lg text-[var(--text-primary)]" />
          <TypewriterText text="Check back soon for new visual captures." as="p" className="font-sans text-xs text-[var(--text-muted)] mt-1" />
        </div>
      ) : (
        <>
        {stale && (
          <div className="mb-6 flex flex-wrap items-center justify-between gap-2 text-xs font-sans text-[var(--text-muted)]">
            <span>Showing a saved copy — it may be out of date.</span>
            <button
              onClick={refetch}
              disabled={refreshing}
              className="underline hover:text-[var(--text-primary)] cursor-pointer"
            >
              {refreshing ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        )}
        {/* GRID VIEW (3-column Instagram style) */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 sm:gap-4">
          {photos.map((item, idx) => {
            const imgSrc = getPhotoSrc(item);
            const isProtected = item.has_passcode && item.content && item.content.includes('🔒');

            return (
              <div
                key={item.id || idx}
                onClick={() => openPhoto(item, idx)}
                className={`group relative aspect-square bg-[var(--code-bg)] rounded-md overflow-hidden border border-[var(--border-subtle)] cursor-pointer select-none animate-content-fade stagger-${Math.min(idx + 1, 6)}`}
              >
                {imgSrc ? (
                  <ProgressiveImage
                    src={imgSrc}
                    alt={item.title || 'Photo'}
                    aspectRatio="aspect-square"
                    imgClassName="transition-transform duration-300 group-hover:scale-105"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center p-4 text-center">
                    <span className="font-serif text-xs text-[var(--text-muted)] italic">
                      {isProtected ? 'Passcode Protected' : item.title}
                    </span>
                  </div>
                )}

                {/* Overlay on hover */}
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-3 text-white">
                  <p className="font-sans text-xs font-medium line-clamp-1">
                    {item.title}
                  </p>
                  <p className="font-sans text-[10px] text-white/80 mt-0.5">
                    {formatDate(item.date)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}

      {/* FULLSCREEN LIGHTBOX MODAL */}
      {activePhoto && (
        <div
          className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center p-2 sm:p-6 animate-in fade-in duration-150"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelectedPhotoIndex(null);
          }}
        >


          {/* Navigation Arrows */}
          {selectedPhotoIndex > 0 && (
            <button
              onClick={() => navigatePhoto(-1)}
              className="fixed left-3 sm:left-6 top-1/2 -translate-y-1/2 z-[100] p-2.5 text-white/90 hover:text-white bg-black/70 hover:bg-black rounded-full transition-transform hover:scale-110 shadow-xl cursor-pointer"
              aria-label="Previous photo"
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
          )}

          {selectedPhotoIndex < photos.length - 1 && (
            <button
              onClick={() => navigatePhoto(1)}
              className="fixed right-3 sm:right-6 top-1/2 -translate-y-1/2 z-[100] p-2.5 text-white/90 hover:text-white bg-black/70 hover:bg-black rounded-full transition-transform hover:scale-110 shadow-xl cursor-pointer"
              aria-label="Next photo"
            >
              <ChevronRight className="w-6 h-6" />
            </button>
          )}

          {/* Main Modal Layout Card */}
          <div className="relative w-full max-w-4xl max-h-[90vh] bg-[var(--bg-main)] rounded-2xl overflow-hidden shadow-2xl flex flex-col md:flex-row border border-[var(--border-subtle)]">
            {/* Image Viewport Column */}
            <div
              className="md:flex-1 bg-black flex items-center justify-center relative min-h-[260px] max-h-[58vh] md:max-h-[85vh] p-4 select-none"
              onTouchStart={handleTouchStart}
              onTouchEnd={handleTouchEnd}
            >
              {/* High-visibility Close Button strictly on Photo Container Top-Left */}
              <button
                onClick={() => setSelectedPhotoIndex(null)}
                className="lightbox-close-btn w-11 h-11 min-w-[44px] min-h-[44px] shrink-0"
                style={{ width: '44px', height: '44px', minWidth: '44px', minHeight: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', backgroundColor: 'transparent', boxShadow: 'none' }}
                aria-label="Close photo view"
                title="Close photo"
              >
                <X className="w-5 h-5 text-white" />
              </button>

              {getPhotoSrc(activePhoto) ? (
                <ProgressiveImage
                  src={getPhotoSrc(activePhoto)}
                  alt={activePhoto.title || 'Photo'}
                  objectFit="object-contain"
                  className="max-w-full max-h-[52vh] md:max-h-[80vh] rounded shadow-lg"
                  imgClassName="max-h-[52vh] md:max-h-[80vh]"
                />
              ) : (
                <div className="text-white/60 font-serif italic text-sm">No preview available</div>
              )}
            </div>

            {/* Sidebar Details Column */}
            <div className="md:w-72 lg:w-80 flex flex-col shrink-0 border-t md:border-t-0 md:border-l border-[var(--border-subtle)] bg-[var(--bg-main)]">
              {/* Header */}
              <div className="p-4 border-b border-[var(--border-subtle)] flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <h2 className="font-serif text-base sm:text-lg font-medium text-[var(--text-primary)] break-words line-clamp-2">
                    {activePhoto.title}
                  </h2>
                  <div className="flex flex-wrap items-center gap-3 text-[11px] text-[var(--text-muted)] font-sans mt-1">
                    <span className="flex items-center gap-1 shrink-0">
                      <Calendar className="w-3 h-3" />
                      {formatDate(activePhoto.date)}
                    </span>
                    {activePhoto.location && (
                      <span className="flex items-center gap-1 shrink-0 truncate max-w-[140px]">
                        <MapPin className="w-3 h-3" />
                        <span>{activePhoto.location}</span>
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Caption: the post's text (full text once fetched, excerpt until then) */}
              {(() => {
                const full = activeKey ? fullText[activeKey] : undefined;
                const caption = getCleanCaption(activePhoto)
                  || (full ? stripMarkdown(getCleanCaption({ content: full })) : '')
                  || (!activePhoto.has_passcode && typeof activePhoto.excerpt === 'string' ? activePhoto.excerpt.trim() : '');
                return caption ? (
                  <div className="flex-1 overflow-y-auto p-4 text-sm font-sans text-[var(--text-primary)] leading-relaxed break-words whitespace-pre-line">
                    {caption}
                  </div>
                ) : null;
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Protected Entry Modal for Passcode-Locked Photos */}
      {passcodeModalPhoto && (
        <ProtectedEntryModal
          entry={passcodeModalPhoto}
          onUnlock={(_unlockedData) => {
            refetch();
            setPasscodeModalPhoto(null);
          }}
          onClose={() => setPasscodeModalPhoto(null)}
        />
      )}
    </div>
  );
}

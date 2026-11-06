import React, { useEffect, useState, useCallback } from 'react';
import RichViewer from '../components/RichViewer';
import TypewriterText from '../components/TypewriterText';
import useDocumentMeta from '../hooks/useDocumentMeta';
import FeedSkeleton from '../components/FeedSkeleton';

import { supabase } from '../supabase';

const defaultAbout = {
  author_name: 'q04ti',
  tagline: '',
  bio: '',
  projects: [],
  links: []
};

export default function About() {
  useDocumentMeta({
    title: 'About',
    description: 'Thoughts, things I make, places I go, and everything in between.'
  });

  const [aboutData, setAboutData] = useState(() => {
    try {
      const storedAuthor = localStorage.getItem('site_author_name');
      const cached = localStorage.getItem('cached_about_data');
      if (cached) {
        const parsed = JSON.parse(cached);
        // Wipe legacy hardcoded dummy strings if present in cached data
        if (parsed?.bio && parsed.bio.includes('Welcome to my digital diary and visual archive')) {
          localStorage.removeItem('cached_about_data');
          return {
            author_name: storedAuthor || (parsed.author_name && parsed.author_name.trim() !== '' ? parsed.author_name : 'q04ti'),
            tagline: '',
            bio: '',
            projects: [],
            links: []
          };
        }
        if (parsed && typeof parsed === 'object') {
          return {
            author_name: (parsed.author_name && parsed.author_name.trim() !== '') ? parsed.author_name : (storedAuthor || 'q04ti'),
            tagline: parsed.tagline || '',
            bio: parsed.bio || '',
            projects: Array.isArray(parsed.projects) ? parsed.projects : [],
            links: Array.isArray(parsed.links) ? parsed.links : []
          };
        }
      }
      if (storedAuthor && storedAuthor.trim()) {
        return { ...defaultAbout, author_name: storedAuthor.trim() };
      }
    } catch {}
    return defaultAbout;
  });
  // The skeleton only ever shows when there is no saved About content to
  // render yet; a saved copy renders immediately and refreshes in the
  // background. (loading used to start false and never become true, so the
  // skeleton branch was dead and a failed fetch rendered the default
  // author as if it were the real page.)
  const [loading, setLoading] = useState(() => {
    try {
      const cached = localStorage.getItem('cached_about_data');
      if (!cached) return true;
      const parsed = JSON.parse(cached);
      return !(parsed && (
        parsed.bio || parsed.tagline ||
        (Array.isArray(parsed.projects) && parsed.projects.length > 0) ||
        (Array.isArray(parsed.links) && parsed.links.length > 0)
      ));
    } catch {
      return true;
    }
  });
  const [loadFailed, setLoadFailed] = useState(false);

  const hasRealContent = (d) => Boolean(d && (
    d.bio || d.tagline ||
    (Array.isArray(d.projects) && d.projects.length > 0) ||
    (Array.isArray(d.links) && d.links.length > 0)
  ));

  const doFetch = useCallback(async () => {
    let data = null;
    try {
      const res = await fetch('/api/about');
      if (res.ok) {
        const text = await res.text();
        if (text && !text.trim().startsWith('<')) {
          data = JSON.parse(text);
        }
      }
    } catch {}

    // Fallback: Direct Supabase query if API server endpoint is not reachable
    if (!data && supabase && typeof supabase.from === 'function') {
      try {
        const { data: supaRows } = await supabase.from('about').select('*').limit(1);
        if (supaRows && supaRows[0]) {
          data = supaRows[0];
        }
      } catch {}
    }

    if (data) {
      let projects = data.projects;
      if (typeof projects === 'string') {
        try { projects = JSON.parse(projects); } catch { projects = []; }
      }
      let links = data.links;
      if (typeof links === 'string') {
        try { links = JSON.parse(links); } catch { links = []; }
      }

      const updated = {
        author_name: (data.author_name && data.author_name.trim() !== '') ? data.author_name : 'q04ti',
        tagline: data.tagline || '',
        bio: data.bio || '',
        projects: Array.isArray(projects) ? projects : [],
        links: Array.isArray(links) ? links : []
      };
      setAboutData(updated);
      setLoadFailed(false);
      try {
        localStorage.setItem('cached_about_data', JSON.stringify(updated));
        if (updated.author_name) {
          localStorage.setItem('site_author_name', updated.author_name);
        }
      } catch {}
    } else {
      // Both sources failed. The error state only renders when there is
      // no real content to show; a saved copy keeps rendering as-is.
      setLoadFailed(true);
    }
    setLoading(false);
  }, []);

  const handleRetry = () => {
    setLoadFailed(false);
    setLoading(true);
    doFetch();
  };

  useEffect(() => {
    // Always fetch fresh on mount so projects/bio/links never stay stale
    doFetch();

    // Also refetch if the admin saves changes in the same session
    const handleUpdate = () => {
      doFetch();
    };
    window.addEventListener('about-data-updated', handleUpdate);
    return () => window.removeEventListener('about-data-updated', handleUpdate);
  }, [doFetch]);

  return (
    <div className="notebook-container">
      {loading ? (
        <FeedSkeleton type="about" />
      ) : loadFailed && !hasRealContent(aboutData) ? (
        <div className="py-16 text-center animate-content-fade">
          <h1 className="text-2xl font-serif font-medium mb-3">Couldn&apos;t load the About page</h1>
          <p className="text-sm font-sans text-[var(--text-secondary)] mb-6">
            Check your connection and try again.
          </p>
          <button
            onClick={handleRetry}
            className="quiet-button text-xs font-sans uppercase tracking-wider py-2.5 px-6 rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-hover)] transition-all cursor-pointer"
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="space-y-12 animate-content-fade">
          {/* Header section */}
          <header>
            <TypewriterText
              text={aboutData.author_name}
              as="h1"
              className="text-3xl font-serif font-medium tracking-tight mb-2"
            />
            {aboutData.tagline && (
              <TypewriterText
                text={aboutData.tagline}
                as="p"
                className="text-sm font-serif italic text-[var(--text-secondary)]"
              />
            )}
          </header>

          {/* Short Bio */}
          {aboutData.bio && (
            <section className="prose-editorial">
              <RichViewer content={aboutData.bio} />
            </section>
          )}

          {/* Projects */}
          {aboutData.projects && aboutData.projects.length > 0 && (
            <section className="pt-6 border-t border-[var(--border-subtle)]">
              <TypewriterText text="Projects & Work" as="h2" className="text-xs font-sans uppercase tracking-widest text-[var(--text-muted)] font-medium mb-6" />
              <div className="space-y-6">
                {aboutData.projects.map((proj, idx) => (
                  <div key={idx} className="group">
                    <h3 className="text-lg font-serif font-medium">
                      {proj.link ? (
                        <a
                          href={proj.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-[var(--accent-warm)] transition-colors underline underline-offset-4 decoration-[var(--border-subtle)]"
                        >
                          <TypewriterText text={proj.title} />
                        </a>
                      ) : (
                        <TypewriterText text={proj.title} />
                      )}
                    </h3>
                    {proj.description && (
                      <TypewriterText text={proj.description} as="p" className="text-sm font-serif text-[var(--text-secondary)] mt-1" />
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Links */}
          {aboutData.links && aboutData.links.length > 0 && (
            <section className="pt-6 border-t border-[var(--border-subtle)]">
              <TypewriterText text="Links & Contact" as="h2" className="text-xs font-sans uppercase tracking-widest text-[var(--text-muted)] font-medium mb-4" />
              <ul className="flex flex-wrap gap-6 text-sm font-sans">
                {aboutData.links.map((link, idx) => (
                  <li key={idx}>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--text-primary)] hover:text-[var(--accent-warm)] underline underline-offset-4"
                    >
                      <TypewriterText text={link.label} />
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

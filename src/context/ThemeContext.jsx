import React, { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { fetchSiteSettings } from '../utils/siteSettings';

const ThemeContext = createContext({
  theme: 'light',
  toggleTheme: () => {},
  setTheme: () => {},
  siteDefaultTheme: 'light',
  updateSiteDefaultTheme: () => {},
  hasUserOverride: false
});

export function ThemeProvider({ children }) {
  // Only true if the visitor intentionally clicked the theme button on the website
  const [hasUserOverride, setHasUserOverride] = useState(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        // Clean legacy override poison
        if (localStorage.getItem('theme_user_override')) {
          localStorage.removeItem('theme_user_override');
        }
        const manual = localStorage.getItem('user_manual_theme');
        return manual === 'light' || manual === 'dark';
      }
    } catch {}
    return false;
  });

  const [siteDefaultTheme, setSiteDefaultTheme] = useState(() => {
    try {
      if (typeof document !== 'undefined') {
        const injected = document.documentElement.getAttribute('data-theme-injected');
        if (injected === 'light' || injected === 'dark') return injected;
        if (document.documentElement.classList.contains('dark')) return 'dark';
      }
      if (typeof window !== 'undefined' && window.localStorage) {
        const cached = localStorage.getItem('site_default_theme');
        if (cached === 'light' || cached === 'dark') return cached;
      }
    } catch {}
    return 'light';
  });

  const [theme, setTheme] = useState(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const manual = localStorage.getItem('user_manual_theme');
        if (manual === 'light' || manual === 'dark') {
          return manual;
        }
      }
      if (typeof document !== 'undefined') {
        const injected = document.documentElement.getAttribute('data-theme-injected');
        if (injected === 'light' || injected === 'dark') return injected;
        if (document.documentElement.classList.contains('dark')) return 'dark';
      }
      if (typeof window !== 'undefined' && window.localStorage) {
        const cachedDefault = localStorage.getItem('site_default_theme');
        if (cachedDefault === 'light' || cachedDefault === 'dark') {
          return cachedDefault;
        }
      }
    } catch {}
    return 'light';
  });

  // Apply default theme to the document and state
  const applySiteDefault = (newDefault, force = false) => {
    if (newDefault !== 'light' && newDefault !== 'dark') return;
    setSiteDefaultTheme(newDefault);
    try {
      localStorage.setItem('site_default_theme', newDefault);
    } catch {}

    const manual = typeof window !== 'undefined' && localStorage.getItem('user_manual_theme');
    if (!manual || force) {
      if (force) {
        try {
          localStorage.removeItem('user_manual_theme');
          localStorage.removeItem('theme_user_override');
        } catch {}
        setHasUserOverride(false);
      }
      setTheme(newDefault);
      const root = document.documentElement;
      if (newDefault === 'dark') {
        root.classList.add('dark');
        if (document.body) document.body.classList.add('dark');
      } else {
        root.classList.remove('dark');
        if (document.body) document.body.classList.remove('dark');
      }
    }
  };

  // 1. Initial load from the shared settings store & direct Supabase
  useEffect(() => {
    fetchSiteSettings()
      .then(data => {
        if (data && (data.default_theme === 'light' || data.default_theme === 'dark')) {
          applySiteDefault(data.default_theme);
        }
      })
      .catch(() => {});

    // Direct Supabase query for instant zero-latency default theme retrieval
    if (supabase && typeof supabase.from === 'function') {
      supabase
        .from('realtime_sync')
        .select('payload')
        .eq('id', 'site_settings')
        .maybeSingle()
        .then(({ data }) => {
          if (data?.payload?.default_theme === 'light' || data?.payload?.default_theme === 'dark') {
            applySiteDefault(data.payload.default_theme);
          }
        })
        .catch(() => {});
    }
  }, []);

  // 2. Realtime listener across tabs, devices, and Supabase CDC
  useEffect(() => {
    const handleAboutUpdate = (e) => {
      const data = e.detail?.data || e.detail?.payload || e.detail;
      const newDefault = data?.default_theme;
      if (newDefault === 'light' || newDefault === 'dark') {
        applySiteDefault(newDefault, true);
      }
    };

    window.addEventListener('about-data-updated', handleAboutUpdate);
    window.addEventListener('site-settings-updated', handleAboutUpdate);

    // Direct Supabase Realtime channel subscription
    let channel;
    if (supabase && typeof supabase.channel === 'function') {
      try {
        channel = supabase
          // A fresh topic per subscription: supabase.channel() hands back an
          // existing channel with the same name, and the one this effect just
          // unsubscribed is still registered until its leave completes, so
          // re-running the effect got that dying channel back, .on() threw
          // ("cannot add callbacks after subscribe()"), and the catch below
          // hid it: live admin changes stopped reaching open pages.
          .channel(`theme-sync-channel:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'realtime_sync', filter: 'id=eq.site_settings' }, (payload) => {
            const newDefault = payload?.new?.payload?.default_theme;
            if (newDefault === 'light' || newDefault === 'dark') {
              applySiteDefault(newDefault, true);
            }
          })
          .subscribe();
      } catch {}
    }

    const handleStorage = (e) => {
      if (e.key === 'site_default_theme') {
        if (e.newValue === 'light' || e.newValue === 'dark') {
          applySiteDefault(e.newValue);
        }
      } else if (e.key === 'user_manual_theme') {
        if (e.newValue === 'light' || e.newValue === 'dark') {
          setHasUserOverride(true);
          setTheme(e.newValue);
        } else if (e.newValue === null) {
          setHasUserOverride(false);
          setTheme(siteDefaultTheme);
        }
      }
    };

    window.addEventListener('storage', handleStorage);

    return () => {
      window.removeEventListener('about-data-updated', handleAboutUpdate);
      window.removeEventListener('site-settings-updated', handleAboutUpdate);
      window.removeEventListener('storage', handleStorage);
      if (channel) {
        try {
          if (typeof supabase.removeChannel === 'function') supabase.removeChannel(channel);
          else if (typeof channel.unsubscribe === 'function') channel.unsubscribe();
        } catch {}
      }
    };
  }, [siteDefaultTheme]);

  // Apply dark class to document root and enable smooth transitions once ready
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
      if (document.body) document.body.classList.add('dark');
    } else {
      root.classList.remove('dark');
      if (document.body) document.body.classList.remove('dark');
    }

    const timer = setTimeout(() => {
      root.classList.add('theme-ready');
    }, 50);
    return () => clearTimeout(timer);
  }, [theme]);

  // When a user toggles the button on the main website
  const toggleTheme = () => {
    setHasUserOverride(true);
    setTheme(prev => {
      const next = prev === 'light' ? 'dark' : 'light';
      try {
        localStorage.setItem('user_manual_theme', next);
        localStorage.setItem('diary-theme', next);
        localStorage.setItem('theme', next);
      } catch {}
      return next;
    });
  };

  // When the admin updates the site default theme in AboutEdit
  const updateSiteDefaultTheme = (newDefault) => {
    if (newDefault !== 'light' && newDefault !== 'dark') return;
    setSiteDefaultTheme(newDefault);
    setTheme(newDefault);
    setHasUserOverride(false);
    try {
      localStorage.setItem('site_default_theme', newDefault);
      localStorage.removeItem('user_manual_theme');
      localStorage.removeItem('theme_user_override');
      localStorage.setItem('diary-theme', newDefault);
      localStorage.setItem('theme', newDefault);
    } catch {}

    const root = document.documentElement;
    if (newDefault === 'dark') {
      root.classList.add('dark');
      if (document.body) document.body.classList.add('dark');
    } else {
      root.classList.remove('dark');
      if (document.body) document.body.classList.remove('dark');
    }
  };

  return (
    <ThemeContext.Provider value={{
      theme,
      toggleTheme,
      setTheme,
      siteDefaultTheme,
      updateSiteDefaultTheme,
      hasUserOverride
    }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

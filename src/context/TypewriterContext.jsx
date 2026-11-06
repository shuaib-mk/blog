import React, { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { publishRealtimeUpdate } from '../utils/realtime';
import { fetchSiteSettings } from '../utils/siteSettings';

const TypewriterContext = createContext({
  typewriterEnabled: false,
  toggleTypewriter: () => {},
  setTypewriterEnabled: () => {},
  siteDefaultEnabled: false,
  updateSiteDefault: () => {},
  hasUserOverride: false
});

export function TypewriterProvider({ children }) {
  const [hasUserOverride, setHasUserOverride] = useState(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const manual = localStorage.getItem('user_manual_typewriter');
        return manual === 'true' || manual === 'false';
      }
    } catch {}
    return false;
  });

  const [siteDefaultEnabled, setSiteDefaultEnabled] = useState(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const cached = localStorage.getItem('site_default_typewriter');
        if (cached === 'true') return true;
        if (cached === 'false') return false;
      }
    } catch {}
    return false;
  });

  const [typewriterEnabled, setTypewriterEnabled] = useState(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const manual = localStorage.getItem('user_manual_typewriter');
        if (manual === 'true') return true;
        if (manual === 'false') return false;
        const cached = localStorage.getItem('site_default_typewriter');
        if (cached === 'true') return true;
        if (cached === 'false') return false;
        const legacy = localStorage.getItem('typewriter-enabled');
        if (legacy === 'true') return true;
        if (legacy === 'false') return false;
      }
    } catch {}
    return false;
  });

  const applySiteDefault = (newDefault) => {
    if (typeof newDefault !== 'boolean') return;
    setSiteDefaultEnabled(newDefault);
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.setItem('site_default_typewriter', String(newDefault));
      }
    } catch {}

    const manual = typeof window !== 'undefined' && localStorage.getItem('user_manual_typewriter');
    if (!manual) {
      setTypewriterEnabled(newDefault);
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          localStorage.setItem('typewriter-enabled', String(newDefault));
        }
      } catch {}
    }
  };

  // 1. Initial load from the shared settings store & direct Supabase
  useEffect(() => {
    fetchSiteSettings()
      .then(data => {
        if (data && typeof data.default_typewriter_enabled === 'boolean') {
          applySiteDefault(data.default_typewriter_enabled);
        }
      })
      .catch(() => {});

    // Direct Supabase query for instant zero-latency default typewriter retrieval
    if (supabase && typeof supabase.from === 'function') {
      supabase
        .from('realtime_sync')
        .select('payload')
        .eq('id', 'site_settings')
        .maybeSingle()
        .then(({ data }) => {
          if (typeof data?.payload?.default_typewriter_enabled === 'boolean') {
            applySiteDefault(data.payload.default_typewriter_enabled);
          }
        })
        .catch(() => {});
    }
  }, []);

  // 2. Realtime listener across tabs, devices, SSE, and Supabase CDC
  useEffect(() => {
    const handleSettingsUpdate = (e) => {
      const data = e.detail?.data || e.detail?.payload || e.detail;
      const newDefault = data?.default_typewriter_enabled;
      if (typeof newDefault === 'boolean') {
        applySiteDefault(newDefault);
      }
    };

    window.addEventListener('about-data-updated', handleSettingsUpdate);
    window.addEventListener('site-settings-updated', handleSettingsUpdate);

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
          .channel(`typewriter-sync-channel:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'realtime_sync', filter: 'id=eq.site_settings' }, (payload) => {
            const newDefault = payload?.new?.payload?.default_typewriter_enabled;
            if (typeof newDefault === 'boolean') {
              applySiteDefault(newDefault);
            }
          })
          .subscribe();
      } catch {}
    }

    const handleStorage = (e) => {
      if (e.key === 'site_default_typewriter') {
        if (e.newValue === 'true' || e.newValue === 'false') {
          applySiteDefault(e.newValue === 'true');
        }
      } else if (e.key === 'user_manual_typewriter') {
        if (e.newValue === 'true' || e.newValue === 'false') {
          setHasUserOverride(true);
          setTypewriterEnabled(e.newValue === 'true');
        } else if (e.newValue === null) {
          setHasUserOverride(false);
          setTypewriterEnabled(siteDefaultEnabled);
        }
      } else if (e.key === 'typewriter-enabled') {
        if (e.newValue === 'true' || e.newValue === 'false') {
          setTypewriterEnabled(e.newValue === 'true');
        }
      }
    };

    window.addEventListener('storage', handleStorage);

    return () => {
      window.removeEventListener('about-data-updated', handleSettingsUpdate);
      window.removeEventListener('site-settings-updated', handleSettingsUpdate);
      window.removeEventListener('storage', handleStorage);
      if (channel) {
        try {
          if (typeof supabase.removeChannel === 'function') supabase.removeChannel(channel);
          else if (typeof channel.unsubscribe === 'function') channel.unsubscribe();
        } catch {}
      }
    };
  }, [siteDefaultEnabled]);

  const toggleTypewriter = () => {
    setHasUserOverride(true);
    setTypewriterEnabled(prev => {
      const next = !prev;
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          localStorage.setItem('user_manual_typewriter', String(next));
          localStorage.setItem('typewriter-enabled', String(next));
        }
      } catch {}
      return next;
    });
  };

  const updateSiteDefault = (newDefault) => {
    if (typeof newDefault !== 'boolean') return;
    setSiteDefaultEnabled(newDefault);
    setTypewriterEnabled(newDefault);
    setHasUserOverride(false);

    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.setItem('site_default_typewriter', String(newDefault));
        localStorage.setItem('typewriter-enabled', String(newDefault));
        localStorage.removeItem('user_manual_typewriter');
      }
    } catch {}

    try {
      publishRealtimeUpdate({
        type: 'about',
        op: 'UPDATE',
        data: { default_typewriter_enabled: newDefault }
      });

      if (supabase && typeof supabase.from === 'function') {
        supabase.from('realtime_sync').select('payload').eq('id', 'site_settings').maybeSingle().then(({ data }) => {
          const current = data?.payload || {};
          supabase.from('realtime_sync').upsert({
            id: 'site_settings',
            version: Date.now(),
            event: 'site_settings_updated',
            payload: {
              ...current,
              default_typewriter_enabled: newDefault
            },
            updated_at: new Date().toISOString()
          }).then(() => {}).catch(() => {});
        }).catch(() => {});
      }
    } catch {}
  };

  return (
    <TypewriterContext.Provider value={{
      typewriterEnabled,
      toggleTypewriter,
      setTypewriterEnabled,
      siteDefaultEnabled,
      updateSiteDefault,
      hasUserOverride
    }}>
      {children}
    </TypewriterContext.Provider>
  );
}

export function useTypewriter() {
  return useContext(TypewriterContext);
}

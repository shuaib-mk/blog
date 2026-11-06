import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from './context/ThemeContext';
import { AuthProvider } from './context/AuthContext';
import { TypewriterProvider } from './context/TypewriterContext';
import { ViewCountProvider } from './context/ViewCountContext';
import { ToastProvider } from './context/ToastContext';
import { initRealtimeSync } from './utils/realtime';
import { reloadForNewVersion } from './utils/staleChunk';
import App from './App';
import './index.css';

// Initialize multi-transport realtime sync engine (SSE, Supabase Realtime, BroadcastChannel)
initRealtimeSync();

// A chunk from an older deploy failed to load: reload into the new version
// (guarded against loops in staleChunk.js). Vite fires this before the
// import rejects; preventDefault stops the error when we do reload.
if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadForNewVersion()) event.preventDefault();
  });
}

// Register PWA service worker cleanly for installability and offline support.
// Production builds only: in `vite` dev the worker's stale-while-revalidate
// cache served the previous version of edited source files once.
if (typeof window !== 'undefined' && 'serviceWorker' in navigator && import.meta.env.DEV) {
  // Clear any worker (and its cache) left over from earlier dev sessions.
  navigator.serviceWorker.getRegistrations()
    .then((regs) => regs.forEach((reg) => reg.unregister()))
    .catch(() => {});
  if (window.caches) {
    window.caches.keys().then((keys) => keys.forEach((key) => window.caches.delete(key))).catch(() => {});
  }
}

if (typeof window !== 'undefined' && 'serviceWorker' in navigator && import.meta.env.PROD && process.env.NODE_ENV !== 'test') {
  const registerSW = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    registerSW();
  } else {
    window.addEventListener('load', registerSW);
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          <TypewriterProvider>
            <ViewCountProvider>
              <ToastProvider>
                <App />
              </ToastProvider>
            </ViewCountProvider>
          </TypewriterProvider>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>
);

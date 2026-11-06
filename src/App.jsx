import React, { Suspense, lazy, useEffect, useLayoutEffect } from 'react';
import { Routes, Route, useLocation, useNavigationType } from 'react-router-dom';
import Header from './components/Header';
import Footer from './components/Footer';
import ProtectedRoute from './components/ProtectedRoute';
import ErrorBoundary from './components/ErrorBoundary';

// Public pages (eager loaded for instant feel)
import Home from './pages/Home';
import Journal from './pages/Journal';
import Writing from './pages/Writing';
import Updates from './pages/Updates';
import Photos from './pages/Photos';
import EntryDetail from './pages/EntryDetail';
import Archive from './pages/Archive';
import About from './pages/About';
import Activity from './pages/Activity';
import NotFound from './pages/NotFound';

// Admin pages (lazy loaded for zero initial bundle bloat)
const Login = lazy(() => import('./pages/admin/Login'));
const Dashboard = lazy(() => import('./pages/admin/Dashboard'));
const Editor = lazy(() => import('./pages/admin/Editor'));
const Media = lazy(() => import('./pages/admin/Media'));
const AboutEdit = lazy(() => import('./pages/admin/AboutEdit'));

const PageFallback = () => (
  <div className="notebook-container py-12 text-center text-xs font-sans text-[var(--text-muted)] italic">
    Loading view...
  </div>
);

function ScrollToTop() {
  const location = useLocation();
  const navType = useNavigationType();

  useLayoutEffect(() => {
    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
    }
  }, []);

  useLayoutEffect(() => {
    const key = location.key || location.pathname;
    if (navType === 'POP') {
      const savedPos = sessionStorage.getItem(`scroll_${key}`);
      if (savedPos !== null) {
        const y = parseInt(savedPos, 10);
        window.scrollTo({ top: y, left: 0, behavior: 'instant' });
        document.documentElement.scrollTop = y;
        document.body.scrollTop = y;
      }
    } else {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      requestAnimationFrame(() => {
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
      });
    }

    return () => {
      sessionStorage.setItem(`scroll_${key}`, window.scrollY.toString());
    };
  }, [location.key, location.pathname, navType]);

  return null;
}

export default function App() {
  const location = useLocation();
  const isAdminPath = location.pathname.startsWith('/admin');

  // Admin pages use the admin app manifest, public pages the public one (the
  // server does the same for the first page load), so installing from the
  // blog gives visitors the blog and the dashboard keeps the admin app.
  useEffect(() => {
    try {
      const link = document.querySelector('link[rel="manifest"]');
      const want = isAdminPath ? '/manifest-admin.json' : '/manifest.json';
      if (link && link.getAttribute('href') !== want) {
        link.setAttribute('href', want);
        // An install prompt captured for the other manifest would install the
        // wrong app (e.g. the public blog from the admin dashboard's button).
        // Drop it; the browser offers a new one for this manifest, which
        // usePWAInstall picks up from its beforeinstallprompt listener.
        window.deferredInstallPrompt = null;
      }
    } catch {}
  }, [isAdminPath]);

  return (
    <div className="min-h-screen flex flex-col justify-between">
      {/* One boundary around the whole shell (header, routes, footer) so a
          throw in any of them shows the fallback instead of a blank page.
          Keyed by pathname so navigating anywhere clears the error state. */}
      <ErrorBoundary key={location.pathname}>
      <ScrollToTop />
      <div>
        {/* Render minimalist public header on public pages */}
        {!isAdminPath && <Header />}

        <main className={isAdminPath ? 'pt-8' : ''}>
          <Suspense fallback={<PageFallback />}>
            <Routes>
              {/* Public Read-Only Routes */}
              <Route path="/" element={<Home />} />
              <Route path="/journal" element={<Journal />} />
              <Route path="/writing" element={<Writing />} />
              <Route path="/photos" element={<Photos />} />
              <Route path="/updates" element={<Updates />} />
              <Route path="/entry/:slug" element={<EntryDetail />} />
              <Route path="/archive" element={<Archive />} />
              <Route path="/activity" element={<Activity />} />
              <Route path="/about" element={<About />} />

              {/* Admin Authentication & Protected Workspace */}
              <Route path="/admin/login" element={<Login />} />
              <Route
                path="/admin"
                element={
                  <ProtectedRoute>
                    <Dashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/admin/dashboard"
                element={
                  <ProtectedRoute>
                    <Dashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/admin/new"
                element={
                  <ProtectedRoute>
                    <Editor />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/admin/edit/:id"
                element={
                  <ProtectedRoute>
                    <Editor />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/admin/media"
                element={
                  <ProtectedRoute>
                    <Media />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/admin/about"
                element={
                  <ProtectedRoute>
                    <AboutEdit />
                  </ProtectedRoute>
                }
              />

              {/* Fallback 404 */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </main>
      </div>

      {/* Render quiet footer */}
      {!isAdminPath && <Footer />}

      </ErrorBoundary>
    </div>
  );
}

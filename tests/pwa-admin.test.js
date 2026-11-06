process.env.NODE_ENV = 'test';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import http from 'http';
import app from '../api/index.js';

const PORT = 3885;

describe('Admin PWA App Specification Tests', () => {
  let server;

  before(async () => {
    server = http.createServer((req, res) => {
      // Simple static file handler for public files in test
      const publicDir = path.resolve(process.cwd(), 'public');
      if (req.url === '/manifest.json' || req.url === '/manifest-admin.json') {
        const content = fs.readFileSync(path.join(publicDir, req.url.slice(1)), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(content);
      }
      if (req.url === '/sw.js') {
        const content = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        return res.end(content);
      }
      return app(req, res);
    });
    await new Promise(resolve => server.listen(PORT, resolve));
  });

  after(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('1. manifest-admin.json is valid and configured specifically for Admin space', async () => {
    const res = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${PORT}/manifest-admin.json`, (r) => {
        let body = '';
        r.on('data', chunk => { body += chunk; });
        r.on('end', () => resolve({ status: r.statusCode, body }));
      }).on('error', reject);
    });

    assert.strictEqual(res.status, 200);
    const manifest = JSON.parse(res.body);

    assert.strictEqual(manifest.display, 'standalone', 'App must launch in standalone full-screen mode');
    assert.strictEqual(manifest.start_url, '/admin/dashboard', 'Start URL must point directly to Admin Dashboard');
    assert.strictEqual(manifest.background_color, '#121212');
    assert.strictEqual(manifest.theme_color, '#121212');
    assert.ok(manifest.icons && manifest.icons.length >= 3, 'Must include 192, 512, and maskable icons');
    assert.ok(manifest.shortcuts && manifest.shortcuts.length >= 2, 'Must include quick writing shortcuts');

    const hasNewJournalShortcut = manifest.shortcuts.some(s => s.url.includes('/admin/new?type=journal'));
    assert.strictEqual(hasNewJournalShortcut, true, 'Shortcuts must include quick journal entry launcher');
  });

  test('1b. public manifest.json installs the blog, and admin pages link the admin manifest', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve('public/manifest.json'), 'utf8'));
    assert.strictEqual(manifest.start_url, '/', 'Visitors installing the site get the blog home');
    assert.notStrictEqual(manifest.id, '/admin', 'Public app must not share the admin app identity');
    assert.ok(!(manifest.shortcuts || []).some(s => s.url.startsWith('/admin')), 'Public app has no admin shortcuts');

    const html = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${PORT}/admin/dashboard`, (r) => {
        let body = '';
        r.on('data', chunk => { body += chunk; });
        r.on('end', () => resolve(body));
      }).on('error', reject);
    });
    assert.ok(html.includes('<link rel="manifest" href="/manifest-admin.json"'), 'Admin pages must link the admin manifest');
  });

  test('2. sw.js is served with proper cache-bypassing for APIs', async () => {
    const res = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${PORT}/sw.js`, (r) => {
        let body = '';
        r.on('data', chunk => { body += chunk; });
        r.on('end', () => resolve({ status: r.statusCode, body }));
      }).on('error', reject);
    });

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes("url.pathname.startsWith('/api/')"), 'Service worker must bypass API calls');
    assert.ok(res.body.includes('supabase.co'), 'Service worker must bypass live Supabase calls');
  });

  test('3. index.html includes PWA manifest link and iOS standalone meta tags', () => {
    const htmlPath = path.resolve(process.cwd(), 'index.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    assert.ok(htmlContent.includes('<link rel="manifest" href="/manifest.json"'), 'Must link to manifest.json');
    assert.ok(htmlContent.includes('apple-mobile-web-app-capable'), 'Must declare iOS standalone app capability');
    assert.ok(htmlContent.includes('apple-touch-icon'), 'Must include apple-touch-icon');
  });

  test('4. All required icon assets exist and are non-empty', () => {
    const publicDir = path.resolve(process.cwd(), 'public');
    const requiredFiles = ['icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable.png', 'apple-touch-icon.png'];

    for (const file of requiredFiles) {
      const fullPath = path.join(publicDir, file);
      assert.ok(fs.existsSync(fullPath), `${file} must exist`);
      const stat = fs.statSync(fullPath);
      assert.ok(stat.size > 500, `${file} must not be empty`);
    }
  });

  test('5. index.html globally captures beforeinstallprompt and links icon-192.png favicon', () => {
    const htmlPath = path.resolve(process.cwd(), 'index.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    assert.ok(htmlContent.includes('window.deferredInstallPrompt'), 'Must define window.deferredInstallPrompt');
    assert.ok(htmlContent.includes('beforeinstallprompt'), 'Must listen to beforeinstallprompt in head');
    assert.ok(htmlContent.includes('href="/icon-192.png"'), 'Must link icon-192.png as favicon');
  });

  test('6. Header component preserves clean serif wordmark', () => {
    const headerPath = path.resolve(process.cwd(), 'src/components/Header.jsx');
    const headerContent = fs.readFileSync(headerPath, 'utf8');

    assert.ok(headerContent.includes('{siteMeta.author_name}'), 'Header must render author name wordmark');
    assert.ok(!headerContent.includes('src="/icon-192.png"'), 'Header should not have inserted logo img');
  });

  test('7. PWAInstallButton triggers direct install and does not display tutorial guides', () => {
    const btnPath = path.resolve(process.cwd(), 'src/components/PWAInstallButton.jsx');
    const btnContent = fs.readFileSync(btnPath, 'utf8');

    assert.ok(btnContent.includes('promptInstall'), 'Must trigger promptInstall directly');
    assert.ok(!btnContent.includes('three dots menu'), 'Must not display manual tutorial guide steps');
    assert.ok(!btnContent.includes('Share'), 'Must not contain manual Safari guide');
  });

  test('8. App.jsx defines route for /admin/dashboard to prevent 404 on launch', () => {
    const appPath = path.resolve(process.cwd(), 'src/App.jsx');
    const appContent = fs.readFileSync(appPath, 'utf8');

    assert.ok(appContent.includes('path="/admin/dashboard"'), 'Must define route for /admin/dashboard');
  });
});

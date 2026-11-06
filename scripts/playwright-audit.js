import { chromium } from 'playwright';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import express from 'express';
import apiApp from '../api/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const PORT = 3456;

// Create static preview server for production build output in dist/
async function startStaticServer() {
  const distDir = path.join(projectRoot, 'dist');
  if (!fs.existsSync(distDir)) {
    throw new Error('dist directory missing. Run npm run build first.');
  }

  const app = express();
  app.use(apiApp);
  app.use(express.static(distDir));

  // SPA fallback to index.html for non-asset routes
  app.use((req, res) => {
    if (req.path.includes('.') && !req.path.endsWith('.html')) {
      return res.status(404).end();
    }
    res.sendFile(path.join(distDir, 'index.html'));
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(PORT, resolve));
  console.log(`Static SPA server started on http://127.0.0.1:${PORT}`);
  return server;
}

async function runPlaywrightAudit() {
  console.log('\n=============================================================');
  console.log('PLAYWRIGHT RESPONSIVE AUDIT (375px, 768px, 1280px)');
  console.log('=============================================================\n');

  const baseUrl = process.env.BASE_URL ? process.env.BASE_URL.replace(/\/+$/, '') : null;
  let server = null;

  if (baseUrl) {
    console.log(`Running audit in BASE_URL mode targeting: ${baseUrl}`);
    console.log('(Skipping local static server, NO Supabase route mocking)\n');
  } else {
    server = await startStaticServer();
  }

  const artifactsDir = path.join(projectRoot, 'scratch', 'playwright_screenshots');
  if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
  }

  const browser = await chromium.launch({ headless: true });

  const viewports = [
    { name: 'mobile', width: 375, height: 812 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'desktop', width: 1280, height: 800 }
  ];

  const routes = [
    { name: 'home', path: '/' },
    { name: 'journal', path: '/journal' },
    { name: 'writing', path: '/writing' },
    { name: 'photos', path: '/photos' },
    { name: 'updates', path: '/updates' },
    { name: 'archive', path: '/archive' },
    { name: 'about', path: '/about' },
    // The live API no longer serves built-in sample entries; point these at
    // real posts with AUDIT_ENTRY_SLUG / AUDIT_PROTECTED_SLUG when auditing
    // a deployed site.
    { name: 'entry_page', path: `/entry/${process.env.AUDIT_ENTRY_SLUG || 'sample-entry'}` },
    { name: 'protected_entry', path: `/entry/${process.env.AUDIT_PROTECTED_SLUG || 'protected-sample-entry'}` },
    { name: 'popup_card', path: `/entry/${process.env.AUDIT_ENTRY_SLUG || 'sample-entry'}?quote=Sample+Quote+Card` }
  ];

  let totalTests = 0;
  let passed = 0;
  let failed = 0;
  const auditErrors = [];

  for (const vp of viewports) {
    console.log(`\n--- Auditing Viewport: ${vp.width}x${vp.height} (${vp.name}) ---`);

    for (const route of routes) {
      totalTests++;
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height }
      });

      const page = await context.newPage();
      const consoleErrors = [];
      const failedRequests = [];

      // Only mock remote Supabase REST queries when running in local static preview mode
      if (!baseUrl) {
        await page.route('**/*.supabase.co/rest/**', route => {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([])
          });
        });
      }

      page.on('console', msg => {
        if (msg.type() === 'error') {
          consoleErrors.push(msg.text());
        }
      });

      page.on('response', res => {
        if (res.status() >= 400 && !res.url().includes('/favicon.ico')) {
          failedRequests.push(`${res.status()} ${res.url()}`);
        }
      });

      const url = baseUrl ? `${baseUrl}${route.path}` : `http://127.0.0.1:${PORT}${route.path}`;

      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 });
        await page.waitForTimeout(500);

        // Check horizontal overflow
        const overflow = await page.evaluate(() => {
          const documentWidth = document.documentElement.clientWidth;
          const scrollWidth = document.documentElement.scrollWidth;
          const bodyOverflow = document.body.scrollWidth > documentWidth;
          return {
            hasOverflow: scrollWidth > documentWidth || bodyOverflow,
            scrollWidth,
            clientWidth: documentWidth
          };
        });

        // Screenshot filename
        const shotFilename = `${route.name}_${vp.width}px.png`;
        const shotPath = path.join(artifactsDir, shotFilename);
        await page.screenshot({ path: shotPath, fullPage: true });

        const isSuccess = !overflow.hasOverflow && consoleErrors.length === 0 && failedRequests.length === 0;

        if (isSuccess) {
          passed++;
          console.log(`  ✅ PASS: [${vp.width}px] ${route.path.padEnd(30)} Saved: ${shotFilename}`);
        } else {
          failed++;
          const failureReasons = [];
          if (overflow.hasOverflow) failureReasons.push(`Horizontal scroll detected (${overflow.scrollWidth}px > ${overflow.clientWidth}px)`);
          if (consoleErrors.length > 0) failureReasons.push(`Console errors: ${consoleErrors.join('; ')}`);
          if (failedRequests.length > 0) failureReasons.push(`Failed requests: ${failedRequests.join('; ')}`);

          const msg = `❌ FAIL: [${vp.width}px] ${route.path} -> ${failureReasons.join(' | ')}`;
          console.log(`  ${msg}`);
          auditErrors.push(msg);
        }

      } catch (err) {
        failed++;
        const msg = `❌ FAIL: [${vp.width}px] ${route.path} -> Navigation Error: ${err.message}`;
        console.log(`  ${msg}`);
        auditErrors.push(msg);
      } finally {
        await context.close();
      }
    }
  }

  await browser.close();
  if (server) server.close();

  console.log('\n-------------------------------------------------------------');
  console.log(`Playwright Audit Summary: ${passed}/${totalTests} Passed, ${failed} Failed.`);
  console.log(`Screenshots saved in: ${artifactsDir}`);
  console.log('-------------------------------------------------------------\n');

  if (failed > 0) {
    console.error('Audit failures detected:');
    auditErrors.forEach(e => console.error(e));
    process.exit(1);
  }
}

runPlaywrightAudit();

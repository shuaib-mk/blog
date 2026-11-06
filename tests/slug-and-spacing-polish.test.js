import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { slugify } from '../src/utils/slug.js';

test('slugify converts titles with punctuation and quotes to clean url slugs', () => {
  const title1 = 'The Invisible Threat: Why "Zero-Click" Spyware is the Ultimate Test for Our Digital Privacy';
  const expected1 = 'the-invisible-threat-why-zero-click-spyware-is-the-ultimate-test-for-our-digital-privacy';
  assert.strictEqual(slugify(title1), expected1);

  const title2 = 'testttttt gif';
  assert.strictEqual(slugify(title2), 'testttttt-gif');

  const title3 = '  Hello, World! -- 2026/10/18  ';
  assert.strictEqual(slugify(title3), 'hello-world-2026-10-18');

  assert.strictEqual(slugify(''), '');
  assert.strictEqual(slugify(null), '');
  assert.strictEqual(slugify(undefined), '');
});

test('Header.jsx has refined bottom margin mb-6 sm:mb-8 without excessive mb-10 gap', () => {
  const headerPath = path.resolve('src/components/Header.jsx');
  const content = fs.readFileSync(headerPath, 'utf8');

  assert.ok(content.includes('mb-6 sm:mb-8'), 'Header should have mb-6 sm:mb-8');
  assert.ok(!content.includes('mb-10 border-b'), 'Header should no longer have loose mb-10');
});

test('EntryDetail.jsx removes back link so entry metadata immediately takes up top space', () => {
  const detailPath = path.resolve('src/pages/EntryDetail.jsx');
  const content = fs.readFileSync(detailPath, 'utf8');

  assert.ok(!content.includes('← Back to'), 'Back to journal/writing/updates link should be completely removed');
  assert.ok(content.includes('<header className="mb-6 sm:mb-8">'), 'Entry detail header should have mb-6 sm:mb-8');
});

test('Editor.jsx provides automatic slug syncing, custom slug toggle, and sync button', () => {
  const editorPath = path.resolve('src/pages/admin/Editor.jsx');
  const content = fs.readFileSync(editorPath, 'utf8');

  assert.ok(content.includes('slugify(value)'), 'Editor should auto-slugify title on change');
  assert.ok(content.includes('isCustomSlug'), 'Editor should track custom slug state');
  assert.ok(content.includes('Sync with title'), 'Editor should have a Sync with title button');
  assert.ok(content.includes('RefreshCw'), 'Editor should use RefreshCw icon for sync button');
});

test('Server PUT endpoint normalizes slug and handles duplicate slug collisions', () => {
  // server/index.js now runs the production app from api/index.js.
  const serverPath = path.resolve('api/index.js');
  const content = fs.readFileSync(serverPath, 'utf8');

  assert.ok(content.includes('entries_slug_key'), 'Server PUT should handle entries_slug_key collision');
  assert.ok(content.includes("updateData.slug = payload.title.toLowerCase()"), 'Server should fallback to slugified title if slug is empty');
});

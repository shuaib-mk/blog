import { test } from 'node:test';
import assert from 'node:assert';
import { uploadMediaFile } from '../src/utils/uploadMedia.js';

function fakeFile(size, name = 'photo.jpg', type = 'image/jpeg') {
  return { name, type, size };
}

function mockFetch(script) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url, opts, body: opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : null });
    return script(url, opts, calls);
  };
  return calls;
}

const json = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj, text: async () => JSON.stringify(obj) });

test('a full first bucket is skipped and the file lands in the next one', async () => {
  const calls = mockFetch((url, opts) => {
    if (url === '/api/b2-upload') {
      const excl = JSON.parse(opts.body).excludeBuckets;
      const bucket = excl.includes('q04ti-media-1') ? 'q04ti-media-2' : 'q04ti-media-1';
      return json({ uploadUrl: `https://${bucket}.example/put`, storageKey: 'images/x.jpg', bucket, publicUrl: 'p' });
    }
    if (url.startsWith('https://q04ti-media-1')) return { ok: false, status: 403, text: async () => 'storage cap exceeded' };
    if (url.startsWith('https://q04ti-media-2')) return { ok: true, status: 200, text: async () => '' };
    if (url === '/api/media/confirm') return json({ success: true }, 201);
    throw new Error('unexpected ' + url);
  });
  const out = await uploadMediaFile(fakeFile(8 * 1024 * 1024), 'tok');
  assert.deepStrictEqual(out, { success: true });
  const presigns = calls.filter(c => c.url === '/api/b2-upload');
  assert.strictEqual(presigns.length, 2);
  assert.deepStrictEqual(presigns[1].body.excludeBuckets, ['q04ti-media-1']);
  const confirm = calls.find(c => c.url === '/api/media/confirm');
  assert.strictEqual(confirm.body.bucket, 'q04ti-media-2', 'server checks the bucket it actually landed in');
});

test('big file with every bucket refusing gives a clear error (no server fallback over 4 MB)', async () => {
  const calls = mockFetch((url, opts) => {
    if (url === '/api/b2-upload') {
      const excl = JSON.parse(opts.body).excludeBuckets;
      const order = ['q04ti-media-1', 'q04ti-media-2', 'q04ti-blog'];
      const bucket = order.find(b => !excl.includes(b));
      return json({ uploadUrl: `https://${bucket}.example/put`, storageKey: 'k', bucket });
    }
    if (url.startsWith('https://')) throw new TypeError('Failed to fetch');
    throw new Error('unexpected ' + url);
  });
  await assert.rejects(uploadMediaFile(fakeFile(20 * 1024 * 1024), 'tok'), /Upload failed for this 20\.0 MB file/);
  assert.strictEqual(calls.filter(c => c.url === '/api/b2-upload').length, 3);
  assert.ok(!calls.some(c => c.url === '/api/media/upload'));
});

test('small file falls back to the server upload when direct upload is blocked', async () => {
  const calls = mockFetch((url, opts) => {
    if (url === '/api/b2-upload') {
      const excl = JSON.parse(opts.body).excludeBuckets;
      const order = ['q04ti-media-1', 'q04ti-media-2', 'q04ti-blog'];
      return json({ uploadUrl: 'https://x/put', storageKey: 'k', bucket: order.find(b => !excl.includes(b)) });
    }
    if (url.startsWith('https://')) throw new TypeError('Failed to fetch');
    if (url === '/api/media/upload') return json({ success: true, via: 'server' }, 201);
    throw new Error('unexpected ' + url);
  });
  const out = await uploadMediaFile(fakeFile(300 * 1024), 'tok');
  assert.strictEqual(out.via, 'server');
  assert.ok(calls.some(c => c.url === '/api/media/upload'));
});

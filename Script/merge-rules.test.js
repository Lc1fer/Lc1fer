'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { parseConfig, main, download, cleanupObsoleteFiles } = require('./merge-rules');

async function fixture(t, config) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-rules-test-'));
  // Remove only the exact temporary directory created for this test.
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, 'merge.yaml');
  await fs.writeFile(configFile, config);
  return { dir, configFile, run: () => main({ configFile, outputDir: dir, options: { attempts: 1 } }) };
}

test('reject unsupported YAML values with line numbers', () => {
  for (const value of ['"DOMAIN,a.com"', "'DOMAIN,a.com'", '|', '>', '*alias', '[a, b]', 'DOMAIN,a.com # comment']) {
    assert.throws(() => parseConfig(`keep:\n  rules:\n    add:\n      - ${value}\n`), /Line 4: Unsupported YAML value/);
  }
  assert.throws(() => parseConfig('keep:\nKeep:\n'), /Duplicate output name/);
  assert.throws(() => parseConfig('keep:\n  unknown: []\n'), /Line 2/);
});

test('merge, deduplicate and remove exact rules; unchanged output keeps timestamp', async t => {
  const f = await fixture(t, 'keep:\n  rules:\n    add:\n      - DOMAIN,b.com\n      - DOMAIN,a.com\n      - DOMAIN,b.com\n    remove:\n      - DOMAIN,b.com\n');
  assert.equal((await f.run()).updated, 1);
  const first = await fs.readFile(path.join(f.dir, 'keep.txt'), 'utf8');
  assert.match(first, /\nDOMAIN,a.com\n$/);
  assert(!first.includes('DOMAIN,b.com'));
  assert.equal((await f.run()).unchanged, 1);
  assert.equal(await fs.readFile(path.join(f.dir, 'keep.txt'), 'utf8'), first);
});

test('clean only obsolete top-level TXT files and report deletions', async t => {
  const f = await fixture(t, 'keep:\n  url: []\n');
  for (const name of ['keep.txt', 'obsolete.txt', 'old.TXT', 'notes.json']) {
    await fs.writeFile(path.join(f.dir, name), 'original');
  }
  await fs.mkdir(path.join(f.dir, 'nested.txt'));
  await fs.writeFile(path.join(f.dir, 'nested.txt', 'child.txt'), 'nested');
  const summary = await f.run();
  assert.equal(summary.deleted, 2);
  assert.equal(summary.skipped, 1);
  assert.deepEqual((await fs.readdir(f.dir)).sort(), ['keep.txt', 'merge.yaml', 'nested.txt', 'notes.json']);
  assert.equal(await fs.readFile(path.join(f.dir, 'keep.txt'), 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(f.dir, 'nested.txt', 'child.txt'), 'utf8'), 'nested');
  // An explicitly supplied configuration is protected even with a TXT extension.
  const alternate = path.join(f.dir, 'config.txt');
  await fs.writeFile(alternate, 'keep:\n');
  assert.equal(await cleanupObsoleteFiles({ keep: {} }, f.dir, alternate), 0);
  assert.equal(await fs.readFile(alternate, 'utf8'), 'keep:\n');
});

test('invalid configuration never cleans files', async t => {
  const f = await fixture(t, 'invalid config');
  await fs.writeFile(path.join(f.dir, 'old.txt'), 'original');
  await assert.rejects(f.run(), /Unsupported syntax/);
  assert.equal(await fs.readFile(path.join(f.dir, 'old.txt'), 'utf8'), 'original');
});

test('output cannot overwrite a TXT configuration or trigger cleanup', async t => {
  const f = await fixture(t, 'keep:\n');
  const configFile = path.join(f.dir, 'keep.txt');
  const config = 'keep:\n  rules:\n    add:\n      - DOMAIN,a.com\n';
  await fs.writeFile(configFile, config);
  await fs.writeFile(path.join(f.dir, 'obsolete.txt'), 'original');
  await assert.rejects(main({ configFile, outputDir: f.dir }), /overwrite configuration/);
  assert.equal(await fs.readFile(configFile, 'utf8'), config);
  assert.equal(await fs.readFile(path.join(f.dir, 'obsolete.txt'), 'utf8'), 'original');
});

test('download retries temporary HTTP errors but stops on permanent errors', async t => {
  let calls = 0, cancelled = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? { ok: false, status: 503, statusText: 'Unavailable', body: { cancel: async () => cancelled++ } }
    : { ok: true, text: async () => '# comment\r\nDOMAIN,a.com\rDOMAIN,a.com\n' });
  const options = { attempts: 3, timeoutMs: 1000, retryMs: 1 };
  assert.deepEqual([...await download('https://example.com/rules', options)], ['DOMAIN,a.com']);
  assert.equal(calls, 2);
  assert.equal(cancelled, 1);
  calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { ok: false, status: 404, statusText: 'Missing', body: { cancel: async () => {} } };
  });
  await assert.rejects(download('https://example.com/rules', options), /HTTP 404/);
  assert.equal(calls, 1);
});

test('download timeout also covers reading the response body', async t => {
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => ({
    ok: true,
    text: () => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('body aborted')), { once: true });
    }),
  }));
  await assert.rejects(download('https://example.com/rules', { attempts: 1, timeoutMs: 5, retryMs: 1 }), /body aborted/);
});

test('shared URLs download once and concurrent requests stay within the limit', async t => {
  let active = 0, maximum = 0;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return { ok: true, text: async () => 'DOMAIN,a.com' };
  });
  const f = await fixture(t, 'one:\n  url:\n    - https://example.com/a\n    - https://example.com/b\ntwo:\n  url:\n    - https://example.com/a\n    - https://example.com/c\n');
  const summary = await main({ configFile: f.configFile, outputDir: f.dir, options: { concurrency: 2, attempts: 1 } });
  assert.equal(summary.updated, 2);
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls).size, 3);
  assert.equal(maximum, 2);
});

test('download failure preserves the existing category', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const f = await fixture(t, 'keep:\n  url:\n    - https://example.com/rules\n');
  await fs.writeFile(path.join(f.dir, 'keep.txt'), 'original');
  assert.equal((await f.run()).failed, 1);
  assert.equal(await fs.readFile(path.join(f.dir, 'keep.txt'), 'utf8'), 'original');
});

test('empty download behavior is preserved', async t => {
  t.mock.method(globalThis, 'fetch', async url => ({ ok: true, text: async () => url.endsWith('/empty') ? '' : 'DOMAIN,new.com' }));
  const f = await fixture(t, 'keep:\n  url:\n    - https://example.com/empty\n    - https://example.com/full\n');
  assert.equal((await f.run()).updated, 1);
  assert.match(await fs.readFile(path.join(f.dir, 'keep.txt'), 'utf8'), /DOMAIN,new.com/);
  await fs.writeFile(f.configFile, 'keep:\n  url:\n    - https://example.com/empty\n');
  const before = await fs.readFile(path.join(f.dir, 'keep.txt'), 'utf8');
  assert.equal((await f.run()).skipped, 1);
  assert.equal(await fs.readFile(path.join(f.dir, 'keep.txt'), 'utf8'), before);
});

// Simulate both platforms without depending on the test machine's filesystem.
async function loadWithFilesystem(platform, fakeFs) {
  const source = await fs.readFile(path.join(__dirname, 'merge-rules.js'), 'utf8');
  const context = {
    require: name => name === 'node:fs/promises' ? fakeFs : require(name),
    module: { exports: {} }, __dirname, process: { platform }, console,
  };
  vm.runInNewContext(source, context);
  return context.module.exports;
}

test('cleanup uses Windows case folding and Linux exact names', async () => {
  for (const platform of ['win32', 'linux']) {
    const deleted = [];
    const api = await loadWithFilesystem(platform, {
      readdir: async () => ['Proxy.txt', 'proxy.txt', 'merge.yaml'].map(name => ({ name, isFile: () => true })),
      unlink: async file => deleted.push(path.basename(file)),
    });
    await api.cleanupObsoleteFiles({ proxy: {} }, 'Rule', 'Rule/merge.yaml');
    assert.deepEqual(deleted, platform === 'linux' ? ['Proxy.txt'] : []);
  }
});

test('default paths resolve from script directory', async () => {
  let readPath, outputPath;
  const api = await loadWithFilesystem(process.platform, {
    readFile: async file => { readPath = file; return 'keep:\n'; },
    mkdir: async dir => { outputPath = dir; },
    readdir: async () => [],
  });
  await api.main();
  assert.equal(outputPath, path.resolve(__dirname, '..', 'Rule'));
  assert.equal(readPath, path.join(outputPath, 'merge.yaml'));
});

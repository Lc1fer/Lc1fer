'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');

const OPTIONS = { concurrency: 4, attempts: 3, timeoutMs: 60_000, retryMs: 2_000 };

function parseConfig(text) {
  const result = Object.create(null);
  const names = new Set();
  let current = null;
  let section = null;
  let sections = new Set();
  for (const [index, raw] of text.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const fail = message => { throw new Error(`Line ${index + 1}: ${message}`); };
    if (/^\s*\t/.test(raw)) fail('Use spaces for indentation');
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0 && line.endsWith(':')) {
      const name = line.slice(0, -1).trim();
      if (!/^[A-Za-z0-9._+-]+$/.test(name) || name.endsWith('.') ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
        fail(`Invalid output name: ${name}`);
      }
      const key = name.toLowerCase();
      if (names.has(key)) fail(`Duplicate output name: ${name}`);
      names.add(key);
      current = result[name] = { url: [], rules: [] };
      sections = new Set();
      section = null;
      continue;
    }
    const match = indent === 2 && line.match(/^(url|rules):\s*(\[\s*\])?$/);
    if (current && match) {
      if (sections.has(match[1])) fail(`Duplicate section: ${match[1]}`);
      sections.add(match[1]);
      section = match[2] ? null : match[1];
      continue;
    }
    if (indent >= 4 && current && section && line.startsWith('- ')) {
      const value = line.slice(2).trim();
      if (!value || value.startsWith('#')) continue;
      if (section === 'url') {
        let parsed;
        try { parsed = new URL(value); } catch { fail(`Invalid URL: ${value}`); }
        if (!['http:', 'https:'].includes(parsed.protocol)) fail('URL must use HTTP or HTTPS');
      }
      current[section].push(value);
      continue;
    }
    fail(`Unsupported syntax: ${line}`);
  }
  if (!names.size) throw new Error('No rule categories found');
  return result;
}

function addRules(target, text) {
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (line && !line.startsWith('#')) target.add(line);
  }
  return target;
}

async function download(url, options = OPTIONS) {
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    let failure;
    let retryable = true;
    try {
      const response = await fetch(url, {
        redirect: 'follow', signal: controller.signal,
        headers: { 'User-Agent': 'GitHub-Actions-Rule-Merger' },
      });
      if (!response.ok) {
        retryable = [408, 429].includes(response.status) || response.status >= 500;
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return addRules(new Set(), await response.text());
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
    }
    if (!retryable || attempt === options.attempts) throw failure;
    console.warn(`Retry ${attempt}/${options.attempts - 1}: ${url} (${failure.message})`);
    await sleep(options.retryMs * 2 ** (attempt - 1));
  }
}

async function mapLimit(items, limit, action) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await action(items[index]);
    }
  }));
}

const timeFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

async function atomicWrite(output, content) {
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, output);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function generateRule(name, config, downloads, outputDir) {
  const output = path.join(outputDir, `${name}.txt`);
  if (!config.url.length && !config.rules.length) return 'skipped';
  const rules = new Set();
  for (const url of new Set(config.url)) {
    const result = downloads.get(url);
    if (result.error) {
      console.error(`FAILED: ${name}: ${url}: ${result.error.message}; original file preserved`);
      return 'failed';
    }
    for (const rule of result.rules) rules.add(rule);
  }
  for (const rule of config.rules) addRules(rules, rule);
  if (!rules.size) {
    console.warn(`SKIP: ${name} generated no rules; original file preserved`);
    return 'skipped';
  }
  const sorted = [...rules].sort();
  let oldText;
  try { oldText = await fs.readFile(output, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (oldText !== undefined) {
    const oldRules = addRules(new Set(), oldText);
    if (oldRules.size === rules.size && sorted.every(rule => oldRules.has(rule))) {
      console.log(`UNCHANGED: ${output}`);
      return 'unchanged';
    }
  }
  await atomicWrite(output, `# 更新时间：${timeFormatter.format(new Date())}\n\n${sorted.join('\n')}\n`);
  console.log(`UPDATED: ${output} (${rules.size} unique rules)`);
  return 'updated';
}

async function main({ configFile = path.join('Rule', 'merge.yaml'), outputDir = 'Rule', options = OPTIONS } = {}) {
  const settings = { ...OPTIONS, ...options };
  for (const key of Object.keys(OPTIONS)) {
    if (!Number.isSafeInteger(settings[key]) || settings[key] < 1) throw new Error(`Invalid option: ${key}`);
  }
  const config = parseConfig(await fs.readFile(configFile, 'utf8'));
  await fs.mkdir(outputDir, { recursive: true });
  const urls = [...new Set(Object.values(config).flatMap(item => item.url))];
  const downloads = new Map();
  await mapLimit(urls, settings.concurrency, async url => {
    console.log(`Downloading: ${url}`);
    try { downloads.set(url, { rules: await download(url, settings) }); }
    catch (error) { downloads.set(url, { error }); }
  });
  const summary = { updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  for (const [name, item] of Object.entries(config)) {
    try { summary[await generateRule(name, item, downloads, outputDir)]++; }
    catch (error) {
      summary.failed++;
      console.error(`FAILED: ${name}: ${error.message}`);
    }
  }
  console.log('Summary:', summary);
  return summary;
}

if (require.main === module) {
  main().then(summary => {
    if (summary.failed) process.exitCode = 1;
  }).catch(error => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseConfig, addRules, download, main };

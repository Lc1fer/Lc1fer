'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');

// 自动清理未在配置中保留的直属 TXT 文件：true 启用，false 关闭。
const CLEANUP_ENABLED = false;

const OPTIONS = Object.freeze({ concurrency: 4, attempts: 3, timeoutMs: 60_000, retryMs: 2_000 });
const MAX_TIMER_MS = 2 ** 31 - 1;

const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, '..', 'Rule');

// Only category -> url / rules -> add / remove is supported.
// Values must be unquoted, single-line strings; comments occupy their own lines.
function parseConfig(text) {
  const result = Object.create(null);
  const names = new Set();
  let current = null;
  let section = null;
  let ruleAction = null;
  let sections = new Set();
  let ruleActions = new Set();
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
      current = result[name] = { url: [], rules: { add: [], remove: [] } };
      sections = new Set();
      ruleActions = new Set();
      section = null;
      ruleAction = null;
      continue;
    }
    const match = indent === 2 && line.match(/^(url|rules):\s*(\[\s*\])?$/);
    if (current && match) {
      if (sections.has(match[1])) fail(`Duplicate section: ${match[1]}`);
      sections.add(match[1]);
      section = match[2] ? null : match[1];
      ruleAction = null;
      continue;
    }
    const actionMatch = indent === 4 && line.match(/^(add|remove):\s*(\[\s*\])?$/);
    if (current && section === 'rules' && actionMatch) {
      if (ruleActions.has(actionMatch[1])) fail(`Duplicate rule action: ${actionMatch[1]}`);
      ruleActions.add(actionMatch[1]);
      ruleAction = actionMatch[2] ? null : actionMatch[1];
      continue;
    }
    if (current && ((section === 'url' && indent === 4) ||
        (section === 'rules' && ruleAction && indent === 6)) && line.startsWith('- ')) {
      const value = line.slice(2).trim();
      if (!value || value.startsWith('#')) continue;
      if (/^["'|>\[\]{}&*!%@`]/.test(value) || /\s#|:\s/.test(value) || /^(?:null|true|false|~)$/i.test(value)) {
        fail('Unsupported YAML value; use an unquoted single-line value and separate comment lines');
      }
      if (section === 'url') {
        let parsed;
        try { parsed = new URL(value); } catch { fail(`Invalid URL: ${value}`); }
        if (!['http:', 'https:'].includes(parsed.protocol)) fail('URL must use HTTP or HTTPS');
      }
      if (section === 'url') current.url.push(value);
      else current.rules[ruleAction].push(value);
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

function resolveOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Invalid options: use an object');
  }
  const settings = { ...OPTIONS, ...options };
  for (const key of Object.keys(OPTIONS)) {
    if (!Number.isSafeInteger(settings[key]) || settings[key] < 1 ||
        ((key === 'timeoutMs' || key === 'retryMs') && settings[key] > MAX_TIMER_MS)) {
      throw new Error(`Invalid option: ${key}`);
    }
  }
  return settings;
}

async function download(url, options = {}) {
  const settings = resolveOptions(options);
  for (let attempt = 1; attempt <= settings.attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
    let failure;
    let retryable = true;
    try {
      const response = await fetch(url, {
        redirect: 'follow', signal: controller.signal,
        headers: { 'User-Agent': 'GitHub-Actions-Rule-Merger' },
      });
      if (!response.ok) {
        retryable = [408, 429].includes(response.status) || response.status >= 500;
        // Discard the body without hiding the HTTP failure if cancellation fails.
        try { await response.body?.cancel(); } catch {}
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return addRules(new Set(), await response.text());
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
    }
    if (!retryable || attempt === settings.attempts) throw failure;
    console.warn(`Retry ${attempt}/${settings.attempts - 1}: ${url} (${failure.message})`);
    // Node.js otherwise turns overflowing delays into a 1 ms timer.
    await sleep(Math.min(settings.retryMs * 2 ** (attempt - 1), MAX_TIMER_MS));
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
  if (!config.url.length && !config.rules.add.length) return 'skipped';
  const rules = new Set();
  for (const url of config.url) {
    const result = downloads.get(url);
    if (result.error) {
      console.error(`FAILED: ${name}: ${url}: ${result.error.message}; original file preserved`);
      return 'failed';
    }
    for (const rule of result.rules) rules.add(rule);
  }
  for (const rule of config.rules.add) addRules(rules, rule);
  if (!rules.size) {
    console.warn(`SKIP: ${name} generated no rules; original file preserved`);
    return 'skipped';
  }
  // Apply removals last so they override both downloaded and added rules.
  for (const rule of addRules(new Set(), config.rules.remove.join('\n'))) rules.delete(rule);
  let oldText;
  try { oldText = await fs.readFile(output, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (oldText !== undefined) {
    const oldRules = addRules(new Set(), oldText);
    if (oldRules.size === rules.size && oldRules.isSupersetOf(rules)) {
      console.log(`UNCHANGED: ${output}`);
      return 'unchanged';
    }
  }
  // Allocate and sort only when the output actually needs to change.
  const sorted = [...rules].sort();
  await atomicWrite(output, `# 更新时间：${timeFormatter.format(new Date())}\n\n${sorted.join('\n')}\n`);
  console.log(`UPDATED: ${output} (${rules.size} unique rules)`);
  return 'updated';
}

// Windows paths are case-insensitive; Linux paths must match exactly.
function fileKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

async function resolveFilePaths(outputDir, configFile) {
  const [realOutputDir, realConfigFile, realConfigDir] = await Promise.all([
    fs.realpath(outputDir), fs.realpath(configFile), fs.realpath(path.dirname(path.resolve(configFile))),
  ]);
  // Protect both a configuration symlink and its target, including directory aliases.
  const protectedPaths = new Set([
    path.resolve(configFile), realConfigFile, path.join(realConfigDir, path.basename(configFile)),
  ].map(fileKey));
  return { realOutputDir, protectedPaths };
}

function assertSafeOutputs(config, outputDir, protectedPaths) {
  for (const name of Object.keys(config)) {
    if (protectedPaths.has(fileKey(path.join(outputDir, `${name}.txt`)))) {
      throw new Error(`Output would overwrite configuration: ${name}.txt`);
    }
  }
}

async function cleanupObsoleteFiles(config, outputDir, configFile, resolvedPaths) {
  const { realOutputDir, protectedPaths } = resolvedPaths ?? await resolveFilePaths(outputDir, configFile);
  const expectedFiles = new Set(Object.keys(config).map(name => fileKey(name + '.txt')));
  let deleted = 0;
  for (const entry of await fs.readdir(realOutputDir, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.txt' ||
        expectedFiles.has(fileKey(entry.name))) continue;
    const output = path.join(realOutputDir, entry.name);
    if (protectedPaths.has(fileKey(output))) continue;
    await fs.unlink(output);
    deleted++;
    console.log('DELETED: ' + output);
  }
  return deleted;
}

// Count category users so shared sources download once and are released after last use.
function createDownloadCache(categories) {
  const downloads = new Map();
  for (const [, config] of categories) {
    for (const url of config.url) {
      const cached = downloads.get(url);
      if (cached) cached.remainingUsers++;
      else downloads.set(url, { remainingUsers: 1 });
    }
  }
  return downloads;
}

async function downloadSources(downloads, settings) {
  await mapLimit([...downloads.keys()], settings.concurrency, async url => {
    const cached = downloads.get(url);
    console.log(`Downloading: ${url}`);
    try { cached.rules = await download(url, settings); }
    catch (error) { cached.error = error; }
  });
}

function releaseDownloads(config, downloads) {
  for (const url of config.url) {
    const cached = downloads.get(url);
    if (--cached.remainingUsers === 0) downloads.delete(url);
  }
}

async function main({
  configFile = path.join(DEFAULT_OUTPUT_DIR, 'merge.yaml'),
  outputDir = DEFAULT_OUTPUT_DIR,
  options = {},
  cleanupEnabled = CLEANUP_ENABLED,
} = {}) {
  if (typeof cleanupEnabled !== 'boolean') throw new Error('Invalid option: cleanupEnabled; use true or false');
  const settings = resolveOptions(options);
  const config = parseConfig(await fs.readFile(configFile, 'utf8'));
  await fs.mkdir(outputDir, { recursive: true });
  const resolvedPaths = await resolveFilePaths(outputDir, configFile);
  assertSafeOutputs(config, resolvedPaths.realOutputDir, resolvedPaths.protectedPaths);

  // Deduplicate each category once; preserve the original configuration for cleanup.
  const categories = Object.entries(config).map(([name, item]) => [
    name, { ...item, url: [...new Set(item.url)] },
  ]);
  const downloads = createDownloadCache(categories);
  await downloadSources(downloads, settings);

  const summary = { updated: 0, unchanged: 0, skipped: 0, failed: 0, deleted: 0 };
  for (const [name, item] of categories) {
    try { summary[await generateRule(name, item, downloads, resolvedPaths.realOutputDir)]++; }
    catch (error) {
      summary.failed++;
      console.error(`FAILED: ${name}: ${error.message}`);
    } finally {
      releaseDownloads(item, downloads);
    }
  }
  try {
    if (cleanupEnabled) {
      summary.deleted = await cleanupObsoleteFiles(config, resolvedPaths.realOutputDir, configFile, resolvedPaths);
    } else {
      console.log('CLEANUP DISABLED: obsolete TXT files preserved');
    }
  } finally {
    // Keep completed generation results visible even when directory cleanup fails.
    console.log('Summary:', summary);
  }
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

module.exports = { parseConfig, addRules, download, cleanupObsoleteFiles, main };

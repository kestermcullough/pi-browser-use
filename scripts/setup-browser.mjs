#!/usr/bin/env node
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const MANIFEST = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
const APP_BINARY = 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const ARCHIVE_ROOT = 'chrome-mac-arm64';
const runNative = promisify(execFile);
const within = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
const archiveKey = (name) => name.replace(/\/$/, '').normalize('NFD').toLowerCase();
const exists = async (name) => fs.lstat(name).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

async function usableCurrent(base) {
  const current = path.join(base, 'current');
  if (!await exists(current)) return false;
  try {
    const root = await fs.realpath(current);
    if (!within(base, root) || root === base) throw new Error('current escapes the browser directory');
    const binary = path.join(current, APP_BINARY);
    const resolved = await fs.realpath(binary);
    if (!within(root, resolved)) throw new Error('browser executable escapes its installation');
    if (!(await fs.stat(binary)).isFile()) return false;
    await fs.access(binary, constants.X_OK);
    return true;
  } catch (error) {
    if (['ENOENT', 'EACCES'].includes(error.code)) return false;
    throw error;
  }
}

async function checkParents(home, base) {
  // Do not follow user-created redirects into profiles or other installations.
  for (const relative of ['.pi', '.pi/browser-use', '.pi/browser-use/browser']) {
    const stat = await exists(path.join(home, relative));
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error(`Refusing non-directory or symlink: ${relative}`);
    }
  }
  return base;
}

async function receive(fetchImpl, url, limit, consume) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetchImpl(url, { redirect: 'error', signal: controller.signal });
    if (!response.ok || (response.url && response.url !== url)) throw new Error(`Download refused: ${url}`);
    if (!response.body) throw new Error('Empty download');
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error('Download exceeds size limit');
      await consume(chunk);
    }
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

function stableDownload(manifest) {
  const stable = manifest?.channels?.Stable;
  const version = stable?.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid Stable version');
  const entries = stable?.downloads?.chrome;
  if (!Array.isArray(entries)) throw new Error('Missing Stable Chrome downloads');
  const matches = entries.filter((entry) => entry?.platform === 'mac-arm64');
  const url = `https://storage.googleapis.com/chrome-for-testing-public/${version}/mac-arm64/chrome-mac-arm64.zip`;
  if (matches.length !== 1 || matches[0].url !== url) throw new Error('Untrusted Stable download URL');
  return { version, url };
}

// Inspect the central directory before extraction, including symlink attributes.
// ZIP64 and unusual archives are deliberately refused rather than guessed at.
async function archiveEntries(archive) {
  const file = await fs.open(archive, 'r');
  try {
    const { size } = await file.stat();
    const tail = Buffer.alloc(Math.min(size, 65557));
    await file.read(tail, 0, tail.length, size - tail.length);
    let end = tail.length - 22;
    while (end >= 0 && !(tail.readUInt32LE(end) === 0x06054b50 && end + 22 + tail.readUInt16LE(end + 20) === tail.length)) end--;
    if (end < 0) throw new Error('Invalid ZIP directory');
    const count = tail.readUInt16LE(end + 10);
    const length = tail.readUInt32LE(end + 12);
    const offset = tail.readUInt32LE(end + 16);
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || count !== tail.readUInt16LE(end + 8) || count === 65535 || !count || length > 8 * 1024 * 1024 || offset + length !== size - tail.length + end) throw new Error('Unsupported ZIP directory');
    const directory = Buffer.alloc(length);
    await file.read(directory, 0, length, offset);
    const entries = [];
    const names = new Set();
    let cursor = 0;
    let expanded = 0;
    while (cursor < length) {
      if (cursor + 46 > length || directory.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP entry');
      const nameLength = directory.readUInt16LE(cursor + 28);
      const next = cursor + 46 + nameLength + directory.readUInt16LE(cursor + 30) + directory.readUInt16LE(cursor + 32);
      if (next > length) throw new Error('Invalid ZIP entry length');
      const name = new TextDecoder('utf-8', { fatal: true }).decode(directory.subarray(cursor + 46, cursor + 46 + nameLength));
      const parts = name.replace(/\/$/, '').split('/');
      if (parts[0] !== ARCHIVE_ROOT || parts.some((part) => !part || part === '.' || part === '..') || /[\\\x00-\x1f\x7f*?\[\]]/.test(name) || names.has(archiveKey(name))) throw new Error('Unsafe archive path');
      names.add(archiveKey(name));
      const mode = directory.readUInt32LE(cursor + 38) >>> 16;
      const kind = mode & 0xf000;
      if ((directory.readUInt16LE(cursor + 8) & 1) || ![0, 8].includes(directory.readUInt16LE(cursor + 10)) || ![0, 0x8000, 0x4000, 0xa000].includes(kind)) throw new Error('Unsupported archive entry');
      if (kind === 0xa000 && name.endsWith('/')) throw new Error('Invalid archive symlink');
      const localOffset = directory.readUInt32LE(cursor + 42);
      const local = Buffer.alloc(30);
      if (localOffset + 30 > offset || (await file.read(local, 0, 30, localOffset)).bytesRead !== 30 || local.readUInt32LE(0) !== 0x04034b50) throw new Error('Invalid ZIP local header');
      const localName = Buffer.alloc(local.readUInt16LE(26));
      await file.read(localName, 0, localName.length, localOffset + 30);
      if (!localName.equals(directory.subarray(cursor + 46, cursor + 46 + nameLength)) || local.readUInt16LE(6) !== directory.readUInt16LE(cursor + 8) || local.readUInt16LE(8) !== directory.readUInt16LE(cursor + 10) || localOffset + 30 + localName.length + local.readUInt16LE(28) + directory.readUInt32LE(cursor + 20) > offset) throw new Error('Inconsistent ZIP local header');
      expanded += directory.readUInt32LE(cursor + 24);
      if (expanded > 2 * 1024 ** 3) throw new Error('Archive exceeds extraction limit');
      entries.push({ name, symlink: kind === 0xa000 });
      cursor = next;
    }
    if (entries.length !== count || !names.has(archiveKey(`${ARCHIVE_ROOT}/${APP_BINARY}`))) throw new Error('Missing Chrome archive layout');
    for (const entry of entries.filter((entry) => entry.symlink)) {
      if (entries.some((other) => archiveKey(other.name).startsWith(`${archiveKey(entry.name)}/`))) throw new Error('Archive writes through a symlink');
    }
    return entries;
  } finally {
    await file.close();
  }
}

async function validateExtracted(root) {
  const realRoot = await fs.realpath(root);
  async function walk(directory) {
    for (const name of await fs.readdir(directory)) {
      const entry = path.join(directory, name);
      const stat = await fs.lstat(entry);
      if (!within(realRoot, await fs.realpath(entry))) throw new Error('Extracted symlink escapes installation');
      if (stat.isDirectory()) await walk(entry);
      else if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('Unsupported extracted file');
    }
  }
  await walk(root);
  const binary = path.join(root, APP_BINARY);
  if (!(await fs.stat(binary)).isFile()) throw new Error('Missing Chrome executable');
  await fs.access(binary, constants.X_OK);
}

export async function setupBrowser({ home = os.homedir(), platform = process.platform, arch = process.arch, fetchImpl = globalThis.fetch, runCommand = runNative } = {}) {
  if (platform !== 'darwin' || arch !== 'arm64') throw new Error('Browser setup supports only macOS Apple Silicon (darwin/arm64)');
  home = await fs.realpath(home);
  const base = await checkParents(home, path.join(home, '.pi/browser-use/browser'));
  if (await usableCurrent(base)) return path.join(base, 'current', APP_BINARY);
  if (await exists(path.join(base, 'current'))) throw new Error('Refusing to replace an unknown or unusable current installation');

  const chunks = [];
  await receive(fetchImpl, MANIFEST, 1024 * 1024, async (chunk) => chunks.push(Buffer.from(chunk)));
  const { version, url } = stableDownload(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  const staging = await fs.mkdtemp(path.join(base, '.setup-'));
  const destination = path.join(base, `chrome-${version}-${path.basename(staging).slice(7)}`);
  let published = false;
  let moved = false;
  const command = (args, maxBuffer = 8 * 1024 * 1024) => runCommand('/usr/bin/unzip', args, { timeout: 120_000, maxBuffer, killSignal: 'SIGKILL' });
  try {
    const archive = path.join(staging, 'chrome.zip');
    const output = await fs.open(archive, 'wx', 0o600);
    try {
      await receive(fetchImpl, url, 512 * 1024 * 1024, async (chunk) => {
        let offset = 0;
        while (offset < chunk.length) offset += (await output.write(chunk, offset, chunk.length - offset)).bytesWritten;
      });
    } finally {
      await output.close();
    }
    const entries = await archiveEntries(archive);
    const links = new Map();
    for (const entry of entries.filter((entry) => entry.symlink)) {
      const { stdout } = await command(['-p', archive, entry.name], 16 * 1024);
      if (!stdout || /[\x00-\x1f\x7f\\]/.test(stdout) || path.posix.isAbsolute(stdout)) throw new Error('Unsafe archive symlink');
      links.set(archiveKey(entry.name), stdout);
    }
    for (const name of links.keys()) {
      const pending = name.split('/');
      const resolved = [];
      let followed = 0;
      while (pending.length) {
        const part = pending.shift();
        if (part === '..') {
          if (resolved.length <= 1) throw new Error('Unsafe archive symlink');
          resolved.pop();
        } else if (part && part !== '.') {
          resolved.push(part);
          const target = links.get(archiveKey(resolved.join('/')));
          if (target !== undefined) {
            if (++followed > 40) throw new Error('Archive symlink cycle');
            resolved.pop();
            pending.unshift(...target.split('/'));
          }
        }
      }
    }
    const extracted = path.join(staging, 'extracted');
    await fs.mkdir(extracted, { mode: 0o700 });
    await command(['-q', archive, '-d', extracted]);
    if ((await fs.readdir(extracted)).join() !== ARCHIVE_ROOT) throw new Error('Unexpected extracted archive layout');
    const root = path.join(extracted, ARCHIVE_ROOT);
    if (!(await fs.lstat(root)).isDirectory()) throw new Error('Invalid extracted archive root');
    await validateExtracted(root);
    await fs.writeFile(path.join(root, 'install.json'), `${JSON.stringify({ version, platform: 'mac-arm64', manifest: MANIFEST, url, installedAt: new Date().toISOString() })}\n`, { flag: 'wx', mode: 0o600 });
    if (await exists(destination)) throw new Error('Installation destination already exists');
    await fs.rename(root, destination);
    moved = true;
    try {
      // Creation is atomic and cannot replace a concurrent installer's current.
      await fs.symlink(path.basename(destination), path.join(base, 'current'));
      published = true;
    } catch (error) {
      if (error.code !== 'EEXIST' || !await usableCurrent(base)) throw error;
    }
    return path.join(base, 'current', APP_BINARY);
  } finally {
    if (moved && !published) await fs.rm(destination, { recursive: true, force: true });
    await fs.rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  setupBrowser().then((binary) => console.log(`Chrome for Testing ready: ${binary}`)).catch((error) => {
    console.error(`Browser setup failed: ${error.message}`);
    process.exitCode = 1;
  });
}

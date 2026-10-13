import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setupBrowser } from '../scripts/setup-browser.mjs';

const version = '123.0.4567.89';
const manifestURL = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
const downloadURL = `https://storage.googleapis.com/chrome-for-testing-public/${version}/mac-arm64/chrome-mac-arm64.zip`;
const binary = 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const root = 'chrome-mac-arm64';
const manifest = () => ({ channels: { Stable: { version, downloads: { chrome: [{ platform: 'mac-arm64', url: downloadURL }] } } } });

// A minimal ZIP directory fixture; extraction is always mocked, never launches Chrome.
function zip(entries = [{ name: `${root}/${binary}`, mode: 0o100755 }]) {
  let offset = 0;
  const locals = [];
  const records = entries.map(({ name, mode = 0o100644 }) => {
    const text = Buffer.from(name);
    const record = Buffer.alloc(46 + text.length);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(0x0314, 4);
    record.writeUInt16LE(text.length, 28);
    record.writeUInt32LE((mode << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    text.copy(record, 46);
    const local = Buffer.alloc(30 + text.length);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(text.length, 26);
    text.copy(local, 30);
    locals.push(local);
    offset += local.length;
    return record;
  });
  const directory = Buffer.concat(records);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function fixture(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'setup-browser-test-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const base = path.join(home, '.pi/browser-use/browser');
  const profile = path.join(home, '.pi/browser-use/profile/sentinel');
  await fs.mkdir(path.dirname(profile), { recursive: true });
  await fs.writeFile(profile, 'untouched');
  return { home, base, profile };
}

async function install(rootPath) {
  const executable = path.join(rootPath, binary);
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, 'mock executable', { mode: 0o755 });
}

function dependencies(home, { metadata = manifest(), archive = zip(), extract, linkTargets = {} } = {}) {
  const requests = [];
  const commands = [];
  return {
    requests, commands,
    options: {
      home, platform: 'darwin', arch: 'arm64',
      fetchImpl: async (url, options) => {
        requests.push(url);
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal instanceof AbortSignal);
        assert.ok([manifestURL, downloadURL].includes(url));
        return new Response(url === manifestURL ? JSON.stringify(metadata) : archive);
      },
      runCommand: async (command, args, options) => {
        commands.push(args);
        assert.equal(command, '/usr/bin/unzip');
        assert.equal(options.timeout, 120_000);
        assert.equal(options.killSignal, 'SIGKILL');
        if (args[0] === '-p') return { stdout: linkTargets[args[2]] ?? '../outside' };
        assert.equal(args[0], '-q');
        const directory = args[3];
        if (extract) await extract(directory);
        else await install(path.join(directory, root));
        return { stdout: '' };
      },
    },
  };
}

async function unchanged({ base, profile }) {
  assert.equal(await fs.readFile(profile, 'utf8'), 'untouched');
  const contents = await fs.readdir(base).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  assert.deepEqual(contents, []);
}

test('installed fast path performs no fetch, command, or filesystem mutation', async (t) => {
  const f = await fixture(t);
  await install(path.join(f.base, 'existing'));
  await fs.symlink('existing', path.join(f.base, 'current'));
  const before = await fs.lstat(path.join(f.base, 'current'));
  const d = dependencies(f.home);
  assert.equal(await setupBrowser(d.options), path.join(f.base, 'current', binary));
  assert.deepEqual(d.requests, []);
  assert.deepEqual(d.commands, []);
  assert.equal((await fs.lstat(path.join(f.base, 'current'))).mtimeMs, before.mtimeMs);
  assert.equal(await fs.readFile(f.profile, 'utf8'), 'untouched');
});

test('unsupported platform and architecture are refused before network or mutation', async (t) => {
  for (const [platform, arch] of [['linux', 'arm64'], ['darwin', 'x64']]) {
    const f = await fixture(t);
    const d = dependencies(f.home);
    await assert.rejects(setupBrowser({ ...d.options, platform, arch }), /macOS Apple Silicon/);
    assert.deepEqual(d.requests, []);
    await unchanged(f);
  }
});

test('official Stable download publishes a versioned install and provenance, then is idempotent', async (t) => {
  const f = await fixture(t);
  const d = dependencies(f.home);
  await setupBrowser(d.options);
  assert.deepEqual(d.requests, [manifestURL, downloadURL]);
  const target = await fs.readlink(path.join(f.base, 'current'));
  assert.match(target, /^chrome-123\.0\.4567\.89-[A-Za-z0-9]+$/);
  assert.deepEqual((await fs.readdir(f.base)).sort(), [target, 'current'].sort());
  const provenance = JSON.parse(await fs.readFile(path.join(f.base, target, 'install.json')));
  assert.equal(provenance.version, version);
  assert.equal(provenance.url, downloadURL);
  assert.equal(provenance.manifest, manifestURL);
  assert.equal(provenance.platform, 'mac-arm64');
  const again = dependencies(f.home);
  await setupBrowser(again.options);
  assert.deepEqual(again.requests, []);
  assert.equal(await fs.readFile(f.profile, 'utf8'), 'untouched');
});

test('malformed or untrusted metadata is refused without staging', async (t) => {
  for (const change of [
    (m) => { m.channels.Stable.version = '../bad'; },
    (m) => { m.channels.Stable.downloads.chrome[0].url = 'https://evil.example/chrome.zip'; },
    (m) => { m.channels.Stable.downloads.chrome[0].url = downloadURL.replace('https:', 'http:'); },
    (m) => { m.channels.Stable.downloads.chrome[0].url += '?redirect=evil'; },
    (m) => { m.channels.Stable.downloads.chrome.push(m.channels.Stable.downloads.chrome[0]); },
    (m) => { delete m.channels.Stable.downloads; },
  ]) {
    const f = await fixture(t);
    const metadata = manifest();
    change(metadata);
    const d = dependencies(f.home, { metadata });
    await assert.rejects(setupBrowser(d.options), /Invalid Stable|Untrusted Stable|Missing Stable/);
    assert.deepEqual(d.requests, [manifestURL]);
    await unchanged(f);
  }
});

test('malformed archive, traversal, wrong layout and symlink write-through are refused before extraction', async (t) => {
  const inconsistent = zip();
  inconsistent[30] = 'x'.charCodeAt(0);
  for (const archive of [
    inconsistent,
    Buffer.from('not a zip'),
    zip([{ name: `${root}/../escape` }]),
    zip([{ name: '/absolute' }]),
    zip([{ name: 'other-root/file' }]),
    zip([{ name: `${root}/missing-binary` }]),
    zip([{ name: `${root}/${binary}` }, { name: `${root}/link`, mode: 0o120777 }, { name: `${root}/link/file` }]),
    zip([{ name: `${root}/${binary}` }, { name: `${root}/Link`, mode: 0o120777 }, { name: `${root}/link/file` }]),
    zip([{ name: `${root}/${binary}` }, { name: `${root}/file` }, { name: `${root}/File` }]),
  ]) {
    const f = await fixture(t);
    const d = dependencies(f.home, { archive });
    await assert.rejects(setupBrowser(d.options), /ZIP|archive|layout/i);
    assert.deepEqual(d.commands, []);
    await unchanged(f);
  }
});

test('archive symlink escape and cycles are refused before extraction', async (t) => {
  for (const targets of [
    { [`${root}/link`]: '../../outside' },
    { [`${root}/link`]: '/outside' },
    { [`${root}/link`]: 'link' },
    { [`${root}/link`]: '.', [`${root}/second`]: 'link/../outside' },
  ]) {
    const f = await fixture(t);
    const archive = zip([{ name: `${root}/${binary}` }, ...Object.keys(targets).map((name) => ({ name, mode: 0o120777 }))]);
    const d = dependencies(f.home, { archive, linkTargets: targets });
    await assert.rejects(setupBrowser(d.options), /symlink/);
    assert.ok(d.commands.every((args) => args[0] === '-p'));
    await unchanged(f);
  }
});

test('valid internal framework-style symlinks are supported', async (t) => {
  const f = await fixture(t);
  const link = `${root}/Versions/Current`;
  const d = dependencies(f.home, {
    archive: zip([{ name: `${root}/${binary}` }, { name: link, mode: 0o120777 }]),
    linkTargets: { [link]: 'A' },
    extract: async (directory) => {
      const installation = path.join(directory, root);
      await install(installation);
      await fs.mkdir(path.join(installation, 'Versions/A'), { recursive: true });
      await fs.symlink('A', path.join(installation, 'Versions/Current'));
    },
  });
  await setupBrowser(d.options);
  assert.equal(await fs.readFile(f.profile, 'utf8'), 'untouched');
});

test('extraction failures or invalid extracted layout clean only own staging', async (t) => {
  for (const extract of [
    async () => { throw new Error('mock extraction failure'); },
    async (directory) => { await fs.mkdir(path.join(directory, 'unexpected')); },
    async (directory) => {
      await install(path.join(directory, root));
      await fs.symlink('../../../outside', path.join(directory, root, 'escape'));
    },
    async (directory) => {
      await install(path.join(directory, root));
      await fs.chmod(path.join(directory, root, binary), 0o600);
    },
  ]) {
    const f = await fixture(t);
    await fs.mkdir(f.base, { recursive: true });
    await fs.writeFile(path.join(f.base, '.setup-not-ours'), 'preserve');
    const d = dependencies(f.home, { extract });
    await assert.rejects(setupBrowser(d.options));
    assert.deepEqual(await fs.readdir(f.base), ['.setup-not-ours']);
    assert.equal(await fs.readFile(f.profile, 'utf8'), 'untouched');
  }
});

test('unknown current and escaping current or parent symlinks are never replaced', async (t) => {
  for (const type of ['directory', 'dangling', 'escape', 'parent']) {
    const f = await fixture(t);
    await fs.mkdir(f.base, { recursive: true });
    const current = path.join(f.base, 'current');
    if (type === 'directory') await fs.mkdir(current);
    if (type === 'dangling') await fs.symlink('missing', current);
    if (type === 'escape') {
      await install(path.join(f.home, 'outside'));
      await fs.symlink(path.join(f.home, 'outside'), current);
    }
    if (type === 'parent') {
      await fs.rmdir(f.base);
      await fs.mkdir(path.join(f.home, 'outside'));
      await fs.symlink(path.join(f.home, 'outside'), f.base);
    }
    const before = await fs.lstat(type === 'parent' ? f.base : current);
    const d = dependencies(f.home);
    await assert.rejects(setupBrowser(d.options), /Refusing|escapes/);
    assert.deepEqual(d.requests, []);
    assert.equal((await fs.lstat(type === 'parent' ? f.base : current)).ino, before.ino);
    assert.equal(await fs.readFile(f.profile, 'utf8'), 'untouched');
  }
});

test('a concurrent publisher wins without overwrite; losing setup cleans its installation', async (t) => {
  const f = await fixture(t);
  const d = dependencies(f.home, {
    extract: async (directory) => {
      await install(path.join(directory, root));
      await install(path.join(f.base, 'winner'));
      await fs.writeFile(path.join(f.base, 'winner/install.json'), 'winner provenance');
      await fs.symlink('winner', path.join(f.base, 'current'));
    },
  });
  await setupBrowser(d.options);
  assert.deepEqual((await fs.readdir(f.base)).sort(), ['current', 'winner']);
  assert.equal(await fs.readlink(path.join(f.base, 'current')), 'winner');
  assert.equal(await fs.readFile(path.join(f.base, 'winner/install.json'), 'utf8'), 'winner provenance');
  assert.equal(await fs.readFile(f.profile, 'utf8'), 'untouched');
});

test('network failure cleans staging without touching existing unrelated installation', async (t) => {
  const f = await fixture(t);
  await install(path.join(f.base, 'older'));
  const d = dependencies(f.home);
  const fetch = d.options.fetchImpl;
  d.options.fetchImpl = async (url, options) => {
    if (url === downloadURL) throw new Error('offline download failure');
    return fetch(url, options);
  };
  await assert.rejects(setupBrowser(d.options), /offline download failure/);
  assert.deepEqual(await fs.readdir(f.base), ['older']);
  assert.equal(await fs.readFile(path.join(f.base, 'older', binary), 'utf8'), 'mock executable');
  assert.equal(await fs.readFile(f.profile, 'utf8'), 'untouched');
});

test('HTTP errors, unexpected response origins, invalid JSON and oversized metadata are refused', async (t) => {
  for (const response of [
    () => new Response('unavailable', { status: 503 }),
    () => ({ ok: true, url: 'https://evil.example/manifest', body: [] }),
    () => new Response('{invalid'),
    () => new Response('x'.repeat(1024 * 1024 + 1)),
  ]) {
    const f = await fixture(t);
    const d = dependencies(f.home);
    d.options.fetchImpl = async () => response();
    await assert.rejects(setupBrowser(d.options));
    assert.deepEqual(d.commands, []);
    await unchanged(f);
  }
});

test('an unusable concurrent current is preserved and unpublished setup is removed', async (t) => {
  const f = await fixture(t);
  const d = dependencies(f.home, {
    extract: async (directory) => {
      await install(path.join(directory, root));
      await fs.mkdir(path.join(f.base, 'current'));
      await fs.writeFile(path.join(f.base, 'current/sentinel'), 'unknown winner');
    },
  });
  await assert.rejects(setupBrowser(d.options), { code: 'EEXIST' });
  assert.deepEqual(await fs.readdir(f.base), ['current']);
  assert.equal(await fs.readFile(path.join(f.base, 'current/sentinel'), 'utf8'), 'unknown winner');
  assert.equal(await fs.readFile(f.profile, 'utf8'), 'untouched');
});

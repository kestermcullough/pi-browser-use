import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function eventually(check, timeout = 15_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await delay(50); }
  assert.fail('Condition did not settle within deadline.');
}
async function exists(path) { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function fixture({ directory = process.cwd() } = {}) {
  // Keep the socket path below macOS's Unix socket length limit.
  const home = await mkdtemp(join(tmpdir(), 'bu-'));
  const binary = join(home, '.pi/browser-use/browser/current/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  await mkdir(join(binary, '..'), { recursive: true });
  const fake = fileURLToPath(new URL('./fake-chrome.mjs', import.meta.url));
  await writeFile(binary, `#!/bin/bash\nexec -a "$0" '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o700 });
  await chmod(binary, 0o700);
  const helperFixture = fileURLToPath(new URL('./fake-helper.mjs', import.meta.url));
  const helperBinaries = [];
  for (const suffix of ['', ' (GPU)', ' (Renderer)', ' Impostor']) {
    const name = `Google Chrome for Testing Helper${suffix}`;
    const helper = join(binary, '../../Frameworks/Google Chrome for Testing Framework.framework/Versions/152.0.0.0/Helpers', `${name}.app/Contents/MacOS`, name);
    await mkdir(join(helper, '..'), { recursive: true });
    await writeFile(helper, `#!/bin/bash\nexec -a "$0" '${process.execPath}' '${helperFixture}' "$@"\n`, { mode: 0o700 });
    helperBinaries.push(helper);
  }
  const root = join(home, '.pi/browser-use');
  const owner = join(root, 'shared/owner.json');
  const guardian = join(root, 'shared/guardian.json');
  const sdkLock = join(root, 'profile/.bu-pi.lock');
  const socket = join(root, 'shared/owner.sock');
  const state = join(root, 'profile/fixture-state.json');
  const children = [];
  function launch(environment = {}) {
    const child = spawn(process.execPath, ['worker.mjs'], { cwd: directory, env: { ...process.env, ...environment, HOME: home, DO_NOT_TRACK: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    let id = 0;
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const pending = new Map();
    createInterface({ input: child.stdout }).on('line', line => {
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); message.error ? waiter.reject(new Error(message.error)) : waiter.resolve(message.result); }
    });
    child.on('exit', () => { for (const waiter of pending.values()) waiter.reject(new Error(`Client exited: ${stderr}`)); pending.clear(); });
    return {
      child,
      request(action, code, timeoutMs = 5000) {
        const current = ++id;
        const promise = bounded(new Promise((resolve, reject) => pending.set(current, { resolve, reject })), timeoutMs + 8000, `Fixture request ${current}: ${code?.slice(0, 80)}`);
        child.stdin.write(JSON.stringify({ id: current, action, code, timeoutMs }) + '\n');
        return { id: current, promise };
      },
      cell(code, timeoutMs) { return this.request('execute', code, timeoutMs).promise; },
      cancel(id) { child.stdin.write(JSON.stringify({ id, action: 'cancel' }) + '\n'); },
      async close(eof = false) {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit');
        if (eof) child.stdin.end(); else child.stdin.write(JSON.stringify({ action: 'shutdown' }) + '\n');
        try {
          const [code] = await bounded(exited, 8000, 'Fixture bridge close');
          assert.equal(code, 0, stderr);
        } catch (error) { child.kill('SIGKILL'); throw error; }
      },
    };
  }
  async function recover() {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { preparePaths } from './shared-paths.mjs';
      import { acquireOwner, releaseOwner } from './owner-lock.mjs';
      await preparePaths(); const identity = await acquireOwner();
      if (identity) await releaseOwner(identity);
    `], { cwd: directory, env: { ...process.env, HOME: home, DO_NOT_TRACK: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(child);
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    const [code] = await bounded(once(child, 'exit'), 30_000, 'Fixture recovery');
    assert.equal(code, 0, stderr);
  }
  async function cleanup() {
    return bounded(cleanupProcesses(), 12_000, `Fixture cleanup ${home}`).catch(error => {
      console.error(`PRESERVED FIXTURE: ${home}`, error);
      throw error;
    });
  }
  async function cleanupProcesses() {
    const log = join(root, 'shared/service.log');
    if (await exists(log)) {
      const diagnostics = await readFile(log, 'utf8');
      if (diagnostics) console.log('Fixture service diagnostics:', diagnostics);
    }
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (await exists(owner)) {
      const record = await json(owner);
      if (alive(record.pid)) {
        // Resume the exact fixture owner if this test stopped it, then let it clean up.
        process.kill(record.pid, 'SIGCONT');
        process.kill(record.pid, 'SIGTERM');
      } else {
        await recover();
      }
      await eventually(async () => !await exists(owner), 8000);
    }
    await rm(home, { recursive: true, force: true });
  }
  return { home, root, owner, guardian, sdkLock, socket, state, binary, helperBinaries, launch, recover, cleanup };
}

test('relocated package starts and shares a browser from a directory with spaces and Unicode', { timeout: 25_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'bp-'));
  const directory = join(temporary, 'browser package café');
  let f;
  try {
    await mkdir(directory);
    for (const name of ['package.json', 'worker.mjs', 'service.mjs', 'guardian.mjs', 'shared-paths.mjs', 'owner-lock.mjs', 'owned-group.mjs', 'sdk-session.mjs', 'launch-browser.sh']) {
      await copyFile(fileURLToPath(new URL('../' + name, import.meta.url)), join(directory, name));
    }
    await symlink(await realpath(fileURLToPath(new URL('../node_modules', import.meta.url))), join(directory, 'node_modules'));
    f = await fixture({ directory });
    const a = f.launch(); const b = f.launch();
    await Promise.all([a.cell('var marker="relocated-A"; console.log(await page.info());'), b.cell('var marker="relocated-B"; console.log(await page.info());')]);
    assert.equal((await a.cell('console.log(marker);')).text.trim(), 'relocated-A');
    assert.equal((await b.cell('console.log(marker);')).text.trim(), 'relocated-B');
    assert.equal((await json(f.state)).targets.length, 3);
    await a.close();
    assert.equal((await b.cell('console.log(marker);')).text.trim(), 'relocated-B');
    await b.close();
    await eventually(async () => !await exists(f.owner) && !await exists(f.sdkLock));
  } finally {
    if (f) await f.cleanup();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('shared browser: startup race, real SDK REPL/target isolation, reset/reconnect, lifecycle and private IPC', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const a = f.launch(); const b = f.launch();
    const [ar, br] = await Promise.all([
      a.cell('var marker = "A"; console.log(page.targetId);'),
      b.cell('var marker = "B"; console.log(page.targetId);'),
    ]);
    const aid = ar.text.trim(); const bid = br.text.trim();
    assert.notEqual(aid, bid);
    const state = await json(f.state);
    assert.equal(state.targets.length, 3, 'One initial browser tab plus one per client');
    const events = await readFile(join(f.root, 'profile/fixture-events.jsonl'), 'utf8');
    assert.equal(events.split('\n').filter(line => line && JSON.parse(line).method === 'launch').length, 1, 'Startup race must launch only one browser');
    for (const path of [f.root, join(f.root, 'shared'), join(f.root, 'workspace')]) assert.equal((await stat(path)).mode & 0o777, 0o700);
    assert.equal((await stat(f.socket)).mode & 0o777, 0o600);
    assert.equal((await stat(f.owner)).mode & 0o777, 0o600);
    assert.equal((await stat(f.sdkLock)).mode & 0o777, 0o600);
    assert.equal((await a.cell('console.log(marker);')).text.trim(), 'A');
    assert.equal((await b.cell('console.log(marker);')).text.trim(), 'B');
    assert.deepEqual(JSON.parse((await a.cell('console.log(JSON.stringify((await tabs.list()).map(t => t.targetId)));')).text), [aid]);
    await assert.rejects(a.cell(`await tabs.get(${JSON.stringify(bid)});`), /another client/);
    await assert.rejects(a.cell('await browser.send("Browser.close");'), /service-owned/);
    const opened = await a.cell('var extra = await tabs.open(); console.log(extra.targetId);');
    const extra = opened.text.trim();
    assert.equal((await a.cell(`console.log((await tabs.get(${JSON.stringify(extra)})).targetId);`)).text.trim(), extra);
    const popup = JSON.parse((await a.cell(`console.log(JSON.stringify(await browser.send('Fixture.popup', {openerId: ${JSON.stringify(aid)}})));`)).text).targetId;
    assert.equal((await a.cell(`console.log((await tabs.get(${JSON.stringify(popup)})).targetId);`)).text.trim(), popup);
    // Persist nested popup ownership before its intermediate opener disappears.
    const nested = JSON.parse((await a.cell(`console.log(JSON.stringify(await browser.send('Fixture.popup', {openerId: ${JSON.stringify(popup)}})));`)).text).targetId;
    await a.cell('await tabs.list();');
    await a.cell(`await browser.send('Target.closeTarget', {targetId: ${JSON.stringify(popup)}});`);
    await a.cell('await reconnect();');
    assert.equal((await a.cell(`console.log((await tabs.get(${JSON.stringify(nested)})).targetId);`)).text.trim(), nested);
    assert.equal((await a.cell('console.log(marker);')).text.trim(), 'A');
    const targetsBefore = JSON.parse((await a.cell('console.log(JSON.stringify((await tabs.list()).map(t => t.targetId)));')).text);
    assert.deepEqual(new Set(targetsBefore), new Set([aid, extra, nested]));
    const loop = a.request('execute', 'while (true) {}', 1000);
    await assert.rejects(loop.promise, /exceeded 1000 ms/);
    assert.equal((await b.cell('console.log(marker); console.log(page.targetId);')).text.trim(), `B\n${bid}`);
    assert.equal((await a.cell('console.log(typeof marker); console.log(page.targetId);')).text.trim(), `undefined\n${aid}`);
    await assert.rejects(a.cell(`await tabs.get(${JSON.stringify(bid)});`), /another client/);
    assert.equal((await a.cell(`console.log((await tabs.get(${JSON.stringify(nested)})).targetId);`)).text.trim(), nested);
    const cancelled = a.request('execute', 'while (true) {}', 10_000);
    await delay(200); a.cancel(cancelled.id);
    await assert.rejects(cancelled.promise, /cancelled/);
    await a.cell('await reconnect(); console.log(JSON.stringify((await tabs.list()).map(t => t.targetId)));');
    assert.equal((await a.cell(`console.log((await tabs.get(${JSON.stringify(nested)})).targetId);`)).text.trim(), nested);
    assert.equal((await b.cell('console.log(marker);')).text.trim(), 'B');
    const afterReset = (await a.cell('console.log((await tabs.open()).targetId);')).text.trim();
    assert.equal((await a.cell(`console.log((await tabs.get(${JSON.stringify(afterReset)})).targetId);`)).text.trim(), afterReset);
    await a.close();
    await eventually(async () => (await json(f.state)).targets.length === 2);
    assert.equal((await b.cell('console.log(marker);')).text.trim(), 'B');
    const c = f.launch();
    await c.cell('var marker = "C";');
    c.child.kill('SIGKILL');
    await eventually(async () => (await json(f.state)).targets.length === 2);
    assert.equal((await b.cell('console.log(marker);')).text.trim(), 'B');
    const browserPid = state.pid;
    const ownerPid = (await json(f.owner)).pid;
    await b.close(true);
    await eventually(async () => !await exists(f.owner) && !await exists(f.sdkLock) && !await exists(f.socket) && !alive(browserPid) && !alive(ownerPid));
    const finalEvents = await readFile(join(f.root, 'profile/fixture-events.jsonl'), 'utf8');
    assert.match(finalEvents, /Browser.close/);
  } finally { await f.cleanup(); }
});

test('shared browser: owner SIGKILL recovery and final abrupt client release', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const a = f.launch();
    const workerPid = Number((await a.cell('var marker = "old"; console.log(process.pid);')).text.trim());
    const blocked = a.cell('while (true) {}', 60_000).catch(error => error);
    await delay(200);
    const previous = await json(f.owner);
    const browserPid = (await json(f.state)).pid;
    process.kill(previous.pid, 'SIGKILL');
    await eventually(() => !alive(browserPid) && !alive(workerPid));
    assert.ok(await blocked instanceof Error);
    const b = f.launch();
    assert.equal((await b.cell('console.log(typeof marker);')).text.trim(), 'undefined');
    const replacement = await json(f.owner);
    assert.notEqual(replacement.token, previous.token);
    const newPid = (await json(f.state)).pid;
    b.child.kill('SIGKILL');
    await eventually(async () => !await exists(f.owner) && !await exists(f.sdkLock) && !await exists(f.socket) && !alive(newPid));
  } finally { await f.cleanup(); }
});

test('shared browser: orphan/interrupted-claim recovery verifies identity; legacy locks fail closed', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const a = f.launch();
    await a.cell('console.log(page.targetId);');
    const record = await json(f.guardian);
    const owner = await json(f.owner);
    // Kill the owner first, then its exact fixture guardian before EOF cleanup.
    process.kill(record.pid, 'SIGSTOP');
    process.kill(owner.pid, 'SIGKILL');
    process.kill(record.pid, 'SIGKILL');
    await eventually(() => !alive(record.pid));
    assert.ok(alive(record.browserPid));
    // Durable claim from a verified dead fixture PID simulates a killed recovery worker.
    await writeFile(join(f.root, 'shared', `recover-${owner.token}`), String(record.pid), { mode: 0o600 });
    const b = f.launch();
    await b.cell('console.log(page.targetId);');
    assert.ok(!alive(record.browserPid));
    await b.close();
    await eventually(async () => !await exists(f.owner));
    await writeFile(f.sdkLock, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    const c = f.launch();
    await assert.rejects(c.cell('console.log(page.targetId);'), /guardian exited|could not start|connection lost|Client exited/);
    assert.equal((await json(f.sdkLock)).pid, process.pid, 'Must not unlink an unknown legacy/live lock');
    await c.close();
    await eventually(async () => !alive((await json(f.owner)).pid));
    assert.ok(await exists(f.guardian), 'Unknown profile lock must retain the generation evidence');
    await rm(f.sdkLock);
    await f.recover();
  } finally { await f.cleanup(); }
});

test('shared browser: stopped bridge loses only its lease; stopped owner watchdog cleans browser and locks', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const a = f.launch(); const b = f.launch();
    await Promise.all([a.cell('var marker = "A";'), b.cell('var marker = "B";')]);
    a.child.kill('SIGSTOP');
    await eventually(async () => (await json(f.state)).targets.length === 2, 15_000);
    assert.equal((await b.cell('console.log(marker);')).text.trim(), 'B');
    // Resume only the exact fixture bridge so Node can reap it.
    a.child.kill('SIGCONT');
    await eventually(() => a.child.exitCode !== null);
    const owner = await json(f.owner);
    const browserPid = (await json(f.state)).pid;
    process.kill(owner.pid, 'SIGSTOP');
    await eventually(async () => !alive(browserPid) && !await exists(f.owner) && !await exists(f.sdkLock) && !await exists(f.socket), 20_000);
    const c = f.launch();
    assert.equal((await c.cell('console.log(typeof marker);')).text.trim(), 'undefined');
    await c.close();
    await eventually(async () => !await exists(f.owner));
  } finally { await f.cleanup(); }
});

test('SDK isolation adapter fails clearly on unsupported runtime shape', async () => {
  const { checkSDK } = await import('../sdk-session.mjs');
  assert.throws(() => checkSDK({ runtime: {} }), /Incompatible Browser Use SDK API/);
  assert.doesNotThrow(() => checkSDK({ runtime: { owned: new Set(), terminate() {} }, browser: { endpoint: 'ws://fixture' } }));
});

test('shared browser: owner death during browser startup cannot launch overlapping profile owners', { timeout: 40_000 }, async () => {
  const f = await fixture();
  try {
    const a = f.launch({ FAKE_CHROME_START_DELAY_MS: '1500' });
    const interrupted = a.cell('console.log(page.targetId);').catch(error => error);
    await eventually(async () => await exists(f.guardian) && await exists(f.state));
    const initialGuardian = await json(f.guardian);
    assert.equal(initialGuardian.endpoint, undefined, 'Fixture must still be initializing');
    const originalBrowser = (await json(f.state)).pid;
    const originalOwner = await json(f.owner);
    process.kill(originalOwner.pid, 'SIGKILL');
    const b = f.launch();
    await b.cell('var marker = "replacement"; console.log(page.targetId);');
    assert.ok(await interrupted instanceof Error);
    assert.ok(!alive(originalBrowser));
    assert.equal((await b.cell('console.log(marker);')).text.trim(), 'replacement');
    await b.close();
    await eventually(async () => !await exists(f.owner) && !await exists(f.sdkLock));
  } finally { await f.cleanup(); }
});

test('owned-group cleanup refuses unrelated/reused identities and owner crash never signals other groups', { timeout: 30_000 }, async () => {
  const { processIdentity, closeOwnedGroup } = await import('../owned-group.mjs');
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const f = await fixture();
  try {
    const identity = await processIdentity(unrelated.pid);
    assert.equal(identity.group, unrelated.pid);
    await assert.rejects(closeOwnedGroup(identity.group, [{ ...identity, started: 'not the original birth identity' }]), /refusing group cleanup/);
    assert.ok(alive(unrelated.pid));
    const a = f.launch();
    const workerPid = Number((await a.cell('console.log(process.pid);')).text.trim());
    const blocked = a.cell('while (true) {}', 60_000).catch(error => error);
    await delay(100);
    process.kill((await json(f.owner)).pid, 'SIGKILL');
    await eventually(async () => !alive(workerPid) && !await exists(f.owner) && !await exists(f.sdkLock));
    assert.ok(await blocked instanceof Error);
    assert.ok(alive(unrelated.pid), 'Cleanup must not signal the unrelated detached group');
  } finally {
    try {
      if (unrelated.exitCode === null && unrelated.signalCode === null) {
        const exited = once(unrelated, 'exit');
        unrelated.kill('SIGTERM');
        await bounded(exited, 2000, 'Unrelated fixture process exit');
      }
    } finally { await f.cleanup(); }
  }
});

const lifecyclePreload = fileURLToPath(new URL('./lifecycle-interleaving.mjs', import.meta.url));
function interleavingEnvironment(f, flags) {
  return { NODE_OPTIONS: `--import=${lifecyclePreload}`, LIFECYCLE_INTERLEAVING: f.home, ...flags };
}

test('service startup idle arbitration never arms over a client accepted during socket chmod', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const a = f.launch(interleavingEnvironment(f, { PAUSE_SOCKET_CHMOD: '1', FAKE_CHROME_START_DELAY_MS: '6500' }));
    const running = a.cell('console.log("cold startup survived");', 10_000);
    await eventually(() => exists(join(f.home, 'chmod.entered')));
    await eventually(() => exists(f.state));
    assert.ok(await exists(join(f.home, 'chmod.entered')), 'Browser starts for accepted client while socket chmod remains paused');
    await writeFile(join(f.home, 'chmod.continue'), 'continue');
    assert.equal((await running).text.trim(), 'cold startup survived');
    const browserPid = (await json(f.state)).pid;
    await a.close();
    await eventually(async () => !await exists(f.owner) && !alive(browserPid));
  } finally { await f.cleanup(); }
});

for (const startupDelay of [0, 2000, 6000]) {
  test(`guardian-only SIGKILL preserves generation and recovers Chrome (${startupDelay ? `initialization ${startupDelay}ms` : 'ready'})`, { timeout: 40_000 }, async () => {
    const f = await fixture();
    try {
      const a = f.launch({ FAKE_CHROME_START_DELAY_MS: String(startupDelay) });
      const pending = a.cell('console.log(page.targetId);', 10_000).catch(error => error);
      await eventually(async () => await exists(f.state) && await exists(f.sdkLock));
      if (!startupDelay) assert.ok(!(await pending instanceof Error));
      const previous = await json(f.owner);
      const record = await json(f.guardian);
      const browserPid = (await json(f.state)).pid;
      if (startupDelay) assert.equal(record.endpoint, undefined, 'Kill in pre-endpoint spawn window');
      process.kill(record.pid, 'SIGKILL');
      await eventually(() => !alive(previous.pid));
      assert.equal((await json(f.owner)).token, previous.token);
      assert.deepEqual(await json(f.guardian), record, 'Unexpected death must not discard or overwrite evidence');
      assert.ok(alive(browserPid));
      if (startupDelay) assert.ok(await pending instanceof Error);
      const b = f.launch();
      assert.equal((await b.cell('console.log("recovered");', 10_000)).text.trim(), 'recovered');
      assert.ok(!alive(browserPid), 'Original browser closes before replacement launch');
      assert.notEqual((await json(f.owner)).token, previous.token);
      const events = (await readFile(join(f.root, 'profile/fixture-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.ok(events.findIndex(e => e.pid === browserPid && e.method === 'Browser.close') < events.findLastIndex(e => e.method === 'launch'));
      await b.close();
      await eventually(async () => !await exists(f.owner) && !await exists(f.sdkLock));
    } finally { await f.cleanup(); }
  });
}

test('guardian dead-generation retirement serializes instrumented replacement acquisition', { timeout: 40_000 }, async () => {
  const f = await fixture();
  try {
    const a = f.launch(interleavingEnvironment(f, { PAUSE_GENERATION_RETIRE: '1' }));
    await a.cell('console.log(page.targetId);');
    const previous = await json(f.owner);
    process.kill(previous.pid, 'SIGKILL');
    await eventually(() => exists(join(f.home, 'retire.entered')));
    const b = f.launch();
    const replacementRequest = b.cell('console.log("replacement");', 10_000);
    await delay(600);
    assert.equal((await json(f.owner)).token, previous.token, 'A claimant cannot retire a generation while guardian retirement is paused');
    await writeFile(join(f.home, 'retire.continue'), 'continue');
    assert.equal((await replacementRequest).text.trim(), 'replacement');
    const replacement = await json(f.owner);
    assert.notEqual(replacement.token, previous.token);
    await delay(300);
    assert.deepEqual(await json(f.owner), replacement, 'Late old cleanup cannot unlink replacement owner');
    assert.equal((await b.cell('console.log("still owned");')).text.trim(), 'still owned');
    await b.close();
    await eventually(async () => !await exists(f.owner));
  } finally {
    await writeFile(join(f.home, 'retire.continue'), 'continue');
    await f.cleanup();
  }
});

test('initialization recovery refuses ambiguous dedicated-profile processes and unrelated endpoint identity', { timeout: 40_000 }, async () => {
  const f = await fixture();
  const unrelated = await fixture();
  let decoy;
  try {
    const peer = unrelated.launch();
    await peer.cell('console.log("unrelated profile");');
    const unrelatedPid = (await json(unrelated.state)).pid;
    const a = f.launch({ FAKE_CHROME_START_DELAY_MS: '6000' });
    const interrupted = a.cell('console.log(page.targetId);').catch(error => error);
    await eventually(async () => await exists(f.state) && await exists(f.sdkLock));
    const previous = await json(f.owner);
    const record = await json(f.guardian);
    process.kill(record.pid, 'SIGKILL');
    await eventually(() => !alive(previous.pid));
    assert.ok(await interrupted instanceof Error);
    decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', `--user-data-dir=${await realpath(join(f.root, 'profile'))}`], { stdio: 'ignore' });
    await delay(100);
    await assert.rejects(f.recover(), /Ambiguous profile processes/);
    assert.equal((await json(f.owner)).token, previous.token);
    assert.deepEqual(await json(f.guardian), record);
    const exited = once(decoy, 'exit'); decoy.kill('SIGTERM'); await bounded(exited, 2000, 'Decoy exit');
    const portFile = join(f.root, 'profile/DevToolsActivePort');
    await writeFile(portFile, await readFile(join(unrelated.root, 'profile/DevToolsActivePort')));
    await assert.rejects(f.recover(), /Browser identity changed/);
    assert.ok(alive(unrelatedPid), 'Mismatched endpoint must not close unrelated profile');
    assert.ok(alive((await json(f.state)).pid));
    assert.equal((await json(f.owner)).token, previous.token);
    await rm(portFile);
    await f.recover();
    assert.ok(!alive((await json(f.state)).pid));
    assert.equal((await peer.cell('console.log("still unrelated");')).text.trim(), 'still unrelated');
    await peer.close();
    await eventually(async () => !await exists(unrelated.owner));
  } finally {
    if (decoy?.exitCode === null && decoy.signalCode === null) decoy.kill('SIGKILL');
    try { await f.cleanup(); } finally { await unrelated.cleanup(); }
  }
});

test('guardian-only SIGKILL before SDK spawn retains generation until stable profile absence is verified', { timeout: 25_000 }, async () => {
  const f = await fixture();
  try {
    const a = f.launch(interleavingEnvironment(f, { PAUSE_GUARDIAN_INITIALIZATION: '1' }));
    const pending = a.cell('console.log(page.targetId);').catch(error => error);
    await eventually(() => exists(join(f.home, 'initialize.entered')));
    const previous = await json(f.owner);
    const record = await json(f.guardian);
    assert.ok(!await exists(f.sdkLock) && !await exists(f.state));
    process.kill(record.pid, 'SIGKILL');
    await eventually(() => !alive(previous.pid));
    assert.ok(await pending instanceof Error);
    assert.deepEqual(await json(f.guardian), record);
    assert.equal((await json(f.owner)).token, previous.token);
    const b = f.launch();
    await b.cell('console.log("fresh after verified absence");');
    assert.notEqual((await json(f.owner)).token, previous.token);
    await b.close();
    await eventually(async () => !await exists(f.owner));
  } finally { await f.cleanup(); }
});

test('service refuses to overwrite guardian evidence even when its owner record is missing', { timeout: 25_000 }, async () => {
  const f = await fixture();
  const evidence = { pid: process.pid, token: '11111111-1111-1111-1111-111111111111', endpoint: 'ws://127.0.0.1:1/devtools/browser/evidence' };
  try {
    await mkdir(join(f.root, 'shared'), { recursive: true, mode: 0o700 });
    await writeFile(f.guardian, JSON.stringify(evidence), { mode: 0o600 });
    const a = f.launch();
    await assert.rejects(a.cell('console.log(page.targetId);'), /EEXIST/);
    await a.close();
    await eventually(async () => !alive((await json(f.owner)).pid));
    assert.deepEqual(await json(f.guardian), evidence);
    assert.ok(!await exists(f.state));
    // Only the test-created sentinel is removed; production fails closed.
    await rm(f.guardian);
    await f.recover();
  } finally {
    if (await exists(f.guardian) && (await json(f.guardian)).token === evidence.token) await rm(f.guardian);
    await f.cleanup();
  }
});

for (const [startupDelay, genericGPU] of [[0, false], [2000, false], [2000, true]]) {
  test(`owner-lock recovers one main with canonical GPU/utility/renderer helpers (${startupDelay ? 'PID-only initialization' : 'ready record'}${genericGPU ? ', generic GPU binary' : ''})`, { timeout: 30_000 }, async () => {
    const f = await fixture();
    try {
      const a = f.launch({ FAKE_CHROME_HELPERS: '1', FAKE_CHROME_START_DELAY_MS: String(startupDelay), ...(genericGPU ? { FAKE_CHROME_GENERIC_GPU: '1' } : {}) });
      const pending = a.cell('console.log(page.targetId);', 10_000).catch(error => error);
      await eventually(async () => await exists(f.state) && await exists(f.sdkLock));
      if (!startupDelay) assert.ok(!(await pending instanceof Error));
      const original = await json(f.state);
      assert.equal(original.helpers.length, 3);
      assert.ok(original.helpers.every(alive), 'All fixture helpers are real running children');
      const previous = await json(f.owner);
      const guardian = await json(f.guardian);
      if (startupDelay) assert.equal(guardian.endpoint, undefined);
      process.kill(guardian.pid, 'SIGKILL');
      await eventually(() => !alive(previous.pid));
      assert.deepEqual(await json(f.guardian), guardian);
      const b = f.launch();
      assert.equal((await b.cell('console.log("helper recovery succeeded");', 10_000)).text.trim(), 'helper recovery succeeded');
      assert.ok(!alive(original.pid));
      assert.ok(original.helpers.every(pid => !alive(pid)), 'Profile and non-profile helpers exit before replacement');
      assert.notEqual((await json(f.owner)).token, previous.token);
      const events = (await readFile(join(f.root, 'profile/fixture-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.ok(events.findIndex(e => e.pid === original.pid && e.method === 'Browser.close') < events.findLastIndex(e => e.method === 'launch'));
      await b.close();
      await eventually(async () => !await exists(f.owner) && !await exists(f.sdkLock));
    } finally { await f.cleanup(); }
  });
}

test('owner-lock refuses typed impostors, lookalike helpers, wrong groups/roles and multiple mains without closing or discarding evidence', { timeout: 35_000 }, async () => {
  const f = await fixture();
  let decoy;
  try {
    const a = f.launch();
    await a.cell('console.log(page.targetId);');
    const original = await json(f.state);
    const previous = await json(f.owner);
    const guardian = await json(f.guardian);
    const lock = await json(f.sdkLock);
    process.kill(guardian.pid, 'SIGKILL');
    await eventually(() => !alive(previous.pid));
    const profileArgument = `--user-data-dir=${await realpath(join(f.root, 'profile'))}`;
    const helperFixture = fileURLToPath(new URL('./fake-helper.mjs', import.meta.url));
    const cases = [
      ['typed arbitrary executable', process.execPath, [helperFixture, '--type=renderer', profileArgument], /Ambiguous profile processes/],
      ['lookalike helper name', f.helperBinaries[3], ['--type=utility', profileArgument], /Ambiguous profile processes/],
      ['canonical helper in wrong group', f.helperBinaries[0], ['--type=utility', profileArgument], /helper user\/group changed/],
      ['canonical GPU helper with renderer role', f.helperBinaries[1], ['--type=renderer', profileArgument], /helper role/],
      ['multiple main candidates', '/bin/bash', ['-c', 'exec -a "$1" "$2" "$3" "$4"', 'fixture', f.binary, process.execPath, helperFixture, profileArgument], /Ambiguous profile processes/],
    ];
    for (const [label, command, args, error] of cases) {
      decoy = spawn(command, args, { detached: true, stdio: 'ignore' });
      await delay(100);
      assert.ok(alive(decoy.pid), label);
      await assert.rejects(f.recover(), error, label);
      assert.ok(alive(original.pid), label);
      assert.ok(alive(decoy.pid), 'Recovery never signals an unproven process');
      assert.deepEqual(await json(f.owner), previous);
      assert.deepEqual(await json(f.guardian), guardian);
      assert.deepEqual(await json(f.sdkLock), lock);
      const exited = once(decoy, 'exit'); decoy.kill('SIGTERM'); await bounded(exited, 2000, label);
    }
    const helperScript = await readFile(f.helperBinaries[0]);
    const external = join(f.home, 'external-helper');
    await writeFile(external, helperScript, { mode: 0o700 });
    await rm(f.helperBinaries[0]);
    await symlink(external, f.helperBinaries[0]);
    try {
      decoy = spawn(f.helperBinaries[0], ['--type=utility', profileArgument], { detached: true, stdio: 'ignore' });
      await delay(100);
      await assert.rejects(f.recover(), /helper executable/);
      assert.ok(alive(original.pid) && alive(decoy.pid));
      assert.deepEqual(await json(f.owner), previous);
      assert.deepEqual(await json(f.guardian), guardian);
      assert.deepEqual(await json(f.sdkLock), lock);
    } finally {
      if (decoy.exitCode === null && decoy.signalCode === null) {
        const exited = once(decoy, 'exit'); decoy.kill('SIGTERM'); await bounded(exited, 2000, 'External helper exit');
      }
      await rm(f.helperBinaries[0]);
      await writeFile(f.helperBinaries[0], helperScript, { mode: 0o700 });
    }
    const framework = join(f.binary, '../../Frameworks/Google Chrome for Testing Framework.framework');
    const externalFramework = join(f.home, 'external-framework');
    await rm(externalFramework, { recursive: true, force: true });
    await rename(framework, externalFramework);
    await symlink(externalFramework, framework);
    let frameworkDecoy;
    try {
      frameworkDecoy = spawn(f.helperBinaries[0], ['--type=utility', profileArgument], { detached: true, stdio: 'ignore' });
      await delay(100);
      await assert.rejects(f.recover(), /framework root/);
      assert.ok(alive(original.pid));
      assert.deepEqual(await json(f.owner), previous);
      assert.deepEqual(await json(f.guardian), guardian);
      assert.deepEqual(await json(f.sdkLock), lock);
    } finally {
      if (frameworkDecoy?.exitCode === null && frameworkDecoy?.signalCode === null) {
        const exited = once(frameworkDecoy, 'exit'); frameworkDecoy.kill('SIGTERM'); await bounded(exited, 2000, 'Framework symlink helper exit');
      }
      await rm(framework);
      await rename(externalFramework, framework);
    }
    for (const [change, error] of [
      [{ group: guardian.pid + 1 }, /Guardian group identity changed/],
      [{ parent: guardian.pid }, /Guardian lineage changed/],
      [{ browserPid: guardian.pid }, /Browser identity changed/],
      [{ endpoint: 'ws://example.invalid:9222/devtools/browser/unrelated' }, /nonlocal browser endpoint/],
    ]) {
      const record = { ...guardian, ...change };
      await writeFile(f.guardian, JSON.stringify(record));
      await assert.rejects(f.recover(), error);
      assert.ok(alive(original.pid));
      assert.deepEqual(await json(f.guardian), record);
      assert.deepEqual(await json(f.owner), previous);
      assert.deepEqual(await json(f.sdkLock), lock);
    }
    await writeFile(f.guardian, JSON.stringify(guardian));
    const events = (await readFile(join(f.root, 'profile/fixture-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(!events.some(e => e.method === 'Browser.close'), 'Every refusal precedes Browser.close');
    await f.recover();
    assert.ok(!alive(original.pid));
  } finally {
    if (decoy?.exitCode === null && decoy.signalCode === null) {
      const exited = once(decoy, 'exit'); decoy.kill('SIGKILL'); await bounded(exited, 2000, 'Decoy cleanup');
    }
    await f.cleanup();
  }
});

test('owner-lock refuses a canonical same-group helper with unrelated ancestry', { timeout: 25_000 }, async () => {
  const f = await fixture();
  let proxyPid;
  let helperPid;
  try {
    const a = f.launch();
    await a.cell('console.log(page.targetId);');
    ({ proxyPid, helperPid } = JSON.parse((await a.cell(`console.log(JSON.stringify(await browser.send('Fixture.unrelatedHelper', {binary: ${JSON.stringify(f.helperBinaries[0])}})));`)).text));
    const previous = await json(f.owner);
    const guardian = await json(f.guardian);
    const browserPid = (await json(f.state)).pid;
    const lock = await json(f.sdkLock);
    process.kill(guardian.pid, 'SIGKILL');
    await eventually(() => !alive(previous.pid));
    await assert.rejects(f.recover(), /helper lineage changed/);
    assert.ok(alive(browserPid) && alive(proxyPid) && alive(helperPid));
    assert.deepEqual(await json(f.owner), previous);
    assert.deepEqual(await json(f.guardian), guardian);
    assert.deepEqual(await json(f.sdkLock), lock);
    process.kill(proxyPid, 'SIGKILL');
    await eventually(() => !alive(proxyPid));
    await assert.rejects(f.recover(), /helper lineage changed/);
    assert.ok(alive(browserPid) && alive(helperPid));
    assert.deepEqual(await json(f.owner), previous);
    assert.deepEqual(await json(f.guardian), guardian);
    assert.deepEqual(await json(f.sdkLock), lock);
    const events = (await readFile(join(f.root, 'profile/fixture-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(!events.some(e => e.method === 'Browser.close'), 'Orphan refusal precedes Browser.close');
    process.kill(helperPid, 'SIGTERM');
    process.kill(browserPid, 'SIGTERM');
    await rm(f.owner, { force: true });
    await rm(f.guardian, { force: true });
    await rm(f.sdkLock, { force: true });
  } finally {
    if (proxyPid && alive(proxyPid)) process.kill(proxyPid, 'SIGTERM');
    if (helperPid && alive(helperPid)) process.kill(helperPid, 'SIGTERM');
    if (helperPid) process.kill(helperPid, 'SIGKILL');
    if (await exists(f.owner)) await rm(f.owner, { force: true });
    await rm(f.guardian, { force: true });
    await rm(f.sdkLock, { force: true });
    await f.cleanup();
  }
});

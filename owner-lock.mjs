import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { link, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { CDP } from '@browser_use/pi';
import { alive, executablePath, guardianPath, ownerPath, profileDir, readJSON, runDir, sleep, socketPath } from './shared-paths.mjs';

const exec = promisify(execFile);
async function optionalJSON(path) {
  try { return await readJSON(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
// Every actor retiring a generation uses this immutable claim chain. A crashed
// claimant's successor gets a new path; no check-then-unlink of a shared mutex.
async function arbitrate(identity, action) {
  if (typeof identity.token !== 'string' || !/^[a-f0-9-]{36}$/.test(identity.token)) throw new Error('Unknown owner record; refusing recovery.');
  let claim = join(runDir, `recover-${identity.token}`);
  const candidate = join(runDir, `${randomUUID()}.recovery-candidate`);
  await writeFile(candidate, String(process.pid), { flag: 'wx', mode: 0o600 });
  try {
    for (let depth = 0; ; depth++) {
      if (depth === 16) throw new Error('Too many interrupted recoveries; refusing ambiguous ownership.');
      try { await link(candidate, claim); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const pid = Number(await readFile(claim, 'utf8'));
        if (alive(pid)) return false;
        claim += `-${pid}`;
      }
    }
  } finally { await rm(candidate, { force: true }); }
  if ((await optionalJSON(ownerPath))?.token !== identity.token) return false;
  return action();
}
async function processSnapshot() {
  const { stdout } = await exec('ps', ['-axo', 'pid=,uid=,ppid=,pgid=,lstart=,command='], { timeout: 1500 });
  return stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), user: Number(match[2]), parent: Number(match[3]), group: Number(match[4]), started: match[5], command: match[6] }] : [];
  });
}
function hasArgument(command, argument) {
  const offset = command.indexOf(argument);
  return offset >= 0 && (offset === 0 || /\s/.test(command[offset - 1])) && (offset + argument.length === command.length || /\s/.test(command[offset + argument.length]));
}
async function profileProcesses(snapshot) {
  snapshot ??= await processSnapshot();
  const argument = `--user-data-dir=${await realpath(profileDir)}`;
  return snapshot.filter(p => {
    if (!hasArgument(p.command, argument)) return false;
    if (p.user !== process.getuid()) throw new Error('Unknown profile process user; refusing recovery.');
    return true;
  });
}
const escapePattern = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function browserProcesses(guardian, { allowReparentedHelpers = false } = {}) {
  const snapshot = await processSnapshot();
  const profile = await profileProcesses(snapshot);
  const binary = join(homedir(), '.pi/browser-use/browser/current/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  let expected;
  try { expected = await realpath(binary); }
  catch (error) { if (error.code === 'ENOENT' && !profile.length) return { profile, helpers: [] }; throw error; }
  const contents = dirname(dirname(expected));
  const aliasContents = dirname(dirname(binary));
  // Only these exact bundle executables/roles are browser helpers. --type alone
  // is not ownership proof; canonical paths, group and ancestry are also required.
  const helperPattern = new RegExp(`^(${[contents, aliasContents].map(escapePattern).join('|')})/Frameworks/Google Chrome for Testing Framework\\.framework/(?:Versions/[^/\\s]+/)?Helpers/(Google Chrome for Testing Helper(?: \\(GPU\\)| \\(Renderer\\))?)\\.app/Contents/MacOS/\\2(?= |$)`);
  if (!profile.length) {
    if (snapshot.some(p => p.group === guardian.pid && helperPattern.test(p.command))) throw new Error('Browser helpers remain without their main; refusing recovery.');
    return { profile, helpers: [] };
  }
  async function helper(p) {
    const match = p.command.match(helperPattern);
    if (!match) return false;
    const types = [...p.command.matchAll(/(?:^|\s)--type=([^\s]+)/g)].map(m => m[1]);
    const roles = match[2].endsWith('(GPU)') ? ['gpu-process'] : match[2].endsWith('(Renderer)') ? ['renderer'] : ['utility', 'gpu-process'];
    if (types.length !== 1 || !roles.includes(types[0])) throw new Error('Unknown browser helper role; refusing recovery.');
    const resolved = await realpath(match[0]);
    const bundle = await realpath(dirname(contents));
    const frameworks = await realpath(join(contents, 'Frameworks'));
    if (frameworks !== join(bundle, 'Contents/Frameworks')) throw new Error('Unknown browser helper framework root; refusing recovery.');
    const framework = await realpath(join(frameworks, 'Google Chrome for Testing Framework.framework'));
    if (!framework.startsWith(`${frameworks}/`)) throw new Error('Unknown browser helper framework root; refusing recovery.');
    const canonical = new RegExp(`^${escapePattern(framework)}/(?:Versions/[^/\\s]+/)?Helpers/${escapePattern(match[2])}\\.app/Contents/MacOS/${escapePattern(match[2])}$`);
    if (!canonical.test(resolved)) throw new Error('Unknown browser helper executable; refusing recovery.');
    return true;
  }
  const main = profile.filter(p => (p.command.startsWith(`${expected} `) || p.command.startsWith(`${binary} `) || p.command.startsWith(`/bin/sh ${executablePath} `)) && !/(?:^|\s)--type(?:=|\s|$)/.test(p.command));
  if (main.length !== 1) throw new Error('Ambiguous profile processes; refusing recovery.');
  const browser = main[0];
  const isBrowser = !browser.command.startsWith(`/bin/sh ${executablePath} `);
  if (browser.group !== guardian.pid || (browser.parent !== guardian.pid && browser.parent !== 1)) throw new Error('Browser lineage changed; refusing recovery.');
  if (guardian.browserPid !== undefined && guardian.browserPid !== browser.pid) throw new Error('Browser identity changed; refusing recovery.');
  const helpers = [];
  for (const p of snapshot) {
    if (p.pid === browser.pid) continue;
    const inProfile = profile.some(q => q.pid === p.pid);
    // Non-profile processes are considered only when they name an exact Helper
    // executable in the recorded group. Never adopt/signal arbitrary group peers.
    if (!inProfile && (p.group !== guardian.pid || !helperPattern.test(p.command))) continue;
    if (!isBrowser || !await helper(p)) throw new Error('Ambiguous profile processes: unknown browser helper; refusing recovery.');
    if (p.user !== process.getuid() || p.group !== browser.group) throw new Error('Browser helper user/group changed; refusing recovery.');
    helpers.push(p);
  }
  const byPid = new Map(helpers.map(p => [p.pid, p]));
  for (const p of helpers) {
    let current = p;
    const visited = new Set();
    while (current.parent !== browser.pid && !(allowReparentedHelpers && current.parent === 1)) {
      if (visited.has(current.pid) || !byPid.has(current.parent)) throw new Error('Browser helper lineage changed; refusing recovery.');
      visited.add(current.pid);
      current = byPid.get(current.parent);
    }
  }
  return { profile, browser, isBrowser, helpers };
}
function sameProcess(a, b) {
  return a && b && ['pid', 'user', 'parent', 'group', 'started', 'command'].every(key => a[key] === b[key]);
}
async function helpersAbsent(helpers) {
  const snapshot = await processSnapshot();
  for (const p of helpers) {
    const current = snapshot.find(q => q.pid === p.pid);
    if (!current) continue;
    if (!sameProcess(p, { ...current, parent: current.parent === 1 ? p.parent : current.parent })) throw new Error('Browser helper identity changed; refusing recovery.');
    return false;
  }
  return true;
}
async function profileAbsent() {
  if ((await profileProcesses()).length) return false;
  // A just-spawned launcher must also disappear before retiring its evidence.
  await sleep(300);
  return !(await profileProcesses()).length;
}
async function retire(identity) {
  // Arbitration is held through all removals; removing owner.json last admits replacement.
  if ((await optionalJSON(ownerPath))?.token !== identity.token) return false;
  await rm(guardianPath, { force: true });
  await rm(socketPath, { force: true });
  await rm(ownerPath);
  return true;
}
export async function recoverOwner(previous) {
  if (alive(previous.pid)) return false;
  return arbitrate(previous, async () => {
    // The guardian may be doing SDK cleanup, but cannot retire records outside
    // this arbitration. Keep its evidence even if it exits while we wait.
    let guardian = await optionalJSON(guardianPath);
    const until = Date.now() + 12_000;
    while (guardian && alive(guardian.pid) && Date.now() < until) {
      await sleep(100);
      guardian = await optionalJSON(guardianPath);
    }
    if ((await optionalJSON(ownerPath))?.token !== previous.token) return false;
    if (guardian && (guardian.token !== previous.token || alive(guardian.pid))) throw new Error('Previous browser guardian is unknown or still alive; refusing recovery.');
    // PID-only publication is sufficient: detached guardian spawn fixes PGID=PID.
    if (guardian?.group !== undefined && guardian.group !== guardian.pid) throw new Error('Guardian group identity changed; refusing recovery.');
    if (guardian?.parent !== undefined && guardian.parent !== previous.pid && guardian.parent !== 1) throw new Error('Guardian lineage changed; refusing recovery.');
    const sdkLock = join(profileDir, '.bu-pi.lock');
    const sdkOwner = await optionalJSON(sdkLock);
    if (sdkOwner && (!guardian || sdkOwner.pid !== guardian.pid || alive(sdkOwner.pid))) throw new Error('Unknown/legacy profile lock; refusing recovery.');
    const deadline = Date.now() + 20_000;
    for (;;) {
      const processes = await profileProcesses();
      if (!processes.length) {
        if (guardian) await browserProcesses(guardian);
        if (await profileAbsent()) {
          if (guardian) await browserProcesses(guardian);
          break;
        }
        continue;
      }
      if (!guardian || !sdkOwner) throw new Error('Browser ownership lock is absent; refusing orphan recovery.');
      const { browser, isBrowser, helpers } = await browserProcesses(guardian);
      if (!browser) continue;
      let endpoint = guardian.endpoint;
      if (!endpoint) {
        // Initialization can die after spawning Chrome but before SDK publication.
        try {
          const [port, path] = (await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
          if (!/^\d+$/.test(port) || Number(port) > 65535 || Number(port) < 1 || !/^\/devtools\/browser\/[\w-]+$/.test(path)) throw new Error('Malformed profile DevTools endpoint; refusing recovery.');
          endpoint = `ws://127.0.0.1:${port}${path}`;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (endpoint && isBrowser) {
        if (!/^ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/devtools\/browser\/[\w-]+$/.test(endpoint)) throw new Error('Unknown nonlocal browser endpoint; refusing recovery.');
        const cdp = await CDP.connect(endpoint, 1500);
        let closingHelpers;
        try {
          const info = await cdp.send('SystemInfo.getProcessInfo');
          const reported = info.processInfo.filter(p => p.type === 'browser');
          if (reported.length !== 1 || reported[0].id !== browser.pid) throw new Error('Browser identity changed; refusing recovery.');
          const current = await browserProcesses(guardian);
          if (!sameProcess(browser, current.browser) || helpers.some(p => {
            const live = current.helpers.find(q => q.pid === p.pid);
            return live && !sameProcess(p, live);
          })) throw new Error('Browser process identity changed; refusing recovery.');
          closingHelpers = [...new Map([...helpers, ...current.helpers].map(p => [p.pid, p])).values()];
          if ((await optionalJSON(ownerPath))?.token !== previous.token || alive(previous.pid) || alive(guardian.pid) || JSON.stringify(await optionalJSON(guardianPath)) !== JSON.stringify(guardian) || JSON.stringify(await optionalJSON(sdkLock)) !== JSON.stringify(sdkOwner)) throw new Error('Owner identity changed; refusing recovery.');
          await cdp.send('Browser.close').catch(() => {});
        } finally { cdp.close(); }
        const closingDeadline = Date.now() + 5000;
        while ((alive(browser.pid) || !await helpersAbsent(closingHelpers)) && Date.now() < closingDeadline) await sleep(50);
        if (alive(browser.pid)) throw new Error('Orphan browser did not close; refusing recovery.');
        if (!await helpersAbsent(closingHelpers)) throw new Error('Browser helpers remain; refusing recovery.');
        if (!await profileAbsent()) throw new Error('Profile processes remain; refusing recovery.');
        await browserProcesses(guardian, { allowReparentedHelpers: true });
        break;
      }
      if (Date.now() >= deadline) throw new Error('Orphan browser endpoint did not appear; refusing recovery.');
      await sleep(100);
    }
    if (sdkOwner) await rm(sdkLock);
    return retire(previous);
  });
}
export async function acquireOwner() {
  const identity = { pid: process.pid, token: randomUUID() };
  const candidate = join(runDir, `${identity.token}.candidate`);
  await writeFile(candidate, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
  try {
    for (let i = 0; i < 160; i++) {
      try { await link(candidate, ownerPath); return identity; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const previous = await optionalJSON(ownerPath);
      if (!previous) continue;
      if (alive(previous.pid)) return undefined;
      if (await recoverOwner(previous)) continue;
      await sleep(100);
    }
    throw new Error('Browser owner recovery did not finish.');
  } finally { await rm(candidate, { force: true }); }
}
export async function releaseOwner(identity, guardianPid) {
  return arbitrate(identity, async () => {
    const guardian = await optionalJSON(guardianPath);
    // Only a guardian that completed exact-child SDK cleanup may remove its own
    // evidence. A service seeing an unexpectedly dead guardian preserves it.
    if (guardian && (guardian.pid !== guardianPid || guardian.token !== identity.token)) return false;
    if (await optionalJSON(join(profileDir, '.bu-pi.lock')) || !await profileAbsent()) return false;
    if (guardian) await rm(guardianPath);
    if (guardianPid && alive(identity.pid)) return true;
    return retire(identity);
  });
}

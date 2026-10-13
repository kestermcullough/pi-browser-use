import { Browser, BrowserUse, CDP } from '@browser_use/pi';
import { createInterface } from 'node:readline';
import { checkSDK, sessionOptions } from './sdk-session.mjs';
import { alive, executablePath, guardianPath, ownerPath, profileDir, readJSON, sleep, workspace, writeJSON } from './shared-paths.mjs';
import { releaseOwner } from './owner-lock.mjs';
import { closeOwnedGroup, processIdentity } from './owned-group.mjs';

// The service's pipe and heartbeat are the lease. Only this process launches Chrome.
let owner;
let browserPid;
let closing;
let lastBeat = Date.now();
let ownerIdentity;
let launcher;
const executionWorkers = new Map();
let probing = false;
let heartbeatLost = false;
const input = createInterface({ input: process.stdin });
let permitStart;
const startPermit = new Promise(resolve => { permitStart = resolve; });
async function shutdown() {
  if (closing) return closing;
  closing = (async () => {
    clearInterval(watchdog);
    await initializing.catch(() => {});
    if (owner) {
      let cdp;
      try {
        cdp = await CDP.connect(owner.browser.endpoint, 1500);
        await cdp.send('Browser.close').catch(() => {});
        const until = Date.now() + 5000;
        while (browserPid && alive(browserPid) && Date.now() < until) await sleep(50);
      } catch { /* SDK cleanup below terminates only its exact launched child. */ }
      finally { cdp?.close(); }
      await owner.close();
    }
    if (launcher && (!alive(launcher.pid) || heartbeatLost)) {
      await closeOwnedGroup(launcher.group, [launcher, ...executionWorkers.values()]);
    }
    if (ownerIdentity) await releaseOwner(ownerIdentity, process.pid);
  })();
  return closing;
}
function exit() { void shutdown().then(() => process.exit(0), error => { console.error(error); process.exit(1); }); }
input.on('line', line => {
  if (line === 'start') permitStart(true);
  else if (line === 'close') { permitStart(false); exit(); }
  else if (line === 'beat') lastBeat = Date.now();
  else {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.action === 'own-worker') {
      void (async () => {
        let error;
        try {
          const identity = await processIdentity(message.pid);
          if (!launcher || identity?.parent !== launcher.pid || identity.group !== launcher.group) throw new Error('Execution worker is not a child of the elected service.');
          executionWorkers.set(identity.pid, identity);
        } catch (failure) { error = String(failure); }
        process.stdout.write(JSON.stringify({ type: 'worker-owned', nonce: message.nonce, error }) + '\n');
      })();
    }
  }
});
input.on('close', () => { permitStart(false); exit(); });
process.stdout.on('error', exit);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { permitStart(false); exit(); });
const watchdog = setInterval(() => {
  if (closing || probing || Date.now() - lastBeat <= 10_000) return;
  probing = true;
  void (async () => {
    // Confirm loss on a second channel before closing a potentially healthy owner.
    process.stdout.write(JSON.stringify({ type: 'probe' }) + '\n');
    await sleep(2000);
    if (closing || Date.now() - lastBeat <= 10_000) return;
    const current = launcher && await processIdentity(launcher.pid);
    if (current && (process.ppid !== launcher.pid || current.group !== launcher.group || current.started !== launcher.started)) throw new Error('Service launcher identity changed; refusing watchdog termination.');
    heartbeatLost = true;
    permitStart(false);
    exit();
  })().catch(error => console.error(error)).finally(() => { probing = false; });
}, 1000);
const initializing = (async () => {
  // Launch only after the service has durably recorded our PID. Recovery can
  // otherwise mistake the short spawn/publication window for no guardian.
  if (!await startPermit) return;
  ownerIdentity = await readJSON(ownerPath);
  if (ownerIdentity.pid !== process.ppid) throw new Error('Browser guardian was not started by the elected service.');
  launcher = await processIdentity(process.ppid);
  if (launcher?.group !== launcher.pid || (await processIdentity(process.pid))?.group !== process.pid) throw new Error('Browser guardian and service require separate owned process groups.');
  owner = await BrowserUse.create({ ...sessionOptions, browser: Browser.chromium({ executablePath, profileDir, headless: false }), workspace });
  checkSDK(owner);
  const cdp = await CDP.connect(owner.browser.endpoint, 3000);
  try {
    browserPid = (await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(p => p.type === 'browser')?.id;
    if (!Number.isSafeInteger(browserPid)) throw new Error('Chrome did not report its process identity.');
  } finally { cdp.close(); }
  await writeJSON(guardianPath, { ...await processIdentity(process.pid), pid: process.pid, token: ownerIdentity.token, browserPid, endpoint: owner.browser.endpoint });
  process.stdout.write(JSON.stringify({ endpoint: owner.browser.endpoint }) + '\n');
})();
initializing.catch(error => { console.error(error); exit(); });

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { chmod, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { acquireOwner, releaseOwner } from './owner-lock.mjs';
import { createClientSession } from './sdk-session.mjs';
import { processIdentity } from './owned-group.mjs';
import { executablePath, guardianPath, preparePaths, privateDirectory, profileDir, socketPath, workspace } from './shared-paths.mjs';

await preparePaths();
const identity = await acquireOwner();
if (!identity) process.exit(0);
let guardian;
let heartbeat;
let endpoint;
let closing;
let idle;
const clients = new Set();
const server = createServer({ allowHalfOpen: true }, accept);
let browserStart;
const workerClaims = new Map();
const registeredWorkers = new WeakSet();
async function registerWorker(worker) {
  if (registeredWorkers.has(worker)) return;
  const nonce = randomUUID();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { workerClaims.delete(nonce); reject(new Error('Execution worker ownership acknowledgement timed out.')); }, 3000);
    workerClaims.set(nonce, { resolve, reject, timer });
    guardian.stdin.write(JSON.stringify({ action: 'own-worker', pid: worker.pid, nonce }) + '\n');
  });
  registeredWorkers.add(worker);
}
function getBrowser() {
  return browserStart ??= (async () => {
    if ((await processIdentity(process.pid))?.group !== process.pid) throw new Error('Shared browser service requires its own detached process group.');
    guardian = spawn(process.execPath, [fileURLToPath(new URL('./guardian.mjs', import.meta.url))], { detached: true, stdio: ['pipe', 'pipe', 'inherit'] });
    const ready = createInterface({ input: guardian.stdout });
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Browser owner startup timed out.')), 20_000);
      guardian.once('error', reject);
      guardian.once('exit', () => reject(new Error('Browser guardian exited during startup.')));
      ready.on('line', line => {
        try {
          const message = JSON.parse(line);
          if (message.endpoint) resolve(message.endpoint);
          else if (message.type === 'probe') guardian.stdin.write('beat\n');
          else if (message.type === 'worker-owned') {
            const claim = workerClaims.get(message.nonce);
            if (claim) {
              clearTimeout(claim.timer); workerClaims.delete(message.nonce);
              message.error ? claim.reject(new Error(message.error)) : claim.resolve();
            }
          }
        } catch (error) { reject(error); }
      });
      ready.once('line', () => clearTimeout(timer));
      guardian.once('exit', () => clearTimeout(timer));
    });
    // Publication can fail before result is awaited; shutdown still reaps the guardian.
    result.catch(() => {});
    guardian.stdin.on('error', () => {});
    heartbeat = setInterval(() => { if (!guardian.stdin.destroyed) guardian.stdin.write('beat\n'); }, 1000);
    guardian.once('exit', () => {
      for (const claim of workerClaims.values()) { clearTimeout(claim.timer); claim.reject(new Error('Browser guardian exited.')); }
      workerClaims.clear();
      if (!closing) void shutdown();
    });
    // Two-phase launch: recovery must know the guardian before it can spawn Chrome.
    await writeFile(guardianPath, JSON.stringify({ ...await processIdentity(guardian.pid), pid: guardian.pid, token: identity.token }), { flag: 'wx', mode: 0o600 });
    guardian.stdin.write('start\n');
    endpoint = await result;
    return endpoint;
  })();
}
function accept(socket) {
  if (closing) { socket.destroy(); return; }
  clearTimeout(idle);
  const client = { socket, controllers: new Map(), queue: Promise.resolve(), runtime: undefined, creating: undefined, released: false, lastBeat: Date.now() };
  clients.add(client);
  const lease = setInterval(() => {
    if (Date.now() - client.lastBeat > 10_000) socket.destroy();
  }, 1000);
  socket.once('close', () => clearInterval(lease));
  const input = createInterface({ input: socket });
  let bytes = 0;
  socket.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) socket.destroy(); });
  socket.on('error', () => {});
  const reply = value => { if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n'); };
  input.on('line', line => {
    bytes = 0;
    if (Buffer.byteLength(line) > 1024 * 1024) { socket.destroy(); return; }
    let request;
    try { request = JSON.parse(line); } catch { socket.destroy(); return; }
    if (request.action === 'heartbeat') { client.lastBeat = Date.now(); return; }
    if (request.action === 'cancel') { client.controllers.get(request.id)?.abort(); return; }
    if (request.action === 'shutdown') { void release(client).then(() => socket.end()); return; }
    if (client.released) return;
    if (!Number.isSafeInteger(request.id) || client.controllers.has(request.id)) { socket.destroy(); return; }
    const controller = new AbortController();
    client.controllers.set(request.id, controller);
    client.queue = client.queue.then(async () => {
      try {
        if (controller.signal.aborted) throw new Error('Browser operation cancelled.');
        if (request.action === 'status') {
          reply({ id: request.id, result: { text: JSON.stringify({ open: !!client.runtime, clients: clients.size, profileDir, workspace: client.runtime?.session.workspace, executablePath }), images: [] } });
        } else if (request.action === 'execute') {
          if (typeof request.code !== 'string' || !Number.isInteger(request.timeoutMs ?? 30_000) || (request.timeoutMs ?? 30_000) < 1 || (request.timeoutMs ?? 30_000) > 60_000) throw new Error('Invalid browser cell.');
          if (!client.runtime) {
            client.creating = (async () => {
              const cdp = await getBrowser();
              const directory = join(workspace, randomUUID());
              await privateDirectory(directory);
              client.runtime = await createClientSession(cdp, directory, registerWorker);
              return client.runtime;
            })();
            await client.creating;
          }
          if (controller.signal.aborted) throw new Error('Browser operation cancelled.');
          const result = await client.runtime.execute(request.code, { timeoutMs: request.timeoutMs ?? 30_000, signal: controller.signal });
          reply({ id: request.id, result });
        } else throw new Error('Unknown browser action.');
      } catch (error) { reply({ id: request.id, error: String(error), result: error?.result }); }
      finally { client.controllers.delete(request.id); }
    });
  });
  socket.once('end', () => { void release(client).then(() => socket.end()); });
  socket.once('close', () => { input.close(); void release(client); });
}
function armIdle(ms) {
  clearTimeout(idle);
  if (!clients.size && !closing) idle = setTimeout(() => {
    if (!clients.size && !closing) void shutdown();
  }, ms);
}
async function release(client) {
  if (client.releasing) return client.releasing;
  client.released = true;
  client.releasing = (async () => {
    for (const controller of client.controllers.values()) controller.abort();
    await client.creating?.catch(() => {});
    try { await client.runtime?.close(); }
    catch (error) { console.error('Client cleanup:', String(error)); }
    await client.queue.catch(() => {});
    clients.delete(client);
    armIdle(1500);
  })();
  return client.releasing;
}
async function shutdown() {
  if (closing) return closing;
  closing = (async () => {
    clearTimeout(idle);
    server.close();
    for (const client of clients) { client.socket.destroy(); }
    await Promise.all([...clients].map(release));
    await browserStart?.catch(() => {});
    clearInterval(heartbeat);
    if (guardian && guardian.exitCode === null && guardian.signalCode === null) {
      const exited = once(guardian, 'exit');
      guardian.stdin.end('close\n');
      await exited;
    }
    await releaseOwner(identity);
  })();
  closing.then(() => process.exit(0), error => { console.error(error); process.exit(1); });
  return closing;
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void shutdown());
try {
  // umask closes the window before chmod: no other user can connect during bind.
  process.umask(0o077);
  server.listen(socketPath);
  await once(server, 'listening');
  await chmod(socketPath, 0o600);
  armIdle(5000);
} catch (error) { console.error(error); await shutdown(); }

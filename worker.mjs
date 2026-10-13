import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { executablePath, preparePaths, profileDir, runDir, sleep, socketPath, workspace } from './shared-paths.mjs';

let socket;
let connecting;
let closing;
let heartbeat;
let writes = Promise.resolve();
function reply(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
function tryConnect() {
  return new Promise((resolve, reject) => {
    const candidate = connect(socketPath);
    candidate.once('connect', () => { candidate.off('error', reject); resolve(candidate); });
    candidate.once('error', error => { candidate.destroy(); reject(error); });
  });
}
async function getConnection() {
  if (socket) return socket;
  if (connecting) return connecting;
  connecting = (async () => {
    await preparePaths();
    let connected;
    try { connected = await tryConnect(); }
    catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
      const log = await open(join(runDir, 'service.log'), 'a', 0o600);
      let daemon;
      try {
        daemon = spawn(process.execPath, [fileURLToPath(new URL('./service.mjs', import.meta.url))], {
          detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, DO_NOT_TRACK: '1' },
        });
        daemon.on('error', error => console.error(String(error)));
        daemon.unref();
      } finally { await log.close(); }
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        try { connected = await tryConnect(); break; }
        catch (error) {
          if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
          if (daemon.exitCode !== null && daemon.exitCode !== 0) throw new Error(`Shared browser service could not start. See ${join(runDir, 'service.log')}`);
          await sleep(50);
        }
      }
      if (!connected) throw new Error(`Shared browser service startup timed out. See ${join(runDir, 'service.log')}`);
    }
    socket = connected;
    heartbeat = setInterval(() => {
      if (!socket.destroyed) socket.write(JSON.stringify({ action: 'heartbeat' }) + '\n');
    }, 1000);
    const responses = createInterface({ input: socket });
    responses.on('line', line => {
      try { reply(JSON.parse(line)); } catch { /* Ignore malformed diagnostics. */ }
    });
    socket.on('error', error => console.error(String(error)));
    socket.once('close', () => { if (!closing) { console.error('Shared browser connection lost; no actions replayed.'); process.exit(1); } });
    return socket;
  })();
  try { return await connecting; }
  finally { connecting = undefined; }
}
async function shutdown() {
  if (closing) return closing;
  closing = (async () => {
    // Do not reconnect merely to release. A hard deadline affects only this bridge.
    const deadline = setTimeout(() => process.exit(1), 25_000);
    await writes.catch(() => {});
    clearInterval(heartbeat);
    if (socket) {
      const closed = once(socket, 'close');
      socket.end(JSON.stringify({ action: 'shutdown' }) + '\n');
      await closed.catch(() => {});
    }
    clearTimeout(deadline);
  })();
  closing.then(() => process.exit(0), error => { console.error(error); process.exit(1); });
  return closing;
}
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.action === 'shutdown') { void shutdown(); return; }
  if (closing) return;
  if (request.action === 'status' && !socket && !connecting) {
    reply({ id: request.id, result: { text: JSON.stringify({ open: false, profileDir, workspace, executablePath }), images: [] } });
    return;
  }
  // Order writes, not cells: cancellation must reach the service during execution.
  writes = writes.then(async () => {
    try { (await getConnection()).write(JSON.stringify(request) + '\n'); }
    catch (error) { reply({ id: request.id, error: String(error) }); }
  });
});
input.on('close', () => void shutdown());
process.stdout.on('error', () => void shutdown());
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void shutdown());

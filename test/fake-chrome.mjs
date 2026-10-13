#!/usr/bin/env node
// Local CDP fixture: real SDK workers/REPL, no installed browser or network sites.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const profile = process.argv.find(arg => arg.startsWith('--user-data-dir='))?.split('=').slice(1).join('=');
if (!profile) throw new Error('Fixture needs an isolated profile.');
const helpers = [];
if (process.env.FAKE_CHROME_HELPERS) {
  const contents = dirname(dirname(process.argv0));
  for (const [suffix, type, withProfile] of [[process.env.FAKE_CHROME_GENERIC_GPU ? '' : ' (GPU)', 'gpu-process', true], ['', 'utility', false], [' (Renderer)', 'renderer', true]]) {
    const name = `Google Chrome for Testing Helper${suffix}`;
    const binary = join(contents, 'Frameworks/Google Chrome for Testing Framework.framework/Versions/152.0.0.0/Helpers', `${name}.app/Contents/MacOS`, name);
    helpers.push(spawn(binary, [`--type=${type}`, ...(withProfile ? [`--user-data-dir=${profile}`] : [])], { stdio: 'ignore' }));
  }
}
const targets = new Map([['initial', { targetId: 'initial', type: 'page', url: 'about:blank', title: 'Fixture' }]]);
const sessions = new Map();
let next = 0;
const server = createServer();
const ws = new WebSocketServer({ server });
const record = method => {
  appendFileSync(join(profile, 'fixture-events.jsonl'), JSON.stringify({ pid: process.pid, method }) + '\n');
  writeFileSync(join(profile, 'fixture-state.json'), JSON.stringify({ pid: process.pid, helpers: helpers.map(child => child.pid), targets: [...targets.values()] }));
};
record('launch');
ws.on('connection', socket => socket.on('message', async raw => {
  const { id, method, params = {}, sessionId } = JSON.parse(String(raw));
  let result = {};
  let error;
  const target = targets.get(sessions.get(sessionId));
  switch (method) {
    case 'SystemInfo.getProcessInfo': result = { processInfo: [{ type: 'browser', id: process.pid }] }; break;
    case 'Fixture.unrelatedHelper': {
      // Exact bundle helper/group, but an unrelated intermediary breaks ancestry.
      const proxy = spawn(process.execPath, [fileURLToPath(new URL('./fake-helper.mjs', import.meta.url)), '--proxy', params.binary, '--type=utility'], { env: { ...process.env, FIXTURE_HELPER_PROFILE: profile }, stdio: ['ignore', 'pipe', 'ignore'] });
      const [pid] = await once(proxy.stdout, 'data');
      result = { proxyPid: proxy.pid, helperPid: Number(String(pid).trim()) };
      helpers.push(proxy);
      break;
    }
    case 'Target.getTargets': result = { targetInfos: [...targets.values()] }; break;
    case 'Target.createTarget': {
      const targetId = `target-${++next}`;
      targets.set(targetId, { targetId, type: 'page', url: params.url, title: 'Fixture' });
      result = { targetId }; break;
    }
    case 'Fixture.popup': {
      const targetId = `popup-${++next}`;
      targets.set(targetId, { targetId, type: 'page', openerId: params.openerId, url: 'about:blank', title: 'Popup' });
      result = { targetId }; break;
    }
    case 'Target.attachToTarget':
      if (!targets.has(params.targetId)) error = { code: -1, message: 'Target missing' };
      else { const sessionId = `session-${++next}`; sessions.set(sessionId, params.targetId); result = { sessionId }; }
      break;
    case 'Target.closeTarget': targets.delete(params.targetId); result = { success: true }; break;
    case 'Target.detachFromTarget': sessions.delete(params.sessionId); break;
    case 'Page.navigate': target.url = params.url; result = { frameId: 'frame' }; break;
    case 'Runtime.evaluate':
      result = { result: { value: params.expression.includes('location.href') ? { url: target?.url, title: target?.title } : true } }; break;
    case 'Browser.close':
      void Promise.all(helpers.map(async child => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
      })).then(() => setTimeout(() => process.exit(0), 30));
      break;
    case 'Page.enable': case 'Runtime.enable': break;
    default: error = { code: -32601, message: `Fixture does not implement ${method}` };
  }
  record(method);
  socket.send(JSON.stringify({ id, ...(error ? { error } : { result }) }));
}));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
if (process.env.FAKE_CHROME_START_DELAY_MS) await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_CHROME_START_DELAY_MS)));
writeFileSync(join(profile, 'DevToolsActivePort'), `${server.address().port}\n/devtools/browser/fixture\n`);

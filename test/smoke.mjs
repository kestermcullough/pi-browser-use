import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { realpath, stat } from 'node:fs/promises';

const smokeHome = process.env.BROWSER_USE_SMOKE_HOME;
if (!smokeHome || !isAbsolute(smokeHome) || await realpath(smokeHome) === await realpath(homedir())) {
  throw new Error('Set BROWSER_USE_SMOKE_HOME to an isolated absolute HOME with a provisioned browser. Never run this smoke test against your live profile.');
}
async function waitForOwnerExit() {
  const until = Date.now() + 15_000;
  const owner = join(smokeHome, '.pi/browser-use/shared/owner.json');
  while (Date.now() < until) {
    try { await stat(owner); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Shared browser owner did not exit after final release.');
}

const fixture = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<title>Pi Dedicated Browser Trial</title><button onclick="this.textContent=\'Clicked\'">Trial button</button>');
});
fixture.listen(0, '127.0.0.1');
await once(fixture, 'listening');
const url = `http://127.0.0.1:${fixture.address().port}/`;

function launch() {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../worker.mjs', import.meta.url))], {
    stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, HOME: smokeHome, DO_NOT_TRACK: '1' },
  });
  let id = 0;
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      message.error ? waiter.reject(new Error(message.error)) : waiter.resolve(message.result);
    }
  });
  child.on('exit', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('Worker exited.'));
    pending.clear();
  });
  return {
    async cell(code, timeoutMs = 30_000) {
      const current = ++id;
      const promise = new Promise((resolve, reject) => pending.set(current, { resolve, reject }));
      child.stdin.write(JSON.stringify({ id: current, action: 'execute', code, timeoutMs }) + '\n');
      return promise;
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.stdin.write(JSON.stringify({ action: 'shutdown' }) + '\n');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      try { const [code] = await exited; assert.equal(code, 0); }
      finally { clearTimeout(timer); }
    },
  };
}

let worker;
try {
  worker = launch();
  console.log('Testing navigation and AX…');
  const initial = await worker.cell(`await page.goto(${JSON.stringify(url)}); var trialMarker = 42; console.log(await page.info()); console.log(await page.snapshot());`);
  assert.match(initial.text, /Pi Dedicated Browser Trial/);
  assert.match(initial.text, /Trial button/);
  const browserProcess = await worker.cell("console.log(JSON.stringify((await browser.send('SystemInfo.getProcessInfo')).processInfo.find(p => p.type === 'browser')));");
  const browserPid = JSON.parse(browserProcess.text.trim()).id;
  const command = execFileSync('ps', ['-p', String(browserPid), '-o', 'command='], { encoding: 'utf8' });
  assert.match(command, /\.pi\/browser-use\/browser\//, 'Must launch the independently installed browser');
  assert.doesNotMatch(command, /ms-playwright/, 'Must not launch from Playwright cache');
  console.log('PASS: running binary is independent of Playwright.');
  const persistent = await worker.cell('console.log(trialMarker);');
  assert.match(persistent.text, /42/);
  console.log('Testing CDP click and screenshot…');
  const clicked = await worker.cell(`var trialTree = await page.snapshot(); var trialButton = trialTree.nodes.find(n => n.role === 'button' && n.name === 'Trial button'); await page.cdp('DOM.scrollIntoViewIfNeeded', {backendNodeId: trialButton.id}); var trialBox = await page.cdp('DOM.getBoxModel', {backendNodeId: trialButton.id}); var trialQuad = trialBox.model.content; await page.clickAt((trialQuad[0]+trialQuad[2]+trialQuad[4]+trialQuad[6])/4, (trialQuad[1]+trialQuad[3]+trialQuad[5]+trialQuad[7])/4); await page.waitFor(() => document.querySelector('button').textContent === 'Clicked'); console.log(await page.snapshot()); await page.evaluate(() => { document.cookie = 'pi_trial=retained; Max-Age=600; SameSite=Lax'; }); await page.screenshot();`);
  assert.match(clicked.text, /Clicked/);
  assert.ok(clicked.images.length > 0, 'Screenshot must reach Pi');
  console.log('Cookie before shutdown:', (await worker.cell('console.log(await page.evaluate(() => document.cookie));')).text);
  console.log('Testing public page…');
  const publicPage = await worker.cell('await page.goto("https://example.com"); console.log(await page.info());');
  assert.match(publicPage.text, /Example Domain/);
  console.log('Testing hung-cell timeout and recovery…');
  await assert.rejects(worker.cell('while (true) {}', 1000), /timed out|timeout|exceeded 1000 ms/i);
  const recovered = await worker.cell('console.log(await page.info()); console.log(typeof trialMarker);');
  assert.match(recovered.text, /Example Domain/);
  assert.match(recovered.text, /undefined/);
  console.log('Testing shutdown…');
  await worker.close();
  worker = undefined;
  await waitForOwnerExit();
  worker = launch();
  console.log('Testing profile persistence…');
  const restored = await worker.cell(`await page.goto(${JSON.stringify(url)}); console.log(await page.evaluate(() => document.cookie)); await page.evaluate(() => { document.cookie = 'pi_trial=; Max-Age=0'; });`);
  assert.match(restored.text, /pi_trial=retained/);
  console.log('PASS: dedicated visible Chromium, public page navigation, AX snapshot, raw CDP click, persistent REPL, screenshot, cookie persistence across restart, hung-cell recovery, clean shutdown.');
} finally {
  await worker?.close();
  await waitForOwnerExit();
  fixture.close();
}

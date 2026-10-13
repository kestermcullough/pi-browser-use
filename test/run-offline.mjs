import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Independent elapsed bound: node:test's cooperative timeout cannot stop a stuck finally.
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2), 'test/shared-browser.test.mjs'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), detached: true, stdio: 'inherit',
});
const timer = setTimeout(() => {
  console.error(`OFFLINE RUNNER DEADLINE: terminating owned test process group ${child.pid}. Fixture diagnostics/paths above are preserved.`);
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') console.error(error); }
  process.exit(1);
}, 180_000);
child.once('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.once('exit', (code) => { clearTimeout(timer); process.exitCode = code ?? 1; });

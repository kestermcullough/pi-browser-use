#!/usr/bin/env node
// Local real-PID helper/proxy fixture; no CDP or browser access.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
if (process.argv[2] === '--proxy') {
  const child = spawn(process.argv[3], [...process.argv.slice(4), `--user-data-dir=${process.env.FIXTURE_HELPER_PROFILE}`], { stdio: 'ignore' });
  process.stdout.write(String(child.pid) + '\n');
  process.once('SIGTERM', async () => {
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    process.exit(0);
  });
}
setInterval(() => {}, 1000);

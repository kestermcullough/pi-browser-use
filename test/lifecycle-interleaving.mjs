// Isolated offline preload: pause real fs operations without production hooks.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
const role = basename(process.argv[1] ?? '');
const directory = process.env.LIFECYCLE_INTERLEAVING;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function pause(name) {
  await fs.writeFile(join(directory, `${name}.entered`), String(process.pid));
  const deadline = Date.now() + 15_000;
  for (;;) {
    try { await fs.stat(join(directory, `${name}.continue`)); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (Date.now() >= deadline) throw new Error(`Lifecycle fixture ${name} deadline`);
    await sleep(20);
  }
}
if (directory && role === 'service.mjs' && process.env.PAUSE_SOCKET_CHMOD) {
  const chmod = fs.chmod;
  fs.chmod = async (path, mode) => {
    if (String(path).endsWith('/owner.sock')) await pause('chmod');
    return chmod(path, mode);
  };
}
if (directory && role === 'guardian.mjs' && process.env.PAUSE_GENERATION_RETIRE) {
  const rm = fs.rm;
  fs.rm = async (path, options) => {
    if (String(path).endsWith('/owner.sock')) await pause('retire');
    return rm(path, options);
  };
}
syncBuiltinESMExports();
if (directory && role === 'guardian.mjs' && process.env.PAUSE_GUARDIAN_INITIALIZATION) {
  const readFile = fs.readFile;
  fs.readFile = async (path, options) => {
    if (String(path).endsWith('/owner.json')) await pause('initialize');
    return readFile(path, options);
  };
  syncBuiltinESMExports();
}

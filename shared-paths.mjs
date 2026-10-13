import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';

export const root = join(homedir(), '.pi', 'browser-use');
export const profileDir = join(root, 'profile');
export const workspace = join(root, 'workspace');
export const runDir = join(root, 'shared');
export const socketPath = join(runDir, 'owner.sock');
export const ownerPath = join(runDir, 'owner.json');
export const guardianPath = join(runDir, 'guardian.json');
export const executablePath = fileURLToPath(new URL('./launch-browser.sh', import.meta.url));
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owner PID; refusing recovery.');
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid()) throw new Error(`Unsafe browser directory: ${path}`);
  await chmod(path, 0o700);
}
export async function preparePaths() {
  for (const path of [root, profileDir, workspace, runDir]) await privateDirectory(path);
}
export async function readJSON(path) { return JSON.parse(await readFile(path, 'utf8')); }
export async function writeJSON(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

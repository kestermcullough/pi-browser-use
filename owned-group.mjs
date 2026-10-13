import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sleep } from './shared-paths.mjs';
const exec = promisify(execFile);

export async function processIdentity(pid) {
  let stdout;
  try { ({ stdout } = await exec('ps', ['-p', String(pid), '-o', 'ppid=,pgid=,lstart='], { timeout: 1500 })); }
  catch (error) { if (error.code === 1) return undefined; throw error; }
  const match = stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
  return match && { pid, parent: Number(match[1]), group: Number(match[2]), started: match[3] };
}
async function members(group) {
  const { stdout } = await exec('ps', ['-axo', 'pid=,pgid='], { timeout: 1500 });
  return stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number))
    .filter(([, pgid]) => pgid === group).map(([pid]) => pid);
}
async function unchanged(identity) {
  const current = await processIdentity(identity.pid);
  return current?.group === identity.group && current.started === identity.started;
}
function signal(group, name) {
  try { process.kill(-group, name); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

// An original live member reserves the PGID. Never signal a group without that
// continuity proof: an empty original group could have been reused by another process.
export async function closeOwnedGroup(group, anchors) {
  if (!(await members(group)).length) return;
  if (!(await Promise.all(anchors.map(unchanged))).some(Boolean)) throw new Error('Service group identity is no longer provable; refusing group cleanup.');
  const snapshot = (await Promise.all((await members(group)).map(processIdentity))).filter(Boolean);
  signal(group, 'SIGTERM');
  let until = Date.now() + 1000;
  while ((await members(group)).length && Date.now() < until) await sleep(50);
  if ((await members(group)).length) {
    if (!(await Promise.all(snapshot.map(unchanged))).some(Boolean)) throw new Error('Service group may have been reused; refusing SIGKILL.');
    signal(group, 'SIGKILL');
    until = Date.now() + 2000;
    while ((await members(group)).length && Date.now() < until) await sleep(50);
    if ((await members(group)).length) throw new Error('Owned service group did not exit.');
  }
}

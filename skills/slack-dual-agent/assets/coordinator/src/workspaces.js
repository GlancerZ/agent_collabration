import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { childEnv, privateDir, redact } from './config.js';
const exec = promisify(execFile);

export async function prepareWorkspaces(job, project, data, save) {
  const home = resolve(data, 'jobs', job.id); privateDir(home);
  let base = job.baseCommit;
  if (project.path && !base) {
    const dirty = await exec('git', ['status', '--porcelain'], { cwd: project.path, env: childEnv() });
    if (dirty.stdout.trim()) throw Error('Project has uncommitted changes. Commit them or configure a clean checkout before starting.');
    base = (await exec('git', ['rev-parse', '--verify', `${project.ref}^{commit}`], { cwd: project.path, env: childEnv() })).stdout.trim();
    save({ baseCommit: base });
  }
  const workspaces = { ...job.workspaces };
  for (const role of ['codex', 'claude']) {
    if (workspaces[role]) { if (!existsSync(workspaces[role])) throw Error('Recorded workspace disappeared; restore it before resuming.'); continue; }
    const path = resolve(home, role);
    if (project.path) await exec('git', ['worktree', 'add', '--detach', path, base], { cwd: project.path, env: childEnv(), timeout: 60000 });
    else mkdirSync(path, { recursive: true, mode: 0o700 });
    workspaces[role] = path; save({ workspaces });
  }
  return workspaces;
}

export async function verifyCommands(commands, cwd, signal) {
  const reports = [];
  for (const args of commands) {
    if (signal.aborted) throw Error('Stopped');
    try {
      const { stdout, stderr } = await exec(args[0], args.slice(1), { cwd, env: childEnv(), signal, timeout: 300000, maxBuffer: 2_000_000, killSignal: 'SIGTERM' });
      reports.push({ command: args, ok: true, output: redact((stdout + stderr).slice(-12000)) });
    } catch (e) {
      if (signal.aborted) throw Error('Stopped');
      reports.push({ command: args, ok: false, output: redact(String(e.stdout || '') + String(e.stderr || '') + '\n' + e.message).slice(-12000) });
    }
  }
  return reports;
}

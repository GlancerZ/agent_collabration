import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareWorkspaces } from '../src/workspaces.js';
const exec = promisify(execFile);

test('both Git workspaces start at the same commit and preserve the original checkout', async t => {
  const dir = mkdtempSync(resolve(tmpdir(), 'agent-room-git-')), repo = resolve(dir, 'repo'); mkdirSync(repo);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = args => exec('git', args, { cwd: repo });
  await git(['init', '-q']); writeFileSync(resolve(repo, 'base.txt'), 'baseline\n'); await git(['add', 'base.txt']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  const job = { id: 'test-task', workspaces: {} };
  const paths = await prepareWorkspaces(job, { path: repo, ref: 'HEAD' }, resolve(dir, 'data'), patch => Object.assign(job, patch));
  for (const role of ['codex', 'claude']) {
    const sha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: paths[role] })).stdout.trim(); assert.equal(sha, job.baseCommit);
    writeFileSync(resolve(paths[role], 'base.txt'), role + '\n');
  }
  assert.equal(readFileSync(resolve(repo, 'base.txt'), 'utf8'), 'baseline\n');
  assert.equal((await git(['status', '--porcelain'])).stdout, '');
  writeFileSync(resolve(repo, 'base.txt'), 'uncommitted');
  await assert.rejects(() => prepareWorkspaces({ id: 'another-task', workspaces: {} }, { path: repo, ref: 'HEAD' }, resolve(dir, 'data'), () => {}), /uncommitted/);
});

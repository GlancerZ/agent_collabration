import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { snapshotArtifacts } from '../src/artifacts.js';

test('host artifact snapshots measure actual bytes and reject path/symlink escape', t => {
  const dir = mkdtempSync(resolve(tmpdir(), 'agent-room-artifact-')), work = resolve(dir, 'worker'); mkdirSync(work);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(resolve(work, 'part.txt'), 'CODEX_PART\n'); writeFileSync(resolve(dir, 'private.txt'), 'must not read');
  symlinkSync(resolve(dir, 'private.txt'), resolve(work, 'escape.txt'));
  const [part, parent, symlink] = snapshotArtifacts(['part.txt', '../private.txt', 'escape.txt'], work);
  assert.equal(part.bytes, 11); assert.equal(part.text, 'CODEX_PART\n'); assert.equal(part.endsWithLF, true); assert.equal(part.containsCR, false); assert.equal(part.sha256.length, 64);
  assert.equal(parent.unavailable, 'outside producer workspace'); assert.equal(symlink.unavailable, 'outside producer workspace');
});

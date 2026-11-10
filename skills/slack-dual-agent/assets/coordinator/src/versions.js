import { mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, existsSync, renameSync, realpathSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { snapshotArtifacts } from './artifacts.js';
import { redact } from './config.js';

// Freeze named source artifacts before any subsequent writer can alter them.
export function preserveVersions({ data, job, reports, version }) {
  return Object.fromEntries(['codex', 'claude'].map(role => {
    const root = resolve(data, 'jobs', job.id, 'versions', String(job.epoch), version, role), manifest = resolve(root, 'version.json');
    if (existsSync(manifest)) return [role, JSON.parse(readFileSync(manifest, 'utf8'))];
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const report = reports[role], files = [], unavailable = [], workspace = realpathSync(job.workspaces[role]);
    for (const file of snapshotArtifacts(report.artifacts, job.workspaces[role], { limit: Infinity })) {
      // Large files exceed the inline snapshot limit but may still be preserved by copying.
      if (file.unavailable && !file.unavailable.startsWith('file exceeds snapshot limit')) { unavailable.push(file); continue; }
      const name = relative(workspace, file.path);
      if (!name || name.startsWith('..') || isAbsolute(name)) { unavailable.push({ path: file.path, unavailable: 'outside producer workspace' }); continue; }
      const target = resolve(root, 'files', name);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); copyFileSync(file.path, target); chmodSync(target, 0o444);
      files.push({ original: file.path, path: target, bytes: file.bytes, ...(file.sha256 ? { sha256: file.sha256 } : {}) });
    }
    const value = { root, version, role, epoch: job.epoch, files, unavailable, report: { ...report, artifacts: files.map(f => f.path) } };
    writeFileSync(manifest + '.tmp', redact(JSON.stringify(value, null, 2)), { mode: 0o600 }); renameSync(manifest + '.tmp', manifest); chmodSync(manifest, 0o444);
    return [role, value];
  }));
}

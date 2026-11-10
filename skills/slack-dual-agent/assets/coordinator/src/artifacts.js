import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, basename, extname } from 'node:path';

// Public links identify explicitly reported files, never arbitrary workspace paths.
export function availableArtifacts(job, port = 7417) {
  const roles = job.finalRole ? [job.finalRole] : job.mode === 'independent' ? ['codex', 'claude'] : [job.integrator || 'codex'];
  const sources = roles.map(role => ({ role, workspace: job.workspaces?.[role], report: job.results?.[role], kind: 'final', versionLabel: job.finalRole ? '最终整合版' : '现有成果' }));
  for (const [version, versions] of Object.entries(job.sourceVersions || {})) for (const [role, value] of Object.entries(versions)) sources.push({ role, workspace: value.root, report: value.report, kind: version, versionLabel: version === 'original' ? '独立初稿' : '修订候选版' });
  const files = [];
  for (const { role, workspace, report, kind, versionLabel } of sources) {
    if (!workspace) continue;
    let snapshots; try { snapshots = snapshotArtifacts(report?.artifacts || [], workspace); } catch { continue; }
    for (const file of snapshots) {
      if (file.unavailable) continue;
      const id = createHash('sha256').update(file.path).digest('hex').slice(0, 24);
      const url = `http://127.0.0.1:${port}/artifacts/${job.id}/${role}/${id}`;
      files.push({ ...file, id, role, kind, versionLabel, name: basename(file.path), extension: extname(file.path).toLowerCase(), url, downloadUrl: url + '?download=1' });
    }
  }
  return files;
}

// Only named artifacts inside the producer workspace are measured; symlink escapes are rejected.
export function snapshotArtifacts(paths, workspace, { limit = 20 } = {}) {
  const root = realpathSync(workspace);
  return [...new Set(paths)].slice(0, limit).map(name => {
    try {
      const reported = /^\[[^\]]+\]\(([^)]+)\)$/.exec(name)?.[1] || name;
      const path = realpathSync(resolve(root, reported));
      const rel = relative(root, path);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { path: name, unavailable: 'outside producer workspace' };
      const stat = statSync(path);
      if (!stat.isFile()) return { path: name, unavailable: 'not a regular file' };
      if (stat.size > 4_000_000) return { path, bytes: stat.size, unavailable: 'file exceeds snapshot limit; inspect it directly' };
      const bytes = readFileSync(path);
      return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
        first24Hex: bytes.subarray(0, 24).toString('hex'), last24Hex: bytes.subarray(-24).toString('hex'),
        endsWithLF: bytes.at(-1) === 10, containsCR: bytes.includes(13), utf8BOM: bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])),
        ...(bytes.length <= 4096 && !bytes.includes(0) ? { text: bytes.toString('utf8') } : {}) };
    } catch { return { path: name, unavailable: 'file not found or unreadable' }; }
  });
}

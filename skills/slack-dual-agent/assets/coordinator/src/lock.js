import { openSync, writeFileSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
export function acquireLock(file) {
  try {
    const pid = Number(readFileSync(file, 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 1) {
      try { process.kill(pid, 0); throw Error(`Agent Room already running (PID ${pid})`); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
    unlinkSync(file);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const fd = openSync(file, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd);
  return () => { try { if (readFileSync(file, 'utf8') === String(process.pid)) unlinkSync(file); } catch {} };
}

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openSync, closeSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, DATA, loadConfig } from './config.js';
const exec = promisify(execFile), config = loadConfig();
const action = process.argv[2] || 'status';
let pid;
try { pid = Number(readFileSync(resolve(DATA, 'service.pid'), 'utf8')); } catch {}
let ours = false;
if (pid > 1) {
  try { const r = await exec('/bin/ps', ['-p', String(pid), '-o', 'command=']); ours = r.stdout.includes(resolve(ROOT, 'src/main.js')); } catch {}
}
if (action === 'start') {
  if (ours) console.log(`Already running at http://127.0.0.1:${config.port}`);
  else {
    const fd = openSync(resolve(DATA, 'service.log'), 'a', 0o600);
    const child = spawn(process.execPath, [resolve(ROOT, 'src/main.js')], { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd] });
    await new Promise((ok, no) => { child.once('spawn', ok); child.once('error', no); });
    child.unref(); closeSync(fd); console.log(`Started PID ${child.pid}. Open http://127.0.0.1:${config.port}`);
  }
} else if (action === 'stop') {
  if (!ours) console.log('No verified Agent Room process is running.');
  else {
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 40; i++) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(r => setTimeout(r, 250));
    }
    console.log('Stop requested; current checkpoints are retained.');
  }
} else if (action === 'status') console.log(ours ? `Running PID ${pid} at http://127.0.0.1:${config.port}` : 'Stopped');
else throw Error('Use start, stop or status');

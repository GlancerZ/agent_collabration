import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('real PTY supports hidden interactive input without logging its contents',{skip:!process.env.AGENT_ROOM_TEST_PYTHON},async()=>{
  const secret='LOCAL_PTY_TEST_SECRET';
  const p=spawn(process.env.AGENT_ROOM_TEST_PYTHON,[fileURLToPath(new URL('../src/pty-bridge.py',import.meta.url)),'/bin/sh','-c','test -t 0 || exit 2; stty -echo; printf "ENTER_INPUT:"; read value; stty echo; test "$value" = LOCAL_PTY_TEST_SECRET && printf "\\nPTY_INPUT_OK\\n"'],{stdio:['pipe','pipe','pipe']});
  let output='',sent=false;const timer=setTimeout(()=>p.kill('SIGKILL'),10000);
  p.stdout.on('data',b=>{output+=b;if(!sent&&output.includes('ENTER_INPUT:')){sent=true;p.stdin.write(secret+'\n');}});p.stderr.on('data',b=>output+=b);
  const code=await new Promise((ok,no)=>{p.once('close',ok);p.once('error',no);});clearTimeout(timer);
  assert.equal(code,0);assert.ok(output.includes('PTY_INPUT_OK'));assert.ok(!output.includes(secret));
});

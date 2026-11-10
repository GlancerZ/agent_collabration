#!/usr/bin/env node
import {readFileSync, readdirSync, lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve, dirname, relative, isAbsolute, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function walk(root) {
  const files=[];
  for (const entry of readdirSync(root, {withFileTypes:true})) {
    const path=resolve(root,entry.name), stat=lstatSync(path);
    if(stat.isSymbolicLink()) throw Error('Package contains a symlink: '+relative(skillRoot,path));
    if(stat.isDirectory()) files.push(...walk(path));
    else if(stat.isFile()) files.push(path);
    else throw Error('Unsupported package entry: '+path);
  }
  return files.sort();
}
export function verifyBundle(root=skillRoot) {
  const bundle=resolve(root,'assets/coordinator');
  const manifest=JSON.parse(readFileSync(resolve(root,'assets/coordinator-manifest.json'),'utf8'));
  if(manifest.format!==1||!Array.isArray(manifest.files)||!manifest.files.length)throw Error('Invalid coordinator manifest');
  const expected=new Set();
  for(const f of manifest.files){
    if(typeof f.path!=='string'||isAbsolute(f.path)||f.path.split('/').some(x=>!x||x==='.'||x==='..')||expected.has(f.path))throw Error('Invalid manifest path');
    const path=resolve(bundle,f.path);
    if(!path.startsWith(bundle+sep))throw Error('Manifest escaped bundle');
    expected.add(f.path);
    const data=readFileSync(path);
    if(data.length!==f.bytes||createHash('sha256').update(data).digest('hex')!==f.sha256)throw Error('Bundle integrity mismatch: '+f.path);
  }
  const actual=walk(bundle).map(p=>relative(bundle,p).split(sep).join('/'));
  if(actual.length!==expected.size||actual.some(p=>!expected.has(p)))throw Error('Bundle has unlisted files');
  return {bundle,files:manifest.files};
}
export function checkPackage(root=skillRoot) {
  const {files}=verifyBundle(root);
  const packageFiles=walk(root);
  const sensitive=[
    /\bxox[baprs]-[A-Za-z0-9-]{30,}/,
    /\bxapp-[A-Za-z0-9-]{30,}/,
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/,
    /\bsk-[A-Za-z0-9_-]{24,}/,
    /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
    /https?:\/\/[^\s/:@]+:[^\s/@]+@/
  ];
  for(const path of packageFiles){
    const rel=relative(root,path).split(sep).join('/');
    if(rel.split('/').some(s=>['.local','node_modules','.git','__pycache__','.venv'].includes(s))||/(?:^|\/)\.env(?:\.|$)|\.(?:sqlite(?:-wal|-shm)?|db|log|png|jpe?g|zip|skill)$/.test(rel))throw Error('Runtime/private file in package: '+rel);
    // These fixed example.com credentials are a rejection test, never a live login.
    const text=readFileSync(path,'utf8').replaceAll('https://user:password@example.com/','https://example.com/');
    if(sensitive.some(p=>p.test(text)))throw Error('Possible embedded credential: '+rel);
  }
  return {ok:true,coordinatorFiles:files.length,skillFiles:packageFiles.length,coordinatorBytes:files.reduce((n,f)=>n+f.bytes,0)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try {console.log(JSON.stringify(checkPackage(),null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}

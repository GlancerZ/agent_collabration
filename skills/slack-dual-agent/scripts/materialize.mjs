#!/usr/bin/env node
import {accessSync, constants, existsSync, lstatSync, readdirSync, mkdirSync, writeFileSync, chmodSync, readFileSync} from 'node:fs';
import {resolve, dirname, isAbsolute, delimiter} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {verifyBundle, checkPackage} from './check-package.mjs';
import {defaults, validateConfig} from '../assets/coordinator/src/config.js';

function executable(path){try{accessSync(path,constants.X_OK);return lstatSync(path).isFile()||lstatSync(path).isSymbolicLink();}catch{return false;}}
export function findProgram(name,{envPath=process.env.PATH||'',home=homedir()}={}){
  const candidates=envPath.split(delimiter).filter(Boolean).map(dir=>resolve(dir,name));
  candidates.push(resolve(home,'.local/bin',name));
  if(name==='codex')for(const app of ['ChatGPT','Codex'])candidates.push(`/Applications/${app}.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`);
  return candidates.find(executable)||name;
}
export function materialize(destination,{port=7417,codexBin,claudeBin}={}){
  if(!isAbsolute(destination))throw Error('Destination must be an absolute path');
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Port must be an integer from 1024 to 65535');
  destination=resolve(destination);
  if(existsSync(destination)){
    if(lstatSync(destination).isSymbolicLink()||!lstatSync(destination).isDirectory()||readdirSync(destination).length)throw Error('Refusing to overwrite a nonempty destination or symlink');
  }
  checkPackage();
  const config=structuredClone(defaults);
  config.port=port;
  config.agents.codex.bin=codexBin||findProgram('codex');
  config.agents.claude.bin=claudeBin||findProgram('claude');
  const python=findProgram('python3');
  if(isAbsolute(python))config.capabilities.pythonBin=python;
  validateConfig(config);
  const {bundle,files}=verifyBundle();
  mkdirSync(destination,{recursive:true});
  for(const f of files){const target=resolve(destination,f.path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,readFileSync(resolve(bundle,f.path)),{flag:'wx',mode:0o644});}
  const data=resolve(destination,'.local');mkdirSync(data,{mode:0o700});chmodSync(data,0o700);
  const configPath=resolve(data,'config.json');writeFileSync(configPath,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});chmodSync(configPath,0o600);
  return {destination,filesCopied:files.length,configCreated:true,slackEnabled:false,optionalCapabilitiesEnabled:false,cli:{codex:config.agents.codex.bin,claude:config.agents.claude.bin},missingCli:Object.entries(config.agents).filter(([,v])=>!isAbsolute(v.bin)&&!executable(v.bin)).map(([k])=>k),managementUrl:`http://127.0.0.1:${port}`,next:['npm ci --ignore-scripts --no-audit --no-fund','node src/main.js doctor','node src/manage.js start']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const args=process.argv.slice(2),options={};let destination;
    if(args.includes('--help')){console.log('Usage: node materialize.mjs --destination /absolute/path [--port 7417] [--codex-bin /path/codex] [--claude-bin /path/claude]\nCreates a fresh coordinator without overwriting existing files; does not install, start or authenticate.');process.exit(0);}
    for(let i=0;i<args.length;i++){
      const key=args[i],value=args[++i];if(!value||value.startsWith('--'))throw Error('Missing option value');
      if(key==='--destination')destination=value;
      else if(key==='--port')options.port=Number(value);
      else if(key==='--codex-bin')options.codexBin=value;
      else if(key==='--claude-bin')options.claudeBin=value;
      else throw Error('Unknown option: '+key);
    }
    if(!destination)throw Error('An absolute --destination is required');
    console.log(JSON.stringify(materialize(destination,options),null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, access, symlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { ROOT } from '../src/model.mjs';

const local=path.join(ROOT,'.local'),data=path.join(local,'postgres');
const nativeRoot=path.join(ROOT,'node_modules/@embedded-postgres/darwin-arm64');
const binary=name=>path.join(nativeRoot,'native/bin',name);
async function run(name,args,{quiet=false}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(binary(name),args,{stdio:quiet?'pipe':'inherit'});
    let output='';if(quiet){child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);}
    child.on('error',reject);child.on('exit',code=>resolve({code,output}));
  });
}
await mkdir(local,{recursive:true,mode:0o700});
// npm tarballs cannot carry native library symlinks. Restore only in this package.
for(const link of JSON.parse(await readFile(path.join(nativeRoot,'native/pg-symlinks.json'),'utf8'))) {
  const source=path.resolve(nativeRoot,link.source),target=path.resolve(nativeRoot,link.target);
  if(!source.startsWith(nativeRoot+'/')||!target.startsWith(nativeRoot+'/')) throw new Error('Native package symlink escapes its directory');
  try {await access(target);}catch {await symlink(path.relative(path.dirname(target),source),target);}
}
const action=process.argv[2]??'status';
const configFile=path.join(local,'connection.json'),ownerFile=path.join(local,'cluster-owner.json');
if(action==='start') {
  let config;
  try {config=JSON.parse(await readFile(configFile,'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;config={host:'127.0.0.1',port:55432,user:'calypso_lab',password:randomBytes(24).toString('base64url'),database:'calypso_lab'};
    await writeFile(configFile,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
    await writeFile(path.join(local,'password'),config.password+'\n',{mode:0o600,flag:'wx'});}
  let initialized=true;try{await access(path.join(data,'PG_VERSION'));}catch{initialized=false;}
  if(!initialized) {
    const result=await run('initdb',['-D',data,'-U',config.user,'--encoding=UTF8','--locale=C','--auth=scram-sha-256','--pwfile='+path.join(local,'password')]);
    if(result.code!==0)throw new Error('initdb failed; no existing database was reset');
    await writeFile(ownerFile,JSON.stringify({root:ROOT,data})+'\n',{mode:0o600});
  }
  const owner=JSON.parse(await readFile(ownerFile,'utf8'));
  if(owner.root!==ROOT||owner.data!==data)throw new Error('Cluster does not belong to this workspace');
  const status=await run('pg_ctl',['-D',data,'status'],{quiet:true});
  if(status.code!==0) {
    const result=await run('pg_ctl',['-D',data,'-l',path.join(local,'postgres.log'),'-o',`-h 127.0.0.1 -p ${config.port} -c unix_socket_directories='' -c shared_buffers=64MB -c max_connections=20`,'-w','start']);
    if(result.code!==0)throw new Error('PostgreSQL could not start; inspect .local/postgres.log');
  }
  const admin=new pg.Client({...config,database:'postgres'});await admin.connect();
  try{if(!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[config.database])).rows.length)await admin.query('CREATE DATABASE calypso_lab');}
  finally{await admin.end();}
  console.log('Native PostgreSQL ready · 127.0.0.1:55432 · database calypso_lab · credentials in .local/connection.json');
} else if(action==='stop'||action==='status') {
  const owner=JSON.parse(await readFile(ownerFile,'utf8'));
  if(owner.root!==ROOT||owner.data!==data)throw new Error('Cluster ownership mismatch');
  const result=await run('pg_ctl',['-D',data,...(action==='stop'?['-m','fast','-w','stop']:['status'])]);
  if(result.code!==0)process.exitCode=result.code;
} else throw new Error('Use start, stop, or status');

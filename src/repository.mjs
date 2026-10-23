import pg from 'pg';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, TABLES, MODEL_VERSION, digest } from './model.mjs';
import { schemaSQL } from './schema.mjs';

function identifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error('Invalid internal SQL identifier');
  return `"${value}"`;
}
export class Repository {
  constructor(backend,engine) {this.backend=backend;this.engine=engine;this.queue=Promise.resolve();}
  async sql(sql,params=[]) {
    if (this.backend==='postgres') return (await this.engine.query(sql,params)).rows;
    const prepared=this.engine.prepare(sql.replace(/\$\d+/g,'?'));
    return prepared.columns().length ? prepared.all(...params) : (prepared.run(...params),[]);
  }
  async exec(sql) { if(this.backend==='postgres') await this.engine.query(sql); else this.engine.exec(sql); }
  encode(table,key,value) {return TABLES[table]?.json.includes(key)?JSON.stringify(value):value;}
  decode(table,row) {
    const result={...row};
    for (const key of TABLES[table].json) if(typeof result[key]==='string') result[key]=JSON.parse(result[key]);
    for (const key of TABLES[table].numbers??[]) if(result[key]!=null) result[key]=Number(result[key]);
    for (const [key,value] of Object.entries(result)) if(value instanceof Date) result[key]=value.toISOString();
    return result;
  }
  where(table,filters) {
    if(!TABLES[table]) throw new Error('Unknown domain table');
    const entries=Object.entries(filters),values=[];
    return {clause:entries.length?' WHERE '+entries.map(([key,value])=>{
      if(value==null) return `${identifier(key)} IS NULL`;
      values.push(this.encode(table,key,value));return `${identifier(key)}=$${values.length}`;
    }).join(' AND '):'',values};
  }
  async list(table,filters={}) {
    const {clause,values}=this.where(table,filters);
    return (await this.sql(`SELECT * FROM ${identifier(table)}${clause} ORDER BY ${identifier(TABLES[table].pk)}`,values)).map(row=>this.decode(table,row));
  }
  async get(table,filters) {return (await this.list(table,filters))[0]??null;}
  async insert(table,row) {
    if(!TABLES[table]) throw new Error('Unknown domain table');
    const entries=Object.entries(row);
    await this.sql(`INSERT INTO ${identifier(table)}(${entries.map(([key])=>identifier(key)).join(',')}) VALUES(${entries.map((_,i)=>`$${i+1}`).join(',')})`,
      entries.map(([key,value])=>this.encode(table,key,value)));
  }
  async updateMaterial(materialId,changes) {
    if(Object.keys(changes).some(key=>!['revision','updated_at'].includes(key))) throw new Error('Only revision timestamps are mutable in this lab');
    const entries=Object.entries(changes);
    await this.sql(`UPDATE materials SET ${entries.map(([key],i)=>`${identifier(key)}=$${i+1}`).join(',')} WHERE material_id=$${entries.length+1}`,[...entries.map(([,v])=>v),materialId]);
  }
  async updateChoice(choiceId,calculationId,time) {
    await this.sql('UPDATE property_choices SET calculation_id=$1,updated_at=$2 WHERE choice_id=$3',[calculationId,time,choiceId]);
  }
  transaction(action) {
    // A single client/SQLite connection must not interleave transactions.
    const work=this.queue.then(async()=>{
      await this.exec(this.backend==='postgres'?'BEGIN':'BEGIN IMMEDIATE');
      try {const result=await action(this);await this.exec('COMMIT');return result;}
      catch(error){await this.exec('ROLLBACK');throw error;}
    });
    this.queue=work.catch(()=>{});return work;
  }
  async lockSource(sourceId) {if(this.backend==='postgres') await this.sql('SELECT pg_advisory_xact_lock(hashtext($1))',[sourceId]);}
  async lockIdentities(keys) {
    for(const key of [...new Set(keys)].sort())await this.lockSource('material-identity:'+key);
  }
  async deferConstraints() {await this.exec(this.backend==='postgres'?'SET CONSTRAINTS ALL DEFERRED':'PRAGMA defer_foreign_keys=ON');}
  async assertIntegrity() {if(this.backend==='sqlite'&&(await this.sql('PRAGMA foreign_key_check')).length)throw new Error('Transfer contains broken foreign keys');}
  async initialize() {
    const ddl=schemaSQL(this.backend),checksum=digest(ddl);
    const exists=this.backend==='postgres' ? (await this.sql("SELECT to_regclass('schema_migrations') AS name"))[0]?.name
      : (await this.sql("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'"))[0]?.name;
    if(!exists) await this.transaction(async()=>{
      await this.exec(ddl);
      await this.sql('INSERT INTO schema_migrations VALUES($1,$2,$3)',[MODEL_VERSION,checksum,new Date().toISOString()]);
    });
    const versions=await this.sql('SELECT version,checksum FROM schema_migrations ORDER BY version');
    if(versions.length!==1 || versions[0].version!==MODEL_VERSION || versions[0].checksum!==checksum) throw new Error('Schema differs from recorded migration; add a versioned migration instead of overwriting');
  }
  async close() {if(this.backend==='postgres') await this.engine.end();else this.engine.close();}
}
export async function openRepository({backend='postgres',schema='calypso_lab',filename}={}) {
  let repo;
  if(backend==='postgres') {
    if(schema!=='calypso_lab'&&!/^calypso_test_[a-f0-9]{16}$/.test(schema)) throw new Error('Only this lab’s isolated schemas are allowed');
    const config=JSON.parse(await readFile(path.join(ROOT,'.local','connection.json'),'utf8'));
    const client=new pg.Client({...config,application_name:'calypso-real-data-lab'});
    await client.connect();
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${identifier(schema)}`);
    await client.query(`SET search_path TO ${identifier(schema)}, public`);
    repo=new Repository(backend,client);
  } else if(backend==='sqlite') {
    const {DatabaseSync}=await import('node:sqlite');
    const file=filename??path.join(ROOT,'.local','portable.sqlite');
    if(file!==':memory:') await mkdir(path.dirname(file),{recursive:true});
    const engine=new DatabaseSync(file);
    engine.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    repo=new Repository(backend,engine);
  } else throw new Error('Backend must be postgres or sqlite');
  try {await repo.initialize();return repo;}catch(error){await repo.close();throw error;}
}

import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {ROOT} from '../model.mjs';
import path from 'node:path';

export async function platformPool() {
 const config=JSON.parse(await readFile(path.join(ROOT,'.local/connection.json'),'utf8'));
 return new pg.Pool({...config,max:5,application_name:'calypso-local-platform'});
}
export async function transaction(pool,fn) {
 const db=await pool.connect();
 try {await db.query('BEGIN');const result=await fn(db);await db.query('COMMIT');return result;}
 catch(e){await db.query('ROLLBACK');throw e;} finally {db.release();}
}
export async function migrate(pool) {
 const migrations=await Promise.all(['001-platform.sql','002-account-management.sql','003-account-lifecycle.sql','004-contribution-hierarchy.sql','005-unified-ingestion.sql'].map(async (name,index)=>{
  const sql=await readFile(new URL('./'+name,import.meta.url),'utf8');
  return {version:index+1,sql,checksum:createHash('sha256').update(sql).digest('hex')};
 }));
 await transaction(pool,async db=>{
  await db.query("SELECT pg_advisory_xact_lock(hashtext('calypso-platform-migration'))");
  const exists=(await db.query("SELECT to_regclass('calypso_platform.migrations') AS name")).rows[0].name;
  const applied=exists?(await db.query('SELECT * FROM calypso_platform.migrations ORDER BY version')).rows:[];
  if(applied.some(row=>!migrations.some(m=>m.version===row.version)))throw new Error('Unknown platform schema version');
  for(const migration of migrations){
   const row=applied.find(item=>item.version===migration.version);
   if(row){if(row.checksum!==migration.checksum)throw new Error('Platform migration checksum mismatch; do not edit applied migrations');continue;}
   await db.query(migration.sql);await db.query('INSERT INTO calypso_platform.migrations(version,checksum) VALUES($1,$2)',[migration.version,migration.checksum]);
  }
 });
}
export function userDto(row) {
 return {id:row.id,username:row.username,email:row.email,emailVerified:row.email_verified,role:row.role,profile:row.profile,version:String(row.version),passwordChangeRequired:row.password_change_required??false,status:row.status??'active',statusReason:row.status_reason??'',demoAccount:row.demo_account??false,createdAt:row.created_at?.toISOString()};
}
export async function event(db,batchId,actorId,type,detail) {
 await db.query('INSERT INTO calypso_platform.batch_events(batch_id,actor_id,type,detail) VALUES($1,$2,$3,$4)',[batchId,actorId,type,detail]);
}
export const newId=()=>randomUUID();

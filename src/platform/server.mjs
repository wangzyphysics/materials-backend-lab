import {createServer} from 'node:http';
import {createHash,randomBytes,pbkdf2,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {registrationSchema,profileSchema,passwordSchema,loginMethods,canChangeRole} from '../domain/accounts/model.ts';
import {batchSchema} from '../domain/materials/batch-contribution.ts';
import {platformPool,migrate,transaction,userDto,event,newId} from './database.mjs';
import {listMaterials,statistics} from './materials.mjs';
import {materialDetail,detailDownload} from './material-detail.mjs';
import {communityStatistics,adminStatistics,readStatistics} from './statistics.mjs';
import {platformRuntimeConfig,platformSessionCookie} from './runtime-config.mjs';
import {ownedBatch,draftDto,statusDto,saveContribution} from './contributions.mjs';
import {previewImport,commitImport,listImports} from '../ingestion/service.mjs';
import {validatePackage} from '../ingestion/validation.mjs';

const derive=promisify(pbkdf2),cookieName='calypso_session',hours=8;
const digest=v=>createHash('sha256').update(v).digest('hex');
const opaque=()=>randomBytes(32).toString('base64url');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class HttpError extends Error {constructor(status,message){super(message);this.status=status;}}
const fail=(status,message)=>{throw new HttpError(status,message);};
export async function hashPassword(password) {
 const salt=randomBytes(16).toString('hex');
 return {algorithm:'pbkdf2-sha256',iterations:600000,salt,hash:(await derive(password,salt,600000,32,'sha256')).toString('hex')};
}
async function validPassword(password,stored) {
 if(typeof password!=='string'||password.length>128||stored?.algorithm!=='pbkdf2-sha256'||stored.iterations!==600000)return false;
 return timingSafeEqual(await derive(password,stored.salt,stored.iterations,32,'sha256'),Buffer.from(stored.hash,'hex'));
}
function exact(body,keys) {
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!keys.includes(k)))fail(400,'Unsupported request fields');
}
async function jsonBody(req) {
 if(!req.headers['content-type']?.startsWith('application/json'))fail(415,'Use application/json');
 const max=72*1024*1024;if(Number(req.headers['content-length'])>max)fail(413,'Batch is too large');
 let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>max)fail(413,'Batch is too large');chunks.push(chunk);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(400,'Invalid JSON');}
}
async function session(db,req) {
 const raw=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith(cookieName+'='))?.slice(cookieName.length+1);
 if(!raw||!/^[A-Za-z0-9_-]{43}$/.test(raw))return null;
 const row=(await db.query('SELECT s.*,u.id AS account_id,u.username,u.email,u.email_verified,u.role,u.profile,u.version,u.password_change_required,u.status,u.status_reason,u.demo_account,u.created_at AS account_created_at FROM calypso_platform.sessions s LEFT JOIN calypso_platform.users u ON u.id=s.user_id WHERE token_hash=$1 AND expires_at>now()',[digest(raw)])).rows[0];
 return row?{...row,user:row.account_id&&row.status==='active'&&!row.demo_account?userDto({...row,id:row.account_id,created_at:row.account_created_at}):null}:null;
}
async function startSession(db,res,user,previous,secureCookies=false) {
 const token=opaque(),csrf=opaque(),expires=new Date(Date.now()+hours*3600000);
 if(previous)await db.query('DELETE FROM calypso_platform.sessions WHERE token_hash=$1',[previous.token_hash]);
 await db.query('INSERT INTO calypso_platform.sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,$4)',[digest(token),user?.id??null,csrf,expires]);
 res.setHeader('Set-Cookie',platformSessionCookie(token,{secureCookies}));
 return {user,csrfToken:csrf,expiresAt:expires.toISOString()};
}
async function rateLimit(db,key,max=10) {
 const row=(await db.query(`INSERT INTO calypso_platform.rate_limits(key,window_start,attempts) VALUES($1,now(),1)
 ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN calypso_platform.rate_limits.window_start<now()-interval '15 minutes' THEN 1 ELSE calypso_platform.rate_limits.attempts+1 END,
 window_start=CASE WHEN calypso_platform.rate_limits.window_start<now()-interval '15 minutes' THEN now() ELSE calypso_platform.rate_limits.window_start END RETURNING attempts`,[key])).rows[0];
 if(row.attempts>max)fail(429,'Too many attempts. Try later.');
}
export async function createUser(db,input,{role='member',test=false}={}) {
 const data=registrationSchema.parse(input),credential=await hashPassword(data.password),id=newId();
 const row=(await db.query('INSERT INTO calypso_platform.users(id,username,email,profile,role,test_account) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[id,data.username,data.email,data.profile,role,test])).rows[0];
 await db.query('INSERT INTO calypso_platform.password_credentials(user_id,password_hash) VALUES($1,$2)',[id,credential]);return userDto(row);
}

export async function createPlatformServer(pool,{origins=['http://127.0.0.1:5173','http://localhost:5173'],secureCookies=false}={}) {
 const dummy=await hashPassword(opaque());
 const issueSession=(db,res,user,previous)=>startSession(db,res,user,previous,secureCookies);
 return createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  try {
   if(!['127.0.0.1','localhost','[::1]'].includes(new URL('http://'+req.headers.host).hostname))fail(403,'Local service only');
   const url=new URL(req.url,'http://localhost'),path=url.pathname,method=req.method;
   if(path==='/health'&&method==='GET'){await pool.query('SELECT 1');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,backend:'postgres',mode:'local'}));return;}
   const auth=await session(pool,req),user=auth?.user;
   if(!['GET','HEAD'].includes(method)){
    if(!origins.includes(req.headers.origin)||!auth||req.headers['x-csrf-token']!==auth.csrf_token)fail(403,'Invalid origin or CSRF token');
   }
   const requireUser=(allowPasswordChange=false)=>{if(!user)fail(401,'Sign in required');if(user.passwordChangeRequired&&!allowPasswordChange)fail(403,'Change your temporary password before continuing');};
   const requireAdmin=()=>{requireUser();if(user.role!=='admin')fail(403,'Administrator access required');};
   let result;
   if(path==='/api/identity/providers'&&method==='GET')result=loginMethods.map(id=>({id,enabled:id==='password'}));
   else if(path==='/api/identity/registration-options'&&method==='GET')result={passwordRegistration:true,emailVerification:false,mode:'local-database'};
   else if(path==='/api/identity/session'&&method==='GET')result=auth?{user,csrfToken:auth.csrf_token,expiresAt:auth.expires_at.toISOString()}:await issueSession(pool,res,null,null);
   else if(path==='/api/identity/password/sign-in'&&method==='POST'){
    const body=await jsonBody(req);exact(body,['identity','password']);if(typeof body.identity!=='string'||body.identity.length>254||typeof body.password!=='string'||body.password.length>128)fail(400,'Invalid credentials');
    const identity=body.identity.trim().toLowerCase();await rateLimit(pool,'login:'+digest(req.socket.remoteAddress+'|'+identity));
    const row=(await pool.query('SELECT u.*,p.password_hash FROM calypso_platform.users u JOIN calypso_platform.password_credentials p ON p.user_id=u.id WHERE u.username=$1 OR u.email=$1',[identity])).rows[0];
    const valid=await validPassword(body.password,row?.password_hash??dummy);if(!row||!valid||row.status!=='active'||row.demo_account)fail(401,'Invalid account or password');
    result=await transaction(pool,db=>issueSession(db,res,userDto(row),auth));
   } else if(path==='/api/identity/registrations/password'&&method==='POST'){
    if(user)fail(409,'Already signed in');await rateLimit(pool,'register:'+digest(req.socket.remoteAddress),20);
    const body=await jsonBody(req);result=await transaction(pool,async db=>issueSession(db,res,await createUser(db,body),auth));
   } else if(path==='/api/identity/logout'&&method==='POST'){
    await pool.query('DELETE FROM calypso_platform.sessions WHERE token_hash=$1',[auth.token_hash]);res.setHeader('Set-Cookie',platformSessionCookie('',{secureCookies,maxAge:0}));result={ok:true};
   } else if(path==='/api/identity/password/change'&&method==='POST'){
    requireUser(true);const body=await jsonBody(req);exact(body,['currentPassword','newPassword']);const next=passwordSchema.parse(body.newPassword);
    if(typeof body.currentPassword!=='string'||body.currentPassword.length>128)fail(400,'Enter the current password');
    await rateLimit(pool,'password-change:'+user.id);
    result=await transaction(pool,async db=>{
     const row=(await db.query('SELECT u.*,p.password_hash FROM calypso_platform.users u JOIN calypso_platform.password_credentials p ON p.user_id=u.id WHERE u.id=$1 FOR UPDATE OF u,p',[user.id])).rows[0];
     if(row.status!=='active'||row.demo_account)fail(403,'Active account required');if(!await validPassword(body.currentPassword,row.password_hash))fail(401,'The current password is incorrect');
     if(await validPassword(next,row.password_hash))fail(400,'Choose a different new password');
     await db.query('UPDATE calypso_platform.password_credentials SET password_hash=$1 WHERE user_id=$2',[await hashPassword(next),user.id]);
     const updated=(await db.query('UPDATE calypso_platform.users SET password_change_required=false,version=version+1 WHERE id=$1 RETURNING *',[user.id])).rows[0];
     await db.query('DELETE FROM calypso_platform.sessions WHERE user_id=$1',[user.id]);
     await db.query("INSERT INTO calypso_platform.account_audit(id,actor_id,target_id,action,reason) VALUES($1,$2,$2,'password-changed','Account owner changed password')",[newId(),user.id]);
     return issueSession(db,res,userDto(updated),null);
    });
   } else if(path==='/api/identity/me/profile'&&method==='PATCH'){
    requireUser();const body=await jsonBody(req);exact(body,['profile','expectedVersion']);const profile=profileSchema.strict().parse(body.profile);
    const row=(await pool.query('UPDATE calypso_platform.users SET profile=$1,version=version+1 WHERE id=$2 AND version::text=$3 RETURNING *',[profile,user.id,body.expectedVersion])).rows[0];if(!row)fail(409,'Profile changed; reload it');result=userDto(row);
   } else if(path==='/api/identity/admin/statistics'&&method==='GET'){
    requireAdmin();const view=url.searchParams.get('view')??'live';if(!['live','demo'].includes(view))fail(400,'Invalid statistics view');result=await readStatistics(pool,db=>adminStatistics(db,view));
   } else if(path==='/api/identity/admin/users'&&method==='GET'){
    requireAdmin();const users=(await pool.query('SELECT * FROM calypso_platform.users ORDER BY created_at,id')).rows;
    const audit=(await pool.query('SELECT * FROM calypso_platform.role_audit ORDER BY occurred_at DESC LIMIT 500')).rows;
    const accountAudit=(await pool.query('SELECT * FROM calypso_platform.account_audit ORDER BY occurred_at DESC LIMIT 500')).rows;
    result={items:users.map(userDto),audit:audit.map(a=>({id:a.id,actorId:a.actor_id,targetId:a.target_id,previousRole:a.previous_role,role:a.role,reason:a.reason,at:a.occurred_at.toISOString()})),accountAudit:accountAudit.map(a=>({id:a.id,actorId:a.actor_id,targetId:a.target_id,action:a.action,reason:a.reason,at:a.occurred_at.toISOString()}))};
   } else if(/^\/api\/identity\/admin\/users\/[^/]+\/(status|sessions)$/.test(path)&&method==='PATCH'){
    requireAdmin();const id=path.split('/')[5],operation=path.split('/')[6],body=await jsonBody(req);if(!uuid.test(id))fail(404,'Account not found');
    exact(body,operation==='status'?['status','reason','expectedVersion']:['reason','expectedVersion']);
    if(typeof body.reason!=='string'||body.reason.trim().length<3||body.reason.length>500)fail(400,'Provide a reason');
    if(operation==='status'&&!['active','suspended','deleted'].includes(body.status))fail(400,'Invalid account status');
    if(id===user.id)fail(403,'Another administrator must manage your access');
    result=await transaction(pool,async db=>{
     await db.query("SELECT pg_advisory_xact_lock(hashtext('calypso-platform-roles'))");
     const users=(await db.query('SELECT * FROM calypso_platform.users ORDER BY id FOR UPDATE')).rows,actor=users.find(u=>u.id===user.id),target=users.find(u=>u.id===id);
     if(!actor||actor.role!=='admin'||actor.status!=='active'||actor.password_change_required)fail(403,'Administrator access required');
     if(!target)fail(404,'Account not found');if(String(target.version)!==body.expectedVersion)fail(409,'Account changed; refresh before editing');
     if(operation==='status'&&target.status===body.status)fail(409,'Account already has this status');
     if(operation==='status'&&target.role==='admin'&&body.status!=='active'&&users.filter(u=>u.role==='admin'&&u.status==='active'&&!u.demo_account).length<=1)fail(403,'The last active administrator must be retained');
     if(operation==='status'&&target.status==='deleted'&&body.status!=='active')fail(409,'Restore the deleted account before further changes');
     let updated=target,action='sessions-revoked';
     if(operation==='status'){action=body.status==='deleted'?'account-deleted':body.status==='suspended'?'account-suspended':target.status==='deleted'?'account-restored':'account-reactivated';updated=(await db.query('UPDATE calypso_platform.users SET status=$1,status_reason=$2,status_changed_at=now(),version=version+1 WHERE id=$3 RETURNING *',[body.status,body.reason.trim(),id])).rows[0];}
     else updated=(await db.query('UPDATE calypso_platform.users SET version=version+1 WHERE id=$1 RETURNING *',[id])).rows[0];
     await db.query('DELETE FROM calypso_platform.sessions WHERE user_id=$1',[id]);
     await db.query('INSERT INTO calypso_platform.account_audit(id,actor_id,target_id,action,reason) VALUES($1,$2,$3,$4,$5)',[newId(),user.id,id,action,body.reason.trim()]);return userDto(updated);
    });
   } else if(/^\/api\/identity\/admin\/users\/[^/]+\/(profile|password-reset)$/.test(path)&&['PATCH','POST'].includes(method)){
    requireAdmin();const id=path.split('/')[5],operation=path.split('/')[6],body=await jsonBody(req);
    if(!uuid.test(id))fail(404,'Account not found');
    const editing=operation==='profile';if(method!==(editing?'PATCH':'POST'))fail(405,'Unsupported method');
    exact(body,editing?['profile','reason','expectedVersion']:['reason','expectedVersion']);
    if(typeof body.reason!=='string'||body.reason.trim().length<3||body.reason.length>500)fail(400,'Provide a reason for the account change');
    if(id===user.id)fail(403,'Use your own account settings; another administrator is required to reset your account');
    const profile=editing?profileSchema.strict().parse(body.profile):null;
    result=await transaction(pool,async db=>{
     await db.query("SELECT pg_advisory_xact_lock(hashtext('calypso-platform-roles'))");
     const actor=(await db.query('SELECT * FROM calypso_platform.users WHERE id=$1 FOR UPDATE',[user.id])).rows[0];if(actor.role!=='admin'||actor.password_change_required||actor.status!=='active')fail(403,'Administrator access required');
     const target=(await db.query('SELECT * FROM calypso_platform.users WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!target)fail(404,'Account not found');if(String(target.version)!==body.expectedVersion)fail(409,'Account changed; refresh before editing');if(!editing&&(target.demo_account||target.status!=='active'))fail(403,'Only an active real account can receive a password reset');
     let row,temporaryPassword,fields=[];
     if(editing){fields=Object.keys(profile).filter(key=>JSON.stringify(profile[key])!==JSON.stringify(target.profile[key]));row=(await db.query('UPDATE calypso_platform.users SET profile=$1,version=version+1 WHERE id=$2 RETURNING *',[profile,id])).rows[0];}
     else {temporaryPassword=randomBytes(18).toString('base64url');await db.query('UPDATE calypso_platform.password_credentials SET password_hash=$1 WHERE user_id=$2',[await hashPassword(temporaryPassword),id]);row=(await db.query('UPDATE calypso_platform.users SET password_change_required=true,version=version+1 WHERE id=$1 RETURNING *',[id])).rows[0];await db.query('DELETE FROM calypso_platform.sessions WHERE user_id=$1',[id]);}
     await db.query('INSERT INTO calypso_platform.account_audit(id,actor_id,target_id,action,reason,changed_fields) VALUES($1,$2,$3,$4,$5,$6)',[newId(),user.id,id,editing?'profile-updated':'password-reset',body.reason.trim(),JSON.stringify(fields)]);
     return editing?userDto(row):{user:userDto(row),temporaryPassword};
    });
   } else if(/^\/api\/identity\/admin\/users\/[^/]+\/role$/.test(path)&&method==='PATCH'){
    requireAdmin();const id=path.split('/')[5];if(!uuid.test(id))fail(404,'Account not found');const body=await jsonBody(req);exact(body,['role','reason','expectedVersion']);
    if(!['admin','member'].includes(body.role)||typeof body.reason!=='string'||body.reason.trim().length<3||body.reason.length>500)fail(400,'Invalid role or reason');
    result=await transaction(pool,async db=>{
     await db.query("SELECT pg_advisory_xact_lock(hashtext('calypso-platform-roles'))");const users=(await db.query('SELECT * FROM calypso_platform.users ORDER BY id FOR UPDATE')).rows.map(userDto),actor=users.find(u=>u.id===user.id),target=users.find(u=>u.id===id);
     if(actor.role!=='admin'||actor.status!=='active'||actor.password_change_required)fail(403,'Administrator access required');if(!target)fail(404,'Account not found');if(target.version!==body.expectedVersion)fail(409,'Account changed');
     try{canChangeRole(actor,target,body.role,users);}catch(e){fail(403,e.message);}
     const row=(await db.query('UPDATE calypso_platform.users SET role=$1,version=version+1 WHERE id=$2 RETURNING *',[body.role,id])).rows[0];
     await db.query('INSERT INTO calypso_platform.role_audit(id,actor_id,target_id,previous_role,role,reason) VALUES($1,$2,$3,$4,$5,$6)',[newId(),actor.id,id,target.role,body.role,body.reason.trim()]);
     await db.query('DELETE FROM calypso_platform.sessions WHERE user_id=$1',[id]);return userDto(row);
    });
   } else if(path==='/api/materials/statistics'&&method==='GET'){
    result=await readStatistics(pool,async db=>{const communityDemo=await communityStatistics(db,'demo');return {...await statistics(db),community:await communityStatistics(db),...(communityDemo.registeredUsers.count?{communityDemo}:{})};});
   } else if(path==='/api/materials/previews'&&method==='GET'){
    if(url.search)fail(400,'Public previews do not accept search criteria');result=await listMaterials(pool,new URLSearchParams('limit=6'),{importedOnly:true});
   } else if(path==='/api/materials/materials'&&method==='GET'){
    requireUser();try{result=await readStatistics(pool,db=>listMaterials(db,url.searchParams));}catch(e){if(e.code)throw e;fail(400,e.message);}
   } else if(/^\/api\/materials\/records\/[^/]+(?:\/download)?$/.test(path)&&method==='GET'){
    requireUser();let key;try{key=decodeURIComponent(path.split('/')[4]);}catch{fail(400,'Invalid record identifier');}
    if(path.endsWith('/download')){
     const file=await readStatistics(pool,db=>detailDownload(db,key,user,url.searchParams));
     res.setHeader('Content-Type',file.type);res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);res.end(file.bytes);return;
    }
    if(url.search)fail(400,'Record details do not accept query parameters');
    result=await readStatistics(pool,db=>materialDetail(db,key,user));
   } else if(path==='/api/contributions/validate'&&method==='POST'){
    requireUser();const body=await jsonBody(req);exact(body,['draft']);result=(await validatePackage(body.draft)).report;
   } else if(path==='/api/contributions/admin/imports/preview'&&method==='POST'){
    requireAdmin();result=await previewImport(pool,user,await jsonBody(req));
   } else if(path==='/api/contributions/admin/imports'&&method==='POST'){
    requireAdmin();result=await commitImport(pool,user,await jsonBody(req));
   } else if(path==='/api/contributions/admin/imports'&&method==='GET'){
    requireAdmin();result=await listImports(pool,user,url.searchParams);
   } else if(path==='/api/contributions/batches'&&method==='GET'){
    requireUser();const archived=url.searchParams.get('archived')==='true';const rows=(await pool.query(`SELECT * FROM calypso_platform.batches WHERE owner_id=$1 AND deleted_at IS ${archived?'NOT ':''}NULL ORDER BY updated_at DESC`,[user.id])).rows;
    result={items:await Promise.all(rows.map(async r=>({draft:await draftDto(pool,r),state:statusDto(r)})))};
   } else if(/^\/api\/contributions\/batches\/[^/]+$/.test(path)&&method==='GET'){
    requireUser();const row=await ownedBatch(pool,path.split('/')[4],user);result={draft:await draftDto(pool,row),state:statusDto(row)};
   } else if(/^\/api\/contributions\/batches\/[^/]+$/.test(path)&&method==='PUT'){
    requireUser();const id=path.split('/')[4],body=await jsonBody(req);exact(body,['draft','expectedUpdatedAt']);if(!uuid.test(id))fail(400,'Invalid batch ID');
    if(body.draft?.id!==id)fail(400,'Batch ID mismatch');
    result=await saveContribution(pool,user,body.draft,body.expectedUpdatedAt);
   } else if(/^\/api\/contributions\/batches\/[^/]+\/submit$/.test(path)&&method==='POST'){
    requireUser();const id=path.split('/')[4];result=await transaction(pool,async db=>{
     let row=await ownedBatch(db,id,user,{lock:true});if(!['not-submitted','needs-information'].includes(row.review_status))fail(409,'Batch has already been submitted');
     const {report}=await validatePackage(await draftDto(db,row));
     if(!report.canSubmit)fail(400,'Complete all record context, file checks and permissions before submission');
     row=(await db.query("UPDATE calypso_platform.batches SET review_status='pending',submitted_at=now(),updated_at=now() WHERE id=$1 RETURNING *",[id])).rows[0];
     await event(db,id,user.id,'review.submitted',{status:'pending'});return statusDto(row);
    });
   } else if(/^\/api\/contributions\/batches\/[^/]+\/events$/.test(path)&&method==='GET'){
    requireUser();const row=await ownedBatch(pool,path.split('/')[4],user);const events=(await pool.query('SELECT sequence,type,detail,occurred_at FROM calypso_platform.batch_events WHERE batch_id=$1 ORDER BY sequence',[row.id])).rows;
    result={state:statusDto(row),events:events.map(e=>({sequence:String(e.sequence),type:e.type,detail:e.detail,occurredAt:e.occurred_at.toISOString()}))};
   } else if(/^\/api\/contributions\/batches\/[^/]+$/.test(path)&&method==='DELETE'){
    requireUser();const id=path.split('/')[4];result=await transaction(pool,async db=>{await ownedBatch(db,id,user,{lock:true});await db.query('UPDATE calypso_platform.batches SET deleted_at=now(),updated_at=now() WHERE id=$1',[id]);await event(db,id,user.id,'batch.archived',{});return {ok:true};});
   } else if(/^\/api\/contributions\/batches\/[^/]+\/restore$/.test(path)&&method==='POST'){
    requireUser();const id=path.split('/')[4];result=await transaction(pool,async db=>{await ownedBatch(db,id,user,{lock:true,archived:true});await db.query('UPDATE calypso_platform.batches SET deleted_at=NULL,updated_at=now() WHERE id=$1',[id]);await event(db,id,user.id,'batch.restored',{});return {ok:true};});
   } else if(path==='/api/contributions/admin/review'&&method==='GET'){
    requireAdmin();const rows=(await pool.query("SELECT * FROM calypso_platform.batches WHERE deleted_at IS NULL AND review_status<>'not-submitted' AND owner_id IN (SELECT id FROM calypso_platform.users WHERE NOT demo_account) ORDER BY submitted_at DESC")).rows;
    result={items:await Promise.all(rows.map(async r=>({state:statusDto(r),title:r.draft_json.title,contributor:r.draft_json.contributor,visibility:r.draft_json.visibility,phases:r.draft_json.phases??[],conditions:r.draft_json.conditions??[],records:r.draft_json.records,files:(await pool.query('SELECT client_id AS id,path,size,sha256 FROM calypso_platform.files WHERE batch_id=$1',[r.id])).rows})))};
   } else if(/^\/api\/contributions\/admin\/review\/[^/]+$/.test(path)&&method==='PATCH'){
    requireAdmin();const id=path.split('/')[5],body=await jsonBody(req);exact(body,['status','notes','expectedUpdatedAt']);if(!uuid.test(id)||!['needs-information','approved','rejected'].includes(body.status)||typeof body.notes!=='string'||body.notes.trim().length<3||body.notes.length>4000)fail(400,'Review requires a decision and reason');
    result=await transaction(pool,async db=>{
     let row=(await db.query('SELECT * FROM calypso_platform.batches WHERE id=$1 AND deleted_at IS NULL AND owner_id IN (SELECT id FROM calypso_platform.users WHERE NOT demo_account) FOR UPDATE',[id])).rows[0];if(!row||!['pending','needs-information'].includes(row.review_status))fail(409,'Batch is not awaiting review');if(row.updated_at.toISOString()!==body.expectedUpdatedAt)fail(409,'Batch changed; refresh the review queue');
     row=(await db.query('UPDATE calypso_platform.batches SET review_status=$1,review_notes=$2,reviewer_id=$3,updated_at=now() WHERE id=$4 RETURNING *',[body.status,body.notes.trim(),user.id,id])).rows[0];await event(db,id,user.id,'review.updated',{status:body.status,notes:body.notes.trim()});return statusDto(row);
    });
   } else if(/^\/api\/contributions\/batches\/[^/]+\/files\/[^/]+$/.test(path)&&method==='GET'){
    requireUser();const parts=path.split('/'),id=parts[4],fileId=decodeURIComponent(parts[6]);if(!uuid.test(id))fail(404,'File not found');
    const row=(await pool.query('SELECT * FROM calypso_platform.batches WHERE id=$1 AND deleted_at IS NULL',[id])).rows[0];
    if(!row||(row.owner_id!==user.id&&!(user.role==='admin'&&row.review_status!=='not-submitted')))fail(404,'File not found');
    const file=(await pool.query('SELECT * FROM calypso_platform.files WHERE batch_id=$1 AND client_id=$2',[id,fileId])).rows[0];if(!file)fail(404,'File not found');
    res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.path.split('/').at(-1))}`);res.end(file.bytes);return;
   } else fail(404,'Unknown route');
   res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(result));
  } catch(error) {
   res.statusCode=error.status??(error.name==='ZodError'?400:error.code==='23505'?409:500);
   res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify({error:res.statusCode===500?'Local database request failed':res.statusCode===409&&!error.status?'Account or record changed / already exists':error.name==='ZodError'?'Invalid input':error.message,...(Array.isArray(error.issues)?{issues:error.issues.map(i=>({path:i.path??[],message:i.message}))}:{})}));
   // Never log request bodies, passwords, session IDs or database connection details.
   if(res.statusCode===500)console.error('Platform request failed:',error.code??error.name);
  }
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const runtime=platformRuntimeConfig();
 const pool=await platformPool();await migrate(pool);const server=await createPlatformServer(pool,runtime);
 server.listen(8877,'127.0.0.1',()=>console.log('CALYPSO local PostgreSQL API · http://127.0.0.1:8877'));
 let stopping=false;const stop=()=>{if(stopping)return;stopping=true;server.close(async()=>{await pool.end();process.exit(0);});server.closeIdleConnections();};process.on('SIGINT',stop);process.on('SIGTERM',stop);
 server.on('error',async e=>{console.error('Local API could not listen:',e.code);await pool.end();process.exitCode=1;});
}

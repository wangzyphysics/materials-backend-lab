import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {platformPool,transaction,migrate} from '../src/platform/database.mjs';
import {createPlatformServer} from '../src/platform/server.mjs';
import {searchPlan,composition} from '../src/platform/materials.mjs';
import {newBatch,newPhase,newCondition,defaultRecord,makeDraftFile} from '../src/domain/materials/batch-contribution.ts';
import {emptyProfile} from '../src/domain/accounts/model.ts';

test('search parser rejects unsupported criteria and preserves composition semantics',()=>{
 assert.deepEqual(composition('Ca(OH)2'),{Ca:1,O:2,H:2});assert.deepEqual(composition('Fe₂O₃'),{Fe:2,O:3});
 assert.equal(searchPlan(new URLSearchParams('type=any&query=Fe-O')).interpretation,'elements');
 for(const query of ['pressureMin=NaN','spaceGroup=231','type=bad','type=system&query=fe-O','type=elements&query=Fe-O&excludeElements=O','foo=bar','query=H&query=O','sort=created_at;DROP','provenance=bad','dataType=unknown','origin=unknown','pressureAvailability=unknown'])assert.throws(()=>searchPlan(new URLSearchParams(query)));
});

test('native PostgreSQL platform: identity, ownership, review, privacy, recovery and search',async t=>{
 const pool=await platformPool(),ids=[],createdBatches=[];await migrate(pool);
 let server=await createPlatformServer(pool);await new Promise(r=>server.listen(0,'127.0.0.1',r));let base='http://127.0.0.1:'+server.address().port;
 const origin='http://127.0.0.1:5173';
 const client=()=>({cookie:'',csrf:'',async request(path,method='GET',body,extra={}){
  const response=await fetch(base+path,{method,headers:{Origin:origin,...(this.cookie?{Cookie:this.cookie}:{}),...(method!=='GET'?{'X-CSRF-Token':this.csrf}:{}),...(body?{'Content-Type':'application/json'}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})});
  const cookie=response.headers.get('set-cookie');if(cookie)this.cookie=cookie.split(';')[0];
  const data=response.headers.get('content-type')?.includes('json')?await response.json():new Uint8Array(await response.arrayBuffer());
  if(response.ok&&data.csrfToken)this.csrf=data.csrfToken;return {status:response.status,data};
 }});
 const a=client(),b=client(),anonymous=client(),password='Synthetic QA password 42',suffix=randomUUID().slice(0,8);
 let ua,ub,privateBatch,publicBatch;
 const signup=(username)=>({username,email:username+'@calypso.test',password,profile:{...emptyProfile('Synthetic QA researcher'),institution:'QA institute',researchGroup:'QA group',careerStage:'doctoral'}});
 const makeBatch=async visibility=>{
  const batch=newBatch(),file=await makeDraftFile('qa-raman.csv',new TextEncoder().encode('100,1\n200,2\n300,1\n'),'text/csv'),record=defaultRecord(file.id,1,'experimental','raman');
  Object.assign(record,{sampleId:'QA sample',formula:'H2',pressureGPa:'0',temperatureK:'300',method:'Synthetic API test only',source:'Synthetic QA fixture, not scientific evidence'});
  Object.assign(batch,{title:'Disposable PostgreSQL API QA '+suffix,files:[file],records:[record],visibility,permissionConfirmed:true,contributor:{...batch.contributor,name:'Synthetic QA researcher',email:'qa@calypso.test'}});return batch;
 };
 const stop=()=>new Promise(r=>{server.close(r);server.closeIdleConnections();});
 try {
  await t.test('anonymous overview is real, previews are bounded and search is protected',async()=>{
   assert.equal((await anonymous.request('/api/materials/materials')).status,401);
   const stats=(await anonymous.request('/api/materials/statistics')).data;assert.equal(stats.materials.count,20);assert.equal(stats.phases.count,10);assert.equal(stats.structureRecords.count,20);
   assert.equal((await anonymous.request('/api/materials/previews')).data.items.length,6);assert.equal((await anonymous.request('/api/materials/previews?query=H')).status,400);
   assert.deepEqual((await anonymous.request('/api/identity/providers')).data.filter(p=>p.enabled).map(p=>p.id),['password']);
  });
  await a.request('/api/identity/session');await b.request('/api/identity/session');
  await t.test('CSRF, foreign origins, required affiliations and caller privilege fields are rejected',async()=>{
   assert.equal((await a.request('/api/identity/registrations/password','POST',signup('qa.a.'+suffix),{'X-CSRF-Token':'wrong'})).status,403);
   assert.equal((await a.request('/api/identity/registrations/password','POST',signup('qa.a.'+suffix),{Origin:'https://foreign.invalid'})).status,403);
   assert.equal((await a.request('/api/identity/registrations/password','POST',{...signup('qa.a.'+suffix),role:'admin'})).status,400);
   const bad=signup('qa.a.'+suffix);bad.profile.institution='';assert.equal((await a.request('/api/identity/registrations/password','POST',bad)).status,400);
  });
  await t.test('database registration persists hashed credentials and private member profiles',async()=>{
   const first=await a.request('/api/identity/registrations/password','POST',signup('qa.a.'+suffix));assert.equal(first.status,200);ua=first.data.user;ids.push(ua.id);
   const second=await b.request('/api/identity/registrations/password','POST',signup('qa.b.'+suffix));assert.equal(second.status,200);ub=second.data.user;ids.push(ub.id);
   await pool.query('UPDATE calypso_platform.users SET test_account=true WHERE id=ANY($1::uuid[])',[ids]);
   assert.equal(ua.role,'member');assert.equal(ua.emailVerified,false);assert.equal(ua.profile.publicProfile,false);
   assert.equal(ua.profile.contactEmail,ua.email);assert.equal(ua.profile.countryRegion,'China');
   const stored=(await pool.query('SELECT password_hash FROM calypso_platform.password_credentials WHERE user_id=$1',[ua.id])).rows[0].password_hash;
   assert.equal(stored.iterations,600000);assert.ok(!JSON.stringify(stored).includes(password));
   assert.equal((await a.request('/api/identity/admin/users')).status,403);
  });
  await t.test('profile updates are persistent, versioned and cannot grant roles',async()=>{
   const next={...ua.profile,researchGroup:'Updated QA group'};const updated=await a.request('/api/identity/me/profile','PATCH',{profile:next,expectedVersion:ua.version});assert.equal(updated.status,200);ua=updated.data;
   assert.equal((await a.request('/api/identity/me/profile','PATCH',{profile:next,expectedVersion:'1'})).status,409);
   assert.equal((await a.request('/api/identity/me/profile','PATCH',{profile:{...next,role:'admin'},expectedVersion:ua.version})).status,400);
   assert.equal((await a.request('/api/identity/session')).data.user.profile.researchGroup,'Updated QA group');
   for(const key of ['contactEmail','institution','researchGroup','careerStage','countryRegion'])assert.equal((await a.request('/api/identity/me/profile','PATCH',{profile:{...next,[key]:''},expectedVersion:ua.version})).status,400);
  });
  await t.test('password sign-in rotates sessions, rejects incorrect passwords and duplicate registration',async()=>{
   const oldCookie=a.cookie;await a.request('/api/identity/logout','POST',{});await a.request('/api/identity/session');
   assert.equal((await a.request('/api/identity/password/sign-in','POST',{identity:ua.username,password:'wrong password'})).status,401);
   assert.equal((await a.request('/api/identity/password/sign-in','POST',{identity:ua.email.toUpperCase(),password})).status,200);assert.notEqual(a.cookie,oldCookie);
   await anonymous.request('/api/identity/session');assert.equal((await anonymous.request('/api/identity/registrations/password','POST',signup(ua.username))).status,409);
  });
  await t.test('teaching examples and marked teaching imports are rejected before any database writes',async()=>{
   const before=(await pool.query('SELECT count(*)::int AS n FROM calypso_platform.batches WHERE owner_id=$1',[ua.id])).rows[0].n;
   const example=await makeBatch('private');example.exampleOnly=true;
   const response=await a.request('/api/contributions/batches/'+example.id,'PUT',{draft:example,expectedUpdatedAt:example.updatedAt});assert.equal(response.status,400);assert.match(response.data.error,/Teaching examples/);
   const imported=await makeBatch('private');imported.records[0].source='TUTORIAL ONLY: a teaching import';imported.exampleOnly=false;
   assert.equal((await a.request('/api/contributions/batches/'+imported.id,'PUT',{draft:imported,expectedUpdatedAt:imported.updatedAt})).status,400);
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM calypso_platform.batches WHERE owner_id=$1',[ua.id])).rows[0].n,before);
  });
  await t.test('file hashes and ownership are enforced; drafts remain private and saves detect conflicts',async()=>{
   const batch=await makeBatch('private');createdBatches.push(batch.id);
   const corrupt=structuredClone(batch);corrupt.files[0].sha256='0'.repeat(64);
   assert.equal((await a.request('/api/contributions/batches/'+batch.id,'PUT',{draft:corrupt,expectedUpdatedAt:batch.updatedAt})).status,400);
   const saved=await a.request('/api/contributions/batches/'+batch.id,'PUT',{draft:batch,expectedUpdatedAt:batch.updatedAt});assert.equal(saved.status,200);privateBatch=saved.data.draft;
   assert.equal(saved.data.state.ownerId,ua.id);assert.equal((await b.request('/api/contributions/batches/'+batch.id)).status,404);
   assert.equal((await b.request('/api/contributions/batches/'+batch.id,'PUT',{draft:privateBatch,expectedUpdatedAt:privateBatch.updatedAt})).status,404);
   const changed=await a.request('/api/contributions/batches/'+batch.id,'PUT',{draft:{...privateBatch,title:'Updated QA draft'},expectedUpdatedAt:privateBatch.updatedAt});assert.equal(changed.status,200);
   assert.equal((await a.request('/api/contributions/batches/'+batch.id,'PUT',{draft:privateBatch,expectedUpdatedAt:privateBatch.updatedAt})).status,409);privateBatch=changed.data.draft;
   const download=await a.request('/api/contributions/batches/'+batch.id+'/files/'+batch.files[0].id);assert.equal(download.status,200);assert.equal(new TextDecoder().decode(download.data),'100,1\n200,2\n300,1\n');
   assert.equal((await b.request('/api/contributions/batches/'+batch.id+'/files/'+batch.files[0].id)).status,404);
  });
  await t.test('metadata-only saves and shared-original removals persist across reloads without publishing incomplete drafts',async()=>{
   const draft=newBatch(),phase={...newPhase(),formula:'FeO'},c1=newCondition(phase.id),c2=newCondition(phase.id);createdBatches.push(draft.id);
   Object.assign(draft,{title:'Disposable metadata and removal QA '+suffix,phases:[phase],conditions:[c1,c2]});
   const first=await a.request('/api/contributions/batches/'+draft.id,'PUT',{draft,expectedUpdatedAt:draft.updatedAt});assert.equal(first.status,200);
   const opened=await a.request('/api/contributions/batches/'+draft.id);assert.equal(opened.status,200);assert.equal(opened.data.draft.conditions.length,2);assert.equal(opened.data.draft.phases[0].id,phase.id);assert.equal(opened.data.draft.records.length,0);
   assert.equal((await a.request('/api/contributions/batches/'+draft.id+'/submit','POST',{})).status,400);
   const file=await makeDraftFile('shared.csv',new TextEncoder().encode('10,1\n20,2\n'));
   const records=[c1,c2].map((c,i)=>({...defaultRecord(file.id,i+1,'experimental','raman'),phaseId:phase.id,conditionId:c.id}));
   const input={...opened.data.draft,files:[file],records};
   let saved=await a.request('/api/contributions/batches/'+draft.id,'PUT',{draft:input,expectedUpdatedAt:input.updatedAt});assert.equal(saved.status,200);assert.equal(saved.data.draft.files.length,1);assert.equal(saved.data.draft.records.length,2);
   let next={...saved.data.draft,records:[saved.data.draft.records[1]],conditions:[c2]};
   saved=await a.request('/api/contributions/batches/'+draft.id,'PUT',{draft:next,expectedUpdatedAt:next.updatedAt});assert.equal(saved.status,200);assert.equal(saved.data.draft.files[0].sha256,file.sha256);assert.equal(saved.data.draft.records[0].conditionId,c2.id);
   next={...saved.data.draft,phases:[],conditions:[],files:[],records:[]};
   saved=await a.request('/api/contributions/batches/'+draft.id,'PUT',{draft:next,expectedUpdatedAt:next.updatedAt});assert.equal(saved.status,200);
   const reloaded=(await a.request('/api/contributions/batches/'+draft.id)).data.draft;assert.equal(reloaded.records.length,0);assert.equal(reloaded.files.length,0);assert.equal(reloaded.phases.length,0);
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM calypso_platform.files WHERE batch_id=$1',[draft.id])).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM calypso_platform.records WHERE batch_id=$1',[draft.id])).rows[0].n,0);
  });
  await pool.query("UPDATE calypso_platform.users SET role='admin' WHERE id=$1",[ub.id]);
  await t.test('submission stores real pending state; admin cannot read unsubmitted private drafts',async()=>{
   assert.equal((await b.request('/api/contributions/batches/'+privateBatch.id+'/files/'+privateBatch.files[0].id)).status,404);
   const submitted=await a.request('/api/contributions/batches/'+privateBatch.id+'/submit','POST',{});assert.equal(submitted.status,200);assert.equal(submitted.data.review,'pending');assert.equal(submitted.data.records[0].percent,null);
   assert.equal((await a.request('/api/contributions/batches/'+privateBatch.id,'PUT',{draft:privateBatch,expectedUpdatedAt:privateBatch.updatedAt})).status,409);
   assert.equal((await b.request('/api/contributions/batches/'+privateBatch.id+'/files/'+privateBatch.files[0].id)).status,200);
   assert.equal((await b.request('/api/contributions/batches/'+privateBatch.id)).status,404);
  });
  await t.test('approval respects private visibility; only approved public contributions are searchable',async()=>{
   let queue=(await b.request('/api/contributions/admin/review')).data.items,entry=queue.find(i=>i.state.id===privateBatch.id);
   assert.equal(entry.files.length,1);assert.equal((await b.request('/api/contributions/admin/review/'+privateBatch.id,'PATCH',{status:'approved',notes:'Synthetic QA decision only',expectedUpdatedAt:entry.state.updatedAt})).status,200);
   assert.equal((await a.request('/api/materials/materials?limit=100')).data.total,20);
   const batch=await makeBatch('public-after-review');createdBatches.push(batch.id);publicBatch=(await a.request('/api/contributions/batches/'+batch.id,'PUT',{draft:batch,expectedUpdatedAt:batch.updatedAt})).data.draft;
   await a.request('/api/contributions/batches/'+batch.id+'/submit','POST',{});
   assert.equal((await a.request('/api/materials/materials?limit=100')).data.total,20);
   queue=(await b.request('/api/contributions/admin/review')).data.items;entry=queue.find(i=>i.state.id===batch.id);
   const approved=await b.request('/api/contributions/admin/review/'+batch.id,'PATCH',{status:'approved',notes:'Synthetic QA decision only',expectedUpdatedAt:entry.state.updatedAt});assert.equal(approved.status,200);assert.equal(approved.data.records[0].publication,'public');assert.equal(approved.data.records[0].ingestion,'not-ingested');assert.equal(approved.data.records[0].percent,null);
   const records=(await a.request('/api/materials/materials?type=elements&query=H&limit=100')).data.items;assert.ok(records.some(r=>r.provenance==='contributed'&&r.dataType==='raman'));
   assert.equal((await anonymous.request('/api/materials/previews')).data.total,20);
  });
  await t.test('archive is recoverable and removes contributions from public search',async()=>{
   assert.equal((await a.request('/api/contributions/batches/'+publicBatch.id,'DELETE')).status,200);assert.equal((await a.request('/api/materials/materials?limit=100')).data.total,20);
   assert.ok((await a.request('/api/contributions/batches?archived=true')).data.items.some(i=>i.draft.id===publicBatch.id));
   assert.equal((await a.request('/api/contributions/batches/'+publicBatch.id+'/restore','POST',{})).status,200);assert.equal((await a.request('/api/materials/materials?limit=100')).data.total,21);
   await a.request('/api/contributions/batches/'+publicBatch.id,'DELETE');
  });
  await t.test('mixed structure and spectroscopy batches retain separate calculation eligibility',async()=>{
   const batch=await makeBatch('private');createdBatches.push(batch.id);
   const structure=await makeDraftFile('POSCAR',new TextEncoder().encode('Synthetic QA only\n1\n1 0 0\n0 1 0\n0 0 1\nH\n1\nDirect\n0 0 0\n'),'text/plain');
   const record=defaultRecord(structure.id,2,'theoretical','structure');
   Object.assign(record,{sampleId:'Disposable calculation QA',formula:'H',pressureGPa:'0',method:'Synthetic QA setup only',source:'Disposable synthetic fixture; not scientific evidence'});
   batch.files.push(structure);batch.records.push(record);batch.computationRequested=true;
   const saved=await a.request('/api/contributions/batches/'+batch.id,'PUT',{draft:batch,expectedUpdatedAt:batch.updatedAt});assert.equal(saved.status,200);assert.equal(saved.data.draft.files.length,2);assert.equal(saved.data.state.records[1].computation,'awaiting-submission');
   const pending=await a.request('/api/contributions/batches/'+batch.id+'/submit','POST',{});assert.equal(pending.status,200);assert.equal(pending.data.records[0].computation,'not-applicable');assert.equal(pending.data.records[1].computation,'awaiting-review');
   const queue=(await b.request('/api/contributions/admin/review')).data.items,entry=queue.find(i=>i.state.id===batch.id);
   const approved=await b.request('/api/contributions/admin/review/'+batch.id,'PATCH',{status:'approved',notes:'Disposable mixed-batch QA only',expectedUpdatedAt:entry.state.updatedAt});assert.equal(approved.status,200);assert.equal(approved.data.records[0].computation,'not-applicable');assert.equal(approved.data.records[1].computation,'pending-eligibility');assert.ok(approved.data.records.every(r=>r.percent===null&&r.currentStep===null&&r.publication==='private'));
  });
  await t.test('contribution hierarchy persists mixed acquisitions, preserves phase IDs and rejects cross-batch identity reuse',async()=>{
   const batch=await makeBatch('private'),p={...newPhase(),formula:'H'},c={...newCondition(p.id),pressureMode:'reported',pressureGPa:'0',temperatureMode:'reported',temperatureK:'300'};
   batch.phases=[p];batch.conditions=[c];batch.records=batch.records.map(r=>({...r,phaseId:p.id,conditionId:c.id}));
   batch.records.push({...batch.records[0],id:'theory-repeat',origin:'theoretical',acquisitionLabel:'Simulated curve'});
   let response=await a.request('/api/contributions/batches/'+batch.id,'PUT',{draft:batch,expectedUpdatedAt:batch.updatedAt});assert.equal(response.status,200);
   const saved=response.data.draft;assert.equal(saved.schemaVersion,3);assert.equal(saved.files.length,1);assert.equal(saved.records[0].phaseId,saved.records[1].phaseId);
   assert.equal(saved.records[1].origin,'theoretical');assert.match(saved.records[0].phaseLabel,/Unidentified phase/);
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM calypso_platform.contribution_phases WHERE batch_id=$1',[batch.id])).rows[0].n,1);
   const reread=(await a.request('/api/contributions/batches/'+batch.id)).data.draft;assert.deepEqual(reread.phases,saved.phases);assert.deepEqual(reread.conditions,saved.conditions);
   const renamed={...saved,phases:[{...saved.phases[0],name:'Contributor phase A'}]};
   response=await a.request('/api/contributions/batches/'+batch.id,'PUT',{draft:renamed,expectedUpdatedAt:saved.updatedAt});assert.equal(response.status,200);
   assert.equal(response.data.draft.phases[0].id,p.id);assert.equal(response.data.draft.phases[0].identification,'unassigned');
   const collision={...saved,id:crypto.randomUUID()};assert.equal((await b.request('/api/contributions/batches/'+collision.id,'PUT',{draft:collision,expectedUpdatedAt:collision.updatedAt})).status,409);
   const invalid={...response.data.draft,records:[{...saved.records[0],conditionId:'missing'}]};assert.equal((await a.request('/api/contributions/batches/'+batch.id,'PUT',{draft:invalid,expectedUpdatedAt:response.data.draft.updatedAt})).status,400);
   const submitted=await a.request('/api/contributions/batches/'+batch.id+'/submit','POST',{});assert.equal(submitted.status,200);
   const queue=(await b.request('/api/contributions/admin/review')).data.items.find(item=>item.state.id===batch.id);assert.equal(queue.phases[0].id,p.id);assert.equal(queue.conditions[0].id,c.id);assert.equal(queue.records.length,2);
  });
  await t.test('public contribution grouping preserves declared identity without inventing reported pressure',async()=>{
   const batch=await makeBatch('public-after-review'),p={...newPhase(),formula:'H2',name:'Synthetic target-pressure phase '+suffix};
   const c={...newCondition(p.id),pressureMode:'target',pressureGPa:'25',temperatureMode:'not-modelled'};
   batch.phases=[p];batch.conditions=[c];batch.records=batch.records.map(r=>({...r,origin:'theoretical',phaseId:p.id,conditionId:c.id}));
   const saved=await a.request('/api/contributions/batches/'+batch.id,'PUT',{draft:batch,expectedUpdatedAt:batch.updatedAt});assert.equal(saved.status,200);
   assert.equal((await a.request('/api/contributions/batches/'+batch.id+'/submit','POST',{})).status,200);
   const entry=(await b.request('/api/contributions/admin/review')).data.items.find(item=>item.state.id===batch.id);
   assert.equal((await b.request('/api/contributions/admin/review/'+batch.id,'PATCH',{status:'approved',notes:'Synthetic target-pressure QA only',expectedUpdatedAt:entry.state.updatedAt})).status,200);
   const result=(await a.request('/api/materials/materials?type=phase&query='+encodeURIComponent(p.name))).data;
   assert.equal(result.items.length,1);assert.equal(result.items[0].phaseId,p.id);assert.equal(result.items[0].pressureGPa,null);
   const groups=(await a.request('/api/materials/materials?groupBy=phase&type=phase&query='+encodeURIComponent(p.name))).data.groups;
   assert.equal(groups.length,1);assert.equal(groups[0].reportedPressureCount,0);assert.equal(groups[0].minGPa,null);
   assert.equal((await pool.query('SELECT metadata FROM calypso_platform.contribution_phases WHERE id=$1',[p.id])).rows[0].metadata.identification,'unassigned');
   assert.equal((await a.request('/api/contributions/batches/'+batch.id,'DELETE')).status,200);
  });
  await t.test('real material search supports source IDs, composition, exact systems, phase, pressure, symmetry and pagination',async()=>{
   const id=(await a.request('/api/materials/materials?type=id&query=caly-259513')).data;assert.equal(id.total,1);assert.equal(id.items[0].spaceGroup,'Cm');
   const record=id.items[0];assert.equal((await a.request('/api/materials/materials?type=record&query='+record.recordId)).data.total,1);
   assert.equal((await a.request('/api/materials/materials?type=formula&query=NbH11Ta3')).data.total,1);
   assert.equal((await a.request('/api/materials/materials?type=system&query=Nb-Ta-H')).data.total,1);
   assert.equal((await a.request('/api/materials/materials?type=id&query=caly-259513&spaceGroup=8&crystalSystem=monoclinic')).data.total,1);
   assert.equal((await a.request('/api/materials/materials?type=id&query=caly-259513&excludeElements=Ta')).data.total,0);
   const phase=(await a.request('/api/materials/materials?type=phase&query=B2%2Fn-mB24&limit=100')).data.items;assert.deepEqual(phase.map(r=>r.pressureGPa).sort((a,b)=>a-b),[1,15,60]);
   const at15=(await a.request('/api/materials/materials?type=phase&query=B2%2Fn-mB24&pressureMin=15&pressureMax=15')).data.items;assert.equal(at15.length,1);assert.equal(at15[0].pressureGPa,15);
   const all=(await a.request('/api/materials/materials?limit=100')).data.items;assert.equal(all.filter(r=>r.pressureGPa===null).length,9);
   const finite=(await a.request('/api/materials/materials?pressureMin=0&limit=100')).data.items;assert.ok(finite.every(r=>r.pressureGPa!==null));
   const first=(await a.request('/api/materials/materials?limit=12')).data.items,second=(await a.request('/api/materials/materials?limit=12&offset=12')).data.items;
   assert.equal(first.length,12);assert.equal(second.length,8);assert.equal(new Set([...first,...second].map(r=>r.recordId)).size,20);
   assert.equal((await a.request('/api/materials/materials?pressureMin=oops')).status,400);
   const page1=(await a.request('/api/materials/materials?limit=10')).data,page2=(await a.request('/api/materials/materials?limit=10&offset=10')).data;
   assert.equal(page1.total,20);assert.equal(page1.items.length,10);assert.equal(page2.items.length,10);assert.equal(new Set([...page1.items,...page2.items].map(r=>r.recordId)).size,20);
  });
  await t.test('result filters and ordering apply to the whole database and preserve unreported pressure',async()=>{
   const known=(await a.request('/api/materials/materials?pressureAvailability=reported&limit=100&sort=pressure_asc')).data;
   assert.equal(known.total,11);assert.equal(known.order,'unspecified');assert.ok(known.items.every((r,i)=>r.pressureGPa!==null&&(i===0||known.items[i-1].pressureGPa<=r.pressureGPa)));
   const missing=(await a.request('/api/materials/materials?pressureAvailability=missing&limit=100')).data;assert.equal(missing.total,9);assert.ok(missing.items.every(r=>r.pressureGPa===null));
   const descending=(await a.request('/api/materials/materials?sort=pressure_desc&limit=100')).data.items;assert.equal(descending[0].pressureGPa,300);assert.ok(descending.slice(-9).every(r=>r.pressureGPa===null));
   assert.equal((await a.request('/api/materials/materials?provenance=imported&dataType=structure&limit=100')).data.total,20);
   assert.equal((await a.request('/api/materials/materials?provenance=contributed&limit=100')).data.total,0);
   assert.equal((await a.request('/api/materials/materials?sort=bad')).status,400);
   const symmetry=(await a.request('/api/materials/materials?sort=space_group_asc&limit=100')).data;assert.equal(symmetry.total,20);assert.equal(symmetry.items[0].spaceGroup,'P1');
  });
  await t.test('statistics are administrator-only, omit personal fields and exclude QA accounts and uploads',async()=>{
   assert.equal((await anonymous.request('/api/identity/admin/statistics')).status,401);
   assert.equal((await a.request('/api/identity/admin/statistics')).status,403);
   const response=await b.request('/api/identity/admin/statistics');assert.equal(response.status,200);
   const data=response.data;assert.equal(data.science.materials,20);assert.equal(data.science.structureRepresentations,40);assert.equal(data.science.calculations,48);assert.equal(data.science.pressureReported,11);assert.equal(data.science.pressureMissing,9);assert.equal(data.workflowConnected,false);assert.equal(data.registrations.length,30);
   assert.ok(!JSON.stringify(data).includes(ua.email));assert.ok(!JSON.stringify(data).includes('password'));assert.ok(!JSON.stringify(data).includes(ua.profile.institution));
   const actual=(await pool.query('SELECT count(*)::int AS count FROM calypso_platform.users WHERE NOT test_account')).rows[0].count;assert.equal(data.accounts.registered,actual);
   const publicStats=(await anonymous.request('/api/materials/statistics')).data;assert.equal(publicStats.community.registeredUsers.count,actual);assert.ok(publicStats.community.regions.every(r=>r.users>=3));
  });
  await t.test('phase aggregation spans the complete result set and keeps unassigned records separate',async()=>{
   const response=await a.request('/api/materials/materials?groupBy=phase&limit=100');assert.equal(response.status,200);
   const data=response.data;assert.equal(data.total,20);assert.equal(data.groupsTotal,18);assert.equal(data.groups.reduce((sum,g)=>sum+g.count,0),20);
   const hydrogen=data.groups.find(g=>g.phaseLabel==='B2/n-mB24');assert.equal(hydrogen.count,3);assert.equal(hydrogen.minGPa,1);assert.equal(hydrogen.maxGPa,60);assert.equal(data.groups.filter(g=>!g.phaseId).length,8);assert.ok(data.groups.filter(g=>!g.phaseId).every(g=>g.count===1));
   const children=(await a.request('/api/materials/materials?groupKey='+encodeURIComponent(hydrogen.key)+'&sort=pressure_asc&limit=100')).data;assert.deepEqual(children.items.map(r=>r.pressureGPa),[1,15,60]);
   const filtered=(await a.request('/api/materials/materials?groupBy=phase&type=phase&query=B2%2Fn-mB24&pressureMin=15&pressureMax=15')).data;assert.equal(filtered.groups[0].count,1);assert.equal(filtered.groups[0].minGPa,15);
   const first=(await a.request('/api/materials/materials?groupBy=phase&limit=10')).data.groups,second=(await a.request('/api/materials/materials?groupBy=phase&limit=10&offset=10')).data.groups;assert.equal(new Set([...first,...second].map(g=>g.key)).size,18);
   assert.equal((await a.request('/api/materials/materials?groupBy=spaceGroup')).status,400);assert.equal((await a.request('/api/materials/materials?groupKey=invalid')).status,400);
  });
  await t.test('showcase statistics are explicitly synthetic and never enter live search or login',async()=>{
   const demo=(await b.request('/api/identity/admin/statistics?view=demo')).data;assert.equal(demo.mode,'demo');assert.equal(demo.demoAvailable,true);assert.ok(demo.accounts.registered>=170);assert.equal(demo.contributions.batches,48);assert.equal(demo.science.materials,20);
   const live=(await b.request('/api/identity/admin/statistics')).data;assert.equal(live.mode,'live');assert.equal(live.contributions.batches,0);
   const overview=(await anonymous.request('/api/materials/statistics')).data;assert.equal(overview.community.mode,'live');assert.equal(overview.communityDemo.mode,'demo');assert.ok(overview.communityDemo.regions.length>=7);
   assert.equal((await a.request('/api/materials/materials?limit=100')).data.total,20);
   const stored=(await pool.query('SELECT count(*)::int AS n FROM calypso_platform.password_credentials p JOIN calypso_platform.users u ON u.id=p.user_id WHERE u.demo_account')).rows[0];assert.equal(stored.n,0);
   assert.equal((await anonymous.request('/api/identity/password/sign-in','POST',{identity:'demo.showcase.001',password:'Synthetic login must fail'})).status,401);
  });
  await t.test('batch history and session data survive an API restart',async()=>{
   await stop();server=await createPlatformServer(pool);await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
   assert.equal((await a.request('/api/identity/session')).data.user.id,ua.id);
   const history=(await a.request('/api/contributions/batches/'+privateBatch.id+'/events')).data;assert.equal(history.state.review,'approved');assert.ok(history.events.some(e=>e.type==='review.updated'));assert.ok(history.events.every(e=>e.occurredAt));
  });
  await t.test('role changes are audited, reject self changes and revoke target sessions',async()=>{
   const current=(await a.request('/api/identity/session')).data.user;
   assert.equal((await b.request('/api/identity/admin/users/'+ub.id+'/role','PATCH',{role:'member',reason:'Synthetic QA self-change',expectedVersion:ub.version})).status,403);
   const granted=await b.request('/api/identity/admin/users/'+ua.id+'/role','PATCH',{role:'admin',reason:'Synthetic QA role grant',expectedVersion:current.version});assert.equal(granted.status,200);
   assert.equal((await a.request('/api/materials/materials')).status,401);
   const listing=(await b.request('/api/identity/admin/users')).data;assert.ok(listing.audit.some(e=>e.targetId===ua.id));assert.ok(!JSON.stringify(listing).includes('password_hash'));
  });
  await t.test('administrator profile edits and password recovery are versioned, audited and enforce changing temporary passwords',async()=>{
   // a's session was revoked by the preceding role-change test. b remains the test administrator.
   await a.request('/api/identity/session');await a.request('/api/identity/password/sign-in','POST',{identity:ua.username,password});
   let current=(await a.request('/api/identity/session')).data.user;
   const edited={...current.profile,institution:'Updated QA institute',countryRegion:'China'};
   assert.equal((await a.request('/api/identity/admin/users/'+ua.id+'/password-reset','POST',{reason:'Disposable self reset',expectedVersion:current.version})).status,403);
   assert.equal((await b.request('/api/identity/admin/users/'+ua.id+'/profile','PATCH',{profile:{...edited,researchGroup:''},reason:'Disposable QA invalid edit',expectedVersion:current.version})).status,400);
   const update=await b.request('/api/identity/admin/users/'+ua.id+'/profile','PATCH',{profile:edited,reason:'Disposable QA affiliation correction',expectedVersion:current.version});assert.equal(update.status,200);current=update.data;
   assert.equal((await b.request('/api/identity/admin/users/'+ua.id+'/profile','PATCH',{profile:edited,reason:'Disposable stale version',expectedVersion:'1'})).status,409);
   const reset=await b.request('/api/identity/admin/users/'+ua.id+'/password-reset','POST',{reason:'Disposable QA password recovery',expectedVersion:current.version});assert.equal(reset.status,200);assert.equal(reset.data.user.passwordChangeRequired,true);const temporary=reset.data.temporaryPassword;assert.ok(temporary.length>=20);
   assert.equal((await a.request('/api/materials/materials')).status,401);
   await a.request('/api/identity/session');assert.equal((await a.request('/api/identity/password/sign-in','POST',{identity:ua.username,password})).status,401);
   assert.equal((await a.request('/api/identity/password/sign-in','POST',{identity:ua.username,password:temporary})).status,200);
   assert.equal((await a.request('/api/materials/materials')).status,403);assert.equal((await a.request('/api/contributions/batches')).status,403);assert.equal((await a.request('/api/identity/admin/users')).status,403);
   assert.equal((await a.request('/api/identity/password/change','POST',{currentPassword:'incorrect password',newPassword:'New disposable password 73'})).status,401);
   const changed=await a.request('/api/identity/password/change','POST',{currentPassword:temporary,newPassword:'New disposable password 73'});assert.equal(changed.status,200);assert.equal(changed.data.user.passwordChangeRequired,false);
   assert.equal((await a.request('/api/materials/materials?limit=10')).status,200);
   const listing=(await b.request('/api/identity/admin/users')).data;assert.ok(listing.accountAudit.some(e=>e.targetId===ua.id&&e.action==='password-reset'));assert.ok(listing.accountAudit.some(e=>e.targetId===ua.id&&e.action==='profile-updated'));assert.ok(!JSON.stringify(listing).includes(temporary));
   const row=(await pool.query('SELECT password_hash FROM calypso_platform.password_credentials WHERE user_id=$1',[ua.id])).rows[0];assert.ok(!JSON.stringify(row).includes(temporary));
  });
  await t.test('suspension, session revocation, recoverable deletion and restore enforce account access without erasing contributions',async()=>{
   let current=(await a.request('/api/identity/session')).data.user;
   assert.equal((await b.request('/api/identity/admin/users/'+ub.id+'/status','PATCH',{status:'suspended',reason:'Disposable self action',expectedVersion:ub.version})).status,403);
   const suspended=await b.request('/api/identity/admin/users/'+ua.id+'/status','PATCH',{status:'suspended',reason:'Disposable QA suspension',expectedVersion:current.version});assert.equal(suspended.status,200);current=suspended.data;assert.equal(current.status,'suspended');
   assert.equal((await a.request('/api/materials/materials')).status,401);await a.request('/api/identity/session');assert.equal((await a.request('/api/identity/password/sign-in','POST',{identity:ua.username,password:'New disposable password 73'})).status,401);
   assert.equal((await b.request('/api/identity/admin/users/'+ua.id+'/status','PATCH',{status:'active',reason:'Disposable stale update',expectedVersion:'1'})).status,409);
   current=(await b.request('/api/identity/admin/users/'+ua.id+'/status','PATCH',{status:'active',reason:'Disposable QA reactivation',expectedVersion:current.version})).data;
   await a.request('/api/identity/session');assert.equal((await a.request('/api/identity/password/sign-in','POST',{identity:ua.username,password:'New disposable password 73'})).status,200);
   current=(await b.request('/api/identity/admin/users/'+ua.id+'/sessions','PATCH',{reason:'Disposable QA session revoke',expectedVersion:current.version})).data;assert.equal((await a.request('/api/materials/materials')).status,401);
   const before=(await pool.query('SELECT count(*)::int AS n FROM calypso_platform.batches WHERE owner_id=$1',[ua.id])).rows[0].n;
   current=(await b.request('/api/identity/admin/users/'+ua.id+'/status','PATCH',{status:'deleted',reason:'Disposable QA recoverable deletion',expectedVersion:current.version})).data;assert.equal(current.status,'deleted');
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM calypso_platform.batches WHERE owner_id=$1',[ua.id])).rows[0].n,before);
   current=(await b.request('/api/identity/admin/users/'+ua.id+'/status','PATCH',{status:'active',reason:'Disposable QA restore',expectedVersion:current.version})).data;assert.equal(current.status,'active');
   await a.request('/api/identity/session');assert.equal((await a.request('/api/identity/password/sign-in','POST',{identity:ua.username,password:'New disposable password 73'})).status,200);
   const audit=(await b.request('/api/identity/admin/users')).data.accountAudit;for(const action of ['account-suspended','account-reactivated','account-deleted','account-restored','sessions-revoked'])assert.ok(audit.some(event=>event.targetId===ua.id&&event.action===action));
  });
 } finally {
  await stop();
  // Delete only identities and fixtures created by this test, never existing research data.
  if(ids.length)await transaction(pool,async db=>{
   for(const table of ['batch_events','records','files','contribution_conditions','contribution_phases'])await db.query(`DELETE FROM calypso_platform.${table} WHERE batch_id IN(SELECT id FROM calypso_platform.batches WHERE owner_id=ANY($1::uuid[]))`,[ids]);
   await db.query('DELETE FROM calypso_platform.batches WHERE owner_id=ANY($1::uuid[])',[ids]);
   await db.query('DELETE FROM calypso_platform.role_audit WHERE actor_id=ANY($1::uuid[]) OR target_id=ANY($1::uuid[])',[ids]);
   await db.query('DELETE FROM calypso_platform.account_audit WHERE actor_id=ANY($1::uuid[]) OR target_id=ANY($1::uuid[])',[ids]);
   await db.query('DELETE FROM calypso_platform.sessions WHERE user_id=ANY($1::uuid[])',[ids]);await db.query('DELETE FROM calypso_platform.password_credentials WHERE user_id=ANY($1::uuid[])',[ids]);await db.query('DELETE FROM calypso_platform.users WHERE id=ANY($1::uuid[])',[ids]);
  });
  await pool.end();
 }
});

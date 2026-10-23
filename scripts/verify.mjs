import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, digest, id, TABLES } from '../src/model.mjs';
import { openRepository } from '../src/repository.mjs';
import { MaterialService } from '../src/service.mjs';
import { mongoDocuments, fromMongoDocuments } from '../src/transfer.mjs';
import { createApiServer } from '../src/server.mjs';

const bundle=JSON.parse(await readFile(path.join(ROOT,'samples/ingest.json'),'utf8'));
const checks=[],evidence={};let main,temporary,peer,portable,roundtrip,server;
const schema=()=>`calypso_test_${randomBytes(8).toString('hex')}`;
const stagingSchema=schema(),roundtripSchema=schema();
async function check(name,action){await action();checks.push({name,status:'passed'});console.log('PASS '+name);}
async function dropOwned(repo,name){if(!repo)return;assert.match(name,/^calypso_test_[a-f0-9]{16}$/);await repo.exec(`DROP SCHEMA "${name}" CASCADE`);}
try {
  main=await openRepository();const service=new MaterialService(main);
  const runtime=(await main.sql('SELECT version() AS version,current_database() AS database,current_schema() AS schema'))[0];
  assert.match(runtime.version,/PostgreSQL/);evidence.runtime=runtime;
  await check('Copied source rows match their preserved checksums',async()=>{
    for(const item of bundle.materials)for(const ref of [item.source_ref,item.display_structure_ref,...item.tasks.map(t=>t.source_ref)]){
      const lines=(await readFile(path.join(ROOT,ref.sample_path),'utf8')).split(/(?<=\n)/);
      const raw=lines[ref.sample_line-1];assert.equal(createHash('sha256').update(raw).digest('hex'),ref.row_sha256);
    }
    assert.equal(bundle.materials.length,20);assert.equal(bundle.synthetic,false);
  });
  await check('Native PostgreSQL contains 20 Material identities and 48 real source tasks',async()=>{
    assert.equal((await main.list('materials')).length,20);assert.equal((await main.list('calculations')).length,48);
    evidence.counts={};for(const table of Object.keys(TABLES))evidence.counts[table]=(await main.list(table)).length;
  });
  await check('The original 30-site display cell and 15-site calculation cell coexist correctly',async()=>{
    const alias=await main.get('material_sources',{source_id:bundle.source.source_id,external_material_id:'caly-259513'});
    const material=await service.getMaterial(alias.material_id),relax=material.calculations.find(c=>c.type==='relax');
    assert.equal(material.displayStructure.nsites,30);assert.equal(relax.result.n_atoms_cell,15);
    const source=bundle.materials.find(m=>m.external_material_id==='caly-259513');
    assert.equal(relax.result.raw_energy_ev_cell,source.tasks.find(t=>t.type==='relax').result.energy);
    evidence.cellExample={materialId:alias.material_id,externalId:'caly-259513',displayNsites:30,calculationNsites:15,
      calculationId:relax.calculation_id,energyDefinition:relax.result.energy_definition};
  });
  await check('Both legacy final-structure formats are adapted',async()=>{
    const fields=bundle.materials.flatMap(m=>m.tasks.map(t=>t.output_structure_field)).filter(Boolean);
    assert(fields.includes('trajectory.final_step'));assert(fields.includes('outputs.structure'));
    assert.equal((await main.list('structures')).length,40);
    const bad=await main.sql("SELECT count(*)::int AS count FROM structures WHERE jsonb_array_length(geometry_json->'sites')<>nsites");assert.equal(bad[0].count,0);
  });
  await check('Unreported pressure stays null; no thermodynamic energy is invented',async()=>{
    assert.equal((await main.list('materials')).filter(m=>m.pressure_gpa===null).length,9);
    assert((await main.list('calculation_results')).every(r=>r.energy_definition==='unverified'));
    assert.equal((await main.list('analyses')).length,0);
  });
  await check('Existing source Phase exposes real pressure points 1, 15 and 60 GPa',async()=>{
    const phase=await main.get('phases',{source_label:'B2/n-mB24'});
    assert.deepEqual((await service.phaseMaterials(phase.phase_id)).map(m=>m.pressure_gpa),[1,15,60]);
    assert.equal((await service.resolvePressure(phase.phase_id,15)).status,'resolved');
    assert.equal((await service.resolvePressure(phase.phase_id,12)).status,'unavailable');
    evidence.pressurePhaseId=phase.phase_id;
  });
  await check('Reimport reuses the same receipt, Material IDs and Calculation IDs',async()=>{
    const before=await service.exportSnapshot(),receipt=await service.importBundle(bundle),after=await service.exportSnapshot();
    assert.equal(receipt.replayed,true);assert.equal(before.data_hash,after.data_hash);
  });
  temporary=await openRepository({schema:stagingSchema});peer=await openRepository({schema:stagingSchema});
  const stagedService=new MaterialService(temporary);
  let initial;
  await check('Concurrent first imports allocate each Material only once',async()=>{
    const receipts=await Promise.all([stagedService.importBundle(bundle,{includeStatic:false}),new MaterialService(peer).importBundle(bundle,{includeStatic:false})]);
    assert.deepEqual(receipts.map(r=>r.replayed).sort(),[false,true]);
    assert.deepEqual(receipts[0].mappings.map(m=>m.materialId),receipts[1].mappings.map(m=>m.materialId));
    assert.equal((await temporary.list('materials')).length,20);assert.equal((await temporary.list('calculations')).length,39);
    initial=receipts.find(r=>!r.replayed);evidence.concurrentImport={materials:20,calculations:39,replayedReceipts:1};
  });
  await check('Nine real static calculations can be added later without changing Material IDs',async()=>{
    const receipt=await stagedService.importBundle(bundle);
    assert.equal(receipt.createdMaterials,0);assert.equal(receipt.createdCalculations,9);
    assert.deepEqual(initial.mappings.map(m=>m.materialId),receipt.mappings.map(m=>m.materialId));
    assert.equal((await temporary.list('calculations')).length,48);
    evidence.lateStatic={createdMaterials:0,createdCalculations:9,idsUnchanged:true};
  });
  await check('A second source with the same known-pressure display geometry reuses Material',async()=>{
    const second=structuredClone(bundle);second.source.source_id='verification-second-source';second.materials=[second.materials[0]];second.materials[0].tasks=[];
    const receipt=await stagedService.importBundle(second);
    assert.equal(receipt.createdMaterials,0);assert.equal(receipt.mappings[0].materialId,initial.mappings[0].materialId);
    assert.equal((await temporary.list('materials')).length,20);
  });
  await check('Conflicting source task content is rejected atomically',async()=>{
    const conflict=structuredClone(bundle);conflict.materials[0].tasks[0].result.energy+=1;
    const before=await stagedService.exportSnapshot();await assert.rejects(()=>stagedService.importBundle(conflict),/conflicting material or content/);
    assert.equal((await stagedService.exportSnapshot()).data_hash,before.data_hash);
  });
  await check('Wrong-composition output does not leave a partial calculation',async()=>{
    const conflict=structuredClone(bundle);conflict.materials[0].tasks[0].external_task_id=id('verification');
    conflict.materials[0].tasks[0].output_structure.sites[0].species[0].element='He';
    const before=await stagedService.exportSnapshot();await assert.rejects(()=>stagedService.importBundle(conflict),/composition mismatch/);
    assert.equal((await stagedService.exportSnapshot()).data_hash,before.data_hash);
  });
  await check('PostgreSQL rejects another Material’s property selection',async()=>{
    const choices=await temporary.list('property_choices'),a=choices[0],b=choices.find(c=>c.material_id!==a.material_id);
    await assert.rejects(()=>temporary.transaction(tx=>tx.insert('property_choices',{...a,choice_id:id('invalid'),calculation_id:b.calculation_id})),/ownership\/type\/method mismatch/);
  });
  await check('PostgreSQL rejects a calculation-cell atom-count mismatch',async()=>{
    const result=(await temporary.list('calculation_results')).find(r=>r.raw_energy_ev_cell!==null);
    const calc=await temporary.get('calculations',{calculation_id:result.calculation_id});
    await assert.rejects(()=>temporary.transaction(async tx=>{
      const calculationId=id('validation');await tx.insert('calculations',{...calc,calculation_id:calculationId});
      await tx.insert('calculation_results',{...result,calculation_id:calculationId,n_atoms_cell:result.n_atoms_cell+1});
    }),/actual calculation cell/);
  });
  await check('Stored geometry and Material pressure cannot be overwritten',async()=>{
    const m=(await temporary.list('materials')).find(m=>m.pressure_gpa!==null);
    await assert.rejects(()=>temporary.transaction(tx=>tx.sql('UPDATE structures SET volume_a3=volume_a3+1 WHERE structure_id=$1',[m.display_structure_id])),/Immutable/);
    await assert.rejects(()=>temporary.transaction(tx=>tx.sql('UPDATE materials SET pressure_gpa=pressure_gpa+1 WHERE material_id=$1',[m.material_id])),/identity cannot/);
  });
  const snapshot=await service.exportSnapshot();portable=await openRepository({backend:'sqlite'});const portableService=new MaterialService(portable);
  await check('PostgreSQL → transfer package → SQLite preserves every logical row and ID',async()=>{
    await portableService.restoreSnapshot(snapshot);assert.equal((await portableService.exportSnapshot()).data_hash,snapshot.data_hash);
  });
  await check('PostgreSQL and SQLite return identical Material detail contracts',async()=>{
    for(const m of snapshot.tables.materials)assert.deepEqual(await portableService.getMaterial(m.material_id),await service.getMaterial(m.material_id));
  });
  await check('SQLite also enforces property ownership and geometry immutability',async()=>{
    const choices=await portable.list('property_choices'),a=choices[0],b=choices.find(c=>c.material_id!==a.material_id);
    await assert.rejects(()=>portable.transaction(tx=>tx.insert('property_choices',{...a,choice_id:id('invalid'),calculation_id:b.calculation_id})),/ownership\/type\/method mismatch/);
    await assert.rejects(()=>portable.transaction(tx=>tx.sql('UPDATE structures SET volume_a3=volume_a3+1 WHERE structure_id=$1',[snapshot.tables.structures[0].structure_id])),/Immutable/);
  });
  roundtrip=await openRepository({schema:roundtripSchema});
  await check('SQLite → transfer package → fresh PostgreSQL preserves the same dataset',async()=>{
    const returned=await portableService.exportSnapshot();await new MaterialService(roundtrip).restoreSnapshot(returned);
    assert.equal((await new MaterialService(roundtrip).exportSnapshot()).data_hash,snapshot.data_hash);
  });
  await check('MongoDB document conversion is lossless (no MongoDB server tested)',async()=>{
    assert.deepEqual(fromMongoDocuments(mongoDocuments(snapshot)),snapshot.tables);
    evidence.mongo='document_conversion_only';
  });
  await check('Recomputed package checksum cannot hide mismatched structure metadata',async()=>{
    const bad=structuredClone(snapshot);bad.tables.structures[0].nsites++;bad.data_hash=digest(bad.tables);
    await assert.rejects(()=>portableService.restoreSnapshot(bad),/structure metadata\/hash mismatch/);
  });
  await check('HTTP API reads native PostgreSQL records and serves the inspection page',async()=>{
    server=createApiServer(service);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const base='http://127.0.0.1:'+server.address().port;
    const health=await (await fetch(base+'/api/v1/health')).json();assert.equal(health.backend,'postgres');assert.equal(health.dataset.synthetic,false);
    const response=await (await fetch(base+'/api/v1/materials/'+evidence.cellExample.materialId)).json();assert.equal(response.material.displayStructure.nsites,30);
    assert.match(await (await fetch(base+'/')).text(),/真实结构/);
    assert.equal((await fetch(base+'/api/v1/materials/absent')).status,404);
    assert.equal((await fetch(base+'/api/v1/materials',{method:'POST'})).status,405);
  });
  const report={status:'passed',checked_at:new Date().toISOString(),checks,evidence,
    dataHash:snapshot.data_hash,limits:['20 selected source materials, not a production-scale benchmark.','Physical equivalence matching beyond exact display representation is not implemented.',
      'Source E definitions/method compatibility are unverified; no scientific enthalpy or hull result was generated.','MongoDB document conversion was tested without a MongoDB server.']};
  await mkdir(path.join(ROOT,'artifacts'),{recursive:true});
  await writeFile(path.join(ROOT,'artifacts/verification.json'),JSON.stringify(report,null,2)+'\n');
  await writeFile(path.join(ROOT,'artifacts/material-detail.json'),JSON.stringify(await service.getMaterial(evidence.cellExample.materialId),null,2)+'\n');
  console.log(JSON.stringify({passed:checks.length,status:'passed',runtime:runtime.version,materials:20,calculations:48},null,2));
} finally {
  if(server)await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});
  if(peer)await peer.close();
  try{await dropOwned(temporary,stagingSchema);}finally{if(temporary)await temporary.close();}
  try{await dropOwned(roundtrip,roundtripSchema);}finally{if(roundtrip)await roundtrip.close();}
  if(portable)await portable.close();if(main)await main.close();
}

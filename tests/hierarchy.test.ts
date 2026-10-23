import test from "node:test";
import assert from "node:assert/strict";
import { newBatch,newPhase,newCondition,defaultRecord,makeDraftFile,batchSchema,applyGroupedManifest,batchReadiness,inspectFile,phaseName,recordIssues,importBatchDraft,fileBytes } from "../src/domain/materials/batch-contribution.ts";
const curve = new TextEncoder().encode("x,y,repeat\n100,2,3\n200,5,6\n");
async function fixture() {
  const file=await makeDraftFile("spectrum.csv",curve), phase={...newPhase(),formula:"FeO"}, condition={...newCondition(phase.id),pressureMode:"reported" as const,pressureGPa:"50",temperatureMode:"reported" as const,temperatureK:"300"};
  const record={...defaultRecord(file.id,1,"experimental","raman"),phaseId:phase.id,conditionId:condition.id,source:"Synthetic QA fixture",method:"Synthetic measurement"};
  return batchSchema.parse({...newBatch(),phases:[phase],conditions:[condition],files:[file],records:[record],contributor:{...newBatch().contributor,name:"QA",email:"qa@example.test"},permissionConfirmed:true});
}
test("phase identity is stable, naming does not identify it, and evidence is independent of review",async()=>{
  const b=await fixture(), p=b.phases[0], original=phaseName(p);
  assert.match(original,/Unidentified phase/); assert.equal(p.identification,"unassigned");
  const renamed=batchSchema.parse({...b,phases:[{...p,name:"Phase A"}]});
  assert.equal(renamed.phases[0].id,p.id); assert.equal(renamed.records[0].phaseLabel,"Phase A");
  assert.equal(renamed.phases[0].identification,"unassigned");
  const identified={...renamed,phases:[{...renamed.phases[0],identification:"identified" as const}]};
  assert.ok(batchReadiness(identified,{[b.files[0].id]:inspectFile(b.files[0])}).batchIssues.some(i=>i.includes("evidence")));
});
test("explicit CSV keys group mixed origins and repeated curves without duplicating original files",async()=>{
  const b=await fixture();
  const manifest="record_id,file,origin,data_type,phase_key,condition_key,formula,pressure_gpa,temperature_k,method,source,y_column\na,spectrum.csv,experimental,raman,p1,c1,FeO,50,300,QA,QA,y\nb,spectrum.csv,theoretical,xrd,p1,c1,FeO,50,300,QA,QA,repeat\nc,spectrum.csv,experimental,raman,p1,c2,FeO,50,300,QA,QA,y\n";
  const grouped=applyGroupedManifest(manifest,b.files,b);
  assert.equal(grouped.phases.length,1); assert.equal(grouped.conditions.length,2);
  assert.equal(grouped.records[0].conditionId,grouped.records[1].conditionId);
  assert.notEqual(grouped.records[1].conditionId,grouped.records[2].conditionId);
  assert.equal(grouped.records[1].origin,"theoretical");assert.equal(grouped.records[1].yColumn,2);
  assert.equal(grouped.files.length,1);
  assert.throws(()=>applyGroupedManifest(manifest.replace("p1,c1,FeO,50,300,QA,QA,repeat","p1,c1,Fe2O3,50,300,QA,QA,repeat"),b.files,b),/Conflicting formula/);
  assert.throws(()=>applyGroupedManifest(manifest.replace("p1,c1,FeO,50,300,QA,QA,repeat","p1,c1,FeO,60,300,QA,QA,repeat"),b.files,b),/Conflicting pressure/);
});
test("missing manifest keys and old flat drafts never infer a phase or simultaneous acquisition",async()=>{
  const b=await fixture(),r={...b.records[0],phaseId:undefined,conditionId:undefined};
  const legacy={...b,schemaVersion:2,phases:undefined,conditions:undefined,records:[r,{...r,id:"record-2"}]};
  const migrated=batchSchema.parse(legacy), again=batchSchema.parse(legacy);
  assert.equal(migrated.schemaVersion,3);assert.equal(migrated.phases.length,2);assert.equal(migrated.conditions.length,2);
  assert.notEqual(migrated.records[0].phaseId,migrated.records[1].phaseId);
  assert.deepEqual(migrated.phases,again.phases);assert.equal(migrated.files[0].sha256,b.files[0].sha256);
  const flat=applyGroupedManifest("record_id,file,origin,data_type,formula\na,spectrum.csv,experimental,raman,FeO\nb,spectrum.csv,experimental,raman,FeO\n",b.files,b);
  assert.equal(flat.phases.length,2);
});
test("explicit unknown conditions support structure-free experiment without invented P or T",async()=>{
  const b=await fixture(), c={...b.conditions[0],pressureMode:"unreported" as const,pressureGPa:"",temperatureMode:"unreported" as const,temperatureK:""};
  const draft=batchSchema.parse({...b,conditions:[c]});
  assert.equal(draft.records[0].pressureGPa,"");assert.equal(draft.records[0].temperatureK,"");
  assert.equal(batchReadiness(draft,{[b.files[0].id]:inspectFile(b.files[0])}).ready,1);
  const staticTheory=batchSchema.parse({...draft,conditions:[{...c,temperatureMode:"not-modelled"}],records:[{...draft.records[0],origin:"theoretical"}]});
  assert.equal(batchReadiness(staticTheory,{[b.files[0].id]:inspectFile(b.files[0])}).ready,1);
  const experiment={...staticTheory,records:[{...staticTheory.records[0],origin:"experimental" as const}]};
  assert.ok(batchReadiness(experiment,{[b.files[0].id]:inspectFile(b.files[0])}).issues[b.records[0].id].some(i=>i.includes("Experimental temperature")));
});
test("parent context is authoritative while actual record overrides remain explicit",async()=>{
  const b=await fixture();
  const projected=batchSchema.parse({...b,records:[{...b.records[0],formula:"H",pressureGPa:"999"}]});
  assert.equal(projected.records[0].formula,"FeO");assert.equal(projected.records[0].pressureGPa,"50");
  const overridden=batchSchema.parse({...b,records:[{...b.records[0],overrideConditions:true,pressureGPa:"49.8"}]});
  assert.equal(overridden.records[0].pressureGPa,"49.8");assert.equal(overridden.conditions[0].pressureGPa,"50");
  assert.throws(()=>batchSchema.parse({...b,conditions:[{...b.conditions[0],pressureMode:"unreported"}]}),/Unreported pressure/);
  assert.throws(()=>batchSchema.parse({...b,records:[{...b.records[0],conditionId:"missing"}]}),/association/);
});
test("structure links identify an exact record in the same phase and condition",async()=>{
  const b=await fixture(),r=b.records[0],structure={...r,id:"structure-1",dataType:"structure" as const};
  const linked={...r,structureRecordId:structure.id};
  const file=b.files[0],inspection=inspectFile(file);
  assert.deepEqual(recordIssues(linked,file,inspection,[linked,structure]),[]);
  assert.ok(recordIssues(linked,file,inspection,[linked,{...structure,conditionId:"other"}]).some(i=>i.includes("exact structure")));
});
test("import-as-copy remaps graph identities and preserves associations and original bytes",async()=>{
  const b=await fixture(),copy=await importBatchDraft(JSON.parse(JSON.stringify(b)));
  assert.notEqual(copy.id,b.id);assert.notEqual(copy.phases[0].id,b.phases[0].id);assert.notEqual(copy.conditions[0].id,b.conditions[0].id);
  assert.equal(copy.records[0].phaseId,copy.phases[0].id);assert.equal(copy.records[0].conditionId,copy.conditions[0].id);
  assert.equal(copy.conditions[0].phaseId,copy.phases[0].id);assert.deepEqual(fileBytes(copy.files[0]),curve);
});

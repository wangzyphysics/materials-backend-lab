import { id, digest, geometry, TABLES, MODEL_VERSION } from './model.mjs';

const finite=x=>typeof x==='number'&&Number.isFinite(x);
const aliasId=(sourceId,externalId)=>digest([sourceId,externalId]);
const identityKey=(display,pressure,sourceId,externalId)=>digest({display:display.hash,pressure,
  unknown_conditions:pressure===null?[sourceId,externalId]:null,policy:'exact_display_representation_v1'});
export class MaterialService {
  constructor(repository){this.repo=repository;}
  async importBundle(bundle,{includeStatic=true}={}) {
    if(bundle.format!=='calypso-ingest'||bundle.schema_version!==MODEL_VERSION||bundle.synthetic!==false||!Array.isArray(bundle.materials)) throw new Error('Unsupported real-data import bundle');
    const sourceId=bundle.source?.source_id;
    if(!sourceId)throw new Error('Stable source namespace required');
    const packageHash=digest({bundle,includeStatic,adapter_policy:'source-cell-v1'});
    return this.repo.transaction(async tx=>{
      await tx.lockSource(sourceId);
      const prior=await tx.get('import_receipts',{package_hash:packageHash});
      if(prior)return {...prior.receipt_json,replayed:true};
      // Acquire exact identity locks in a stable order, including across source namespaces.
      const prepared=bundle.materials.map(item=>({item,display:geometry(item.display_structure),pressure:item.source_metadata.pressure??null}));
      await tx.lockIdentities(prepared.map(({item,display,pressure})=>identityKey(display,pressure,sourceId,item.external_material_id)));
      const receipt={importId:id('imp'),packageHash,sourceId,createdMaterials:0,reusedMaterials:0,createdCalculations:0,reusedCalculations:0,mappings:[],replayed:false};
      if(!await tx.get('sources',{source_id:sourceId}))await tx.insert('sources',{source_id:sourceId,provenance_json:{synthetic:false,format:'legacy-jsonl',namespace:sourceId}});
      for(const {item,display,pressure} of prepared) {
        const meta=item.source_metadata;
        if(meta.material_id!==item.external_material_id)throw new Error('Source material identity mismatch');
        if(pressure!==null&&!finite(pressure))throw new Error('Finite reported pressure required');
        const identity=identityKey(display,pressure,sourceId,item.external_material_id);
        let phase=null;
        if(meta.phase_id) {
          phase=await tx.get('phases',{source_id:sourceId,source_label:meta.phase_id,composition_key:display.compositionKey});
          if(!phase){phase={phase_id:id('phase'),source_id:sourceId,source_label:meta.phase_id,composition_key:display.compositionKey,
            composition_json:display.reduced,assignment_basis:'source_provided'};await tx.insert('phases',phase);}
        }
        const sourceAlias=await tx.get('material_sources',{source_id:sourceId,external_material_id:item.external_material_id});
        let material=sourceAlias?await tx.get('materials',{material_id:sourceAlias.material_id}):await tx.get('materials',{identity_key:identity});
        const created=!material,now=new Date().toISOString();
        if(material&&(material.identity_key!==identity||material.phase_id!==(phase?.phase_id??null)))throw new Error('Existing source mapping has conflicting structure, pressure, or phase; explicit review required');
        if(!material) {
          material={material_id:id('mat'),phase_id:phase?.phase_id??null,pressure_gpa:pressure,pressure_status:pressure===null?'unreported':'reported',
            formula:display.formula,composition_key:display.compositionKey,composition_json:display.reduced,elements_json:display.elements,
            chemsys:display.elements.join('-'),identity_key:identity,identity_policy:'exact_display_representation_v1',
            display_structure_id:id('str'),revision:1,created_at:now,updated_at:now};
          await tx.insert('materials',material);
          await tx.insert('structures',this.structureRow(material.material_id,material.display_structure_id,'display_unit_cell',display,item.display_structure_ref));
          receipt.createdMaterials++;
        } else receipt.reusedMaterials++;
        if(!sourceAlias)await tx.insert('material_sources',{alias_id:aliasId(sourceId,item.external_material_id),source_id:sourceId,
          external_material_id:item.external_material_id,material_id:material.material_id,metadata_json:meta,provenance_json:item.source_ref});
        const taskMappings=[];let added=false;
        for(const task of item.tasks) {
          if(task.type==='static'&&!includeStatic)continue;
          const result=await this.addTask(tx,sourceId,material,task);
          receipt[result.created?'createdCalculations':'reusedCalculations']++;added ||= result.created;
          taskMappings.push({externalTaskId:task.external_task_id,calculationId:result.calculationId,type:task.type,action:result.created?'created':'reused'});
        }
        if((added||!sourceAlias)&&!created)await tx.updateMaterial(material.material_id,{revision:material.revision+1,updated_at:now});
        receipt.mappings.push({externalMaterialId:item.external_material_id,materialId:material.material_id,action:created?'created':'reused',tasks:taskMappings});
      }
      await tx.insert('import_receipts',{import_id:receipt.importId,package_hash:packageHash,receipt_json:receipt,
        provenance_json:bundle.source.manifest,created_at:new Date().toISOString()});
      return receipt;
    });
  }
  structureRow(materialId,structureId,role,info,provenance) {
    return {structure_id:structureId,material_id:materialId,role,geometry_json:info.normalized,structure_hash:info.hash,
      nsites:info.nsites,volume_a3:info.volume,composition_key:info.compositionKey,composition_json:info.composition,provenance_json:provenance};
  }
  async addTask(tx,sourceId,material,task) {
    const content=digest(task),alias=await tx.get('calculation_sources',{source_id:sourceId,external_task_id:task.external_task_id});
    if(alias){const existing=await tx.get('calculations',{calculation_id:alias.calculation_id});
      if(existing.material_id!==material.material_id||existing.content_hash!==content)throw new Error('External task ID has conflicting material or content');
      return {calculationId:existing.calculation_id,created:false};}
    if(!await tx.get('calculation_types',{type:task.type}))throw new Error('Unregistered calculation type');
    let output=null;
    if(task.output_structure) {
      const g=geometry(task.output_structure);
      if(g.compositionKey!==material.composition_key)throw new Error('Calculation/output composition mismatch');
      const role=task.type==='relax'?'relax_output':'static_output';
      output=await tx.get('structures',{material_id:material.material_id,role,structure_hash:g.hash});
      if(!output){output=this.structureRow(material.material_id,id('str'),role,g,{...task.source_ref,field:task.output_structure_field,association_basis:'source_material_id'});await tx.insert('structures',output);}
    }
    const settings={type:task.type,codeversion:task.codeversion,parameters:task.inputs.parameters??null,
      pseudo_potential:task.inputs.pseudo_potential??null,kpoints:task.inputs.kpoints??null,
      input_pstress_kbar:task.inputs.pstress??null,compatibility_state:'unverified'};
    const settingsHash=digest(settings);let method=await tx.get('methods',{settings_hash:settingsHash});
    if(!method){method={method_id:id('method'),settings_hash:settingsHash,settings_json:settings,compatibility_state:'unverified'};await tx.insert('methods',method);}
    const calculationId=id('calc'),now=new Date().toISOString();
    await tx.insert('calculations',{calculation_id:calculationId,material_id:material.material_id,type:task.type,method_id:method.method_id,
      output_structure_id:output?.structure_id??null,run_state:['successful','failed','running'].includes(task.source_state)?task.source_state:'unverified',
      validation_state:'source_provided',inputs_json:task.inputs,provenance_json:{...task.source_ref,source_status:task.source_status,source_state:task.source_state,
        trajectory_ref:task.trajectory_ref,association_basis:'source_material_id'},content_hash:content,created_at:now});
    const result=task.result,rawEnergy=finite(result.energy)&&output?result.energy:null;
    const flags=[];
    if(finite(result.energy))flags.push('energy_definition_unverified');
    if(['relax','static'].includes(task.type)&&!output)flags.push('calculation_cell_unavailable');
    if(rawEnergy!==null&&(!finite(result.volume)||Math.abs(result.volume-output.volume_a3)>Math.max(1e-6,output.volume_a3*1e-5)))throw new Error('Source output volume does not match actual calculation cell');
    await tx.insert('calculation_results',{calculation_id:calculationId,material_id:material.material_id,energy_structure_id:rawEnergy===null?null:output.structure_id,
      raw_energy_ev_cell:rawEnergy,energy_definition:'unverified',n_atoms_cell:rawEnergy===null?null:output.nsites,
      volume_a3_cell:rawEnergy===null?null:result.volume,result_json:result,quality_flags_json:flags});
    await tx.insert('calculation_sources',{alias_id:aliasId(sourceId,task.external_task_id),source_id:sourceId,
      external_task_id:task.external_task_id,calculation_id:calculationId,provenance_json:task.source_ref});
    // Select source results by task type; this does not promote raw E to thermodynamic energy.
    const choiceId=digest([material.material_id,task.type,method.method_id]);
    if(await tx.get('property_choices',{choice_id:choiceId}))await tx.updateChoice(choiceId,calculationId,now);
    else await tx.insert('property_choices',{choice_id:choiceId,material_id:material.material_id,
      property_key:task.type,scope_key:method.method_id,calculation_id:calculationId,updated_at:now});
    return {calculationId,created:true};
  }
  async getMaterial(materialId) {
    const m=await this.repo.get('materials',{material_id:materialId});if(!m)return null;
    const display=await this.repo.get('structures',{structure_id:m.display_structure_id});
    const sources=await this.repo.list('material_sources',{material_id:materialId}),calculations=[];
    for(const c of await this.repo.list('calculations',{material_id:materialId})) {
      const r=await this.repo.get('calculation_results',{calculation_id:c.calculation_id});
      calculations.push({...c,result:r,thermodynamics_eligible:false});
    }
    const symmetry=calculations.find(c=>c.type==='symmetry')?.result.result_json;
    return {materialId:m.material_id,phaseId:m.phase_id,formula:m.formula,pressureGPa:m.pressure_gpa,pressureStatus:m.pressure_status,
      revision:m.revision,createdAt:m.created_at,updatedAt:m.updated_at,identityPolicy:m.identity_policy,
      displayStructure:display,structures:await this.repo.list('structures',{material_id:materialId}),sources,calculations,
      availableProperties:[...new Set(['structure',...calculations.map(c=>c.type)])].sort(),
      selectedCalculations:await this.repo.list('property_choices',{material_id:materialId}),
      spaceGroup:symmetry?.symbol??null,crystalSystem:symmetry?.crystal_system??null};
  }
  async listMaterials({query='',limit=100}={}) {
    const rows=await this.repo.list('materials'),items=[];
    // The lab contains 20 records. Production filtering/pagination belongs in adapter queries.
    for(const m of rows) {
      const aliases=await this.repo.list('material_sources',{material_id:m.material_id});
      if(query&&![m.material_id,m.formula,m.chemsys,...aliases.map(a=>a.external_material_id)].some(value=>value.toLowerCase().includes(query.toLowerCase())))continue;
      items.push({recordId:m.material_id,materialId:m.material_id,phaseId:m.phase_id,formula:m.formula,pressureGPa:m.pressure_gpa,
        pressureStatus:m.pressure_status,createdAt:m.created_at,externalIds:aliases.map(a=>a.external_material_id)});
    }
    return {items:items.slice(0,limit),total:items.length,order:'unspecified'};
  }
  async phaseMaterials(phaseId) {
    if(!await this.repo.get('phases',{phase_id:phaseId}))return null;
    return (await this.repo.list('materials',{phase_id:phaseId})).sort((a,b)=>(a.pressure_gpa??Infinity)-(b.pressure_gpa??Infinity)||a.material_id.localeCompare(b.material_id));
  }
  async resolvePressure(phaseId,pressureGpa) {
    const records=await this.phaseMaterials(phaseId);if(!records)return null;
    const matches=records.filter(m=>m.pressure_gpa===pressureGpa);
    if(!matches.length)return {status:'unavailable',availablePressuresGPa:[...new Set(records.filter(m=>m.pressure_gpa!==null).map(m=>m.pressure_gpa))]};
    return {status:matches.length===1?'resolved':'requires_material_selection',candidates:matches.map(m=>({materialId:m.material_id,pressureGPa:m.pressure_gpa}))};
  }
  async exportSnapshot() {
    return this.repo.transaction(async tx=>{
      const tables={};for(const table of Object.keys(TABLES))tables[table]=await tx.list(table);
      return {format:'calypso-transfer',schema_version:MODEL_VERSION,synthetic:false,identity_policy:'exact_display_representation_v1',tables,
        data_hash:digest(tables),file_manifest:'samples/manifest.json'};
    });
  }
  async restoreSnapshot(snapshot) {
    if(snapshot.format!=='calypso-transfer'||snapshot.schema_version!==MODEL_VERSION||snapshot.data_hash!==digest(snapshot.tables)
      ||Object.keys(snapshot.tables).sort().join('|')!==Object.keys(TABLES).sort().join('|'))throw new Error('Invalid transfer package/version/checksum');
    for(const row of snapshot.tables.structures){const g=geometry(row.geometry_json);
      if(g.hash!==row.structure_hash||g.nsites!==row.nsites||g.compositionKey!==row.composition_key
        ||Math.abs(g.volume-row.volume_a3)>Math.max(1e-7,g.volume*1e-10))throw new Error('Transfer structure metadata/hash mismatch');}
    return this.repo.transaction(async tx=>{
      await tx.deferConstraints();
      for(const table of Object.keys(TABLES))for(const row of snapshot.tables[table]) {
        const existing=await tx.get(table,{[TABLES[table].pk]:row[TABLES[table].pk]});
        if(existing){if(digest(existing)!==digest(row))throw new Error('Transfer would overwrite a different existing record');}
        else await tx.insert(table,row);
      }
      await tx.assertIntegrity();
      return {materials:snapshot.tables.materials.length,calculations:snapshot.tables.calculations.length};
    });
  }
}

import { TABLES, digest } from './model.mjs';
export function mongoDocuments(snapshot) {
  return {format:'calypso-mongo-documents',schema_version:snapshot.schema_version,source_data_hash:snapshot.data_hash,
    collections:Object.fromEntries(Object.entries(snapshot.tables).map(([table,rows])=>[table,rows.map(row=>({_id:row[TABLES[table].pk],...row}))])),
    indexes:{materials:[{key:{identity_key:1},unique:true},{key:{phase_id:1,pressure_gpa:1,material_id:1}}],
      material_sources:[{key:{source_id:1,external_material_id:1},unique:true}],
      calculation_sources:[{key:{source_id:1,external_task_id:1},unique:true}],
      calculations:[{key:{material_id:1,type:1}}],
      structures:[{key:{material_id:1,role:1,structure_hash:1},unique:true}],
      phases:[{key:{source_id:1,source_label:1,composition_key:1},unique:true}],
      property_choices:[{key:{material_id:1,property_key:1,scope_key:1},unique:true}],
      methods:[{key:{settings_hash:1},unique:true}],import_receipts:[{key:{package_hash:1},unique:true}]},
    limitations:['Document conversion only; no MongoDB service was run.',
      'Cross-document ownership, immutable publication, and transactions require a MongoDB adapter with equivalent validation.',
      'Raw trajectories remain in files; do not embed an unbounded history or large scientific arrays into one Material document.']};
}
export function fromMongoDocuments(documents) {
  const tables=Object.fromEntries(Object.entries(documents.collections).map(([table,rows])=>[table,rows.map(doc=>{
    if(doc._id!==doc[TABLES[table].pk])throw new Error('Mongo document identity mismatch');
    const {_id,...row}=doc;return row;
  })]));
  if(digest(tables)!==documents.source_data_hash)throw new Error('Mongo document conversion changed logical data');
  return tables;
}

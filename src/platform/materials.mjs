import {normalizeSearch,normalizeFilters,filtersFromParams,isSearchMode,parseElements} from '../domain/materials/search.ts';

/** Formula matching uses elemental ratios, not string order or a claimed phase. */
export function composition(formula) {
 normalizeSearch(formula,'formula');
 const tokens=formula.replace(/[₀-₉]/g,c=>String('₀₁₂₃₄₅₆₇₈₉'.indexOf(c))).match(/[A-Z][a-z]?|\d+(?:\.\d+)?|[()]/g);let i=0;
 function group(){const result={};while(i<tokens.length&&tokens[i]!==')') {let part;if(tokens[i]==='('){i++;part=group();i++;}else part={[tokens[i++]]:1};const amount=/^\d/.test(tokens[i]??'')?Number(tokens[i++]):1;for(const [el,n] of Object.entries(part))result[el]=(result[el]??0)+n*amount;}return result;}
 return group();
}
export function searchPlan(params) {
 const allowed=new Set(['type','query','limit','offset','excludeElements','pressureMin','pressureMax','elementsMin','elementsMax','crystalSystem','spaceGroup','provenance','origin','dataType','pressureAvailability','sort','groupBy','groupKey']);
 for(const key of params.keys())if(!allowed.has(key)||params.getAll(key).length!==1)throw new Error('Unsupported or repeated query parameter');
 const mode=params.get('type')??'any';if(!isSearchMode(mode))throw new Error('Unknown search mode');
 const limit=Number(params.get('limit')??6),offset=Number(params.get('offset')??0);
 if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>1000000)throw new Error('Invalid pagination');
 const groupBy=params.get('groupBy'),groupKey=params.get('groupKey');if(groupBy&&groupBy!=='phase')throw new Error('Unsupported grouping');if(groupKey&&!/^(?:phase|record):[A-Za-z0-9_-]{1,200}$/.test(groupKey))throw new Error('Invalid group key');if(groupBy&&groupKey)throw new Error('Use grouping or group expansion, not both');
 const filters=normalizeFilters(filtersFromParams(params)),raw=params.get('query')?.trim()??'';
 const query=raw?normalizeSearch(raw,mode):'';let interpretation=mode,counts=null,elements=null;
 if(query){if(mode==='any'){try {elements=parseElements(query);interpretation='elements';}catch {try {counts=composition(query);interpretation='formula';}catch{interpretation='text';}}}
 else if(mode==='formula')counts=composition(query);else if(mode==='elements'||mode==='system')elements=parseElements(query);}
 if(elements&&filters.excludeElements&&parseElements(filters.excludeElements).some(e=>elements.includes(e)))throw new Error('Included and excluded elements overlap');
 if(counts&&filters.excludeElements&&parseElements(filters.excludeElements).some(e=>e in counts))throw new Error('Formula and excluded elements overlap');
 return {mode,query,interpretation,counts,elements,filters,limit,offset,groupBy,groupKey};
}
export function querySql(plan) {
 const values=[],conditions=[];const bind=v=>{values.push(v);return '$'+values.length;};
 if(plan.query){
  if(plan.elements){conditions.push(`elements_json @> ${bind(JSON.stringify(plan.elements))}::jsonb`);if(plan.interpretation==='system')conditions.push(`jsonb_array_length(elements_json)=${bind(plan.elements.length)}`);}
  else if(plan.counts){const keys=Object.keys(plan.counts).sort(),first=keys[0];conditions.push(`elements_json @> ${bind(JSON.stringify(keys))}::jsonb`,`jsonb_array_length(elements_json)=${bind(keys.length)}`);
   for(const el of keys)conditions.push(`abs((composition_json->>${bind(el)})::numeric * ${bind(plan.counts[first])}::numeric - (composition_json->>${bind(first)})::numeric * ${bind(plan.counts[el])}::numeric)<0.00000001`);
  } else if(plan.interpretation==='id')conditions.push(`(material_id=${bind(plan.query)} OR ${bind(plan.query)}=ANY(external_ids))`);
  else if(plan.interpretation==='record')conditions.push(`record_id=${bind(plan.query)}`);
  else if(plan.interpretation==='phase')conditions.push(`(phase_id=${bind(plan.query)} OR phase_label=${bind(plan.query)})`);
  else {const pattern='%'+plan.query.replace(/[\\%_]/g,'\\$&')+'%';conditions.push(`(material_id ILIKE ${bind(pattern)} OR formula ILIKE ${bind(pattern)} OR EXISTS(SELECT 1 FROM unnest(external_ids) alias WHERE alias ILIKE ${bind(pattern)}))`);}
 }
 if(plan.groupKey)conditions.push(`CASE WHEN phase_id IS NULL THEN 'record:'||record_id ELSE 'phase:'||phase_id END=${bind(plan.groupKey)}`);
 const f=plan.filters;
 if(f.provenance)conditions.push(`provenance=${bind(f.provenance)}`);
 if(f.origin)conditions.push(f.origin==='unreported'?`origin IS NULL`:`origin=${bind(f.origin)}`);
 if(f.dataType)conditions.push(`data_type=${bind(f.dataType)}`);
 if(f.pressureAvailability)conditions.push(`pressure_gpa IS ${f.pressureAvailability==='reported'?'NOT ':''}NULL`);
 if(f.excludeElements)conditions.push(`NOT elements_json ?| ${bind(parseElements(f.excludeElements))}::text[]`);
 for(const [key,operator] of [['pressureMin','>='],['pressureMax','<=']])if(f[key]!=null)conditions.push(`pressure_gpa ${operator} ${bind(f[key])}`);
 for(const [key,operator] of [['elementsMin','>='],['elementsMax','<=']])if(f[key]!=null)conditions.push(`jsonb_array_length(elements_json) ${operator} ${bind(f[key])}`);
 if(f.crystalSystem)conditions.push(`lower(crystal_system)=${bind(f.crystalSystem)}`);
 if(f.spaceGroup)conditions.push(/^\d+$/.test(f.spaceGroup)?`space_group_number=${bind(String(Number(f.spaceGroup)))}`:`regexp_replace(space_group,'[\\s_]','','g')=${bind(f.spaceGroup.replace(/[\s_]/g,''))}`);
 return {where:conditions.length?' WHERE '+conditions.join(' AND '):'',values};
}
const sourceSql=`SELECT m.material_id,m.display_structure_id AS record_id,m.phase_id,p.source_label AS phase_label,m.formula,m.composition_json,m.elements_json,m.pressure_gpa,m.created_at,
 sym.result_json->>'symbol' AS space_group,sym.result_json->>'number' AS space_group_number,sym.result_json->>'crystal_system' AS crystal_system,
 ARRAY(SELECT external_material_id FROM calypso_lab.material_sources a WHERE a.material_id=m.material_id ORDER BY external_material_id) AS external_ids,
 'imported'::text AS provenance,'structure'::text AS data_type,NULL::text AS origin
 FROM calypso_lab.materials m LEFT JOIN calypso_lab.phases p USING(phase_id)
 LEFT JOIN LATERAL (SELECT r.result_json FROM calypso_lab.property_choices pc JOIN calypso_lab.calculations c USING(calculation_id) JOIN calypso_lab.calculation_results r USING(calculation_id)
 WHERE pc.material_id=m.material_id AND pc.property_key='symmetry' ORDER BY pc.updated_at DESC,pc.calculation_id LIMIT 1) sym ON true`;
const contributedSql=`SELECT 'submission_'||r.id::text AS material_id,'contribution_'||r.id::text AS record_id,NULLIF(r.input_json->>'phaseId','') AS phase_id,NULLIF(r.input_json->>'phaseLabel','') AS phase_label,
 r.input_json->>'formula' AS formula,r.input_json->'_composition' AS composition_json,r.input_json->'_elements' AS elements_json,CASE WHEN coalesce(r.input_json->>'pressureMode','reported')='reported' THEN NULLIF(r.input_json->>'pressureGPa','')::numeric END AS pressure_gpa,b.submitted_at AS created_at,
 NULL::text AS space_group,NULL::text AS space_group_number,NULL::text AS crystal_system,ARRAY[]::text[] AS external_ids,'contributed'::text AS provenance,r.input_json->>'dataType' AS data_type,r.input_json->>'origin' AS origin
 FROM calypso_platform.records r JOIN calypso_platform.batches b ON b.id=r.batch_id JOIN calypso_platform.users owner ON owner.id=b.owner_id WHERE NOT owner.demo_account AND owner.status<>'deleted' AND b.review_status='approved' AND b.deleted_at IS NULL AND b.draft_json->>'visibility'='public-after-review'`;
export async function listMaterials(db,params,{importedOnly=false}={}) {
 const plan=searchPlan(params),q=querySql(plan);
 const source=importedOnly?sourceSql:sourceSql+' UNION ALL '+contributedSql;
 if(plan.groupBy==='phase')return phaseGroups(db,plan,q,source);
 const total=Number((await db.query(`WITH records AS (${source}) SELECT count(*) FROM records${q.where}`,q.values)).rows[0].count);
 const order={created_desc:'created_at DESC,material_id',formula_asc:'formula ASC,material_id',pressure_asc:'pressure_gpa ASC NULLS LAST,material_id',pressure_desc:'pressure_gpa DESC NULLS LAST,material_id',space_group_asc:"CASE WHEN space_group_number ~ '^[0-9]+$' THEN space_group_number::int END ASC NULLS LAST,formula,material_id"}[plan.filters.sort??'created_desc'];
 const rows=(await db.query(`WITH records AS (${source}) SELECT * FROM records${q.where} ORDER BY ${order} LIMIT $${q.values.length+1} OFFSET $${q.values.length+2}`,[...q.values,plan.limit,plan.offset])).rows;
 return {items:rows.map(r=>({recordId:r.record_id,materialId:r.material_id,formula:r.formula,phaseId:r.phase_id,phaseLabel:r.phase_label,spaceGroup:r.space_group,crystalSystem:r.crystal_system,pressureGPa:r.pressure_gpa===null?null:Number(r.pressure_gpa),createdAt:r.created_at.toISOString(),externalIds:r.external_ids,provenance:r.provenance,dataType:r.data_type,origin:r.origin})),total,order:!plan.filters.sort||plan.filters.sort==='created_desc'?'created_desc':'unspecified',offset:plan.offset,limit:plan.limit,interpretation:plan.interpretation};
}
async function phaseGroups(db,plan,q,source) {
 const matched=`WITH matched AS (SELECT * FROM (${source}) records${q.where}), grouped AS (
 SELECT CASE WHEN phase_id IS NULL THEN 'record:'||record_id ELSE 'phase:'||phase_id END AS group_key,phase_id,
 min(CASE WHEN space_group_number ~ '^[0-9]+$' THEN space_group_number::int END) AS min_group_number,min(formula) AS formula,min(phase_label) AS phase_label,count(*)::int AS count,count(pressure_gpa)::int AS reported,
 min(pressure_gpa) AS pressure_min,max(pressure_gpa) AS pressure_max,max(created_at) AS latest,
 array_agg(DISTINCT space_group) FILTER(WHERE space_group IS NOT NULL) AS space_groups,
 array_agg(DISTINCT crystal_system) FILTER(WHERE crystal_system IS NOT NULL) AS crystal_systems
 FROM matched GROUP BY group_key,phase_id)`;
 const totals=(await db.query(`${matched} SELECT (SELECT count(*)::int FROM matched) AS total,count(*)::int AS groups_total FROM grouped`,q.values)).rows[0];
 const sort={created_desc:'latest DESC,group_key',formula_asc:'formula,phase_label,group_key',pressure_asc:'pressure_min ASC NULLS LAST,group_key',pressure_desc:'pressure_max DESC NULLS LAST,group_key',space_group_asc:'min_group_number ASC NULLS LAST,formula,group_key'}[plan.filters.sort??'created_desc'];
 const rows=(await db.query(`${matched} SELECT * FROM grouped ORDER BY ${sort} LIMIT $${q.values.length+1} OFFSET $${q.values.length+2}`,[...q.values,plan.limit,plan.offset])).rows;
 return {groups:rows.map(r=>({key:r.group_key,formula:r.formula,phaseId:r.phase_id,phaseLabel:r.phase_label,count:r.count,reportedPressureCount:r.reported,minGPa:r.pressure_min===null?null:Number(r.pressure_min),maxGPa:r.pressure_max===null?null:Number(r.pressure_max),spaceGroups:r.space_groups??[],crystalSystems:r.crystal_systems??[]})),total:totals.total,groupsTotal:totals.groups_total,offset:plan.offset,limit:plan.limit,grouping:'phase',definition:'Source phase IDs and explicit contributor Phase IDs; contributor assignment is not independent confirmation. Records without a phase identity remain separate. No stability is inferred.'};
}
export async function statistics(db) {
 const row=(await db.query('SELECT count(*)::int AS n,min(pressure_gpa) AS lo,max(pressure_gpa) AS hi FROM calypso_lab.materials')).rows[0];
 const phases=Number((await db.query('SELECT count(*) FROM calypso_lab.phases')).rows[0].count);
 return {materials:{count:row.n,definition:'Imported material identities in this local dataset.'},phases:{count:phases,definition:'Source-provided phase labels, scoped by composition; stability is not inferred.'},structureRecords:{count:row.n,definition:'One display structure per material. Calculation-cell representations are counted separately.'},pressureCoverage:{minGPa:row.lo===null?null:Number(row.lo),maxGPa:row.hi===null?null:Number(row.hi),definition:'Reported material pressures only. Unreported pressure is excluded.'}};
}

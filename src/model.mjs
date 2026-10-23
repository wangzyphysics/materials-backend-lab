import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const MODEL_VERSION = 1;
export const id = kind => `${kind}_${randomUUID()}`;
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]));
  if (typeof value==='number' && !Number.isFinite(value)) throw new Error('Non-finite number');
  return value;
}
export const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const finite = x => typeof x==='number' && Number.isFinite(x);
const rounded = x => { if (!finite(x)) throw new Error('Finite coordinate required'); return Number(x.toFixed(12)); };
const gcd = (a,b) => b ? gcd(b,a%b) : a;
export function geometry(input) {
  if (!Array.isArray(input?.lattice) || input.lattice.length!==3 || !input.lattice.every(row=>Array.isArray(row)&&row.length===3)) throw new Error('3×3 lattice required');
  const lattice=input.lattice.map(row=>row.map(rounded));
  const [a,b,c]=lattice;
  const volume=Math.abs(a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]));
  if (volume<=1e-9) throw new Error('Degenerate cell');
  if (!Array.isArray(input.sites) || !input.sites.length) throw new Error('Sites required');
  const composition={};
  const sites=input.sites.map(site=>{
    if (!Array.isArray(site.frac_coords)||site.frac_coords.length!==3 || !Array.isArray(site.species)||!site.species.length) throw new Error('Site species/coordinates required');
    const species=site.species.map(s=>{
      if (!/^[A-Z][a-z]?$/.test(s.element)||!finite(s.occupancy)||s.occupancy<=0||s.occupancy>1) throw new Error('Invalid species/occupancy');
      composition[s.element]=(composition[s.element]??0)+s.occupancy;
      return {element:s.element,occupancy:s.occupancy};
    }).sort((x,y)=>x.element.localeCompare(y.element));
    if (species.reduce((n,s)=>n+s.occupancy,0)>1+1e-8) throw new Error('Site occupancy exceeds one');
    return {species,frac_coords:site.frac_coords.map(x=>rounded(((rounded(x)%1)+1)%1)%1)};
  }).sort((x,y)=>JSON.stringify(stable(x)).localeCompare(JSON.stringify(stable(y))));
  const elements=Object.keys(composition).sort();
  const integerCounts=elements.map(e=>Math.round(composition[e]*1e6));
  const divisor=integerCounts.reduce(gcd);
  const reduced=Object.fromEntries(elements.map((e,i)=>[e,integerCounts[i]/divisor]));
  const normalized={lattice,sites};
  return {normalized,hash:digest(normalized),volume,nsites:sites.length,composition,reduced,elements,
    compositionKey:elements.map(e=>`${e}:${reduced[e]}`).join('|'),
    formula:elements.map(e=>`${e}${reduced[e]===1?'':reduced[e]}`).join('')};
}

// The logical transfer model is identical for every storage adapter.
export const TABLES = {
  calculation_types:{pk:'type',json:[]},
  sources:{pk:'source_id',json:['provenance_json']},
  phases:{pk:'phase_id',json:['composition_json']},
  materials:{pk:'material_id',json:['composition_json','elements_json'],numbers:['pressure_gpa']},
  structures:{pk:'structure_id',json:['geometry_json','composition_json','provenance_json']},
  material_sources:{pk:'alias_id',json:['metadata_json','provenance_json']},
  methods:{pk:'method_id',json:['settings_json']},
  calculations:{pk:'calculation_id',json:['inputs_json','provenance_json']},
  calculation_results:{pk:'calculation_id',json:['result_json','quality_flags_json']},
  calculation_sources:{pk:'alias_id',json:['provenance_json']},
  property_choices:{pk:'choice_id',json:[]},
  import_receipts:{pk:'import_id',json:['receipt_json','provenance_json']},
  analyses:{pk:'analysis_id',json:['conditions_json','result_json']},
  analysis_inputs:{pk:'input_id',json:['snapshot_json']},
};
export const TYPES=['relax','static','symmetry','synthesizability','dos','band','phonon'];

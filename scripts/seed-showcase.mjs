import {createHash} from 'node:crypto';
import {platformPool,migrate,transaction} from '../src/platform/database.mjs';
import {emptyProfile} from '../src/domain/accounts/model.ts';

// Explicit local showcase metadata, never scientific evidence or login credentials.
const id=key=>{const h=createHash('sha256').update('calypso-showcase-v1:'+key).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
const countries=[['China',72],['United States',24],['Germany',18],['Japan',16],['France',12],['India',10],['United Kingdom',8],['Canada',6],['Australia',6],['Brazil',4],['Switzerland',4]].flatMap(([country,count])=>Array.from({length:count},()=>country));
const pool=await platformPool();
try {
 await migrate(pool);
 await transaction(pool,async db=>{
  for(let i=0;i<countries.length;i++) {
   const label=String(i+1).padStart(3,'0'),email=`showcase.${label}@example.test`,profile={...emptyProfile('Demo researcher '+label,email),institution:'Demo Institute '+(i%12+1),researchGroup:'Demo Research Group '+(i%24+1),careerStage:['doctoral','masters','postdoc','researcher','faculty'][i%5],countryRegion:countries[i]};
   await db.query(`INSERT INTO calypso_platform.users(id,username,email,profile,test_account,demo_account,status,created_at) VALUES($1,$2,$3,$4,true,true,$5,now()-($6::int*interval '1 day')) ON CONFLICT(id) DO NOTHING`,[id('user'+i),'demo.showcase.'+label,email,profile,i<150?'active':i<174?'suspended':'deleted',parseInt(createHash('sha256').update('showcase-date-'+i).digest('hex').slice(0,8),16)%30]);
  }
  for(let i=0;i<countries.length;i++)await db.query("UPDATE calypso_platform.users SET created_at=now()-($1::int*interval '1 day') WHERE id=$2 AND demo_account",[parseInt(createHash('sha256').update('showcase-date-'+i).digest('hex').slice(0,8),16)%30,id('user'+i)]);
  const statuses=['not-submitted','pending','pending','approved','approved','needs-information','rejected','approved'];
  for(let i=0;i<48;i++) {
   const batchId=id('batch'+i),status=statuses[i%8],types=['structure','raman','xrd','property'],records=Array.from({length:1+i%4},(_,j)=>({id:'demo-record-'+j,dataType:types[(i+j)%4],origin:i%2?'experimental':'theoretical',formula:'DEMO',_demo:true}));
   const draft={id:batchId,title:'SYNTHETIC showcase batch '+(i+1),visibility:'private',computationRequested:false,records,files:[],contributor:{name:'Demo researcher '+(i%100+1),email:'showcase@example.test'},_demo:true};
   await db.query(`INSERT INTO calypso_platform.batches(id,owner_id,draft_json,review_status,submitted_at,created_at,updated_at) VALUES($1,$2,$3,$4,CASE WHEN $4='not-submitted' THEN NULL ELSE now()-($5::int*interval '1 day') END,now()-($5::int*interval '1 day'),now()-($5::int*interval '1 day')) ON CONFLICT(id) DO NOTHING`,[batchId,id('user'+i%100),draft,status,i%25]);
   await db.query("UPDATE calypso_platform.batches SET draft_json=jsonb_set(draft_json,'{visibility}',to_jsonb('private'::text)) WHERE id=$1 AND owner_id=$2 AND draft_json->>'_demo'='true'",[batchId,id('user'+i%100)]);
   for(let j=0;j<records.length;j++)await db.query('INSERT INTO calypso_platform.records(id,batch_id,client_id,input_json) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',[id('record'+i+'-'+j),batchId,records[j].id,records[j]]);
  }
 });
 console.log('Showcase ready: 180 explicitly synthetic, passwordless identities; 48 synthetic contribution metadata batches. Live scientific records unchanged.');
} finally {await pool.end();}

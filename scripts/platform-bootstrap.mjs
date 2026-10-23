import {readFile,writeFile,chmod} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {platformPool,migrate,transaction} from '../src/platform/database.mjs';
import {createUser} from '../src/platform/server.mjs';
import {emptyProfile} from '../src/domain/accounts/model.ts';
const pool=await platformPool();
try {
 await migrate(pool);
 const file=new URL('../.local/platform-test-accounts.json',import.meta.url);
 let existing;try{existing=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(existing){console.log('Test credentials already exist in .local/platform-test-accounts.json; no accounts were overwritten.');}
 else {
  const accounts=await transaction(pool,async db=>{
   const created=[];
   for(const [username,role] of [['local.researcher','member'],['local.admin','admin']]){
    const password=randomBytes(18).toString('base64url');
    const profile={...emptyProfile('Local test '+role),institution:'Local test institute',researchGroup:'Local test group',careerStage:'researcher'};
    const user=await createUser(db,{username,email:username+'@calypso.test',password,profile},{role,test:true});created.push({username,password,id:user.id,role});
   }
   return created;
  });
  await writeFile(file,JSON.stringify({mode:'local-test',accounts},null,2)+'\n',{mode:0o600,flag:'wx'});await chmod(file,0o600);
  console.log('Two PostgreSQL test accounts created. Private credentials: .local/platform-test-accounts.json');
 }
} finally {await pool.end();}

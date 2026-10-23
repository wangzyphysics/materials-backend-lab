import { openRepository } from '../src/repository.mjs';
const query=process.argv[2];if(!query)throw new Error('Pass a read-only SQL query');
const repo=await openRepository();
try {await repo.transaction(async tx=>{await tx.exec('SET TRANSACTION READ ONLY');console.log(JSON.stringify(await tx.sql(query),null,2));});}
finally{await repo.close();}

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../src/model.mjs';
import { schemaSQL } from '../src/schema.mjs';
import { openRepository } from '../src/repository.mjs';
import { MaterialService } from '../src/service.mjs';
import { mongoDocuments } from '../src/transfer.mjs';
const repo=await openRepository();
try {
  const snapshot=await new MaterialService(repo).exportSnapshot();
  await mkdir(path.join(ROOT,'artifacts'),{recursive:true});
  for(const [file,value] of [['transfer.json',snapshot],['mongo-documents.json',mongoDocuments(snapshot)]])
    await writeFile(path.join(ROOT,'artifacts',file),JSON.stringify(value,null,2)+'\n');
  for(const backend of ['postgres','sqlite'])await writeFile(path.join(ROOT,'artifacts',backend+'-schema.sql'),schemaSQL(backend));
  console.log(JSON.stringify({materials:snapshot.tables.materials.length,calculations:snapshot.tables.calculations.length,dataHash:snapshot.data_hash},null,2));
}finally{await repo.close();}

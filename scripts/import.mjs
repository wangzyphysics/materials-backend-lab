import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../src/model.mjs';
import { openRepository } from '../src/repository.mjs';
import { MaterialService } from '../src/service.mjs';
const bundle=JSON.parse(await readFile(path.join(ROOT,'samples/ingest.json'),'utf8'));
const repo=await openRepository();
try {
  const receipt=await new MaterialService(repo).importBundle(bundle);
  await mkdir(path.join(ROOT,'artifacts'),{recursive:true});
  await writeFile(path.join(ROOT,'artifacts/import-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify({importId:receipt.importId,createdMaterials:receipt.createdMaterials,reusedMaterials:receipt.reusedMaterials,
    createdCalculations:receipt.createdCalculations,reusedCalculations:receipt.reusedCalculations,replayed:receipt.replayed},null,2));
} finally {await repo.close();}

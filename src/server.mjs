import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ROOT } from './model.mjs';
import { openRepository } from './repository.mjs';
import { MaterialService } from './service.mjs';

export function createApiServer(service) {
  const dataset={synthetic:false,name:'results-0430 · 20 real source records',validation:'source_provided',thermodynamics:'energy_definition_unverified'};
  return createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    try {
      if(req.method!=='GET'){res.statusCode=405;throw new Error('This inspection API is read-only');}
      const url=new URL(req.url,'http://localhost'),parts=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if(url.pathname==='/'){
        res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await readFile(path.join(ROOT,'web/inspect.html')));return;
      }
      let result;
      if(parts[0]!=='api'||parts[1]!=='v1'){res.statusCode=404;throw new Error('Unknown route');}
      if(parts.length===3&&parts[2]==='health') {
        const backend=service.repo.backend;
        const version=backend==='postgres'?(await service.repo.sql('SELECT version() AS version'))[0].version:(await service.repo.sql('SELECT sqlite_version() AS version'))[0].version;
        result={backend,version};
      } else if(parts.length===3&&parts[2]==='statistics') {
        const materials=await service.repo.list('materials'),phases=await service.repo.list('phases'),pressures=materials.filter(m=>m.pressure_gpa!==null).map(m=>m.pressure_gpa);
        result={materials:{count:materials.length,definition:'Exact imported Material identities in this isolated lab.'},
          phases:{count:phases.length,definition:'Source-provided phase labels scoped by composition.'},
          structureRecords:{count:materials.length,definition:'One selected display unit cell per Material; calculation cells are separate representations.'},
          pressureCoverage:{minGPa:pressures.length?Math.min(...pressures):null,maxGPa:pressures.length?Math.max(...pressures):null,definition:'Reported pressures only; unreported pressures are excluded.'}};
      } else if(parts.length===3&&parts[2]==='materials') {
        const limit=Number(url.searchParams.get('limit')??100);if(!Number.isInteger(limit)||limit<1||limit>100){res.statusCode=400;throw new Error('limit must be 1–100');}
        result=await service.listMaterials({query:url.searchParams.get('query')??'',limit});
      } else if(parts.length===4&&parts[2]==='materials') result={material:await service.getMaterial(parts[3])};
      else if(parts.length===3&&parts[2]==='phases')result={items:await service.repo.list('phases')};
      else if(parts.length===5&&parts[2]==='phases'&&parts[4]==='materials')result={records:await service.phaseMaterials(parts[3])};
      else if(parts.length===5&&parts[2]==='phases'&&parts[4]==='resolve') {
        const raw=url.searchParams.get('pressure');if(raw===null||!raw.trim()||!Number.isFinite(Number(raw))){res.statusCode=400;throw new Error('Finite pressure required');}
        result=await service.resolvePressure(parts[3],Number(raw));
      } else if(parts.length===4&&parts[2]==='calculations') {
        result={calculation:await service.repo.get('calculations',{calculation_id:parts[3]}),result:await service.repo.get('calculation_results',{calculation_id:parts[3]})};
      } else {res.statusCode=404;throw new Error('Unknown route');}
      if(result===null||('material'in result&&result.material===null)||('calculation'in result&&result.calculation===null)||('records'in result&&result.records===null)){res.statusCode=404;throw new Error('Record not found');}
      res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify({dataset,...result}));
    } catch(error) {
      if(res.statusCode===200)res.statusCode=error instanceof URIError?400:500;
      res.setHeader('Content-Type','application/json; charset=utf-8');
      res.end(JSON.stringify({dataset,error:res.statusCode===500?'Local query failed':error.message}));
      if(res.statusCode===500)console.error(error.message);
    }
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const repo=await openRepository({backend:process.env.LAB_BACKEND??'postgres'});
  const server=createApiServer(new MaterialService(repo));
  const port=Number(process.env.LAB_API_PORT??8878);
  if(!Number.isInteger(port)||port<1||port>65535){await repo.close();throw new Error('Invalid API port');}
  server.on('error',async error=>{console.error(error.message);await repo.close();process.exitCode=1;});
  server.listen(port,'127.0.0.1',()=>console.log(`Real source data · ${repo.backend} · http://127.0.0.1:${port}/`));
  let stopping=false;const stop=()=>{if(stopping)return;stopping=true;server.close(async()=>{await repo.close();process.exit(0);});server.closeIdleConnections();};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}

import {platformPool} from '../src/platform/database.mjs';
import {adminStatistics,readStatistics} from '../src/platform/statistics.mjs';
const pool=await platformPool();
try {console.log(JSON.stringify(await readStatistics(pool,db=>adminStatistics(db,process.argv.includes('--demo')?'demo':'live')),null,2));}finally{await pool.end();}

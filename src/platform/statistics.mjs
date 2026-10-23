import {aggregateCountries} from '../domain/materials/country-regions.ts';

export async function communityStatistics(db,view='live') {
 const rows=(await db.query(`SELECT profile->>'countryRegion' AS country FROM calypso_platform.users WHERE status<>'deleted' AND ${view==='demo'?'demo_account':'NOT test_account AND NOT demo_account'}`)).rows;
 const countries=aggregateCountries(rows.map(row=>row.country??''));
 return {mode:view,registeredUsers:{count:rows.length,definition:view==='demo'?'Synthetic demo identities for interface preview; these are not actual registered users.':'Registered accounts, excluding preset and QA test accounts; not a verified-person count.'},
  regions:countries.regions,definition:view==='demo'?'Illustrative country assignments for explicitly synthetic demo accounts. These are not verified user locations; country cohorts smaller than 3 accounts are omitted.':'Country / region is self-reported in research profiles, not inferred from IP addresses. Only country aggregates with at least 3 accounts are displayed; unknown locations and smaller groups are omitted.'};
}

/** Called within a repeatable-read, read-only transaction by HTTP and local CLI. */
export async function adminStatistics(db,view='live') {
 const cohort=view==='demo'?'demo_account':'NOT test_account AND NOT demo_account';
 const accounts=(await db.query(`SELECT count(*) FILTER(WHERE (${cohort}) AND status<>'deleted')::int AS registered,count(*) FILTER(WHERE test_account AND NOT demo_account)::int AS test,
 count(*) FILTER(WHERE (${cohort}) AND status<>'deleted' AND email_verified)::int AS "verifiedEmail",count(*) FILTER(WHERE (${cohort}) AND status<>'deleted' AND role='admin')::int AS administrators,
 count(DISTINCT lower(trim(profile->>'institution'))) FILTER(WHERE (${cohort}) AND status<>'deleted' AND trim(profile->>'institution')<>'')::int AS institutions,
 count(DISTINCT (lower(trim(profile->>'institution')),lower(trim(profile->>'researchGroup')))) FILTER(WHERE (${cohort}) AND status<>'deleted' AND trim(profile->>'institution')<>'' AND trim(profile->>'researchGroup')<>'')::int AS "researchGroups",
 (SELECT count(DISTINCT s.user_id)::int FROM calypso_platform.sessions s JOIN calypso_platform.users u ON u.id=s.user_id WHERE ${view==='demo'?'u.demo_account':'NOT u.test_account AND NOT u.demo_account'} AND u.status<>'deleted' AND s.expires_at>now()) AS "signedInAccounts" FROM calypso_platform.users`)).rows[0];
 const science=(await db.query(`SELECT count(*)::int AS materials,count(*)::int AS "displayRecords",count(pressure_gpa)::int AS "pressureReported",count(*) FILTER(WHERE pressure_gpa IS NULL)::int AS "pressureMissing",
 (SELECT count(*)::int FROM calypso_lab.phases) AS "sourcePhases",(SELECT count(*)::int FROM calypso_lab.structures) AS "structureRepresentations",(SELECT count(*)::int FROM calypso_lab.calculations) AS calculations,(SELECT count(*)::int FROM calypso_lab.sources) AS sources FROM calypso_lab.materials`)).rows[0];
 const eligible=`FROM calypso_platform.batches b JOIN calypso_platform.users u ON u.id=b.owner_id WHERE ${view==='demo'?'u.demo_account':'NOT u.test_account AND NOT u.demo_account'} AND u.status<>'deleted' AND b.deleted_at IS NULL`;
 const batch=(await db.query(`SELECT count(*)::int AS batches,count(DISTINCT b.owner_id) FILTER(WHERE b.submitted_at IS NOT NULL)::int AS contributors ${eligible}`)).rows[0];
 const review=(await db.query(`SELECT review_status AS status,count(*)::int AS count ${eligible} GROUP BY review_status ORDER BY review_status`)).rows;
 const files=(await db.query(`SELECT count(*)::int AS files,coalesce(sum(f.size),0)::float8 AS bytes FROM calypso_platform.files f JOIN calypso_platform.batches b ON b.id=f.batch_id JOIN calypso_platform.users u ON u.id=b.owner_id WHERE ${view==='demo'?'u.demo_account':'NOT u.test_account AND NOT u.demo_account'} AND u.status<>'deleted' AND b.deleted_at IS NULL`)).rows[0];
 const record=(await db.query(`SELECT count(*) FILTER(WHERE b.review_status='approved' AND b.draft_json->>'visibility'='public-after-review')::int AS "publicRecords",count(*) FILTER(WHERE b.review_status='approved' AND (b.draft_json->>'computationRequested')::boolean AND r.input_json->>'dataType'='structure')::int AS "awaitingWorkflow" FROM calypso_platform.records r JOIN calypso_platform.batches b ON b.id=r.batch_id JOIN calypso_platform.users u ON u.id=b.owner_id WHERE ${view==='demo'?'u.demo_account':'NOT u.test_account AND NOT u.demo_account'} AND u.status<>'deleted' AND b.deleted_at IS NULL`)).rows[0];
 const types=(await db.query(`SELECT r.input_json->>'dataType' AS type,count(*)::int AS count FROM calypso_platform.records r JOIN calypso_platform.batches b ON b.id=r.batch_id JOIN calypso_platform.users u ON u.id=b.owner_id WHERE ${view==='demo'?'u.demo_account':'NOT u.test_account AND NOT u.demo_account'} AND u.status<>'deleted' AND b.deleted_at IS NULL GROUP BY r.input_json->>'dataType' ORDER BY type`)).rows;
 const registrations=(await db.query(`SELECT to_char(day,'YYYY-MM-DD') AS date,count(u.id)::int AS count FROM generate_series((now() AT TIME ZONE 'Asia/Shanghai')::date-29,(now() AT TIME ZONE 'Asia/Shanghai')::date,interval '1 day') day LEFT JOIN calypso_platform.users u ON ${view==='demo'?'u.demo_account':'NOT u.test_account AND NOT u.demo_account'} AND u.status<>'deleted' AND (u.created_at AT TIME ZONE 'Asia/Shanghai')::date=day::date GROUP BY day ORDER BY day`)).rows;
 const countries=aggregateCountries((await db.query(`SELECT profile->>'countryRegion' AS country FROM calypso_platform.users WHERE (${cohort}) AND status<>'deleted'`)).rows.map(row=>row.country??''),1);
 const statusCounts=(await db.query(`SELECT status,count(*)::int AS count FROM calypso_platform.users WHERE ${cohort} GROUP BY status ORDER BY status`)).rows;
 const careerStages=(await db.query(`SELECT profile->>'careerStage' AS stage,count(*)::int AS count FROM calypso_platform.users WHERE (${cohort}) AND status<>'deleted' GROUP BY profile->>'careerStage' ORDER BY count DESC`)).rows;
 const demoAvailable=Number((await db.query('SELECT count(*)::int AS n FROM calypso_platform.users WHERE demo_account')).rows[0].n)>0;
 return {generatedAt:new Date().toISOString(),mode:view,demoAvailable,statusCounts,careerStages,accounts,science,contributions:{...batch,...files,...record,review,types},registrations,countries:countries.regions,countryUnrecognized:countries.unrecognized,workflowConnected:false};
}

export async function readStatistics(pool,reader) {
 const db=await pool.connect();
 try {await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await reader(db);await db.query('COMMIT');return result;}
 catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {platformRuntimeConfig,platformSessionCookie} from '../src/platform/runtime-config.mjs';
import {createPlatformServer} from '../src/platform/server.mjs';

test('local remains compatible and remote origin enables secure cookies', () => {
  assert.equal(platformRuntimeConfig({}).secureCookies,false);
  const origin='https://calypso-db-web.wangzy-physics.workers.dev';
  assert.deepEqual(platformRuntimeConfig({CALYPSO_ALLOWED_ORIGINS:origin}),{origins:[origin],secureCookies:true});
  for (const value of [origin+'/login',origin+'?returnTo=x','http://untrusted.example',''])
    assert.throws(()=>platformRuntimeConfig({CALYPSO_ALLOWED_ORIGINS:value}));
  assert.throws(()=>platformRuntimeConfig({CALYPSO_ALLOWED_ORIGINS:origin,CALYPSO_SECURE_COOKIES:'false'}));
});
test('HTTPS issue and deletion cookies use Secure without binding to the API domain', () => {
  assert.match(platformSessionCookie('qa',{secureCookies:true}),/; Secure$/);
  assert.match(platformSessionCookie('',{secureCookies:true,maxAge:0}),/Max-Age=0; Secure$/);
  assert.doesNotMatch(platformSessionCookie('qa',{secureCookies:true}),/Domain=/);
  assert.doesNotMatch(platformSessionCookie('qa'),/Secure/);
});

test('proxy-facing API issues a secure session and enforces the configured website origin', async () => {
  const origin='https://calypso-db-web.wangzy-physics.workers.dev';
  let session;
  const pool={async query(sql,params){
    if(sql.startsWith('INSERT INTO calypso_platform.sessions'))session={csrf_token:params[2],expires_at:params[3]};
    if(sql.startsWith('SELECT s.'))return {rows:session?[session]:[]};
    return {rows:[]};
  }};
  const server=await createPlatformServer(pool,{origins:[origin],secureCookies:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try {
    const response=await fetch(base+'/api/identity/session');
    assert.equal(response.status,200);
    assert.match(response.headers.get('set-cookie'),/; Secure$/);
    const {csrfToken}=await response.json();
    const cookie=response.headers.get('set-cookie').split(';')[0];
    const send=website=>fetch(base+'/api/identity/password/sign-in',{method:'POST',
      headers:{Origin:website,Cookie:cookie,'X-CSRF-Token':csrfToken,'Content-Type':'application/json'},body:'{}'});
    assert.equal((await send(origin)).status,400); // Origin/CSRF passed; missing login fields.
    assert.equal((await send('https://foreign.example')).status,403);
  } finally {await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});}
});

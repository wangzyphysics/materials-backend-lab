import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

// Patch only the network/session settings of an already uploaded backend.
// Do not replace the whole server with newer, unrelated database migrations.
const target=process.argv[2]??fileURLToPath(new URL('../src/platform/server.mjs',import.meta.url));
const source=await readFile(target,'utf8');
if(source.includes('// Cloudflare runtime adapter v1')||source.includes('const runtime=platformRuntimeConfig();')) {
  console.log('Cloudflare runtime configuration already supported; no source changes.');
} else {
  const cookie=/^function sessionCookie\(token\)\{[^\n]*\}$/m;
  const logout=/res\.setHeader\('Set-Cookie',`\$\{cookieName\}=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0`\);/;
  if(!cookie.test(source)||!logout.test(source)||(source.match(/createPlatformServer\(pool\);/g)??[]).length!==1)
    throw new Error('Backend version does not match the known local runtime; no files changed.');
  const runtimeModule='./runtime-config.mjs';
  const updated=`// Cloudflare runtime adapter v1\nimport {platformRuntimeConfig,platformSessionCookie} from ${JSON.stringify(runtimeModule)};\n`+
    source.replace(cookie,'function sessionCookie(token){return platformSessionCookie(token,platformRuntimeConfig());}')
      .replace(logout,"res.setHeader('Set-Cookie',platformSessionCookie('',{...platformRuntimeConfig(),maxAge:0}));")
      .replace('createPlatformServer(pool);','createPlatformServer(pool,platformRuntimeConfig());');
  await writeFile(target+'.before-cloudflare-runtime',source,{flag:'wx',mode:0o600});
  await writeFile(target,updated);
  console.log('Updated only origin/Secure-cookie runtime settings; original source backed up. No database writes.');
}

import { z } from 'zod';
const configSchema = z.object({ url: z.string().url(), origin: z.string().url(), username: z.string().min(1), password: z.string().min(1) }).strict();
/** Temporary session per command. Never writes passwords, cookies or CSRF tokens to disk. */
export function createIngestionClient(value) {
    const config = configSchema.parse(value), base = new URL(config.url), origin = new URL(config.origin);
    const local = url => url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((base.protocol !== 'https:' && !local(base)) || base.username || base.password || base.pathname !== '/' || base.search || base.hash)
        throw new Error('API URL must be an HTTPS origin or a loopback HTTP origin');
    if ((origin.protocol !== 'https:' && !local(origin)) || origin.origin !== config.origin)
        throw new Error('Origin must be an allowed website origin');
    let cookie = '', csrf = '';
    async function request(endpoint, method = 'GET', body) {
        const response = await fetch(new URL(endpoint, base), { method, redirect: 'error', signal: AbortSignal.timeout(60000), headers: { Accept: 'application/json', Origin: config.origin, ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const next = response.headers.getSetCookie();
        if (next.length)
            cookie = next.map(v => v.split(';')[0]).join('; ');
        const type = response.headers.get('content-type') ?? '';
        if (!type.includes('application/json'))
            throw new Error('API returned a non-JSON response (HTTP ' + response.status + '). Check the API URL and proxy.');
        const data = await response.json();
        if (!response.ok) {
            const error = new Error(typeof data.error === 'string' ? data.error : 'API request failed');
            error.status = response.status;
            error.issues = data.issues;
            throw error;
        }
        if (data.csrfToken)
            csrf = data.csrfToken;
        return data;
    }
    return {
        async login() { await request('/api/identity/session'); const session = await request('/api/identity/password/sign-in', 'POST', { identity: config.username, password: config.password }); if (session.user?.role !== 'admin')
            throw new Error('Data imports require an administrator account'); if (session.user.passwordChangeRequired)
            throw new Error('Change your temporary password on the website before importing'); },
        preview: input => request('/api/contributions/admin/imports/preview', 'POST', input),
        upload: input => request('/api/contributions/admin/imports', 'POST', input),
        validate: draft => request('/api/contributions/validate', 'POST', { draft }),
        list: (offset = 0, limit = 20) => request('/api/contributions/admin/imports?offset=' + encodeURIComponent(offset) + '&limit=' + encodeURIComponent(limit)),
        status: id => request('/api/contributions/batches/' + encodeURIComponent(id) + '/events'),
        submit: id => request('/api/contributions/batches/' + encodeURIComponent(id) + '/submit', 'POST', {}),
        async close() { if (cookie && csrf)
            await request('/api/identity/logout', 'POST', {}); cookie = ''; csrf = ''; },
    };
}

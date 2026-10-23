const localOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173'];

export function platformRuntimeConfig(env = process.env) {
  const raw = env.CALYPSO_ALLOWED_ORIGINS;
  const origins = raw === undefined ? localOrigins : raw.split(',').map(value => value.trim()).filter(Boolean);
  if (!origins.length) throw new Error('CALYPSO_ALLOWED_ORIGINS requires at least one website origin.');
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))))
      throw new Error('Website origins must be HTTPS origins or local HTTP loopback origins, without paths.');
  }
  const setting = env.CALYPSO_SECURE_COOKIES;
  if (setting !== undefined && !['true', 'false'].includes(setting)) throw new Error('CALYPSO_SECURE_COOKIES must be true or false.');
  const secureCookies = setting === undefined ? origins.some(origin => origin.startsWith('https:')) : setting === 'true';
  if (origins.some(origin => origin.startsWith('https:')) && !secureCookies)
    throw new Error('HTTPS website origins require Secure cookies.');
  return { origins: [...new Set(origins)], secureCookies };
}

export function platformSessionCookie(token, { secureCookies = false, maxAge = 8 * 3600 } = {}) {
  return `calypso_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
}

/** The desktop shell hosts one origin; it never hosts the backend. */
export function applicationUrl(value: string, development = false): URL {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(development && local && url.protocol === 'http:'))) {
    throw new Error('Use an HTTPS application URL (loopback HTTP is allowed during desktop development).');
  }
  return url;
}

export function isApplicationNavigation(value: string, application: URL): boolean {
  try { return applicationUrl(value, application.protocol === 'http:').origin === application.origin; }
  catch { return false; }
}

export function isExternalLink(value: string): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password && ['https:', 'mailto:'].includes(url.protocol);
  } catch { return false; }
}

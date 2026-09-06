import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { ConnectionConfig } from '../shared/types.js';

/** Validate the actual connector destination. An optional allowlist restricts, rather than enables, self-service. */
export function assertConnectionDestination(connection: ConnectionConfig, allowedHosts: readonly string[] = []): void {
  if (connection.kind === 'sqlite') return;
  const host = destinationHost(connection);
  if (allowedHosts.length && !allowedHosts.map(normalizeHost).includes(host)) {
    throw new Error('This database host is restricted by the server connection policy.');
  }
  if (!host || host.includes('\\') || host.includes('/') || host.includes('@') || host.includes('%')) throw new Error('Invalid database hostname.');
  if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && !isPublicAddress(host))) {
    throw new Error('Use a publicly reachable database host. Local and private network addresses are not supported by the hosted app.');
  }
  if (connection.kind === 'mongodb') {
    assertMongoOptions(connection.mongodbUri);
    connection.mongodbDirectConnection = true;
  }
}

export async function prepareConnectionDestination(connection: ConnectionConfig, allowedHosts: readonly string[] = [], resolve = lookup): Promise<void> {
  assertConnectionDestination(connection, allowedHosts);
  if (connection.kind === 'sqlite') return;
  const host = destinationHost(connection);
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('This hostname resolves to a private or reserved network. Use a publicly reachable database.');
  }
  // Pin the checked IP for this connection attempt to prevent a second DNS lookup.
  connection.resolvedAddress = addresses[0].address;
}

function destinationHost(connection: ConnectionConfig): string {
  if (connection.kind === 'elasticsearch') {
    if (connection.elasticsearchHost) return normalizeHost(connection.elasticsearchHost);
    if (!connection.elasticsearchUrl) return '';
    const url = new URL(connection.elasticsearchUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid database address.');
    return normalizeHost(url.hostname);
  }
  if (connection.kind === 'mongodb' && connection.mongodbUri) {
    if (connection.mongodbUri.includes('\\')) throw new Error('Invalid database address.');
    const parsed = /^(mongodb(?:\+srv)?):\/\/([^/?#]+)/i.exec(connection.mongodbUri);
    if (!parsed || parsed[1].toLowerCase() !== 'mongodb') throw new Error('Use a MongoDB URI with an explicit host; SRV discovery is not supported yet.');
    const authority = parsed[2].slice(parsed[2].lastIndexOf('@') + 1);
    if (authority.includes(',') || authority.includes('%')) throw new Error('Use one explicit MongoDB host.');
    return normalizeHost(authority);
  }
  return normalizeHost(connection.host ?? '');
}
function normalizeHost(value: string): string {
  const host = value.trim().toLowerCase();
  if (host.startsWith('[')) return host.slice(1, host.indexOf(']'));
  return isIP(host) ? host : host.replace(/:\d+$/, '').replace(/\.$/, '');
}
/** URI options must not introduce alternate sockets, local files or external auth services. */
function assertMongoOptions(uri?: string): void {
  if (!uri) return;
  const allowed = new Set(['authsource', 'authmechanism', 'tls', 'ssl', 'replicaset', 'readpreference', 'retryreads', 'retrywrites', 'directconnection', 'appname', 'connecttimeoutms', 'sockettimeoutms', 'serverselectiontimeoutms']);
  const params = new URL(uri).searchParams;
  for (const [key, value] of params) {
    if (!allowed.has(key.toLowerCase())) throw new Error(`MongoDB URI option "${key}" is not supported by hosted connections.`);
    if (key.toLowerCase() === 'authmechanism' && !['SCRAM-SHA-1', 'SCRAM-SHA-256', 'DEFAULT'].includes(value.toUpperCase())) {
      throw new Error('Hosted MongoDB connections support password authentication only.');
    }
  }
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    // Global unicast only, excluding IETF special assignments, documentation,
    // 6to4 and the documentation /20. Compare groups, not string prefixes:
    // leading zeroes are legal and must not bypass the exclusions.
    const [first, second = '0'] = address.toLowerCase().split(':');
    const a = parseInt(first, 16), b = parseInt(second || '0', 16);
    return a >= 0x2000 && a <= 0x3fff
      && !(a === 0x2001 && (b <= 0x1ff || b === 0xdb8))
      && a !== 0x2002 && !(a === 0x3fff && b <= 0x0fff);
  }
  return false;
}

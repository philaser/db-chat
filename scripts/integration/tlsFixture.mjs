import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

/** Synthetic localhost identity, trusted only for this disposable-engine run. */
export function createTlsFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'dbchat-integration-tls-'));
  const certificate = path.join(directory, 'server.crt');
  const key = path.join(directory, 'server.key');
  const previous = tls.getCACertificates('default');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
      '-out', certificate, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
    tls.setDefaultCACertificates([...previous, readFileSync(certificate, 'utf8')]);
    return { certificate, key, close() { tls.setDefaultCACertificates(previous); rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}

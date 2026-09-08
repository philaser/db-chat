import { execFileSync } from 'node:child_process';
import path from 'node:path';

const available = ['postgres', 'mysql', 'mongodb'];
const requested = process.argv.slice(2);
if (requested.includes('--help')) {
  console.log('Usage: npm run test:databases -- [postgres mysql mongodb]\nRuns real engines in disposable localhost Docker containers with synthetic data and restricted users. No model requests or customer database access.');
  process.exit(0);
}
const engines = requested.length ? [...new Set(requested)] : available;
if (engines.some(engine => !available.includes(engine))) throw new Error('Choose postgres, mysql, or mongodb.');
for (const engine of engines) {
  console.log(`\nTesting ${engine} with a disposable local database`);
  execFileSync(process.execPath, [path.join('scripts', 'integration', `${engine}.mjs`)], { stdio: 'inherit' });
}

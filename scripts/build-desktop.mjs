import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';

rmSync('dist-desktop', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.desktop.json'], { stdio: 'inherit' });
const { applicationUrl } = await import('../dist-desktop/navigation.js');
const url = process.env.DBCHAT_DESKTOP_URL;
if (url) applicationUrl(url, process.argv.includes('--development'));
const { name, version, description, author } = JSON.parse(readFileSync('package.json', 'utf8'));
// Dependency-free app directory: never package backend drivers or provider configuration.
writeFileSync('dist-desktop/package.json', JSON.stringify({ name, version, description, author, type: 'module', main: 'main.js' }, null, 2));
writeFileSync('dist-desktop/application.json', JSON.stringify({ url: url || null }));

// Prevent dependency discovery from walking into the backend workspace.
mkdirSync('dist-desktop/node_modules', { recursive: true });

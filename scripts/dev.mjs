import { spawn, execFileSync } from 'node:child_process';
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.web-server.json'], { stdio: 'inherit' });
const env = { ...process.env, DBCHAT_WEB_ALLOWED_ORIGIN: process.env.DBCHAT_WEB_ALLOWED_ORIGIN || 'http://localhost:5173' };
const children = [
  spawn(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.web-server.json', '--watch', '--preserveWatchOutput'], { stdio: 'inherit', env }),
  spawn(process.execPath, ['--env-file-if-exists=.env', '--watch', 'dist-web-server/server/server.js'], { stdio: 'inherit', env }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', 'localhost'], { stdio: 'inherit', env })
];
let stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; children.forEach(child => child.kill()); process.exitCode = code; }
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
children.forEach(child => child.on('exit', code => stop(code || 0)));

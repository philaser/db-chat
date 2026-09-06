import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
// Remove retired compiled entry points before producing the deployable backend.
rmSync('dist-web-server', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.web-server.json'], { stdio: 'inherit' });

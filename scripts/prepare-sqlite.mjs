import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve('better-sqlite3/package.json'));
const probe = `
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  // SQLite omits DEFAULT_MEMSTATUS=1 because it is the upstream default.
  if (db.pragma('compile_options').some(row => row.compile_options === 'DEFAULT_MEMSTATUS=0')) process.exit(1);
  db.pragma('hard_heap_limit = 67108864');
  try { db.prepare('SELECT zeroblob(70000000)').get(); process.exit(1); }
  catch (error) { if (error.code !== 'SQLITE_NOMEM') throw error; }
  finally { db.close(); }
`;
function protectedBuild() {
  try { execFileSync(process.execPath, ['-e', probe], { cwd: path.resolve('.'), stdio: 'pipe' }); return true; }
  catch { return false; }
}

if (!protectedBuild()) {
  // The upstream prebuilt binary disables the accounting required by SQLite's
  // hard_heap_limit. Preserve its other build options and compile locally.
  const definitions = path.join(packageRoot, 'deps', 'defines.gypi');
  const source = readFileSync(definitions, 'utf8');
  const flag = /'SQLITE_DEFAULT_MEMSTATUS=[01]'/g;
  if ((source.match(flag) ?? []).length !== 1) {
    throw new Error('Unexpected better-sqlite3 build options. Review the SQLite memory-limit integration before upgrading.');
  }
  writeFileSync(definitions, source.replace(flag, "'SQLITE_DEFAULT_MEMSTATUS=1'"));
  const npmCli = process.env.npm_execpath;
  const nodeGyp = process.env.npm_config_node_gyp ?? require.resolve('node-gyp/bin/node-gyp.js', {
    paths: [packageRoot, ...(npmCli ? [path.dirname(npmCli)] : [])]
  });
  execFileSync(process.execPath, [nodeGyp, 'rebuild', '--release'], { cwd: packageRoot, stdio: 'inherit' });
  if (!protectedBuild()) throw new Error('SQLite native memory protection could not be verified. The build cannot be used to serve uploaded databases.');
}
console.log('SQLite native memory limit verified.');

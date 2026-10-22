// check-env.ts <repo root>: each servers/*/server.env holds only non-secret settings the Parley server accepts
// (apps/server/src/config.ts), with this network's values: the app's own *.fly.dev domain, production mode on a
// production app and test mode on a staging one, Fly's client IP header and passkey sign-in. A secret named here is
// refused (secrets go in Fly's store, through scripts/set-secrets.sh). No value is ever printed. Exits 1 on any problem.
// The same file is also checked by the pinned image's own loadConfig in check.yml.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readServers, runCheck, type Server } from './servers.ts';

const SECRETS = new Set(['DATABASE_URL', 'PARLEY_SECRET_KEY', 'PARLEY_TEST_KEYS']);
/** Optional settings config.ts accepts that this network may use (JSON or a list; config.ts checks the contents). */
const OPTIONAL = new Set(['PARLEY_CIMD_PINS', 'PARLEY_PREREGISTERED_CLIENTS', 'PARLEY_EXTRA_REDIRECT_SCHEMES']);

function expected(s: Server): Record<string, string | null> {
  return {
    PARLEY_DOMAIN: `${s.app}.fly.dev`,
    PARLEY_PUBLIC_URL: `https://${s.app}.fly.dev`,
    PARLEY_MODE: s.production ? 'production' : 'test',
    PARLEY_OPERATOR_CONTACT: null, // any non-empty text
    PARLEY_CLIENT_IP_HEADER: 'fly-client-ip',
    PARLEY_SIGN_IN: 'passkey',
  };
}

function checkFile(s: Server, problems: string[]): void {
  const where = `servers/${s.folder}/server.env`;
  const file = join(s.dir, 'server.env');
  if (!existsSync(file)) {
    problems.push(`${where}: missing`);
    return;
  }
  const want = expected(s);
  const seen = new Map<string, string>();
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (line.trim() === '' || line.startsWith('#')) return;
      const eq = line.indexOf('=');
      const name = eq < 0 ? line : line.slice(0, eq);
      const value = eq < 0 ? '' : line.slice(eq + 1);
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return void problems.push(`${where}:${i + 1}: not a NAME=value line`);
      if (SECRETS.has(name)) return void problems.push(`${where}: ${name} is a secret: set it with scripts/set-secrets.sh, never in the repo`);
      if (!(name in want) && !OPTIONAL.has(name)) return void problems.push(`${where}: ${name} is not a setting this network uses`);
      if (seen.has(name)) return void problems.push(`${where}: ${name} is set twice`);
      // docker --env-file and flyctl --env both take the value literally, quotes included.
      if (/^["']|["']$/.test(value)) return void problems.push(`${where}: ${name} is quoted; write NAME=value with no quotes`);
      seen.set(name, value);
    });
  for (const [name, value] of Object.entries(want)) {
    const got = seen.get(name);
    if (got === undefined || got === '') problems.push(`${where}: ${name} is required`);
    else if (value !== null && got !== value) problems.push(`${where}: ${name} must be ${value}`);
  }
}

export function checkEnv(root: string): { problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const servers = readServers(root);
  for (const s of servers) checkFile(s, problems);
  return { problems, notes: servers.map((s) => `servers/${s.folder}: ${s.app} (${s.production ? 'production' : 'staging'})`) };
}

runCheck('check-env', checkEnv);

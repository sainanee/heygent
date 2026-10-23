// Test helper: a throwaway copy of this repo's layout (servers/*, passed-on-staging.txt), and a run of one of the
// check scripts against it as CI runs them (a separate node process, exit code and stderr).
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DIGEST_A = `sha256:${'a1'.repeat(32)}`;
export const DIGEST_B = `sha256:${'b2'.repeat(32)}`;
export const pin = (digest: string) => `ghcr.io/sainanee/parley-server@${digest}\n`;

export interface ServerSpec {
  app: string;
  /** The `image` file's contents; omitted = no image file (not deployed yet). */
  image?: string;
  /** The `server.env` contents; omitted = a correct one for the app. */
  env?: string;
}

/** A correct server.env for `app` (production unless the name ends in -staging). */
export function goodEnv(app: string): string {
  const mode = app.endsWith('-staging') ? 'test' : 'production';
  return [
    `PARLEY_DOMAIN=${app}.fly.dev`,
    `PARLEY_PUBLIC_URL=https://${app}.fly.dev`,
    `PARLEY_MODE=${mode}`,
    'PARLEY_OPERATOR_CONTACT=https://github.com/sainanee/heygent/issues',
    'PARLEY_CLIENT_IP_HEADER=fly-client-ip',
    'PARLEY_SIGN_IN=passkey',
    '',
  ].join('\n');
}

export function makeTree(servers: Record<string, ServerSpec>, passed: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'heygent-tree-'));
  for (const [folder, spec] of Object.entries(servers)) {
    const dir = join(root, 'servers', folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'fly.toml'), `app = "${spec.app}"\nprimary_region = "sin"\n`);
    writeFileSync(join(dir, 'server.env'), spec.env ?? goodEnv(spec.app));
    if (spec.image !== undefined) writeFileSync(join(dir, 'image'), spec.image);
  }
  writeFileSync(join(root, 'passed-on-staging.txt'), ['# digests that passed conformance on staging', ...passed, ''].join('\n'));
  return root;
}

export function runScript(script: string, root: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', join(import.meta.dirname, script), root],
    { encoding: 'utf8' },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Runs one of this repo's shell scripts with bash, asynchronously (a test may serve HTTP from this process meanwhile). */
export function runShell(
  script: string,
  args: string[],
  opts: { input?: string; env?: Record<string, string> } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [script, ...args], { env: { ...process.env, ...opts.env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    // A script that refuses before reading its input closes stdin first: writing to it then fails with EPIPE, which
    // is what that test expects, not an error.
    child.stdin.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') reject(e); });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(opts.input ?? '');
  });
}

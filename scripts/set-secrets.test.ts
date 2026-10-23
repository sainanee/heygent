// set-secrets.sh against a fake `fly` on PATH that records its argv and standard input.
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTree, runShell } from './test-tree.ts';

const KEY = 'q'.repeat(42) + 'A'; // 32 bytes, base64url
const SECRET_KEY = 'k'.repeat(40);
const DB = 'postgresql://postgres.ref:pw-not-on-argv@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=/etc/parley/supabase-ca.crt';

function setup() {
  const root = makeTree({ heygent: { app: 'heygent' }, 'heygent-staging': { app: 'heygent-staging' } });
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(import.meta.dirname, 'set-secrets.sh'), join(root, 'scripts', 'set-secrets.sh'));
  mkdirSync(join(root, 'bin'));
  const fly = join(root, 'bin', 'fly');
  writeFileSync(fly, `#!/bin/sh\nprintf '%s\\n' "$*" > "${root}/fly-argv"\ncat > "${root}/fly-stdin"\n`);
  chmodSync(fly, 0o755);
  const run = (args: string[], input: string) =>
    runShell(join(root, 'scripts', 'set-secrets.sh'), args, { input, env: { PATH: `${join(root, 'bin')}:${process.env.PATH}` } });
  const flyCalled = () => existsSync(join(root, 'fly-argv'));
  const argv = () => readFileSync(join(root, 'fly-argv'), 'utf8');
  const stdin = () => readFileSync(join(root, 'fly-stdin'), 'utf8');
  return { run, flyCalled, argv, stdin };
}

test('set-secrets refuses PARLEY_TEST_KEYS for a production app', async () => {
  const s = setup();
  const r = await s.run(['heygent', 'PARLEY_TEST_KEYS'], `${KEY}\n`);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /refused: PARLEY_TEST_KEYS is test-mode only, and heygent is a production app/);
  assert.equal(s.flyCalled(), false);
});

test('set-secrets gives values to fly on stdin, never on argv or screen', async () => {
  const s = setup();
  const r = await s.run(['heygent-staging'], `${DB}\n${SECRET_KEY}\n${KEY}\n`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.argv(), 'secrets import --app heygent-staging --stage\n');
  assert.equal(
    s.stdin(),
    `DATABASE_URL=${DB}\nPARLEY_SECRET_KEY=${SECRET_KEY}\nPARLEY_TEST_KEYS={"heygent-conformance":"${KEY}"}\n`,
  );
  for (const secret of ['pw-not-on-argv', SECRET_KEY, KEY]) {
    assert.ok(!s.argv().includes(secret) && !r.stdout.includes(secret) && !r.stderr.includes(secret), 'a value leaked');
  }
});

test('set-secrets refuses a DATABASE_URL on the transaction pooler or without verify-full', async () => {
  const bad = [
    DB.replace(':5432/', ':6543/'), // Supabase's transaction-mode pooler
    DB.replace('sslmode=verify-full', 'sslmode=require'),
    DB.replace('&sslrootcert=/etc/parley/supabase-ca.crt', ''),
  ];
  for (const url of bad) {
    const s = setup();
    const r = await s.run(['heygent', 'DATABASE_URL'], `${url}\n`);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /DATABASE_URL must/);
    assert.ok(!r.stderr.includes('pw-not-on-argv'));
    assert.equal(s.flyCalled(), false);
  }
});

test('set-secrets refuses an app name that is not one line of lowercase letters, digits and hyphens', async () => {
  const s = setup();
  // A second line must not let the name pass as "heygent" while flyctl is handed something else.
  const r = await s.run(['heygent\nheygent-staging'], `${DB}\n${SECRET_KEY}\n`);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /an app name is lowercase letters, digits and hyphens/);
  assert.equal(s.flyCalled(), false);
});

test('set-secrets refuses a DATABASE_URL that does not parse to a Supabase database host, and accepts an encoded password', async () => {
  // An unencoded # / ? in the password ends the authority early: Postgres's client then connects somewhere else
  // (often localhost), and the server fails to start with ECONNREFUSED.
  const direct = (pw: string) =>
    `postgresql://postgres:${pw}@db.abcdefghijklmnopqrst.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=/etc/parley/supabase-ca.crt`;
  for (const url of [direct('pw#not-on-argv'), direct('pw/not-on-argv'), direct('pw?not-on-argv'), DB.replace('aws-0-ap-southeast-1.pooler.supabase.com', 'localhost')]) {
    const s = setup();
    const r = await s.run(['heygent', 'DATABASE_URL'], `${url}\n`);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /DATABASE_URL must/);
    assert.ok(!r.stderr.includes('not-on-argv') && !r.stdout.includes('not-on-argv'));
    assert.equal(s.flyCalled(), false);
  }
  const s = setup();
  const ok = direct('pw%23not-on-argv');
  const r = await s.run(['heygent', 'DATABASE_URL'], `${ok}\n`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(s.stdin().includes(ok));
});

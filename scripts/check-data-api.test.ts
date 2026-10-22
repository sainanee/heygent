// check-data-api.sh against a local stand-in for a Supabase project's Data API (REST and GraphQL).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { runShell } from './test-tree.ts';

const ANON = 'eyJ-stand-in-anon-key';

/** Serves /rest/v1/server_keys and /graphql/v1 as `rest`/`graphql` say; records the apikey headers it saw. */
async function check(rest: { status: number; body: unknown }, graphql: { status: number; body: unknown }, base?: string) {
  const keys: string[] = [];
  const server = createServer((req, res) => {
    keys.push(String(req.headers.apikey));
    const answer = req.url?.startsWith('/rest/v1/server_keys') ? rest : req.url === '/graphql/v1' ? graphql : { status: 404, body: {} };
    req.resume();
    req.on('end', () => {
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const r = await runShell(join(import.meta.dirname, 'check-data-api.sh'), [base ?? `http://127.0.0.1:${port}`], { input: `${ANON}\n` });
    return { ...r, keys };
  } finally {
    server.close();
  }
}

const REFUSED_REST = { status: 404, body: { code: 'PGRST205', message: 'not found' } };
const REFUSED_GRAPHQL = { status: 200, body: { errors: [{ message: 'Unknown field "serverKeysCollection"' }] } };

test('data API check passes when neither REST nor GraphQL serves the tables', async () => {
  const r = await check(REFUSED_REST, REFUSED_GRAPHQL);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.keys, [ANON, ANON]);
  assert.ok(!r.stdout.includes(ANON) && !r.stderr.includes(ANON));
});

test('data API check fails when REST serves server_keys', async () => {
  const r = await check({ status: 200, body: [{ kid: 'k1' }] }, REFUSED_GRAPHQL);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /EXPOSED: GET \/rest\/v1\/server_keys answered 200/);
});

test('data API check fails when GraphQL serves server_keys', async () => {
  const r = await check(REFUSED_REST, { status: 200, body: { data: { serverKeysCollection: { edges: [] } } } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /EXPOSED: POST \/graphql\/v1 answered serverKeysCollection data/);
});

test('data API check passes on permission denied and on a schema that is not exposed', async () => {
  // PostgREST's own refusals: 42501 (the API roles hold no privilege), PGRST106 (public is not an exposed schema).
  const denied = await check({ status: 401, body: { code: '42501', message: 'permission denied for table server_keys' } }, REFUSED_GRAPHQL);
  assert.equal(denied.status, 0, denied.stdout + denied.stderr);
  const unexposed = await check({ status: 406, body: { code: 'PGRST106', message: 'Invalid schema: public' } }, REFUSED_GRAPHQL);
  assert.equal(unexposed.status, 0, unexposed.stdout + unexposed.stderr);
});

test('data API check cannot verify a project it cannot reach', async () => {
  // Nothing listens on port 1: no answer is not a refusal.
  const r = await check(REFUSED_REST, REFUSED_GRAPHQL, 'http://127.0.0.1:1');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /could not verify/);
});

test('data API check cannot verify on a server error', async () => {
  const r = await check({ status: 500, body: { message: 'upstream error' } }, REFUSED_GRAPHQL);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /could not verify: GET \/rest\/v1\/server_keys answered 500/);
});

test('data API check does not take a rejected API key for a refusal', async () => {
  // A mistyped or expired anon key is turned away before the Data API is asked anything.
  const invalid = { status: 401, body: { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' } };
  // Each endpoint on its own: the other one refuses properly, so only this endpoint's rule can make it exit 2.
  for (const [rest, graphql] of [
    [invalid, REFUSED_GRAPHQL],
    [REFUSED_REST, invalid],
  ]) {
    const r = await check(rest!, graphql!);
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /without a permission error \(is the anon key right\?\)/);
  }
});

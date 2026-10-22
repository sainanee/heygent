// check-data-api.sh against a local stand-in for a Supabase project's Data API (REST and GraphQL).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { runShell } from './test-tree.ts';

const ANON = 'eyJ-stand-in-anon-key';

/** Serves /rest/v1/server_keys and /graphql/v1 as `rest`/`graphql` say; records the apikey headers it saw. */
async function check(rest: { status: number; body: unknown }, graphql: { status: number; body: unknown }) {
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
    const r = await runShell(join(import.meta.dirname, 'check-data-api.sh'), [`http://127.0.0.1:${port}`], { input: `${ANON}\n` });
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
  assert.match(r.stderr, /EXPOSED: GraphQL answers serverKeysCollection/);
});

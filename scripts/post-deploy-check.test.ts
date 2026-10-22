// post-deploy-check.sh against a small local HTTP server standing in for a deployed one. (The script was also run
// against real local Parley servers; this keeps its rules under test without one.)
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { runShell } from './test-tree.ts';

interface Stub {
  mode: 'production' | 'test';
  testInterface: boolean;
  /** What /test/v1/accounts answers. */
  testAccounts: number;
}

async function check(stub: Stub, expected: 'production' | 'test') {
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/.well-known/parley') {
      send(200, { mode: stub.mode, operator_contact: 'x', ...(stub.testInterface ? { test_interface: 'http://x/test/v1' } : {}) });
    } else if (req.url === '/test/v1/accounts') send(stub.testAccounts, {});
    else if (req.url === '/healthz') send(200, { status: 'ok' });
    else send(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await runShell(join(import.meta.dirname, 'post-deploy-check.sh'), [`http://127.0.0.1:${port}`, expected]);
  } finally {
    server.close();
  }
}

test('post-deploy check passes a production server that hides its test interface', async () => {
  const r = await check({ mode: 'production', testInterface: false, testAccounts: 404 }, 'production');
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('post-deploy check passes a staging server in test mode, test interface and all', async () => {
  const r = await check({ mode: 'test', testInterface: true, testAccounts: 401 }, 'test');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /post-deploy check passed .*\(test\)/);
});

test('post-deploy check fails a server whose mode is not the expected one', async () => {
  const r = await check({ mode: 'test', testInterface: false, testAccounts: 404 }, 'production');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /mode is test, expected production/);
});

test('post-deploy check fails a production server that names a test interface', async () => {
  const r = await check({ mode: 'production', testInterface: true, testAccounts: 404 }, 'production');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /names a test_interface/);
});

test('post-deploy check fails a production server that answers on /test/v1', async () => {
  const r = await check({ mode: 'production', testInterface: false, testAccounts: 401 }, 'production');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /GET \/test\/v1\/accounts answered 401, not 404/);
});

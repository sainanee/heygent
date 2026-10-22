import assert from 'node:assert/strict';
import { test } from 'node:test';
import { goodEnv, makeTree, runScript } from './test-tree.ts';

const checkEnv = (root: string) => runScript('check-env.ts', root);

test('env check accepts a correct production and staging pair', () => {
  const root = makeTree({ heygent: { app: 'heygent' }, 'heygent-staging': { app: 'heygent-staging' } });
  const r = checkEnv(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('env check rejects test mode on a production app', () => {
  const root = makeTree({
    heygent: { app: 'heygent', env: goodEnv('heygent').replace('PARLEY_MODE=production', 'PARLEY_MODE=test') },
  });
  const r = checkEnv(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /servers\/heygent\/server\.env: PARLEY_MODE must be production/);
});

test('env check rejects a secret in server.env', () => {
  const root = makeTree({
    'heygent-staging': { app: 'heygent-staging', env: `${goodEnv('heygent-staging')}PARLEY_TEST_KEYS={"x":"y"}\n` },
  });
  const r = checkEnv(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /servers\/heygent-staging\/server\.env: PARLEY_TEST_KEYS is a secret/);
  assert.doesNotMatch(r.stderr, /"x":"y"/);
});

test("env check rejects a domain that is not the app's own", () => {
  // The copy-paste slip: the peer folder still names heygent.
  const root = makeTree({ peer: { app: 'parley-peer', env: goodEnv('heygent') } });
  const r = checkEnv(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /servers\/peer\/server\.env: PARLEY_DOMAIN must be parley-peer\.fly\.dev/);
});

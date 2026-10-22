import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DIGEST_A, DIGEST_B, makeTree, pin, runScript } from './test-tree.ts';

const checkPins = (root: string) => runScript('check-pins.ts', root);

test('pin check rejects an unpassed production image', () => {
  // Staging runs A (which needs no listing); production pins A too, but only B ever passed.
  const root = makeTree(
    {
      heygent: { app: 'heygent', image: pin(DIGEST_A) },
      'heygent-staging': { app: 'heygent-staging', image: pin(DIGEST_A) },
    },
    [DIGEST_B],
  );
  const r = checkPins(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /servers\/heygent\/image: .*not in passed-on-staging\.txt/);
  assert.doesNotMatch(r.stderr, /servers\/heygent-staging\//);
});

test('pin check rejects a tag pin (not a digest)', () => {
  // A staging folder, so the only rule this pin can break is the digest rule.
  const root = makeTree({
    heygent: { app: 'heygent' },
    'heygent-staging': { app: 'heygent-staging', image: `ghcr.io/sainanee/parley-server:${'c3'.repeat(20)}\n` },
  });
  const r = checkPins(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /servers\/heygent-staging\/image: .*digest/);
});

test('pin check accepts a production digest listed as passed', () => {
  const root = makeTree(
    {
      heygent: { app: 'heygent', image: pin(DIGEST_A) },
      'heygent-staging': { app: 'heygent-staging', image: pin(DIGEST_A) },
      peer: { app: 'parley-peer', image: pin(DIGEST_A) },
      'peer-staging': { app: 'parley-peer-staging', image: pin(DIGEST_A) },
    },
    [DIGEST_B, DIGEST_A],
  );
  const r = checkPins(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('pin check accepts a folder with no image yet', () => {
  // Production has no image file (not deployed yet), so it needs no passed digest; staging is pinned to an unpassed one.
  const root = makeTree({
    heygent: { app: 'heygent' },
    'heygent-staging': { app: 'heygent-staging', image: pin(DIGEST_A) },
  });
  const r = checkPins(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /servers\/heygent: no image yet/);
});

test('pin check rejects a digest pin of another repository', () => {
  // A digest names content, but conformance ran Parley's image: a pin elsewhere is refused even with a passed digest.
  const root = makeTree(
    { heygent: { app: 'heygent', image: `ghcr.io/someone-else/parley-server@${DIGEST_A}\n` } },
    [DIGEST_A],
  );
  const r = checkPins(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /servers\/heygent\/image: must be one line, ghcr\.io\/sainanee\/parley-server@sha256/);
});

test('pin check rejects a line in passed-on-staging.txt that is not a digest', () => {
  // A full image reference (or any junk) is not how the conformance workflow records a pass.
  const root = makeTree({ heygent: { app: 'heygent' } }, [DIGEST_A, `ghcr.io/sainanee/parley-server@${DIGEST_B}`]);
  const r = checkPins(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /passed-on-staging\.txt:3: not a digest/);
});

// soak.ts's offline rules: the staging-only guard, the state file that carries the scenario between soak.yml's jobs
// (an artifact anyone who can read this public repository can download), and the verdict on what both servers show at
// the end. The network side (moves, partitions, restarts) runs only in soak.yml, against the staging pair.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MINIMUMS, TIMING, coverage, errorCode, judge, loadState, runSoak, saveState, stagingApp, type SoakState } from './soak.ts';

const A = 'https://heygent-staging.fly.dev';
const B = 'https://parley-peer-staging.fly.dev';
const ORIGINS = { a: A, b: B };
const ANN = 'ann@heygent-staging.fly.dev';
const BOB = 'bob@parley-peer-staging.fly.dev';

function soak(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', join(import.meta.dirname, 'soak.ts'), ...args],
    { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const tempFile = (name: string) => join(mkdtempSync(join(tmpdir(), 'heygent-soak-')), name);

function state(over: Partial<SoakState> = {}): SoakState {
  return {
    version: 1,
    a: A,
    b: B,
    started_at: '2026-10-24T00:00:00.000Z',
    people: [
      { address: ANN, side: 'a' },
      { address: BOB, side: 'b' },
    ],
    pairs: [{ a: ANN, b: BOB, connect_thread: 'thr_c' }],
    threads: [{ thread_id: 'thr_1', initiator: ANN, invitee: BOB, applied: true, done: false }],
    alerts_at_start: [],
    restarts_unavailable: null,
    clock: { a: 1_200, b: -300 },
    failures: [],
    counts: { moves: 12, faults: 2 },
    ...over,
  };
}

// ------------------------------------------------------------------ the guard

test('soak refuses a production server, before it reads a key or loads the Parley driver', () => {
  // Catches: a workflow edit (or a slip on the command line) that points the soak at production, where it would pause
  // and restart the live servers. No keys and no Parley checkout are given: the refusal must come first.
  for (const [flag, origin] of [
    ['--a', 'https://heygent.fly.dev'],
    ['--b', 'https://parley-peer.fly.dev'],
  ]) {
    const r = soak(['--parley', '/nonexistent', '--state', tempFile('state.json'), '--minutes', '1', '--new', flag, origin!]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(`${flag}: the soak runs only against ${A} and ${B}`));
    assert.doesNotMatch(r.stderr, /CONFORMANCE_|driver/);
    assert.equal(r.stdout, '');
  }
});

test('the guard takes only the two staging origins, exactly', () => {
  // Catches: a suffix or substring match, which would let a lookalike host (or production) through, and a refusal that
  // echoes a URL with credentials in it into the public log.
  assert.equal(stagingApp(A, '--a'), 'heygent-staging');
  assert.equal(stagingApp(`${B}/`, '--b'), 'parley-peer-staging');
  for (const bad of [
    'https://heygent.fly.dev',
    'https://parley-peer.fly.dev',
    'https://heygent-staging.fly.dev.example.com',
    'https://xheygent-staging.fly.dev',
    'https://heygent-staging.example.com',
    'http://heygent-staging.fly.dev',
    'https://heygent-staging.fly.dev:8443',
    'https://heygent-staging.fly.dev/test/v1',
    'https://heygent-staging.fly.dev/?x=1',
    'https://user:hunter2@heygent-staging.fly.dev',
    'heygent-staging',
  ]) {
    assert.throws(
      () => stagingApp(bad, '--a'),
      (e: Error) => /only against/.test(e.message) && !e.message.includes('hunter2'),
      bad,
    );
  }
});

test('a final run with no scenario to resume fails, and never sets up a fresh one', () => {
  // Catches: the last slice starting a new scenario when the earlier slices' state is lost (a failed upload, a renamed
  // artifact), and passing on a few hours of fresh threads: the verdict must be about the whole soak or a FAIL.
  const r = soak(['--parley', '/nonexistent', '--state', tempFile('state.json'), '--minutes', '300', '--final']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.stdout, 'FAIL no soak state: the soak never set up, or its state was lost\nsoak: FAIL\n');
  // A slice that is not the last refuses instead.
  const s = soak(['--parley', '/nonexistent', '--state', tempFile('state.json'), '--minutes', '300']);
  assert.equal(s.status, 2, s.stdout + s.stderr);
  assert.match(s.stderr, /no soak to resume/);
});

test('a state file that names any other server is refused on resume', () => {
  // Catches: resuming from an artifact that names production (or another pair): the next job would pause and judge the
  // servers the file names, not the ones the workflow checked.
  const path = tempFile('state.json');
  writeFileSync(path, JSON.stringify(state({ a: 'https://heygent.fly.dev' })));
  assert.throws(() => loadState(path, ORIGINS), /only against/);
  // And people who are not on the side the file puts them on.
  writeFileSync(path, JSON.stringify(state({ people: [{ address: 'ann@heygent.fly.dev', side: 'a' }] })));
  assert.throws(() => loadState(path, ORIGINS), /ann@heygent\.fly\.dev/);
});

// ------------------------------------------------------------------ the state file

test('the state file round-trips the scenario and never holds a test key or an agent token', () => {
  // Catches: the live Person objects (each holding its agent's access token, and its Peer the staging test key) reaching
  // the state file, which soak.yml uploads as an artifact of a public repository.
  const key = randomBytes(32);
  const token = `tok_${randomBytes(24).toString('base64url')}`;
  const testKey = { label: 'heygent-conformance', key };
  const peer = { origin: A, domain: 'heygent-staging.fly.dev', key: testKey, browsers: new Map([[ANN, { cookie: 'sid=s3cret' }]]) };
  const live = state();
  // What a careless refactor would put in the state: the runtime's people, agents and peers themselves.
  (live.people as unknown[]) = [
    { address: ANN, side: 'a', peer, agent: { address: ANN, token, peer } },
    { address: BOB, side: 'b', peer, agent: { address: BOB, token, peer } },
  ];
  (live.threads[0] as unknown as Record<string, unknown>).prepared = { references: {}, agent: { token } };
  (live as unknown as Record<string, unknown>).peers = { a: peer };
  const path = tempFile('state.json');
  saveState(path, live);
  const text = readFileSync(path, 'utf8');
  for (const secret of [
    token,
    key.toString('base64url'),
    key.toString('base64'),
    key.toString('hex'),
    `${testKey.label}:${key.toString('base64url')}`,
    JSON.stringify([...key]).slice(1, -1),
    's3cret',
  ]) {
    assert.ok(!text.includes(secret), `the state file holds a secret (${secret.slice(0, 8)}…)`);
  }
  assert.deepEqual(loadState(path, ORIGINS), state());
});

test('an error is logged by its code, never its message', () => {
  // Catches: logging an error's message, which for the driver's failures carries whole answers (approval links, bodies)
  // into the public workflow log.
  const failure = Object.assign(new Error(`approving https://heygent-staging.fly.dev/approve/apr_x: got {"token":"t"}`), { name: 'CaseFailure' });
  assert.equal(errorCode(failure), 'unexpected_answer');
  const api = Object.assign(new Error('parley: unavailable (HTTP 503)'), { name: 'ParleyError', code: 'unavailable', status: 503 });
  assert.equal(errorCode(api), 'api_unavailable_503');
  assert.equal(errorCode(new TypeError('fetch failed')), 'network');
  assert.equal(errorCode(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'timeout');
  const odd = Object.assign(new Error('x'), { name: 'ParleyError', code: 'Bearer abc', status: 401 });
  assert.equal(errorCode(odd), 'api_401');
});

// ------------------------------------------------------------------ the verdict

type View = Record<string, unknown>;

/** One person's view of a Plan thread as GET /test/v1/state gives it, from `who`'s side (the initiator's or the invitee's). */
function planView(who: 'initiator' | 'invitee', over: View = {}): View {
  const mine = (actor: 'initiator' | 'invitee') => (actor === who ? 'you' : 'them');
  const terms = { kind: 'coffee', slots: [{ start: '2026-10-25T10:00:00Z', duration_min: 60 }], place: 'none', price_cap_per_person: 'none' };
  return {
    template: 'plan@1',
    thread_id: 'thr_1',
    status: 'offered',
    state_version: 2,
    you: who,
    counterparty: who === 'initiator' ? BOB : ANN,
    pending_action: null,
    legal_moves: who === 'initiator' ? ['counter', 'accept', 'decline'] : ['withdraw'],
    move_descriptions: [],
    history: [
      { seq: 1, kind: 'move', move: 'propose', by: mine('initiator'), at: '2026-10-24T01:00:00.000Z' },
      { seq: 2, kind: 'move', move: 'counter', by: mine('invitee'), at: '2026-10-24T01:05:00.000Z' },
    ],
    open_offer: { command_id: 'cmd_2', maker: 'invitee', by: mine('invitee'), terms, expires_at: '2026-10-25T09:00:00.000Z' },
    agreed: null,
    ...over,
  };
}

function connectView(who: 'requester' | 'recipient'): View {
  return {
    template: 'connect@1',
    thread_id: 'thr_c',
    status: 'connected',
    state_version: 2,
    you: who,
    counterparty: who === 'requester' ? BOB : ANN,
    pending_action: null,
    legal_moves: ['disconnect'],
    move_descriptions: [],
    history: [
      { seq: 1, kind: 'move', move: 'request', by: who === 'requester' ? 'you' : 'them', at: '2026-10-24T00:01:00.000Z' },
      { seq: 2, kind: 'move', move: 'accept', by: who === 'requester' ? 'them' : 'you', at: '2026-10-24T00:02:00.000Z' },
    ],
    open_offer: null,
    agreed: null,
    wants: ['plan@1'],
    request: null,
  };
}

const DOMAINS = { a: 'heygent-staging.fly.dev', b: 'parley-peer-staging.fly.dev' };
const noAlerts = { a: [], b: [] };

function views(annThreads: View[], bobThreads: View[]) {
  return { [ANN]: annThreads, [BOB]: bobThreads };
}

test('the verdict passes when both servers show every shared thread alike', () => {
  // Each side's view is written from its own person's seat (you/them, its own legal moves), so this also catches a
  // comparison that is too strict to ever pass on two real servers.
  const v = judge(state(), { domains: DOMAINS, views: views([connectView('requester'), planView('initiator')], [connectView('recipient'), planView('invitee')]), alerts: noAlerts });
  assert.deepEqual(v.problems, []);
  assert.equal(v.threads, 2);
});

test('the verdict fails, naming the thread, when the two servers disagree on its state', () => {
  // Catches: a delivery lost in a partition or a restart, which leaves the remote side a version behind for good.
  const behind = planView('invitee', { status: 'offered', state_version: 1, history: planView('invitee').history!.slice(0, 1) as never });
  const ahead = planView('initiator', { status: 'agreed', state_version: 3, open_offer: null });
  const v = judge(state(), { domains: DOMAINS, views: views([connectView('requester'), ahead], [connectView('recipient'), behind]), alerts: noAlerts });
  assert.equal(v.problems.length, 1, v.problems.join('\n'));
  assert.match(v.problems[0]!, /^thread thr_1: status agreed v3 on heygent-staging\.fly\.dev, offered v1 on parley-peer-staging\.fly\.dev/);

  // The same status and version but a different history (an event applied in another order) fails too.
  const swapped = planView('invitee');
  (swapped.history as View[])[1]!.by = 'them';
  const w = judge(state(), { domains: DOMAINS, views: views([connectView('requester'), planView('initiator')], [connectView('recipient'), swapped]), alerts: noAlerts });
  assert.equal(w.problems.length, 1, w.problems.join('\n'));
  assert.match(w.problems[0]!, /^thread thr_1: the two views differ \(history\)/);
});

test('the verdict fails on a thread one server still owes something on, or lacks', () => {
  // Catches: a cancellation stuck in a server's outbox (pending_action stays set after the quiet period), and a thread
  // that never reached the other side at all.
  const owing = planView('invitee', { pending_action: 'cancellation' });
  const v = judge(state(), { domains: DOMAINS, views: views([connectView('requester'), planView('initiator')], [connectView('recipient'), owing]), alerts: noAlerts });
  assert.deepEqual(v.problems, ['thread thr_1: parley-peer-staging.fly.dev still owes a cancellation']);

  const missing = judge(state(), { domains: DOMAINS, views: views([connectView('requester'), planView('initiator')], [connectView('recipient')]), alerts: noAlerts });
  assert.deepEqual(missing.problems, ['thread thr_1: on heygent-staging.fly.dev but not on parley-peer-staging.fly.dev']);

  // A propose the remote side submitted while its coordinator was unreachable, applied on neither: its command is stuck.
  const submitted = state({ threads: [{ thread_id: 'thr_9', initiator: BOB, invitee: ANN, applied: false, done: false }] });
  const lost = judge(submitted, { domains: DOMAINS, views: views([connectView('requester')], [connectView('recipient')]), alerts: noAlerts });
  assert.deepEqual(lost.problems, ['thread thr_9: a propose submitted from parley-peer-staging.fly.dev never reached its coordinator']);
});

test('the verdict fails on an alert raised during the soak, and only notes one that was open before it', () => {
  // Catches: a server that raised an operator alert (a stopped reconciliation, a refused timer) under faults.
  const before = state({ alerts_at_start: [{ side: 'a', kind: 'deletion_pending', subject: 'tmb_1' }] });
  const alerts = {
    a: [{ kind: 'deletion_pending', subject: 'tmb_1', raised_at: '2026-10-20T00:00:00.000Z' }],
    b: [{ kind: 'reconcile_stopped', subject: 'thr_1', raised_at: '2026-10-24T03:00:00.000Z' }],
  };
  const v = judge(before, { domains: DOMAINS, views: views([connectView('requester'), planView('initiator')], [connectView('recipient'), planView('invitee')]), alerts });
  assert.deepEqual(v.problems, ['alert reconcile_stopped thr_1 open on parley-peer-staging.fly.dev (raised 2026-10-24T03:00:00.000Z)']);
  assert.deepEqual(v.notes, ['alert deletion_pending tmb_1 on heygent-staging.fly.dev was already open when the soak began']);

  // Alerts that could not be read are not a pass.
  const unread = judge(state(), { domains: DOMAINS, views: views([connectView('requester'), planView('initiator')], [connectView('recipient'), planView('invitee')]), alerts: { a: [], b: null } });
  assert.deepEqual(unread.problems, ['could not read the open alerts on parley-peer-staging.fly.dev']);
});

// ------------------------------------------------------------------ what the soak must have done

test('the verdict fails a soak that made no restarts, no partition, or too few moves', () => {
  // Catches: a soak that "passes" without having tested anything: restarts refused or never completed for one app, a
  // pause that always failed, a scenario that mostly errored.
  const apps = ['heygent-staging', 'parley-peer-staging'];
  const did = { applied: 2_500, partitions_healed: 30, 'restarted:heygent-staging': 9, 'restarted:parley-peer-staging': 11 };
  assert.deepEqual(coverage(state({ counts: did }), apps), []);
  assert.deepEqual(coverage(state({ counts: { ...did, 'restarted:parley-peer-staging': 0 } }), apps), ['0 machine restarts of parley-peer-staging completed; at least 1 expected']);
  assert.deepEqual(coverage(state({ counts: { ...did, partitions_healed: 0, applied: 400 } }), apps), [
    `only 400 moves were applied; a full soak applies at least ${MINIMUMS.applied}`,
    '0 partitions were made and healed; at least 1 expected',
  ]);
  // A token flyctl refuses makes the run visibly incomplete, whatever else happened.
  const refused = coverage(state({ restarts_unavailable: 'flyctl_not_permitted', counts: { ...did, 'restarted:heygent-staging': 0, 'restarted:parley-peer-staging': 0 } }), apps);
  assert.equal(refused[0], "machine restarts are not possible with the apps' deploy tokens (flyctl_not_permitted)");
  assert.equal(refused.length, 3);
});

// ------------------------------------------------------------------ the run, with a stand-in driver

/** A stand-in for the conformance driver's Peer: it records the test-interface calls the soak makes. */
function fakeDriver(hooks: { calls: string[]; offset?: (domain: string, n: number) => number; settled?: () => Promise<unknown> }) {
  class Peer {
    origin: string;
    domain: string;
    offset = 0;
    syncs = 0;
    constructor(spec: { origin: string }) {
      this.origin = spec.origin;
      this.domain = new URL(spec.origin).hostname;
    }
    async syncClock() {
      this.offset = hooks.offset?.(this.domain, this.syncs++) ?? 0;
    }
    pause(on: boolean) {
      hooks.calls.push(`${this.domain} pause ${on}`);
      return Promise.resolve();
    }
    async alerts() {
      return [];
    }
    async state() {
      return { threads: [] };
    }
    async connectAgent() {
      return { api: { prepare: async () => ({ status: 'prepared', thread_id: 'thr_new', role: 'initiator', state_version: 0, references: {}, legal_moves: ['propose'] }) } };
    }
  }
  const flows = {
    person: async () => assert.fail('no setup when resuming'),
    connect: async () => assert.fail('no setup when resuming'),
    moveFrom: async () => ({ status: 'applied' }),
    settled: async (_p: unknown, answer: unknown) => (hooks.settled === undefined ? answer : hooks.settled()),
    terms: () => ({}),
  };
  return { Peer, flows } as never;
}

function options(driver: never, over: Record<string, unknown> = {}) {
  const lines: string[] = [];
  let stopped = false;
  const stoppers: (() => void)[] = [];
  return {
    lines,
    stop: () => {
      stopped = true;
      for (const fn of stoppers) fn();
    },
    o: {
      a: { app: 'heygent-staging' as const, origin: A, key: { label: 'x', key: Buffer.alloc(32) } },
      b: { app: 'parley-peer-staging' as const, origin: B, key: { label: 'x', key: Buffer.alloc(32) } },
      driver,
      fetch: (() => assert.fail('no network')) as never,
      statePath: tempFile('state.json'),
      state: state({ threads: [] }),
      minutes: 5,
      final: false,
      restart: null,
      restartUnavailable: 'no tokens in this test',
      timing: { ...TIMING, tickMs: 2, faultMs: [0, 0] as [number, number], partitionMs: [600_000, 600_000] as [number, number], faultFreeTailMs: 0, clockSyncMs: 0 },
      log: () => undefined,
      print: (line: string) => lines.push(line),
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))),
      stopped: () => stopped,
      onStop: (fn: () => void) => stoppers.push(fn),
      random: () => 0.9,
      ...over,
    },
  };
}

test('a soak told to stop mid-partition resumes both servers at once, before its move in flight finishes', async () => {
  // Catches: a cancelled job leaving staging cut off (pause_outbound held in memory) because the soak waited on a hung
  // request, or never got as far as its own clean-up.
  const calls: string[] = [];
  let release!: () => void;
  let run!: ReturnType<typeof options>;
  const driver = fakeDriver({
    calls,
    // The move hangs; the job is cancelled meanwhile.
    settled: () => {
      run.stop();
      return new Promise((r) => (release = () => r({ status: 'applied' })));
    },
  });
  run = options(driver);
  const done = runSoak(run.o as never);
  await new Promise((r) => setTimeout(r, 50));
  // The partition (random 0.9 picks both sides) is in place, the move is hanging, and both are already resumed.
  assert.deepEqual(calls.slice(-4), ['heygent-staging.fly.dev pause true', 'parley-peer-staging.fly.dev pause true', 'heygent-staging.fly.dev pause false', 'parley-peer-staging.fly.dev pause false']);
  release();
  assert.equal(await done, 0);
  assert.equal(calls.at(-1), 'parley-peer-staging.fly.dev pause false');
  assert.ok(!calls.slice(calls.lastIndexOf('parley-peer-staging.fly.dev pause true') + 1).some((c) => c.endsWith('true')));
});

test('a soak whose server clock is moved under it fails, naming the server, and says so in the verdict', async () => {
  // Catches: conformance (which moves both clocks about 8 days) running during a soak unseen: offers would lapse, tokens
  // expire, and a result still be reported.
  const calls: string[] = [];
  const driver = fakeDriver({ calls, offset: (domain, n) => (domain === 'parley-peer-staging.fly.dev' && n >= 2 ? 8 * 86_400_000 : 0) });
  const run = options(driver, { final: true, timing: { ...TIMING, tickMs: 2, faultMs: [3_600_000, 3_600_000], clockSyncMs: 0, quiesceMs: 0 } });
  assert.equal(await runSoak(run.o as never), 1);
  assert.ok(run.lines.includes('FAIL the clock of parley-peer-staging.fly.dev moved 691200 s between two reads: something else moved it (conformance?)'), run.lines.join('\n'));
  assert.match(run.lines.at(-1)!, /^soak: FAIL/);
  // The failure is kept in the scenario, so a later slice's verdict still reports it.
  assert.equal(JSON.parse(readFileSync(run.o.statePath, 'utf8')).failures.length, 1);
});

test('the verdict on real views: two servers that agree pass, a partition that kept a withdrawal from one side fails', () => {
  // Recorded from two real Parley servers (fixtures/soak-views.json): Connect, then Plan threads agreed, declined,
  // cancelled and open, each person's view from their own server. Catches: a comparison that real views never satisfy
  // (a field that differs by seat, a timestamp each server writes itself), or one too loose to see a missed event.
  const f = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/soak-views.json'), 'utf8'));
  const recorded = state({ a: `https://${f.domains.a}`, b: `https://${f.domains.b}`, people: f.people, pairs: f.pairs, threads: f.threads });
  const converged = judge(recorded, { domains: f.domains, views: f.converged, alerts: noAlerts });
  assert.deepEqual(converged.problems, []);
  assert.equal(converged.threads, 6);
  const diverged = judge(recorded, { domains: f.domains, views: f.diverged, alerts: noAlerts });
  assert.deepEqual(diverged.problems, [`thread ${f.withdrawn_while_partitioned}: status withdrawn v2 on alpha.test, offered v1 on beta.test`]);
});

// soak.ts: the staging pair's soak (Task 8 Step 6), run by soak.yml as five chained jobs of about 5 hours each.
//
//   soak.ts --parley <dir> --state <file> --minutes <n> [--new] [--final] [--a <origin>] [--b <origin>]
//   soak.ts --parley <dir> --release        (resume both servers' outbound calls, nothing else: after a cancel)
//
// People on both staging servers, each with an agent connected through the real OAuth ceremony, Connect across the
// two servers and then trade Plan moves (propose, counter, accept, decline, withdraw, cancel) on many threads, a move
// every 24 seconds or so. Meanwhile, at random intervals, the soak cuts one or both servers off (the test interface's
// pause_outbound, always resumed) or restarts one server's Fly machine. With --final it then resumes both, lets them
// settle, and judges: no thread stuck, no new alert open, both servers' views of every shared thread identical, and
// the soak itself did what it claims (enough moves applied, partitions healed, each app's machine restarted). A server
// clock moved under it (conformance moves them by days) fails it.
//
// --parley   a checkout of sainanee/parley at the staging image's revision, with the conformance package installed: the
//            soak drives the servers with that package's driver (packages/conformance/src/peer.ts and flows.ts).
// --state    the scenario: people, Connect pairs, Plan threads, counts. --new sets one up (the file must not exist);
//            otherwise it is resumed (it must). It is written as it changes, and never holds a test key or a token:
//            agents are connected again on resume, as their access tokens last an hour anyway.
// --minutes  how long this run may take, setup included (0: judge only).
// --a, --b   default to the staging pair, and nothing else is accepted.
//
// The keys come from the environment only: CONFORMANCE_HEYGENT_STAGING_KEY and CONFORMANCE_PEER_STAGING_KEY
// (`<label>:<base64url key>`), and FLY_TOKEN_HEYGENT_STAGING and FLY_TOKEN_PARLEY_PEER_STAGING, each app's deploy
// token, handed to flyctl alone (for `fly machine restart`). Without the Fly tokens the soak makes no restarts, and its
// verdict fails. Output: one JSON line per event; with --final, then `NOTE`/`FAIL` lines and a `soak: PASS|FAIL` summary.
// Exit: 0 done (with --final: passed), 1 failed or stalled, 2 refused (usage, a server not in the staging pair, a bad
// state file, a missing key).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain } from './servers.ts';

// ------------------------------------------------------------------ the staging pair, and nothing else

/** The only servers the soak touches: its apps, their origins, and where their keys come from. */
const STAGING = {
  'heygent-staging': { origin: 'https://heygent-staging.fly.dev', key: 'CONFORMANCE_HEYGENT_STAGING_KEY', fly: 'FLY_TOKEN_HEYGENT_STAGING' },
  'parley-peer-staging': { origin: 'https://parley-peer-staging.fly.dev', key: 'CONFORMANCE_PEER_STAGING_KEY', fly: 'FLY_TOKEN_PARLEY_PEER_STAGING' },
} as const;
export type StagingApp = keyof typeof STAGING;

/** A refusal before anything is touched: exit 2. */
export class Refusal extends Error {
  override name = 'Refusal';
}

const isStagingApp = (app: string): app is StagingApp => Object.hasOwn(STAGING, app);
const ONLY = `the soak runs only against ${STAGING['heygent-staging'].origin} and ${STAGING['parley-peer-staging'].origin}`;

/**
 * The staging app `origin` names: exactly `https://<staging app>.fly.dev`, with no port, path, query or credentials.
 * Anything else is refused, without repeating it (it might carry credentials).
 */
export function stagingApp(origin: string, what: string): StagingApp {
  let url: URL | null = null;
  try {
    url = new URL(origin);
  } catch {
    url = null;
  }
  const host = url?.hostname ?? '';
  const app = host.endsWith('.fly.dev') ? host.slice(0, -'.fly.dev'.length) : '';
  if (url === null || url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '' || !isStagingApp(app)) {
    throw new Refusal(`${what}: ${ONLY}`);
  }
  return app;
}

/** `app`, when it is one of the two staging apps (the only ones the soak restarts). */
export function assertStagingApp(app: string): StagingApp {
  if (!isStagingApp(app)) throw new Refusal(`restart: ${ONLY}`);
  return app;
}

// ------------------------------------------------------------------ the state file

export type Side = 'a' | 'b';

export interface SoakState {
  version: 1;
  /** The two servers' origins (--a, --b). */
  a: string;
  b: string;
  started_at: string;
  people: { address: string; side: Side }[];
  /** Each person on one side Connected with each on the other. */
  pairs: { a: string; b: string; connect_thread: string }[];
  /** Plan threads the soak started. `applied`: its propose was applied (false: submitted only). `done`: no longer moved. */
  threads: { thread_id: string; initiator: string; invitee: string; applied: boolean; done: boolean }[];
  /** Alerts already open when the soak began: noted at the end, not counted against it. */
  alerts_at_start: { side: Side; kind: string; subject: string }[];
  /** Why the soak can make no machine restarts (no Fly token, or flyctl refused the token), or null. */
  restarts_unavailable: string | null;
  /** Each server's clock offset (its time minus the runner's) at the last read, to catch anyone else moving it. */
  clock: { a: number | null; b: number | null };
  /** What already failed the soak (a clock moved under it): printed as FAIL by the verdict. */
  failures: string[];
  counts: Record<string, number>;
}

const COUNT_NAME = /^[a-z0-9_:.-]{1,80}$/;

/**
 * The state as written: field by field, from a whitelist, so nothing the runtime keeps beside it (agents and their
 * tokens, peers and their keys, browsers and their cookies) can reach the file, even if it ends up in the state.
 */
function plain(s: SoakState): SoakState {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    version: 1,
    a: str(s.a),
    b: str(s.b),
    started_at: str(s.started_at),
    people: s.people.map((p) => ({ address: str(p.address), side: p.side === 'b' ? 'b' : 'a' })),
    pairs: s.pairs.map((p) => ({ a: str(p.a), b: str(p.b), connect_thread: str(p.connect_thread) })),
    threads: s.threads.map((t) => ({ thread_id: str(t.thread_id), initiator: str(t.initiator), invitee: str(t.invitee), applied: t.applied === true, done: t.done === true })),
    alerts_at_start: s.alerts_at_start.map((x) => ({ side: x.side === 'b' ? 'b' : 'a', kind: str(x.kind), subject: str(x.subject) })),
    restarts_unavailable: typeof s.restarts_unavailable === 'string' ? s.restarts_unavailable : null,
    clock: { a: Number.isFinite(s.clock?.a) ? (s.clock.a as number) : null, b: Number.isFinite(s.clock?.b) ? (s.clock.b as number) : null },
    failures: (Array.isArray(s.failures) ? s.failures : []).filter((f) => typeof f === 'string' && /^[\x20-\x7e]{1,300}$/.test(f)),
    counts: Object.fromEntries(Object.entries(s.counts).filter(([k, v]) => COUNT_NAME.test(k) && Number.isSafeInteger(v))),
  };
}

/** Write the state to `path` (whole, or not at all: a job killed mid-write leaves the previous one). */
export function saveState(path: string, s: SoakState): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(plain(s), null, 1)}\n`);
  renameSync(tmp, path);
}

/** The state in `path`, which must be a soak of exactly `origins` (each checked by the staging guard). */
export function loadState(path: string, origins: { a: string; b: string }): SoakState {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Refusal(`${path}: not a soak state file`);
  }
  const list = (v: unknown) => (Array.isArray(v) ? v : null);
  if (raw?.version !== 1 || list(raw.people) === null || list(raw.pairs) === null || list(raw.threads) === null || list(raw.alerts_at_start) === null || typeof raw.counts !== 'object' || raw.counts === null) {
    throw new Refusal(`${path}: not a soak state file (version 1)`);
  }
  for (const side of ['a', 'b'] as const) {
    if (typeof raw[side] !== 'string' || STAGING[stagingApp(raw[side], `${path}: ${side}`)].origin !== origins[side]) {
      throw new Refusal(`${path}: a soak of other servers (${side})`);
    }
  }
  const s = plain(raw as SoakState);
  const domain = { a: new URL(s.a).hostname, b: new URL(s.b).hostname };
  for (const p of s.people) {
    if (!p.address.endsWith(`@${domain[p.side]}`)) throw new Refusal(`${path}: ${p.address} is not on ${domain[p.side]}`);
  }
  return s;
}

// ------------------------------------------------------------------ the verdict

type Json = Record<string, any>;
export interface Alert {
  kind: string;
  subject: string;
  raised_at?: string;
}

const OTHER_ROLE: Record<string, string> = { initiator: 'invitee', invitee: 'initiator', requester: 'recipient', recipient: 'requester' };

/**
 * What both servers must agree on in their people's views of one thread, written from neither seat: everything but the
 * person's own role, counterparty, legal moves and what their server still owes, with each history entry and the open
 * offer saying whose it is by role rather than `you`/`them`.
 */
function sharedPart(view: Json): Json {
  const { you, counterparty: _c, legal_moves: _l, move_descriptions: _d, pending_action: _p, history, open_offer, ...rest } = view;
  const role = (by: unknown) => (by === 'you' ? you : by === 'them' ? (OTHER_ROLE[String(you)] ?? '?') : by);
  const offer = open_offer === null || typeof open_offer !== 'object' ? open_offer : (({ by: _b, ...o }) => o)(open_offer);
  return { ...rest, open_offer: offer, history: Array.isArray(history) ? history.map((h: Json) => ({ ...h, by: role(h?.by) })) : history };
}

/** JSON with sorted keys: equal for equal values, whatever order the servers wrote them in. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Json)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'undefined';
}

export interface JudgeInput {
  domains: { a: string; b: string };
  /** Each soak person's threads (GET /test/v1/state on their own server), or null when they could not be read. */
  views: Record<string, Json[] | null>;
  /** Each server's open alerts, null when they could not be read; null altogether while settling (alerts not judged). */
  alerts: { a: Alert[] | null; b: Alert[] | null } | null;
}

/**
 * The verdict on what both servers show. A problem is: a thread one server has and the other lacks; a thread the two
 * show differently; a thread a server still owes a cancellation or a disconnect on; a propose that was submitted but
 * applied nowhere (stuck in its server's outbox, or refused when it arrived); an alert raised since the soak began.
 */
export function judge(s: SoakState, input: JudgeInput): { problems: string[]; notes: string[]; threads: number } {
  const problems: string[] = [];
  const notes: string[] = [];
  const sideOf = new Map(s.people.map((p) => [p.address, p.side] as const));
  const d = input.domains;
  const other = (x: Side): Side => (x === 'a' ? 'b' : 'a');

  // Every view, by thread and side; and who takes part in each thread on each side, as far as anything says.
  const seen = new Map<string, { a?: Json; b?: Json }>();
  const party = new Map<string, { a?: string; b?: string }>();
  const note = (id: string, who: string) => {
    const side = sideOf.get(who);
    if (side !== undefined) party.set(id, { ...party.get(id), [side]: who });
  };
  for (const p of s.people) {
    const list = input.views[p.address];
    if (list === null || list === undefined) {
      problems.push(`could not read ${p.address}'s threads on ${d[p.side]}`);
      continue;
    }
    for (const v of list) {
      const id = String(v.thread_id);
      seen.set(id, { ...seen.get(id), [p.side]: v });
      note(id, p.address);
      if (typeof v.counterparty === 'string') note(id, v.counterparty);
    }
  }
  const submitted = new Map<string, string>();
  for (const t of s.threads) {
    note(t.thread_id, t.initiator);
    note(t.thread_id, t.invitee);
    if (!t.applied) submitted.set(t.thread_id, t.initiator);
  }
  for (const p of s.pairs) {
    note(p.connect_thread, p.a);
    note(p.connect_thread, p.b);
  }
  const ids = [...new Set([...seen.keys(), ...s.threads.map((t) => t.thread_id), ...s.pairs.map((p) => p.connect_thread)])].sort();

  let compared = 0;
  for (const id of ids) {
    const both = seen.get(id) ?? {};
    // Only where the person's threads were read: an unreadable one is a problem already.
    const readable = (x: Side) => {
      const who = party.get(id)?.[x];
      return who !== undefined && Array.isArray(input.views[who]);
    };
    if (both.a === undefined && both.b === undefined) {
      if (!readable('a') || !readable('b')) continue;
      const from = submitted.get(id);
      problems.push(from !== undefined ? `thread ${id}: a propose submitted from ${d[sideOf.get(from) ?? 'b']} never reached its coordinator` : `thread ${id}: on neither server`);
      continue;
    }
    for (const x of ['a', 'b'] as const) {
      if (both[x] === undefined && both[other(x)] !== undefined && readable(x)) problems.push(`thread ${id}: on ${d[other(x)]} but not on ${d[x]}`);
    }
    for (const x of ['a', 'b'] as const) {
      const owed = both[x]?.pending_action;
      if (owed !== null && owed !== undefined) problems.push(`thread ${id}: ${d[x]} still owes a ${String(owed)}`);
    }
    if (both.a === undefined || both.b === undefined) continue;
    compared++;
    const [va, vb] = [both.a, both.b];
    if (va.status !== vb.status || va.state_version !== vb.state_version) {
      problems.push(`thread ${id}: status ${va.status} v${va.state_version} on ${d.a}, ${vb.status} v${vb.state_version} on ${d.b}`);
    } else if (OTHER_ROLE[String(va.you)] !== vb.you) {
      problems.push(`thread ${id}: ${d.a} has its person as ${va.you}, ${d.b} has its person as ${vb.you}`);
    } else {
      const [sa, sb] = [sharedPart(va), sharedPart(vb)];
      const differ = [...new Set([...Object.keys(sa), ...Object.keys(sb)])].filter((k) => canonical(sa[k]) !== canonical(sb[k])).sort();
      if (differ.length > 0) problems.push(`thread ${id}: the two views differ (${differ.join(', ')})`);
    }
  }

  if (input.alerts !== null) {
    for (const x of ['a', 'b'] as const) {
      const open = input.alerts[x];
      if (open === null) {
        problems.push(`could not read the open alerts on ${d[x]}`);
        continue;
      }
      for (const al of open) {
        const before = s.alerts_at_start.some((b) => b.side === x && b.kind === al.kind && b.subject === al.subject);
        if (before) notes.push(`alert ${al.kind} ${al.subject} on ${d[x]} was already open when the soak began`);
        else problems.push(`alert ${al.kind} ${al.subject} open on ${d[x]} (raised ${al.raised_at ?? '?'})`);
      }
    }
  }
  return { problems, notes, threads: compared };
}

/** What a whole soak must have done for its verdict to mean anything (about 2,700 moves are made in a full one). */
export const MINIMUMS = { applied: 1000, partitions: 1, restartsPerApp: 1 };

/**
 * What the soak failed to do: too few moves applied, no partition made and healed, no completed machine restart of each
 * staging app (or restarts impossible). A soak that did not do these has not tested what it claims, so each is a FAIL.
 */
export function coverage(s: SoakState, apps: readonly string[], min = MINIMUMS): string[] {
  const c = s.counts;
  const problems: string[] = [];
  if ((c.applied ?? 0) < min.applied) problems.push(`only ${c.applied ?? 0} moves were applied; a full soak applies at least ${min.applied}`);
  if ((c.partitions_healed ?? 0) < min.partitions) problems.push(`${c.partitions_healed ?? 0} partitions were made and healed; at least ${min.partitions} expected`);
  if (s.restarts_unavailable === 'flyctl_not_permitted') problems.push('machine restarts are not possible with the apps\' deploy tokens (flyctl_not_permitted)');
  else if (s.restarts_unavailable !== null) problems.push(`machine restarts were not possible (${s.restarts_unavailable})`);
  for (const app of apps) {
    const n = c[`restarted:${app}`] ?? 0;
    if (n < min.restartsPerApp) problems.push(`${n} machine restarts of ${app} completed; at least ${min.restartsPerApp} expected`);
  }
  return problems;
}

// ------------------------------------------------------------------ logging

/**
 * What an error is, as a code for the log: never its message, which for the driver's failures carries whole answers
 * (approval links, bodies), and for a fetch failure can carry the URL.
 */
export function errorCode(e: unknown): string {
  if (!(e instanceof Error)) return 'error';
  const any = e as Error & { code?: unknown; status?: unknown };
  if (e.name === 'ParleyError') {
    const status = Number.isInteger(any.status) ? `_${any.status as number}` : '';
    return typeof any.code === 'string' && /^[a-z_]{1,40}$/.test(any.code) ? `api_${any.code}${status}` : `api${status}`;
  }
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'timeout';
  if (e.name === 'CaseFailure') return 'unexpected_answer';
  if (e.name === 'RestartRefused' || e.name === 'RestartFailed') return e.message;
  if (e instanceof TypeError) return 'network';
  return 'error';
}

// ------------------------------------------------------------------ the soak

const MIN = 60_000;

export interface Timing {
  /** The mean pause between two moves (each pause is 0.5 to 1.5 times it): about three requests a move. */
  tickMs: number;
  /** How long between two faults, and how long a partition lasts (some outlast the 15-minute reconciliation cadence). */
  faultMs: [number, number];
  partitionMs: [number, number];
  /** No new fault this close to the end of a run, so a restart in flight finishes inside it. */
  faultFreeTailMs: number;
  /** Connect an agent again this long after its consent: access tokens last an hour. */
  reconnectMs: number;
  /** Read the servers' clocks again this often (a test-interface call is dated by its server's clock). */
  clockSyncMs: number;
  /** Fail when no move has been answered for this long. */
  stallMs: number;
  /** With --final: how long the servers get to settle, and how often to look meanwhile. */
  quiesceMs: number;
  quiescePollMs: number;
  /** Setup's waits (a Connect request reaching the other side). */
  eventuallyMs: number;
  pollMs: number;
}

export const TIMING: Timing = {
  tickMs: 24_000,
  faultMs: [10 * MIN, 40 * MIN],
  partitionMs: [1 * MIN, 20 * MIN],
  faultFreeTailMs: 10 * MIN,
  reconnectMs: 50 * MIN,
  clockSyncMs: 5 * MIN,
  stallMs: 30 * MIN,
  quiesceMs: 40 * MIN,
  quiescePollMs: 1 * MIN,
  eventuallyMs: 3 * MIN,
  pollMs: 2_000,
};

/** The servers' clocks may be at most this far apart (as the conformance runner holds them): federation's window. */
const MAX_CLOCK_GAP_MS = 60_000;
/** A server's clock may move this far against the runner's between two reads; more means someone moved it. */
const MAX_CLOCK_JUMP_MS = 60_000;
/** The soak keeps at most this many unfinished Plan threads per pair (the coordinator allows 5 open, reservations included). */
const MAX_OPEN_PER_PAIR = 3;
/**
 * And starts at most this many Plan threads per pair in all, so the verdict's reads stay modest: at most 1,080 Plan
 * threads, about 360 per person (GET /test/v1/state reads each person's threads one by one). At one move every 24 s a
 * full soak starts about 830 (at most about 110 on one pair, by a simulation of this mix), so the cap rarely binds.
 */
const MAX_PLAN_THREADS_PER_PAIR = 120;
/** A pair with fewer than MAX_OPEN_PER_PAIR unfinished threads starts another on this share of its turns (always at none). */
const PROPOSE_WHILE_OPEN = 0.1;
/** How likely each legal move is chosen, when the person may make it: counters first, so threads run a few moves. */
const WEIGHTS: Record<string, number> = { counter: 5, accept: 2, decline: 1, withdraw: 1, cancel: 1 };
/** An agreed plan is cancelled on this share of visits; on the others it is left agreed (and no longer moved). */
const CANCEL_AGREED = 0.3;
/** The maker of an open offer, picked to move, withdraws it on this share of turns (and otherwise passes). */
const WITHDRAW_OWN = 0.3;

export interface TestPeer {
  label: string;
  key: Buffer;
}
type Restarter = (app: StagingApp) => Promise<void>;

/** What the soak takes from the conformance driver (packages/conformance/src at the staging image's revision). */
export interface Driver {
  Peer: new (spec: { origin: string; key: TestPeer }, env: { fetch: typeof fetch; defer(fn: () => unknown): void }) => any;
  flows: {
    person(peer: any, prefix: string): Promise<{ address: string; peer: any; agent: any }>;
    connect(ctx: any, requester: any, recipient: any): Promise<string>;
    moveFrom(p: any, ask: object, from: object, move: string, payload: unknown): Promise<Json>;
    settled(p: any, answer: Json): Promise<Json>;
    terms(peer: any): Json;
  };
}

export interface SoakOptions {
  /** The two servers, as the command line checked them (the staging guard): app, origin and test key. */
  a: { app: StagingApp; origin: string; key: TestPeer };
  b: { app: StagingApp; origin: string; key: TestPeer };
  driver: Driver;
  fetch: typeof fetch;
  statePath: string;
  /** The state to resume, or null to set one up. */
  state: SoakState | null;
  minutes: number;
  final: boolean;
  restart: Restarter | null;
  /** Why `restart` is null. */
  restartUnavailable: string | null;
  timing: Timing;
  log(event: string, fields?: Json): void;
  print(line: string): void;
  sleep(ms: number): Promise<void>;
  stopped(): boolean;
  /** Register what to do at once when the run is told to stop (before any in-flight call finishes). */
  onStop(fn: () => void): void;
  /** What the verdict requires the soak to have done (MINIMUMS unless a test says otherwise). */
  minimums?: typeof MINIMUMS;
  random?: () => number;
}

/** Something under the soak went wrong in a way that fails it (a clock moved): the run stops trading moves. */
export class SoakFailed extends Error {
  override name = 'SoakFailed';
}

/** The soak itself: setup or resume, the moves and faults until its time is up, and with `final` the verdict. */
export async function runSoak(o: SoakOptions): Promise<number> {
  const T = o.timing;
  const random = o.random ?? Math.random;
  const between = ([lo, hi]: [number, number]) => lo + random() * (hi - lo);
  const pick = <X>(xs: readonly X[]): X => xs[Math.floor(random() * xs.length)]!;
  const startedAt = Date.now();
  const deadline = startedAt + o.minutes * MIN;
  const sides = ['a', 'b'] as const;
  const env = { fetch: o.fetch, defer: () => undefined };
  const specs = { a: { origin: o.a.origin, key: o.a.key }, b: { origin: o.b.origin, key: o.b.key } };
  const peers: Record<Side, any> = { a: new o.driver.Peer(specs.a, env), b: new o.driver.Peer(specs.b, env) };
  const domains = { a: peers.a.domain as string, b: peers.b.domain as string };
  const apps = { a: o.a.app, b: o.b.app };
  let s = o.state;
  const save = () => {
    if (s !== null) saveState(o.statePath, s);
  };
  const count = (...names: string[]) => {
    if (s === null) return;
    for (const n of names) s.counts[n] = (s.counts[n] ?? 0) + 1;
  };

  // ---- the servers' clocks: read (never moved), in step, and not moved by anyone else (conformance does, by days).
  const lastOffset = { a: s?.clock.a ?? null, b: s?.clock.b ?? null };
  const syncClocks = async () => {
    for (const x of sides) await peers[x].syncClock();
    const jumped: string[] = [];
    for (const x of sides) {
      const now = peers[x].offset as number;
      const was = lastOffset[x];
      if (was !== null && Math.abs(now - was) > MAX_CLOCK_JUMP_MS) {
        jumped.push(`the clock of ${domains[x]} moved ${Math.round((now - was) / 1000)} s between two reads: something else moved it (conformance?)`);
      }
      lastOffset[x] = now;
    }
    if (s !== null) s.clock = { ...lastOffset };
    if (jumped.length > 0) {
      s?.failures.push(...jumped);
      save();
      throw new SoakFailed(jumped.join('; '));
    }
    const gap = Math.abs(peers.a.offset - peers.b.offset);
    if (gap > MAX_CLOCK_GAP_MS) throw new Refusal(`the staging servers' clocks are ${Math.round(gap / 1000)} s apart: run conformance (it puts them in step) first`);
  };
  const resume = async (x: Side) => {
    for (let i = 0; ; i++) {
      try {
        await peers[x].pause(false);
        return true;
      } catch (e) {
        if (i >= 4) {
          o.log('error', { op: 'resume', side: x, code: errorCode(e) });
          return false;
        }
        await o.sleep(5_000);
      }
    }
  };

  // ---- agents: connected through the real ceremony when first needed, and again before their token runs out.
  const agents = new Map<string, { agent: any; at: number }>();
  const sideOf = (address: string): Side => (s?.people.find((p) => p.address === address)?.side ?? (address.endsWith(`@${domains.a}`) ? 'a' : 'b'));
  const personOf = async (address: string) => {
    const side = sideOf(address);
    const live = agents.get(address);
    if (live !== undefined && Date.now() - live.at < T.reconnectMs) return { address, peer: peers[side], agent: live.agent };
    let agent;
    try {
      agent = await peers[side].connectAgent(address);
    } catch {
      // A fresh driver for that server (a new browser, signed in again) and one more try.
      peers[side] = new o.driver.Peer(specs[side], env);
      await peers[side].syncClock();
      agent = await peers[side].connectAgent(address);
    }
    agents.set(address, { agent, at: Date.now() });
    o.log('agent_connected', { side, address });
    return { address, peer: peers[side], agent };
  };

  const eventually = async <X>(what: string, probe: () => Promise<X | null | undefined | false>): Promise<X> => {
    const until = Date.now() + T.eventuallyMs;
    for (;;) {
      try {
        const v = await probe();
        if (v) return v;
      } catch {
        // looked again below
      }
      if (Date.now() > until || o.stopped()) throw Object.assign(new Error(`${what}: not in time`), { name: 'CaseFailure' });
      await o.sleep(T.pollMs);
    }
  };

  // ---- setup: three people a side, every cross-server pair Connected.
  const setUp = async (): Promise<SoakState> => {
    const fresh: SoakState = {
      version: 1,
      a: o.a.origin,
      b: o.b.origin,
      started_at: new Date().toISOString(),
      people: [],
      pairs: [],
      threads: [],
      alerts_at_start: [],
      restarts_unavailable: o.restartUnavailable,
      clock: { ...lastOffset },
      failures: [],
      counts: {},
    };
    for (const x of sides) for (const al of (await peers[x].alerts()) as Alert[]) fresh.alerts_at_start.push({ side: x, kind: al.kind, subject: al.subject });
    s = fresh;
    for (let i = 0; i < 3; i++) {
      for (const x of sides) {
        const p = await o.driver.flows.person(peers[x], 'soak');
        agents.set(p.address, { agent: p.agent, at: Date.now() });
        fresh.people.push({ address: p.address, side: x });
        o.log('person', { side: x, address: p.address });
        save();
      }
    }
    const of = (x: Side) => fresh.people.filter((p) => p.side === x).map((p) => p.address);
    const [as, bs] = [of('a'), of('b')];
    for (let i = 0; i < as.length; i++) {
      for (let j = 0; j < bs.length; j++) {
        // Requests from both sides, alternately.
        const [req, rec] = (i + j) % 2 === 0 ? [as[i]!, bs[j]!] : [bs[j]!, as[i]!];
        const thread = await o.driver.flows.connect({ eventually }, await personOf(req), await personOf(rec));
        fresh.pairs.push({ a: as[i]!, b: bs[j]!, connect_thread: thread });
        o.log('connected', { requester: req, recipient: rec, thread_id: thread });
        save();
      }
    }
    return fresh;
  };

  // ---- moves
  let acting: string | null = null;
  const plan = (counterparty: string, thread_id?: string) => ({ template: 'plan@1', counterparty, ...(thread_id === undefined ? {} : { thread_id }) });
  const outcomeOf = (r: Json) => (r.status === 'rejected' && typeof r.code === 'string' ? `rejected_${r.code}` : String(r.status));
  const moved = (move: string, side: Side, thread_id: string, outcome: string) => {
    count('moves', `move:${move}:${outcome}`, ...(outcome === 'applied' ? ['applied'] : []));
    o.log('move', { move, side, thread_id, outcome });
  };

  const propose = async (pair: SoakState['pairs'][number]) => {
    const [from, to] = random() < 0.5 ? [pair.a, pair.b] : [pair.b, pair.a];
    acting = from;
    const p = await personOf(from);
    const prep = await p.agent.api.prepare(plan(to));
    if (prep.status !== 'prepared') {
      moved('propose', sideOf(from), '-', `prepare_${prep.status}`);
      return;
    }
    const outcome = await o.driver.flows.settled(p, await o.driver.flows.moveFrom(p, { template: 'plan@1', counterparty: to }, prep, 'propose', o.driver.flows.terms(p.peer)));
    if (outcome.status === 'applied' || outcome.status === 'submitted') {
      s!.threads.push({ thread_id: prep.thread_id, initiator: from, invitee: to, applied: outcome.status === 'applied', done: false });
    }
    moved('propose', sideOf(from), prep.thread_id, outcomeOf(outcome));
  };

  const moveOn = async (t: SoakState['threads'][number]) => {
    let movable = false;
    for (const who of random() < 0.5 ? [t.initiator, t.invitee] : [t.invitee, t.initiator]) {
      const to = who === t.initiator ? t.invitee : t.initiator;
      acting = who;
      const p = await personOf(who);
      const prep = await p.agent.api.prepare(plan(to, t.thread_id));
      if (prep.status !== 'prepared') {
        moved('-', sideOf(who), t.thread_id, `prepare_${prep.status}`);
        return;
      }
      const moves = (prep.legal_moves as string[]).filter((m) => Object.hasOwn(WEIGHTS, m));
      if (moves.length === 0) continue;
      movable = true;
      // The maker of an open offer may only withdraw it: mostly leave the turn to the other side.
      if (moves.length === 1 && moves[0] === 'withdraw' && random() >= WITHDRAW_OWN) continue;
      if (moves.length === 1 && moves[0] === 'cancel' && random() >= CANCEL_AGREED) {
        t.done = true;
        o.log('thread_done', { thread_id: t.thread_id, left: 'agreed' });
        return;
      }
      let roll = random() * moves.reduce((n, m) => n + WEIGHTS[m]!, 0);
      const move = moves.find((m) => (roll -= WEIGHTS[m]!) < 0) ?? moves[moves.length - 1]!;
      const payload = move === 'counter' ? o.driver.flows.terms(p.peer) : move === 'accept' ? { slot_index: 0 } : {};
      const outcome = await o.driver.flows.settled(p, await o.driver.flows.moveFrom(p, { template: 'plan@1', counterparty: to }, prep, move, payload));
      if (t.applied === false && outcome.status === 'applied') t.applied = true;
      moved(move, sideOf(who), t.thread_id, outcomeOf(outcome));
      return;
    }
    if (movable) return;
    // Neither may move: the coordinator has the thread ended.
    t.applied = true;
    t.done = true;
    o.log('thread_done', { thread_id: t.thread_id, left: 'ended' });
  };

  const samePair = (t: SoakState['threads'][number], p: SoakState['pairs'][number]) => (t.initiator === p.a && t.invitee === p.b) || (t.initiator === p.b && t.invitee === p.a);
  /** One move on a random pair that has one left to make; false when no pair has (every one at its cap, all ended). */
  const tick = async (): Promise<boolean> => {
    const state = s!;
    const live = state.pairs
      .map((pair) => {
        const mine = state.threads.filter((t) => samePair(t, pair));
        return { pair, open: mine.filter((t) => !t.done), full: mine.length >= MAX_PLAN_THREADS_PER_PAIR };
      })
      .filter((x) => !x.full || x.open.length > 0);
    if (live.length === 0) return false;
    const { pair, open, full } = pick(live);
    if (!full && open.length < MAX_OPEN_PER_PAIR && (open.length === 0 || random() < PROPOSE_WHILE_OPEN)) await propose(pair);
    else await moveOn(pick(open));
    return true;
  };

  // ---- faults
  let partition: { sides: Side[]; until: number } | null = null;
  let restarting: Promise<void> | null = null;
  const heal = async () => {
    const p = partition!;
    const left: Side[] = [];
    for (const x of p.sides) if (!(await resume(x))) left.push(x);
    partition = left.length === 0 ? null : { sides: left, until: Date.now() + MIN };
    if (left.length === 0) count('partitions_healed');
    o.log('heal', { sides: p.sides.filter((x) => !left.includes(x)).join(',') });
  };
  const fault = async () => {
    const kinds = ['partition_a', 'partition_b', 'partition_both', ...(o.restart !== null && s!.restarts_unavailable === null ? ['restart_a', 'restart_b'] : [])];
    const kind = pick(kinds);
    if (kind.startsWith('partition')) {
      const cut: Side[] = kind === 'partition_both' ? ['a', 'b'] : [kind.endsWith('_a') ? 'a' : 'b'];
      const ms = Math.round(between(T.partitionMs));
      const done: Side[] = [];
      for (const x of cut) {
        try {
          await peers[x].pause(true);
          done.push(x);
        } catch (e) {
          count('errors', 'error:pause');
          o.log('error', { op: 'pause', side: x, code: errorCode(e) });
        }
      }
      if (done.length === 0) return;
      partition = { sides: done, until: Date.now() + ms };
      count('faults', `fault:${kind}`);
      o.log('fault', { kind, sides: done.join(','), seconds: Math.round(ms / 1000) });
      return;
    }
    const x: Side = kind.endsWith('_a') ? 'a' : 'b';
    const app = apps[x];
    count('faults', `fault:${kind}`);
    o.log('fault', { kind: 'restart', app });
    restarting = o
      .restart!(app)
      .then(() => {
        count('restarts', `restarted:${app}`);
        o.log('restarted', { app });
      })
      .catch((e: unknown) => {
        count('restart_failures');
        const code = errorCode(e);
        o.log('restart_failed', { app, code });
        // Only a refusal (the token may not restart, no flyctl) stops restarts for good, and fails the verdict; anything
        // else is tried again at a later fault.
        if ((e as Error)?.name === 'RestartRefused') {
          s!.restarts_unavailable = code;
          o.log('restarts_disabled', { reason: code });
        }
      })
      .finally(() => {
        restarting = null;
        save();
      });
  };

  // ---- reading both servers, and the verdict
  const readViews = async (when: string) => {
    const started = Date.now();
    const views: Record<string, Json[] | null> = {};
    for (const p of s!.people) {
      try {
        views[p.address] = (await peers[p.side].state(p.address)).threads as Json[];
      } catch (e) {
        o.log('error', { op: 'state', side: p.side, code: errorCode(e) });
        views[p.address] = null;
      }
    }
    const lists = Object.values(views);
    o.log('state_read', {
      when,
      threads: lists.reduce((n, l) => n + (l?.length ?? 0), 0),
      most_for_one_person: Math.max(0, ...lists.map((l) => l?.length ?? 0)),
      unread: lists.filter((l) => l === null).length,
      bytes: JSON.stringify(views).length,
      ms: Date.now() - started,
    });
    return views;
  };
  const verdict = async (): Promise<number> => {
    if (s === null) {
      o.print('FAIL no soak state: the soak never set up, or its state was lost');
      o.print('soak: FAIL');
      return 1;
    }
    const problems: string[] = [];
    for (const x of sides) if (!(await resume(x))) problems.push(`could not resume ${domains[x]}: it may still be cut off`);
    const until = Date.now() + T.quiesceMs;
    let views = await readViews('settling');
    for (;;) {
      const settling = judge(s, { domains, views, alerts: null });
      if (settling.problems.length === 0 || Date.now() >= until || o.stopped()) break;
      o.log('settling', { problems: settling.problems.length });
      await o.sleep(T.quiescePollMs);
      views = await readViews('settling');
    }
    const alerts = { a: null as Alert[] | null, b: null as Alert[] | null };
    for (const x of sides) {
      try {
        alerts[x] = (await peers[x].alerts()) as Alert[];
      } catch (e) {
        o.log('error', { op: 'alerts', side: x, code: errorCode(e) });
      }
    }
    const v = judge(s, { domains, views, alerts });
    problems.push(...s.failures, ...coverage(s, [apps.a, apps.b], o.minimums ?? MINIMUMS), ...v.problems);
    for (const n of v.notes) o.print(`NOTE ${n}`);
    for (const p of problems) o.print(`FAIL ${p}`);
    const c = s.counts;
    const what = `${v.threads} threads shared by the two servers; ${c.applied ?? 0} moves applied of ${c.moves ?? 0}, ${c.partitions_healed ?? 0} partitions, ${c.restarts ?? 0} machine restarts (${apps.a} ${c[`restarted:${apps.a}`] ?? 0}, ${apps.b} ${c[`restarted:${apps.b}`] ?? 0}), ${c.errors ?? 0} errors, since ${s.started_at}`;
    o.print(problems.length === 0 ? `soak: PASS: ${what}; every thread identical on both, none stuck, no new alert` : `soak: FAIL: ${problems.length} problem(s); ${what}`);
    return problems.length === 0 ? 0 : 1;
  };

  // ---- the run
  // Told to stop (a cancelled job): resume both servers at once, before waiting for anything in flight.
  o.onStop(() => {
    o.log('stopping');
    for (const x of sides) {
      peers[x].pause(false).then(
        () => o.log('resumed_on_stop', { side: x }),
        (e: unknown) => o.log('error', { op: 'resume', side: x, code: errorCode(e) }),
      );
    }
  });
  if (s === null && o.minutes === 0) return o.final ? verdict() : 0;

  let failed = false;
  try {
    // A server may still be coming back from a restart the last slice made.
    for (let i = 0; ; i++) {
      try {
        await syncClocks();
        break;
      } catch (e) {
        if (e instanceof Refusal || e instanceof SoakFailed || i >= 5) throw e;
        o.log('error', { op: 'clock', code: errorCode(e) });
        await o.sleep(20_000);
      }
    }
    for (const x of sides) await resume(x);
    if (s === null && o.minutes > 0) {
      s = await setUp();
      o.log('set_up', { people: s.people.length, pairs: s.pairs.length });
    } else if (s !== null) {
      o.log('resumed', { people: s.people.length, pairs: s.pairs.length, threads: s.threads.length });
    }
    if (s !== null && o.restart === null && s.restarts_unavailable === null) s.restarts_unavailable = o.restartUnavailable ?? 'no restarter';
    if (s?.restarts_unavailable) o.log('restarts_unavailable', { reason: s.restarts_unavailable });
    if (s !== null && s.pairs.length === 0 && !s.failures.includes('the soak set up no Connect pair')) s.failures.push('the soak set up no Connect pair');

    if (s !== null && s.pairs.length > 0 && o.minutes > 0) {
      let nextFault = Date.now() + between(T.faultMs);
      let lastSync = Date.now();
      let lastAnswer = Date.now();
      let idle = false;
      while (!o.stopped() && Date.now() < deadline) {
        const now = Date.now();
        try {
          if (partition !== null && now >= partition.until) await heal();
          if (partition === null && restarting === null && now >= nextFault && deadline - now > T.faultFreeTailMs) {
            await fault();
            nextFault = now + between(T.faultMs);
          }
          if (now - lastSync >= T.clockSyncMs) {
            lastSync = now;
            await syncClocks();
          }
          acting = null;
          const moved = await tick();
          if (!moved && !idle) o.log('every_pair_at_its_cap');
          idle = !moved;
          lastAnswer = Date.now();
        } catch (e) {
          if (e instanceof Refusal || e instanceof SoakFailed) throw e;
          const code = errorCode(e);
          count('errors', `error:${code}`);
          o.log('error', { op: 'move', code });
          // An expired or revoked token: connect that agent again next time.
          if ((e as { status?: unknown })?.status === 401 && acting !== null) agents.delete(acting);
        }
        save();
        if (Date.now() - lastAnswer > T.stallMs) {
          failed = true;
          s.failures.push(`no move was answered for ${Math.round(T.stallMs / MIN)} minutes (stalled)`);
          o.log('stalled', { minutes: Math.round(T.stallMs / MIN) });
          break;
        }
        await o.sleep(between([T.tickMs / 2, (T.tickMs * 3) / 2]));
      }
    }
  } catch (e) {
    if (!(e instanceof SoakFailed)) throw e;
    failed = true;
    o.log('failed', { reason: 'clock_moved' });
  } finally {
    if (partition !== null) await heal();
    if (restarting !== null) await restarting;
    for (const x of sides) await resume(x);
    save();
  }
  if (s !== null && o.minutes > 0) {
    o.log('run_end', { counts: s.counts });
    if (!o.final) await readViews('end_of_slice');
  }
  if (o.final) return verdict();
  return failed || (s?.failures.length ?? 0) > 0 ? 1 : 0;
}

// ------------------------------------------------------------------ restarts, with flyctl and each app's deploy token

class RestartRefused extends Error {
  override name = 'RestartRefused';
}
class RestartFailed extends Error {
  override name = 'RestartFailed';
}

/** Runs flyctl with only PATH, HOME and the app's token in its environment, from an empty directory (no fly.toml). */
function flyctl(args: string[], token: string, cwd: string): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn('flyctl', args, { cwd, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', FLY_API_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 5 * MIN);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      fail(e.code === 'ENOENT' ? new RestartRefused('flyctl_not_found') : new RestartFailed('flyctl_error'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return done(out);
      // Only a classification reaches the log, never flyctl's own words.
      if (/unauthori[sz]ed|forbidden|not authori[sz]ed|permission|access denied/i.test(err)) fail(new RestartRefused('flyctl_not_permitted'));
      else fail(new RestartFailed(code === null ? 'flyctl_killed' : `flyctl_exit_${code}`));
    });
  });
}

/** Restarts the one started machine of a staging app with that app's own deploy token. */
function flyRestarter(tokens: Record<StagingApp, string>): Restarter {
  return async (app) => {
    const checked = assertStagingApp(app);
    const cwd = mkdtempSync(join(tmpdir(), 'soak-fly-'));
    try {
      const listed = await flyctl(['machine', 'list', '--app', checked, '--json'], tokens[checked], cwd);
      let machines: unknown;
      try {
        machines = JSON.parse(listed);
      } catch {
        throw new RestartFailed('machine_list_not_json');
      }
      const started = Array.isArray(machines) ? machines.filter((m) => m?.state === 'started' && typeof m.id === 'string' && /^[0-9a-z]{1,40}$/.test(m.id)) : [];
      if (started.length !== 1) throw new RestartFailed(`started_machines_${started.length}`);
      await flyctl(['machine', 'restart', started[0].id as string, '--app', checked], tokens[checked], cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

// ------------------------------------------------------------------ the command line

const USAGE = 'usage: soak.ts --parley <dir> --state <file> --minutes <n> [--new] [--final] [--a <origin>] [--b <origin>]\n       soak.ts --parley <dir> --release [--a <origin>] [--b <origin>]   (resume both servers, nothing else)';
const KEY = /^([A-Za-z0-9._-]{1,64}):([A-Za-z0-9_-]{43})$/;

interface Args {
  parley: string;
  state: string;
  minutes: number;
  new: boolean;
  final: boolean;
  release: boolean;
  a: string;
  b: string;
}

function parseArgs(argv: string[]): Args | 'help' {
  if (argv.includes('--help') || argv.includes('-h')) return 'help';
  const one = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--new' || arg === '--final' || arg === '--release') {
      flags.add(arg);
      continue;
    }
    if (!['--parley', '--state', '--minutes', '--a', '--b'].includes(arg)) throw new Refusal(`unknown option; ${USAGE}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--') || one.has(arg)) throw new Refusal(`${arg} takes one value; ${USAGE}`);
    one.set(arg, value);
  }
  const release = flags.has('--release');
  if (release && (flags.size > 1 || one.has('--state') || one.has('--minutes'))) throw new Refusal('--release takes only --parley (and --a, --b)');
  const minutes = release ? 0 : Number(one.get('--minutes'));
  if (!one.has('--parley') || (!release && (!one.has('--state') || !one.has('--minutes')))) throw new Refusal(USAGE);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 360) throw new Refusal('--minutes is a whole number from 0 to 360');
  if (flags.has('--new') && minutes === 0) throw new Refusal('--new sets up a soak: give it --minutes');
  return {
    parley: one.get('--parley')!,
    state: one.get('--state') ?? '',
    minutes,
    new: flags.has('--new'),
    final: flags.has('--final'),
    release,
    a: one.get('--a') ?? STAGING['heygent-staging'].origin,
    b: one.get('--b') ?? STAGING['parley-peer-staging'].origin,
  };
}

/** The test key in environment variable `name`, which is then removed from this process's environment. */
function keyFrom(name: string): TestPeer {
  const m = KEY.exec(process.env[name] ?? '');
  delete process.env[name];
  if (m === null) throw new Refusal(`${name} must hold <label>:<base64url 32-byte key>`);
  return { label: m[1]!, key: Buffer.from(m[2]!, 'base64url') };
}

export async function main(argv: string[]): Promise<number> {
  let args: Args | 'help';
  let state: SoakState | null = null;
  let a: StagingApp;
  let b: StagingApp;
  try {
    args = parseArgs(argv);
    if (args === 'help') {
      console.log(USAGE);
      return 0;
    }
    // The guard first, before any key is read or anything loaded.
    a = stagingApp(args.a, '--a');
    b = stagingApp(args.b, '--b');
    if (a === b) throw new Refusal('--a and --b must be the two staging servers');
    const origins = { a: STAGING[a].origin, b: STAGING[b].origin };
    if (args.release) {
      // nothing to read
    } else if (existsSync(args.state)) {
      if (args.new) throw new Refusal(`--new: ${args.state} exists already`);
      state = loadState(args.state, origins);
    } else if (!args.new && !args.final) throw new Refusal(`${args.state}: no soak to resume (--new sets one up)`);
  } catch (e) {
    console.error(`soak: ${e instanceof Refusal ? e.message : 'refused'}`);
    return 2;
  }
  // Only --new sets a soak up: a final run with nothing to resume has its verdict already.
  if (state === null && !args.new && !args.release) {
    console.log('FAIL no soak state: the soak never set up, or its state was lost');
    console.log('soak: FAIL');
    return 1;
  }

  let keys: [TestPeer, TestPeer];
  try {
    keys = [keyFrom(STAGING[a].key), keyFrom(STAGING[b].key)];
  } catch (e) {
    console.error(`soak: ${e instanceof Refusal ? e.message : 'refused'}`);
    return 2;
  }
  const tokens = { 'heygent-staging': process.env[STAGING['heygent-staging'].fly] ?? '', 'parley-peer-staging': process.env[STAGING['parley-peer-staging'].fly] ?? '' };
  for (const app of Object.keys(STAGING) as StagingApp[]) delete process.env[STAGING[app].fly];
  const missing = (Object.keys(tokens) as StagingApp[]).filter((app) => tokens[app] === '').map((app) => STAGING[app].fly);
  const restartUnavailable = missing.length > 0 ? `${missing.join(' and ')} not set` : null;

  let driver: Driver;
  try {
    const src = resolve(args.parley, 'packages/conformance/src');
    driver = { Peer: (await import(pathToFileURL(join(src, 'peer.ts')).href)).Peer, flows: await import(pathToFileURL(join(src, 'flows.ts')).href) };
  } catch {
    console.error(`soak: cannot load the conformance driver from ${args.parley}/packages/conformance/src (install it first)`);
    return 2;
  }

  let stopping = false;
  const stoppers: (() => void)[] = [];
  const sleepers = new Set<() => void>();
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const fn of stoppers) fn();
    for (const wake of sleepers) wake();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const sleep = (ms: number) =>
    new Promise<void>((done) => {
      if (stopping) return done();
      const wake = () => {
        clearTimeout(timer);
        sleepers.delete(wake);
        done();
      };
      const timer = setTimeout(wake, ms);
      sleepers.add(wake);
    });
  // A person's whole state (GET /test/v1/state, a few hundred threads read one by one) gets three minutes; the rest 30 s.
  const fetchWithTimeout: typeof fetch = (input, init) =>
    fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(String(input).includes('/test/v1/state?') ? 180_000 : 30_000) });
  const log = (event: string, fields: Json = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

  if (args.release) {
    const env = { fetch: fetchWithTimeout, defer: () => undefined };
    let ok = true;
    for (const [side, app, key] of [['a', a, keys[0]], ['b', b, keys[1]]] as const) {
      const peer = new driver.Peer({ origin: STAGING[app].origin, key }, env);
      let done = false;
      for (let i = 0; i < 3 && !done; i++) {
        try {
          await peer.syncClock();
          await peer.pause(false);
          done = true;
        } catch (e) {
          log('error', { op: 'resume', side, code: errorCode(e) });
        }
      }
      log(done ? 'resumed' : 'not_resumed', { side, app });
      ok &&= done;
    }
    return ok ? 0 : 1;
  }

  try {
    return await runSoak({
      a: { app: a, origin: STAGING[a].origin, key: keys[0] },
      b: { app: b, origin: STAGING[b].origin, key: keys[1] },
      driver,
      fetch: fetchWithTimeout,
      statePath: args.state,
      state,
      minutes: args.minutes,
      final: args.final,
      restart: restartUnavailable === null ? flyRestarter(tokens) : null,
      restartUnavailable,
      timing: TIMING,
      log,
      print: (line) => console.log(line),
      sleep,
      stopped: () => stopping,
      onStop: (fn) => stoppers.push(fn),
    });
  } catch (e) {
    if (e instanceof Refusal) console.error(`soak: ${e.message}`);
    console.log(JSON.stringify({ at: new Date().toISOString(), event: 'aborted', code: errorCode(e) }));
    if (args.final) console.log(`soak: FAIL: aborted (${errorCode(e)})`);
    return 1;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));

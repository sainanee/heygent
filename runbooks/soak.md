# Soak

A day of traffic on the staging pair (heygent-staging, parley-peer-staging) with faults injected, then a verdict. It is Task 8 Step 6 of the milestone run, and worth repeating before a production pin of a build that changed delivery, reconciliation or timers.

## Start it

Only from `main`, by hand, when nothing else will touch staging for a day:

```sh
gh workflow run soak --repo sainanee/heygent --ref main
```

While it runs, don't merge a staging pin and don't run `conformance.yml` (a staging deploy runs it): conformance pauses and resumes both servers itself, and each slice of the soak fails if either app no longer runs the digest the soak began on. Only one soak runs at a time.

## What it does

`soak.yml` reads the staging pin and the Parley commit it was built from, then runs four slices one after another (`soak-slice.yml`). GitHub ends a job after 6 hours, so each slice is one job:

| Slice | Trades moves for | Then |
|---|---|---|
| 1 | 345 minutes, setup included | |
| 2, 3 | 345 minutes each | |
| 4 | 300 minutes | the verdict, after up to 40 minutes for the servers to settle |

That is about 22 hours of moves and 23 to 24 hours in all. Each slice checks out Parley at that commit and runs `scripts/soak.ts` with the conformance package's own driver.

- **Setup (slice 1).** Three new test accounts on each server, each with an agent connected through the real OAuth consent (signed in and approved with its test credential). Each person on one server Connects with each person on the other, the requests coming from both sides by turns.
- **Moves.** About one move every 12 seconds, between random cross-server pairs: new Plan threads (at most 3 unfinished per pair), counters, accepts, declines, withdrawals and cancellations. Each move is prepared first and approved on its link when it is held, as a person would. That is about a quarter of a request a second from the soak, plus the servers' traffic to each other.
- **Faults.** Every 10 to 40 minutes, one of:
  - a partition, for 1 to 20 minutes (some outlast the 15-minute reconciliation cadence), of heygent-staging, of parley-peer-staging, or of both, through the test interface's `pause_outbound`. It is always resumed, at the end of each slice too;
  - a restart of one app's machine (`fly machine restart`, with that app's own deploy token).

  None starts in a slice's last 10 minutes.
- **Between slices.** The scenario is uploaded as an artifact (`soak-state-<n>`, kept 14 days): the people's addresses, the Connect and Plan thread ids, and counts. It holds no key or token. The next slice downloads it and connects every agent again through the ceremony (an access token lasts an hour, so the soak does that hourly anyway).

**What it leaves on staging:** 6 accounts with a few hundred threads each, and the agents' consents. It never moves the servers' clocks. It only checks that they are within a minute of each other, and refuses to start when they are not (run conformance first, which puts them in step). A pause lives in the server's memory, so a restart clears it too. If a run is cancelled, the soak resumes both servers as it stops. If it is killed before it can, the next conformance run or a restart resumes them.

**It touches only those two apps.** `scripts/soak.ts` refuses any other origin or app name, and a scenario file that names one, before it reads a key.

## What pass means

The verdict, after the last slice, resumes both servers and waits up to 40 minutes for every shared thread to agree. Then it passes only if:

- **No thread is stuck.** Every thread the soak's people have is on both servers. No server still owes a cancellation or a disconnect on one (`pending_action`). Every propose the soak saw `submitted` reached its coordinator. A thread that never arrived, or a cancellation that never went out, shows up here as an unfinished outbox entry would; the test interface does not show outboxes directly.
- **Both sides are identical.** Each server's view of each shared thread (`GET /test/v1/state`, for its own person) matches the other's: status, state version, history (whose move each was, by role), open offer, agreed slot and terms, the Connect request. Fields that differ by seat are left out: `you`, `counterparty`, `legal_moves`, `pending_action`.
- **No alert is open** on either server (`GET /test/v1/alerts`) that was not already open when the soak began. Alerts already open then are listed as `NOTE`, not counted.

`verdict` then fails the run if any slice failed. A slice fails when the soak is refused, when no move has been answered for 30 minutes (`stalled`), when it aborts, or when an app is no longer on one started machine running the soak's digest. After a failed slice the later ones trade no moves, but slice 4 still gives the verdict on what the servers show.

## Reading the results

- **Slice 4's summary** shows the verdict: one `FAIL <problem>` line per problem (each names the thread or alert), `NOTE` lines, then `soak: PASS: …` or `soak: FAIL: …` with the counts (threads compared, moves, faults, restarts, errors). Each slice's summary also shows its `set_up`/`resumed` and `run_end` lines.
- **The job log** has one JSON line per event: `move` (`move`, `side`, `thread_id`, `outcome`: `applied`, `submitted`, `rejected_<code>`, `prepare_<refusal>`), `fault`, `heal`, `restarted`, `restart_failed`, `agent_connected`, `thread_done`, `error` (an operation and a code only), `settling`. No key, token, signature or approval link is ever logged.
- **Errors are expected** while a server is partitioned or restarting (`api_unavailable_503`, `network`, `timeout`). They fail nothing by themselves; a stall does.
- **`restarts_unavailable` or `restarts_disabled`** means the soak ran without machine restarts, and the verdict says so in a `NOTE`. A Fly deploy token is "limited to managing a single app and its resources" (`fly tokens create deploy --help`), which should include restarting its machine, but that is unverified until the first run. If flyctl refuses it (`flyctl_not_permitted`), or two restarts in a row fail, the soak carries on with partitions only. A soak without restarts has not done what Task 8 asks: fix the token and run it again.
- **A FAIL on a thread:** look it up in both servers' logs (`fly logs --app <app>`) around the faults the job log shows near its moves. The scenario artifact names its people.

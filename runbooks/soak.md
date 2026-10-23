# Soak

A day of traffic on the staging pair (heygent-staging, parley-peer-staging) with faults injected, then a verdict. It is Task 8 Step 6 of the milestone run, and worth repeating before a production pin of a build that changed delivery, reconciliation or timers.

## Start it

Only from `main`, by hand, when nothing else will touch staging for a day:

```sh
gh workflow run soak --repo sainanee/heygent --ref main
```

**Leave staging alone while it runs.** Each slice and `conformance.yml`'s `run` job share the `staging` concurrency group, so a conformance run (dispatched, or after a staging deploy) waits for the slice that is running. What the group does not prevent:

- A conformance run waiting when a slice ends takes its turn before the next slice. It moves both clocks about 8 days, and the next slice sees that and fails (`FAIL the clock of <server> moved … s between two reads`).
- GitHub keeps only one job waiting per group, and cancels the older one when another arrives: two conformance runs requested during a slice, or one requested while the next slice is waiting, cancel a waiting job.
- A staging deploy is not in the group. Each slice checks that both apps still run, on one started machine, the digest the soak began on, and fails otherwise.

So don't merge a staging pin or dispatch conformance until the soak is done. Only one soak runs at a time.

## What it does

`soak.yml` reads the staging pin and the Parley commit it was built from, then runs five slices one after another (`soak-slice.yml`). GitHub ends a job after 6 hours, so each slice is one job:

| Slice | Trades moves for | Then |
|---|---|---|
| 1 | 300 minutes, setup included | |
| 2, 3, 4 | 300 minutes each | |
| 5 | 270 minutes | the verdict, after up to 40 minutes for the servers to settle |

That is 24½ hours of moves and about 25½ hours in all. Each slice checks out Parley at that commit and runs `scripts/soak.ts` with the conformance package's own driver.

- **Setup (slice 1).** Three new test accounts on each server, each with an agent connected through the real OAuth consent (signed in and approved with its test credential). Each person on one server Connects with each person on the other (9 pairs), the requests coming from both sides by turns.
- **Moves.** About one move every 24 seconds, between random cross-server pairs, about 2,700 in a full soak. They are new Plan threads, counters (favoured, so a thread runs a few moves), accepts, declines, withdrawals and cancellations. Each move is prepared first and approved on its link when it is held, as a person would. That is about one request every 8 seconds from the soak, plus the servers' traffic to each other.
- **How many threads.** A pair has at most 3 unfinished Plan threads at a time, and at most **120 in all**. That makes at most 1,080 Plan threads, about 360 per person, so that the verdict's reads stay modest: `GET /test/v1/state` reads a person's threads one by one, at about 750 bytes each. A full soak starts about 830 (a simulation of the mix), so the cap rarely binds. A pair at its cap only finishes the threads it has. The soak logs the size and duration of a full read of both servers at the end of every slice (`state_read`); a state read may take up to 3 minutes before it counts as failed.
- **Faults.** Every 10 to 40 minutes, one of:
  - a partition, for 1 to 20 minutes (some outlast the 15-minute reconciliation cadence), of heygent-staging, of parley-peer-staging, or of both, through the test interface's `pause_outbound`. It is always resumed: when its time is up, at the end of each slice, and at once when the job is cancelled;
  - a restart of one app's machine (`fly machine restart`, with that app's own deploy token). A failed restart is tried again at a later fault. Only flyctl refusing the token (or flyctl missing) stops restarts for good, and that fails the verdict.

  None starts in a slice's last 10 minutes.
- **Between slices.** The scenario is uploaded as an artifact (`soak-state-<n>`, kept 14 days): the people's addresses, the Connect and Plan thread ids, the counts, each server's last clock offset, and any failure so far. It holds no key or token. The next slice downloads it and connects every agent again through the ceremony (an access token lasts an hour, so the soak does that hourly anyway).

**What it leaves on staging:** 6 accounts with up to 360 Plan threads each (about 280 expected), and many agent consents (one per reconnect). **It never moves the servers' clocks.** It reads them at every slice start and every 5 minutes, and fails if one moved by more than a minute against the runner's clock (someone else moved it) or if the two are more than a minute apart (run conformance first, which puts them in step).

**Pauses.** A pause lives in the server's memory, so a restart clears it too. If the run is cancelled, the soak resumes both servers before it waits for anything in flight, and a last `if: cancelled()` step resumes both again (`scripts/soak.ts --release`).

**It touches only those two apps.** `scripts/soak.ts` refuses any other origin or app name, and a scenario file that names one, before it reads a key.

## What pass means

The verdict, after the last slice, resumes both servers and waits up to 40 minutes for every shared thread to agree. Then it passes only if all of these hold:

- **The soak did what it claims.** The counts show:
  - at least 1,000 moves applied;
  - at least one partition made and healed;
  - at least one completed machine restart of **each** staging app.

  A soak that could not restart, because the token was refused (`FAIL machine restarts are not possible with the apps' deploy tokens`) or the Fly tokens were not set, fails. So does one whose pauses always failed.
- **No thread is stuck.** Every thread the soak's people have is on both servers. No server still owes a cancellation or a disconnect on one (`pending_action`). Every propose the soak saw `submitted` reached its coordinator. A thread that never arrived, or a cancellation that never went out, shows up here as an unfinished outbox entry would; the test interface does not show outboxes directly.
- **Both sides are identical.** Each server's view of each shared thread (`GET /test/v1/state`, for its own person) matches the other's: status, state version, history (whose move each was, by role), open offer, agreed slot and terms, the Connect request. Fields that differ by seat are left out: `you`, `counterparty`, `legal_moves`, `pending_action`.
- **No alert is open** on either server (`GET /test/v1/alerts`) that was not already open when the soak began. Alerts already open then are listed as `NOTE`, not counted.
- **Nothing failed along the way.** No clock moved under the soak, no slice stalled (no move answered for 30 minutes), and both servers could be resumed for the verdict.

`verdict` then fails the run if any slice failed. A slice fails when the soak is refused, stalls, aborts, sees a clock moved, or when an app is no longer on one started machine running the soak's digest. After a failed slice the later ones trade no moves, but slice 5 still gives the verdict on what the servers show.

## Reading the results

- **Slice 5's summary** shows the verdict: one `FAIL <problem>` line per problem (each names the thread, alert, server or missing fault), `NOTE` lines, then `soak: PASS: …` or `soak: FAIL: …` with the counts (threads compared, moves applied, partitions, restarts per app, errors). Each slice's summary also shows its `set_up`/`resumed` and `run_end` lines.
- **The job log** has one JSON line per event:
  - `move` (`move`, `side`, `thread_id`, `outcome`: `applied`, `submitted`, `rejected_<code>`, `prepare_<refusal>`);
  - `fault`, `heal`, `restarted`, `restart_failed`, `restarts_disabled`;
  - `agent_connected`, `thread_done`;
  - `state_read` (`threads`, `most_for_one_person`, `bytes`, `ms`), `settling`;
  - `stopping`, `resumed_on_stop`;
  - `error` (an operation and a code only).

  No key, token, signature or approval link is ever logged.
- **Errors are expected** while a server is partitioned or restarting (`api_unavailable_503`, `network`, `timeout`), as are `rejected_too_many_offers` counters. They fail nothing by themselves.
- **`state_read` growing slow** (tens of seconds per read at the end of a slice) is worth looking at before the verdict needs it.
- **A FAIL on a thread:** look it up in both servers' logs (`fly logs --app <app>`) around the faults the job log shows near its moves. The scenario artifact names its people.

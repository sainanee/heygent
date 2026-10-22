# Deploy

The four apps, in one Fly organisation, all in Singapore (`primary_region = "sin"`), each with its own Supabase project in Singapore (`ap-southeast-1`):

| Folder | Fly app | URL | Mode | Supabase project |
|---|---|---|---|---|
| `servers/heygent` | `heygent` | https://heygent.fly.dev | production | `heygent` |
| `servers/peer` | `parley-peer` | https://parley-peer.fly.dev | production | `parley-peer` |
| `servers/heygent-staging` | `heygent-staging` | https://heygent-staging.fly.dev | test | `heygent-staging` |
| `servers/peer-staging` | `parley-peer-staging` | https://parley-peer-staging.fly.dev | test | `parley-peer-staging` |

The Fly reference for every `fly` command below is Parley's operator guide, `docs/operators/run-your-own-server.md` in sainanee/parley. Where this page says *unverified*, nobody has run that step yet; Task 7 (the first real deploy) checks them.

## One-time setup (owner)

Each step is an outward action: do it only when you mean to.

**1. Fly apps.** `<org>` is your Fly organisation.

```sh
for app in heygent heygent-staging parley-peer parley-peer-staging; do fly apps create "$app" --org <org>; done
```

**2. Four Supabase projects**, in the Supabase dashboard: one per app, named after the app (table above), region Singapore (`ap-southeast-1`). Choose Postgres 17 if it is offered: Parley's tests run on 17.6 and its operator guide asks for 17 (the migrations use nothing newer than Postgres 13 that we found, but only 17 is tested). Never share a project between two apps: the database is the server (accounts, passkeys, threads, its signing keys). Save each project's database password in your password manager; it goes nowhere else.

The server creates its own tables in the project's `postgres` database at every start, as the `postgres` user; no extensions are needed.

**3. Supabase's root CA, into `certs/supabase-ca.crt`.** In any one project: Project Settings → Database → SSL Configuration → Download certificate. Replace the whole placeholder file `certs/supabase-ca.crt` with it, and check that the other three projects offer the same file (`shasum -a 256` each download; if they differ, stop and ask). Commit it in a pull request. It is public, not a secret. `deploy.yml` refuses to deploy while the file is not a PEM certificate. Each `fly.toml` mounts it into the machine at `/etc/parley/supabase-ca.crt` (`[[files]]`). Unverified until Task 7: that the mount works from `deploy.yml`'s invocation, and that the server's user (`node`) can read the file. Optionally turn on "Enforce SSL on incoming connections" on the same settings page.

**4. Each app's `DATABASE_URL`.** From the project's Connect dialog, take one of these two, both on port **5432**:

- the **direct connection**, `postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres`; or
- the **session pooler**, `postgresql://postgres.<project-ref>:<password>@<pooler host>:5432/postgres` (the host the dialog shows for `ap-southeast-1`).

Never the **transaction pooler on port 6543**. In transaction mode each transaction may run on a different server connection, so anything that spans transactions on one connection breaks without an error. Parley is tested only on plain Postgres connections, which is what the direct connection and the session pooler give. Today its locks are transaction-level advisory locks and we found nothing session-scoped, so transaction mode might work, but it is untested: don't.

The direct connection may be IPv6-only on Supabase. Whether Fly machines reach it over IPv6 is unverified. Use the direct connection first; if the server cannot reach the database (`/healthz` answers 503, or the deploy fails its health check), use the session pooler (IPv4). Task 7 settles which.

Then add TLS that checks Supabase's certificate against the CA from step 3. Append exactly:

```
?sslmode=verify-full&sslrootcert=/etc/parley/supabase-ca.crt
```

The server's Postgres driver (node-postgres 8.23, through pg-connection-string) reads the `sslrootcert` file named in the URL as its only trusted CA, and `sslmode=verify-full` keeps full verification: the chain must end in that CA and the host name must match. Never `sslmode=no-verify` or anything that turns verification off. Whether the session pooler's certificate also chains to that CA is unverified; if `verify-full` fails on it, stop and ask rather than loosen it.

**5. Fly secrets.** For each app, `scripts/set-secrets.sh <app>` (`secrets.md`). It refuses a `DATABASE_URL` that is not on port 5432 or lacks `sslmode=verify-full&sslrootcert=/etc/parley/supabase-ca.crt`.

**6. The `fly` GitHub Environment**, the only place the workflows' secrets live. In sainanee/heygent: Settings → Environments → New environment, named `fly`. Under "Deployment branches and tags" choose "Selected branches and tags" and add `main`, nothing else. Then add its secrets (`secrets.md`): the four per-app Fly deploy tokens and the two conformance keys. No repository-level secrets: `check.yml` runs pull request code and gets none.

**7. A ruleset on `main`.** Settings → Rules → Rulesets → New branch ruleset: name `main`, enforcement Active, bypass list empty, target the default branch, and turn on:

- Restrict deletions;
- Block force pushes;
- Require a pull request before merging (0 approvals: you merge your own);
- Require status checks to pass: `check`.

With the `fly` environment this means nothing reaches Fly except what was merged to `main` through a checked pull request: `deploy.yml` and `conformance.yml` run their jobs only on `main`.

**8. Actions may open pull requests.** Settings → Actions → General → Workflow permissions: allow GitHub Actions to create pull requests (`conformance.yml` opens one). A pull request opened by a workflow does not start `check.yml`, so its required `check` is missing until you close and reopen it.

**9. The image must be public** on GHCR (`ghcr.io/sainanee/parley-server`): Fly and the workflows pull it without credentials.

## Rolling out a Parley build

1. Parley's CI publishes `ghcr.io/sainanee/parley-server:<commit>` from master. The run's summary gives the digest pin, `ghcr.io/sainanee/parley-server@sha256:<64 hex>`.
2. **Staging.** In one pull request, write that line into `servers/heygent-staging/image` and `servers/peer-staging/image` (the same digest in both: conformance refuses a mixed pair). `check.yml` runs. Merge it.
3. `deploy.yml` checks the pins and settings, validates each `fly.toml`, deploys both staging apps, and checks each from outside (`scripts/post-deploy-check.sh`). Then `conformance.yml` runs the suite from the image's own Parley commit (its `org.opencontainers.image.revision` label) against the staging pair. On a pass it opens a pull request, "conformance: sha256:… passed on staging", appending the digest to `passed-on-staging.txt`.
4. **Your go-ahead.** Read the run; close and reopen the pull request so `check` runs (it also checks that the pull request only appends one new digest, from a `conformance/*` branch of this repo); merge it.
5. **Production.** In a pull request, write the same line into `servers/heygent/image` and `servers/peer/image`. `check-pins.ts` refuses a production pin whose digest is not in `passed-on-staging.txt`, in `check.yml` and again in `deploy.yml` before anything deploys. Merge it: `deploy.yml` deploys and checks both. The first production deploy needs the owner's go-ahead at that time.

A folder with no `image` file has not been deployed yet: the checks accept it, and `deploy.yml` skips it.

Settings: edit `server.env` or `fly.toml` in a pull request; merging deploys that folder. Secrets: `secrets.md`, then redeploy.

**Redeploy by hand** (after a secret change, or when a merged change did not deploy: `deploy.yml` deploys only what its own push changed, and a queued run can be dropped when another push arrives while a deploy is running):

```sh
gh workflow run deploy --repo sainanee/heygent --ref main -f folder=<folder>
```

## What conformance does to staging

- **The clock.** Each run moves both staging servers' clocks about 8 days forward (the suite's deletion-after-7-days case), and they stay there: a test-mode clock only moves forward, and the offset is kept in the database, so restarts and deploys keep it. After a few runs staging is weeks ahead of real time. Expect it in staging's dates; it never touches production. One machine per staging app, because the suite reads one clock per server.
- **Accounts.** Every run makes fresh accounts on both; they pile up.
- **What is not yet checked.** The cases that need a third origin (a server the runner impersonates, at a public HTTPS URL, `--third`) are skipped: no such origin is set up yet. A digest in `passed-on-staging.txt` has passed every other case, not those. `conformance.yml` accepts a SKIP of any of those cases **whatever reason the suite prints for it** (the list is the suite's own `THIRD_ORIGIN_CASES`, at the pinned commit), and a SKIP of `production-hides-test-interface` while no production app is deployed; once one is, it checks every deployed production URL (`--prod`). Every other case must PASS, and the PASS and SKIP lines together must cover all of the suite's cases (`CASE_NAMES`). `post-deploy-check.sh` makes the same production check at every production deploy.

## Machines and cost

Each app runs one `shared-cpu-1x` machine with 512 MB, always on (`auto_stop_machines = "off"`, `min_machines_running = 1`): the server's own background work (delivery, expiries) runs inside it, and federation peers and the conformance runner must not find it asleep. That is four machines running all the time, plus four Supabase projects. Letting the staging pair stop when idle would save money, but their background work would then pause and conformance would meet cold servers; if you choose it anyway, set `auto_stop_machines = "stop"` and `min_machines_running = 0` in their `fly.toml` only. `deploy.yml` deploys with `--ha=false` (one machine) and `strategy = "rolling"`: never two copies of a server on one database.

Supabase: check what your plan does with an idle project (free projects can be paused) and how long it keeps backups (the project's Database → Backups page).

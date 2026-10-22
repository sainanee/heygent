# Deploy

The four apps, all in one Fly organisation and one region (`primary_region` in each `fly.toml`, now `lhr`):

| Folder | Fly app | URL | Mode |
|---|---|---|---|
| `servers/heygent` | `heygent` | https://heygent.fly.dev | production |
| `servers/peer` | `parley-peer` | https://parley-peer.fly.dev | production |
| `servers/heygent-staging` | `heygent-staging` | https://heygent-staging.fly.dev | test |
| `servers/peer-staging` | `parley-peer-staging` | https://parley-peer-staging.fly.dev | test |

The Fly reference for every command below is Parley's operator guide, `docs/operators/run-your-own-server.md` in sainanee/parley, section 9. Fly changes its commands from time to time; where this page says *unverified*, nobody has run that step yet.

## One-time setup (owner)

Each step is an outward action: do it only when you mean to.

**1. Apps.** `<org>` is your Fly organisation.

```sh
for app in heygent heygent-staging parley-peer parley-peer-staging; do fly apps create "$app" --org <org>; done
```

**2. One Managed Postgres 17 cluster for all four.** Staging and production share it (and its machine): a staging load, or a cluster outage, reaches production too. Use the same region as `primary_region`; check that it has Managed Postgres with `fly platform regions`.

```sh
fly mpg create --name heygent-db --region lhr --pg-major-version 17 --org <org>
fly mpg list    # note the cluster ID
```

You may be asked for `--plan`.

**3. A database and a role per app.** Names use underscores:

```sh
for db in heygent heygent_staging parley_peer parley_peer_staging; do
  fly mpg databases create <cluster-id> --name "$db"
  fly mpg users create <cluster-id> --username "$db" --role schema_admin
done
```

Unverified, so check each before going on:

- Where `fly mpg users create` shows the new role's password. Wherever it does, take it straight into step 5's hidden prompt; never paste it anywhere else.
- Whether a Managed Postgres role is limited to one database. Its roles (`schema_admin`, `writer`, `reader`) look cluster-wide. Check: `fly mpg connect <cluster-id> -d parley_peer -u heygent` must be refused. If it connects, restrict each database as the cluster's admin user (`fly mpg connect <cluster-id> -d <db>`): `REVOKE CONNECT ON DATABASE <db> FROM PUBLIC; GRANT CONNECT ON DATABASE <db> TO <db>;` (whether Fly lets you is unverified too). Then check again.
- That `schema_admin` may create tables in its database's `public` schema (the server creates its own tables at start).

**4. Each app's `DATABASE_URL`: its own role, its own database, the direct URL.** Do not use `fly mpg attach`: it sets the pooled (PgBouncer) URL, and the server migrates at every start, which Fly advises doing over the direct URL. Copy the direct URL (host `direct.<cluster>.flympg.net`) from the cluster's Connection tab in the Fly dashboard, and change its user, password and database to the app's own. (If an app cannot reach the cluster without attaching, which is unverified, attach after the first deploy and then set `DATABASE_URL` to the direct URL again.)

| App | Database and role |
|---|---|
| `heygent` | `heygent` |
| `heygent-staging` | `heygent_staging` |
| `parley-peer` | `parley_peer` |
| `parley-peer-staging` | `parley_peer_staging` |

**5. Secrets.** For each app, `scripts/set-secrets.sh <app>`, and the GitHub secrets; both are in `secrets.md`.

**6. GitHub.** In sainanee/heygent's settings, under Actions → General → Workflow permissions, allow GitHub Actions to create pull requests (`conformance.yml` opens one). A pull request opened by a workflow does not start `check.yml`; to check it, close and reopen it, or push a commit to it.

**7. The image must be public** on GHCR (`ghcr.io/sainanee/parley-server`): Fly and the workflows pull it without credentials.

## Rolling out a Parley build

1. Parley's CI publishes `ghcr.io/sainanee/parley-server:<commit>` from master. The run's summary gives the digest pin, `ghcr.io/sainanee/parley-server@sha256:<64 hex>`.
2. **Staging.** In one pull request, write that line into `servers/heygent-staging/image` and `servers/peer-staging/image` (the same digest in both: conformance refuses a mixed pair). `check.yml` runs on the pull request. Merge it.
3. `deploy.yml` checks the pins and settings, deploys both staging apps, and checks each from outside (`scripts/post-deploy-check.sh`). Then `conformance.yml` runs the suite from the image's own Parley commit (its `org.opencontainers.image.revision` label) against the staging pair. On a pass it opens a pull request, "conformance: sha256:… passed on staging", appending the digest to `passed-on-staging.txt`.
4. **Your go-ahead.** Read the run, and merge that pull request.
5. **Production.** In a pull request, write the same line into `servers/heygent/image` and `servers/peer/image`. `check-pins.ts` refuses a production pin whose digest is not in `passed-on-staging.txt`. Merge it: `deploy.yml` deploys and checks both. The first production deploy needs the owner's go-ahead at that time.

A folder with no `image` file has not been deployed yet: the checks accept it, and `deploy.yml` skips it.

Settings: edit `server.env` or `fly.toml` in a pull request; merging deploys that folder. Secrets: `secrets.md`, then redeploy.

**Redeploy by hand** (after a secret change, or when a merged change did not deploy: a queued run can be dropped when another push arrives while a deploy is running):

```sh
gh workflow run deploy --repo sainanee/heygent -f folder=<folder>
```

## What conformance does to staging

- **The clock.** Each run moves both staging servers' clocks about 8 days forward (the suite's deletion-after-7-days case), and they stay there: a test-mode clock only moves forward, and the offset is kept in the database, so restarts and deploys keep it. After a few runs staging is weeks ahead of real time. Expect it in staging's dates; it never touches production. One machine per staging app, because the suite reads one clock per server.
- **Accounts.** Every run makes fresh accounts on both; they pile up.
- **What is not yet checked.** The cases that need a third origin (a server the runner impersonates, at a public HTTPS URL, `--third`) are skipped: no such origin is set up yet. A digest in `passed-on-staging.txt` has passed every other case, not those. `conformance.yml` accepts only those skips (the list comes from the suite itself, `THIRD_ORIGIN_CASES`), plus `production-hides-test-interface` while no production app is deployed; once one is, it checks every deployed production URL (`--prod`). `post-deploy-check.sh` makes the same production check at every production deploy.

## Machines and cost

Each app runs one `shared-cpu-1x` machine with 512 MB, always on (`auto_stop_machines = "off"`, `min_machines_running = 1`): the server's own background work (delivery, expiries) runs inside it, and federation peers and the conformance runner must not find it asleep. That is four machines running all the time, plus the Postgres cluster. Letting the staging pair stop when idle would save money, but their background work would then pause and conformance would meet cold servers; if you choose it anyway, set `auto_stop_machines = "stop"` and `min_machines_running = 0` in their `fly.toml` only. `deploy.yml` deploys with `--ha=false` (one machine) and `strategy = "rolling"`: never two copies of a server on one database.

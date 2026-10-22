# heygent

heygent is the reference network of [Parley](https://github.com/sainanee/parley), the open federated protocol for agent-to-agent coordination: four Parley servers on Fly.io (Singapore), each with its own Supabase Postgres database, run by the Parley project. This repo holds their configuration and a few small scripts. It holds no server code: every server runs an unmodified, published Parley image, pinned by digest. A change a server needs goes into Parley.

## The servers

| Server | URL | Mode | Config |
|---|---|---|---|
| heygent | https://heygent.fly.dev | production | `servers/heygent` |
| parley-peer | https://parley-peer.fly.dev | production | `servers/peer` |
| heygent-staging | https://heygent-staging.fly.dev | test | `servers/heygent-staging` |
| parley-peer-staging | https://parley-peer-staging.fly.dev | test | `servers/peer-staging` |

Two production servers federate with each other, as two independent operators' servers would. The staging pair runs each new build first, in test mode, so the conformance suite can drive it. Addresses are `name@<server>`, for example `alice@heygent.fly.dev`.

Each `servers/<folder>` has:

- `fly.toml`: the Fly app;
- `server.env`: the server's non-secret settings;
- `image`: one line, `ghcr.io/sainanee/parley-server@sha256:<digest>`. A folder with no `image` has not been deployed yet.

## How a build reaches production

1. Parley's CI publishes an image, `ghcr.io/sainanee/parley-server:<commit>`.
2. A pull request here pins its digest on the staging pair. Merged, `deploy.yml` deploys it and checks each server from outside.
3. `conformance.yml` runs Parley's conformance suite, from the image's own commit, across the real network against the staging pair.
4. On a pass, the workflow opens a pull request adding the digest to `passed-on-staging.txt`. The owner merges it.
5. Only then may a production pin name that digest: `check-pins.ts` refuses any other, in `check.yml` on every pull request and again in `deploy.yml` before anything deploys.

Production servers run `PARLEY_MODE=production` and never get the test interface's keys; every production deploy is checked from outside for that.

## Secrets

No secret lives here. Database URLs, app keys and test keys are in Fly's secret store; the per-app Fly deploy tokens and the conformance keys are secrets of a GitHub Environment only `main` may use. They are entered through hidden prompts (`scripts/set-secrets.sh`, `gh secret set`) and never printed. `runbooks/secrets.md` names them all.

## Layout

| Path | What |
|---|---|
| `servers/` | one folder per server |
| `certs/supabase-ca.crt` | Supabase's public root CA, mounted into each machine for the database's TLS check |
| `passed-on-staging.txt` | digests that passed conformance on staging, appended only by the conformance workflow's pull request |
| `scripts/check-pins.ts` | the pin rules |
| `scripts/check-env.ts` | each `server.env` against what the server accepts and this network's values |
| `scripts/set-secrets.sh` | stages an app's secrets in Fly from hidden prompts |
| `scripts/post-deploy-check.sh` | checks a deployed server from outside (discovery, mode, test interface, health) |
| `.github/workflows/` | `check` (pull requests), `deploy` (main), `conformance` (after a staging deploy) |
| `runbooks/` | deploy, rollback, secrets, invites, incident |

The checks need Node 24 and nothing else: `npm test` runs the scripts' tests, `npm run check` runs both checks on this repo.

## License

Apache-2.0. See `LICENSE`.

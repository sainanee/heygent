# Incident

First: which app, since when, and did a deploy just happen (`fly releases --app <app>`, and the `deploy` workflow's runs)?

## Production shows test mode or its test interface

`post-deploy-check.sh` failing on `mode` or `test_interface` for `heygent` or `parley-peer`, or `curl -s https://<app>.fly.dev/.well-known/parley` not showing `"mode":"production"`. This must never happen: stop the app first, then look.

```sh
fly machine list --app <app>
fly machine stop <machine-id> --app <app>
```

Then: is `PARLEY_MODE=production` in `servers/<folder>/server.env` on `main`, does `fly secrets list --app <app>` list `PARLEY_TEST_KEYS` (it must not; `fly secrets unset PARLEY_TEST_KEYS --app <app>`), and which image ran? Start it again only by a deploy that passes `post-deploy-check.sh`.

## A server is down or failing its health check

```sh
fly status --app <app>
fly logs --app <app>
```

- `start_failed` with no reason: the server leaves the reason out of its logs on purpose. Reproduce it with the pinned image and the folder's `server.env` plus stand-in secrets, as in the operator guide's "Reading a failed start" (section 2). A wrong secret will not show there: re-enter it with `scripts/set-secrets.sh` (`secrets.md`).
- `/healthz` answers 503: the server cannot reach its database. Check the app's Supabase project (dashboard status; a paused project must be restored), and that `DATABASE_URL` is on port 5432 with `sslmode=verify-full&sslrootcert=/etc/parley/supabase-ca.crt` and that `certs/supabase-ca.crt` is still Supabase's CA. If the direct connection is unreachable from Fly (IPv6), switch that app to the session pooler (`deploy.md`, step 4).
- After a deploy: roll back (`rollback.md`).
- Otherwise: `fly machine restart <machine-id> --app <app>`.

## A secret may have leaked

Rotate it (`secrets.md`, "Rotating"). A leaked `PARLEY_SECRET_KEY` means forged form tokens and readable stored webhooks: rotate it, accepting that recovery codes and stored webhooks stop working. A leaked `DATABASE_URL` is the whole server: reset that project's database password at once. A leaked Fly deploy token reaches its one app: revoke it (`fly tokens list --app <app>`, `fly tokens revoke <id>`) and check `fly releases --app <app>` for deploys you did not make. A leaked test key affects only its staging app.

## Conformance fails on staging

Nothing reaches production: the digest is not listed. Read the run's output (`FAIL <case> <reason>`; each case file in Parley names the bug that makes it fail). "the staging pair runs two images": pin both staging folders to one digest. "is not running exactly one started machine": `fly machine list --app <staging app>`; the suite needs one machine per staging app. A clock-gap stop: run it again, `gh workflow run conformance --repo sainanee/heygent` (it re-aligns the pair).

## Telling peers

Our discovery document's `operator_contact` (in each `server.env`) is how other operators reach us; theirs is in their own discovery document.

# Secrets

Secret values never go in this repo, in chat, in an issue or in a log. They are typed into hidden prompts, or piped from the command that makes them to the command that stores them, so they are never on screen.

## What exists, and where it lives

| Secret | Where | For | Value |
|---|---|---|---|
| `DATABASE_URL` | Fly | each app | Its own Supabase project, port 5432, ending `?sslmode=verify-full&sslrootcert=/etc/parley/supabase-ca.crt` (`deploy.md`, step 4). |
| `PARLEY_SECRET_KEY` | Fly | each app | At least 32 characters. One per app, never shared. |
| `PARLEY_TEST_KEYS` | Fly | `heygent-staging`, `parley-peer-staging` only | `{"heygent-conformance":"<43-character base64url key>"}`; `set-secrets.sh` builds the JSON from the key. |
| `FLY_TOKEN_HEYGENT`, `FLY_TOKEN_HEYGENT_STAGING`, `FLY_TOKEN_PARLEY_PEER`, `FLY_TOKEN_PARLEY_PEER_STAGING` | GitHub, `fly` environment | `deploy.yml` (each app's own token); `conformance.yml` (the two staging ones) | A Fly deploy token for that one app. |
| `CONFORMANCE_HEYGENT_STAGING_KEY` | GitHub, `fly` environment | `conformance.yml` | `heygent-conformance:<heygent-staging's test key>` |
| `CONFORMANCE_PEER_STAGING_KEY` | GitHub, `fly` environment | `conformance.yml` | `heygent-conformance:<parley-peer-staging's test key>` |
| `PARLEY_DEPLOY_KEY` | GitHub, `fly` environment | `conformance.yml` (checks out the pinned image's commit of the private sainanee/parley) | The private half of an ed25519 deploy key added read-only to sainanee/parley alone. |

GitHub secrets live only in the `fly` environment, which only `main` may use (`deploy.md`, step 6); there are no repository-level secrets.

A production app (`heygent`, `parley-peer`) never has `PARLEY_TEST_KEYS`: the server refuses to start with it, `set-secrets.sh` refuses to set it, and `check-env.ts` refuses it in `server.env`.

## Fly secrets: `scripts/set-secrets.sh`

```sh
scripts/set-secrets.sh <app>                    # asks for every secret the app needs
scripts/set-secrets.sh <app> PARLEY_SECRET_KEY  # or only the ones named
```

It reads each value with hidden input, checks its form without printing it, and stages them all with one `fly secrets import --stage` on standard input. Staged secrets take effect at the next deploy; to apply them now, run `fly secrets deploy --app <app>` (or the `deploy` workflow by hand, `deploy.md`).

`DATABASE_URL`: build it from the Supabase project's Connect dialog and your saved password (`deploy.md`, step 4), and paste it into the prompt.

`PARLEY_SECRET_KEY`: make one per app with `openssl rand -base64 32`, keep it in your password manager, and paste it into the prompt. Never change it casually: people's recovery codes and stored agent webhooks stop working under a new key.

`PARLEY_TEST_KEYS` and its GitHub twin, without the key ever being shown (run from the repo root; once per staging app):

```sh
key="$(openssl rand 32 | base64 | tr '+/' '-_' | tr -d '=')"
printf '%s\n' "$key" | scripts/set-secrets.sh heygent-staging PARLEY_TEST_KEYS
printf 'heygent-conformance:%s' "$key" | gh secret set CONFORMANCE_HEYGENT_STAGING_KEY --env fly --repo sainanee/heygent
unset key

key="$(openssl rand 32 | base64 | tr '+/' '-_' | tr -d '=')"
printf '%s\n' "$key" | scripts/set-secrets.sh parley-peer-staging PARLEY_TEST_KEYS
printf 'heygent-conformance:%s' "$key" | gh secret set CONFORMANCE_PEER_STAGING_KEY --env fly --repo sainanee/heygent
unset key
```

## GitHub secrets: `gh secret set --env fly`

**The parley deploy key** (once; while sainanee/parley is private). The private half goes straight into the secret and is deleted:

```sh
ssh-keygen -t ed25519 -N '' -C heygent-conformance -f /tmp/heygent-conformance
gh repo deploy-key add /tmp/heygent-conformance.pub --repo sainanee/parley --title heygent-conformance
gh secret set PARLEY_DEPLOY_KEY --env fly --repo sainanee/heygent < /tmp/heygent-conformance
rm /tmp/heygent-conformance /tmp/heygent-conformance.pub
```

A deploy key is read-only by default, reaches that one repository, does not expire and is not tied to a person; revoke it under sainanee/parley → Settings → Deploy keys. If parley is made public, delete the key and the secret and drop `ssh-key` from `conformance.yml`.


`gh secret set NAME --env fly --repo sainanee/heygent` asks for the value with hidden input; piped, it reads standard input.

**Fly tokens: one deploy token per app.** A Fly deploy token covers exactly one app (`fly tokens create deploy`), so each app gets its own secret and `deploy.yml` uses only the deployed app's token. An org token would reach every app in the organisation, which holds more than these four. The tokens expire in a year: set a reminder.

```sh
for app in heygent heygent-staging parley-peer parley-peer-staging; do
  name="FLY_TOKEN_$(printf '%s' "$app" | tr 'a-z-' 'A-Z_')"
  fly tokens create deploy --app "$app" --name heygent-ci --expiry 8760h | gh secret set "$name" --env fly --repo sainanee/heygent
done
```

That `fly tokens create deploy` prints nothing but the token is unverified. If a workflow then cannot authenticate, run `fly tokens create deploy --app <app> --name heygent-ci --expiry 8760h` on its own, copy the token, and run `gh secret set FLY_TOKEN_<APP> --env fly --repo sainanee/heygent`, pasting it into the hidden prompt. Whether a deploy token may run `fly config validate` (which `deploy.yml` runs first) is unverified too.

## Rotating

- `PARLEY_SECRET_KEY`: only after a leak (it breaks recovery codes and stored webhooks). `set-secrets.sh <app> PARLEY_SECRET_KEY`, then `fly secrets deploy --app <app>`.
- `DATABASE_URL`: reset the project's database password in Supabase (Project Settings → Database), then `set-secrets.sh <app> DATABASE_URL` and `fly secrets deploy --app <app>`.
- A test key: repeat its block above, then `fly secrets deploy --app <staging app>`.
- A Fly token: `fly tokens list --app <app>` and `fly tokens revoke <id>` for the old one, then set a new one as above.

To see which secrets an app has, without values: `fly secrets list --app <app>`.

# Secrets

Secret values never go in this repo, in chat, in an issue or in a log. They are typed into hidden prompts, or piped from the command that makes them to the command that stores them, so they are never on screen.

## What exists, and where it lives

| Secret | Where | Apps | Value |
|---|---|---|---|
| `DATABASE_URL` | Fly | all four | The app's own role on its own database, direct (not pooled) URL. See `deploy.md`. |
| `PARLEY_SECRET_KEY` | Fly | all four | At least 32 characters. One per app, never shared. |
| `PARLEY_TEST_KEYS` | Fly | `heygent-staging`, `parley-peer-staging` only | `{"heygent-conformance":"<43-character base64url key>"}`; `set-secrets.sh` builds the JSON from the key. |
| `FLY_API_TOKEN` | GitHub | | An org deploy token: `deploy.yml`, `conformance.yml`, `check.yml` (`fly config validate`). |
| `CONFORMANCE_HEYGENT_STAGING_KEY` | GitHub | | `heygent-conformance:<heygent-staging's test key>` |
| `CONFORMANCE_PEER_STAGING_KEY` | GitHub | | `heygent-conformance:<parley-peer-staging's test key>` |

A production app (`heygent`, `parley-peer`) never has `PARLEY_TEST_KEYS`: the server refuses to start with it, `set-secrets.sh` refuses to set it, and `check-env.ts` refuses it in `server.env`.

## Fly secrets: `scripts/set-secrets.sh`

```sh
scripts/set-secrets.sh <app>                  # asks for every secret the app needs
scripts/set-secrets.sh <app> PARLEY_SECRET_KEY  # or only the ones named
```

It reads each value with hidden input, checks its form without printing it, and stages them all with one `fly secrets import --stage` on standard input. Staged secrets take effect at the next deploy; to apply them now, run `fly secrets deploy --app <app>` (or the `deploy` workflow by hand, `deploy.md`).

`PARLEY_SECRET_KEY`: make one per app with `openssl rand -base64 32`, keep it in your password manager, and paste it into the prompt. Never change it casually: people's recovery codes and stored agent webhooks stop working under a new key.

`PARLEY_TEST_KEYS` and its GitHub twin, without the key ever being shown (run from the repo root; once per staging app):

```sh
key="$(openssl rand 32 | base64 | tr '+/' '-_' | tr -d '=')"
printf '%s\n' "$key" | scripts/set-secrets.sh heygent-staging PARLEY_TEST_KEYS
printf 'heygent-conformance:%s' "$key" | gh secret set CONFORMANCE_HEYGENT_STAGING_KEY --repo sainanee/heygent
unset key

key="$(openssl rand 32 | base64 | tr '+/' '-_' | tr -d '=')"
printf '%s\n' "$key" | scripts/set-secrets.sh parley-peer-staging PARLEY_TEST_KEYS
printf 'heygent-conformance:%s' "$key" | gh secret set CONFORMANCE_PEER_STAGING_KEY --repo sainanee/heygent
unset key
```

## GitHub secrets: `gh secret set`

`gh secret set NAME --repo sainanee/heygent` asks for the value with hidden input; piped, it reads standard input.

```sh
fly tokens create org --name heygent-ci --expiry 8760h | gh secret set FLY_API_TOKEN --repo sainanee/heygent
```

That `fly tokens create org` prints nothing but the token is unverified. If `gh secret list --repo sainanee/heygent` then shows the secret but a workflow cannot authenticate, run `fly tokens create org --name heygent-ci --expiry 8760h` on its own, copy the token, and run `gh secret set FLY_API_TOKEN --repo sainanee/heygent`, pasting it into the hidden prompt. The token expires in a year: set a reminder.

## Rotating

- `PARLEY_SECRET_KEY`: only after a leak (it breaks recovery codes and stored webhooks). `set-secrets.sh <app> PARLEY_SECRET_KEY`, then `fly secrets deploy --app <app>`.
- `DATABASE_URL`: change the role's password (Fly dashboard, the cluster's Users tab; unverified), then `set-secrets.sh <app> DATABASE_URL` and `fly secrets deploy --app <app>`.
- A test key: repeat its block above, then `fly secrets deploy --app <staging app>`.
- `FLY_API_TOKEN`: `fly tokens list` and `fly tokens revoke <id>` for the old one, then set a new one as above.

To see which secrets an app has, without values: `fly secrets list --app <app>`.

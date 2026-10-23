#!/usr/bin/env bash
# check-database-login.sh <app>: one login to <app>'s database, made from Fly with the app's own stored DATABASE_URL and
# its pinned image, before a deploy relies on it. It runs a one-off machine (removed when it exits, never restarted,
# serving nothing) whose only job is `SELECT 1` through the image's own Postgres client, and prints a verdict and the
# error code, never the URL or the password.
#
# Why: a wrong password surfaces at deploy only as the server failing to start, and after a few attempts Supabase bans
# the machine's address (Database settings → Network bans), so later attempts read ECONNREFUSED and hide the cause.
#   ok      the login works
#   28P01   password authentication failed: fix the password (reset it in Supabase, or re-run set-secrets.sh)
#   ECONNREFUSED / ETIMEDOUT   the address is banned or unreachable: check Network bans, then the host
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: $0 <app>" >&2; exit 2; }
app="$1"
[[ "$app" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "an app name is lowercase letters, digits and hyphens" >&2; exit 2; }
root="$(cd "$(dirname "$0")/.." && pwd)"
folder=''
for toml in "$root"/servers/*/fly.toml; do
  if grep -Eq "^app[[:space:]]*=[[:space:]]*\"$app\"" "$toml"; then folder="$(dirname "$toml")"; fi
done
[ -n "$folder" ] || { echo "no servers/*/fly.toml has app = \"$app\"" >&2; exit 2; }
[ -f "$folder/image" ] || { echo "${folder#"$root"/} has no image pin yet" >&2; exit 2; }
image="$(cat "$folder/image")"
probe="$(mktemp -t check-db-login)"
trap 'rm -f "$probe"' EXIT
cat > "$probe" <<'JS'
const pg = require(require.resolve('pg', { paths: ['/app/apps/server'] }));
const tag = 'CHECK-DB-LOGIN ' + process.env.CHECK_TAG + ' ';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
c.connect().then(() => c.query('SELECT 1')).then(() => console.log(tag + 'ok'), (e) => console.log(tag + (e.code || e.name))).finally(() => c.end().catch(() => {}));
JS
tag="$(date +%s)-$RANDOM"
name="check-db-login-$tag"
fly machine run "$image" node /tmp/check-db-login.js --file-local "/tmp/check-db-login.js=$probe" \
  --file-local "/etc/parley/supabase-ca.crt=$root/certs/supabase-ca.crt" \
  --env "CHECK_TAG=$tag" --app "$app" --region sin --rm --restart no --name "$name" >/dev/null
line=''
for _ in $(seq 1 20); do
  line="$(fly logs --app "$app" --no-tail 2>/dev/null | sed -E 's/\x1b\[[0-9;]*m//g' | grep -o "CHECK-DB-LOGIN $tag [A-Za-z0-9_]*" | tail -1 || true)"
  [ -n "$line" ] && break
  sleep 3
done
result="${line#CHECK-DB-LOGIN "$tag" }"
echo "$app: ${result:-no answer (see fly logs --app $app)}"
[ "$result" = ok ]

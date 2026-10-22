#!/usr/bin/env bash
# set-secrets.sh <app> [SECRET_NAME...]
#
# Asks for each secret <app> needs (or only the ones named) with hidden input, and stages them all in Fly's secret
# store in one `fly secrets import --stage` (the next deploy picks them up). Values never appear on screen, on any
# command line, in a file or in a log: they stay in this shell's memory and go to flyctl on its standard input.
#
#   every app:     DATABASE_URL       the app's own database, as its own role (runbooks/deploy.md)
#                  PARLEY_SECRET_KEY  at least 32 characters (openssl rand -base64 32)
#   staging only:  PARLEY_TEST_KEYS   the conformance runner's test-interface key (43 base64url characters)
#
# A production app (any name not ending in -staging) never gets PARLEY_TEST_KEYS: asking for it is refused.
set -euo pipefail

TEST_PEER_LABEL=heygent-conformance

die() { echo "set-secrets: $*" >&2; exit 1; }
[ $# -ge 1 ] || die "usage: $0 <app> [DATABASE_URL|PARLEY_SECRET_KEY|PARLEY_TEST_KEYS ...]"
app="$1"
shift

root="$(cd "$(dirname "$0")/.." && pwd)"
folder=''
for toml in "$root"/servers/*/fly.toml; do
  if grep -Eq "^app[[:space:]]*=[[:space:]]*\"$app\"" "$toml"; then folder="$(dirname "$toml")"; fi
done
[ -n "$folder" ] || die "no servers/*/fly.toml has app = \"$app\""

case "$app" in
  *-staging) production=0 needed="DATABASE_URL PARLEY_SECRET_KEY PARLEY_TEST_KEYS" ;;
  *) production=1 needed="DATABASE_URL PARLEY_SECRET_KEY" ;;
esac
# Belt and braces: the folder's own settings must agree that a production app is in production mode.
if [ "$production" = 1 ] && ! grep -qx 'PARLEY_MODE=production' "$folder/server.env"; then
  die "$app is a production app but ${folder#"$root"/}/server.env does not say PARLEY_MODE=production"
fi

names="$needed"
if [ $# -gt 0 ]; then
  names="$*"
  for n in "$@"; do
    case " $needed " in
      *" $n "*) ;;
      *)
        if [ "$n" = PARLEY_TEST_KEYS ]; then die "refused: PARLEY_TEST_KEYS is test-mode only, and $app is a production app"; fi
        die "$n is not a secret $app takes (it takes: $needed)"
        ;;
    esac
  done
fi

command -v fly >/dev/null 2>&1 || die "flyctl (fly) is not on PATH"

# ask <prompt>: reads one line with hidden input into $answer.
ask() {
  answer=''
  printf '%s: ' "$1" >&2
  IFS= read -rs answer || true
  echo >&2
  [ -n "$answer" ] || die "nothing entered; nothing was set"
}

payload=''
for name in $names; do
  case "$name" in
    DATABASE_URL)
      ask "DATABASE_URL for $app (its own role on its own database, the direct URL)"
      case "$answer" in postgres://* | postgresql://*) ;; *) die "DATABASE_URL must start with postgres:// or postgresql://; nothing was set" ;; esac
      value="$answer"
      ;;
    PARLEY_SECRET_KEY)
      ask "PARLEY_SECRET_KEY for $app (at least 32 characters)"
      [ "${#answer}" -ge 32 ] || die "PARLEY_SECRET_KEY must be at least 32 characters; nothing was set"
      value="$answer"
      ;;
    PARLEY_TEST_KEYS)
      ask "test-interface key for $app's peer \"$TEST_PEER_LABEL\" (43 base64url characters)"
      # 32 bytes in unpadded base64url: 42 free characters, then one whose low 2 bits are zero (the server checks it).
      printf '%s' "$answer" | grep -Eqx '[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]' ||
        die "the key must be 32 bytes in base64url (43 characters, no padding); nothing was set"
      value="{\"$TEST_PEER_LABEL\":\"$answer\"}"
      ;;
  esac
  payload="${payload}${name}=${value}
"
done
answer=''
value=''

printf '%s' "$payload" | fly secrets import --app "$app" --stage
payload=''
echo "staged for $app: $names" >&2
echo "they take effect at the next deploy (or: fly secrets deploy --app $app)" >&2

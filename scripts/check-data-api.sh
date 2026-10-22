#!/usr/bin/env bash
# check-data-api.sh <supabase project ref>
#
# Checks from outside that a Supabase project does not serve Parley's tables through its Data API: neither REST
# (/rest/v1/) nor GraphQL (/graphql/v1, pg_graphql). Asks for the project's anon key with hidden input; the anon key
# is public by design, but it is not stored, printed or put on a command line here. Run it after the app's first
# deploy (before then Parley's tables do not exist, and an exposed API would look closed). Exits 0 when both refuse,
# 1 when either serves the server_keys table, 2 on a usage error. Needs curl.
set -euo pipefail

usage() { echo "usage: $0 <supabase project ref>" >&2; exit 2; }
[ $# -eq 1 ] || usage
# A project ref gives https://<ref>.supabase.co; a full http(s) base URL is accepted too (this script's tests use one).
if [[ "$1" =~ ^[a-z0-9]+$ ]]; then base="https://$1.supabase.co"
elif [[ "$1" =~ ^https?://[A-Za-z0-9.:-]+$ ]]; then base="$1"
else usage
fi

printf 'anon key for %s: ' "$base" >&2
IFS= read -rs key || true
echo >&2
[ -n "$key" ] || { echo "no key entered" >&2; exit 2; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# The key goes to curl as a header file on standard input, never on its command line.
request() { # <output file> <curl args...>
  local out="$1"
  shift
  printf 'apikey: %s\nAuthorization: Bearer %s\n' "$key" "$key" |
    curl -sS -o "$out" -w '%{http_code}' --max-time 15 -H @- "$@" 2>/dev/null || true
}

exposed=0
rest="$(request "$tmp/rest" "$base/rest/v1/server_keys?select=kid&limit=1")"
if [ "$rest" = 200 ]; then
  echo "EXPOSED: GET /rest/v1/server_keys answered 200" >&2
  exposed=1
else
  echo "ok   GET /rest/v1/server_keys answered $rest (not 200)"
fi

graphql="$(request "$tmp/graphql" -X POST -H 'content-type: application/json' \
  --data '{"query":"{ serverKeysCollection(first: 1) { edges { node { kid } } } }"}' "$base/graphql/v1")"
if [ "$graphql" = 200 ] && grep -q '"serverKeysCollection"' "$tmp/graphql" && ! grep -q '"errors"' "$tmp/graphql"; then
  echo "EXPOSED: GraphQL answers serverKeysCollection" >&2
  exposed=1
else
  echo "ok   GraphQL does not serve serverKeysCollection (status $graphql)"
fi

key=''
if [ "$exposed" -ne 0 ]; then
  echo "the Data API serves Parley's tables: turn it off now (runbooks/deploy.md step 2; runbooks/incident.md)" >&2
  exit 1
fi
echo "data API check passed for $base"

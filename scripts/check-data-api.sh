#!/usr/bin/env bash
# check-data-api.sh <supabase project ref>
#
# Checks from outside that a Supabase project does not serve Parley's tables through its Data API: neither REST
# (/rest/v1/) nor GraphQL (/graphql/v1, pg_graphql). Asks for the project's anon key with hidden input; the anon key
# is public by design, but it is not stored, printed or put on a command line here. Run it after the app's first
# deploy (before then Parley's tables do not exist, and an exposed API would look closed).
#
# It fails closed. Exit 0 only when both endpoints give a refusal it recognises:
#   REST     404 (the Data API off, or no such table in an exposed schema), 406 with PGRST106 (public is not an
#            exposed schema), or 401/403 with PostgreSQL's 42501 (permission denied: the API roles hold no privilege);
#   GraphQL  404 (off), 401/403 with 42501, or 200 with "errors" and no serverKeysCollection data.
# Exit 1 when either serves Parley's server_keys table (REST 200, or GraphQL data). Exit 2 for anything else: no
# answer, a 5xx, a 401 that is not a permission error (a mistyped or expired anon key: "Invalid API key"), an
# unknown answer, or a usage error. A 401/403 counts as a refusal only by its 42501 body, so a key the gateway
# rejects can never pass. Which code and body Supabase gives for each refusal is unverified (runbooks/deploy.md).
# Needs curl.
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
unverified=0
saw() { # <label> <verdict: refused|exposed|unverified> <detail>
  case "$2" in
    refused) echo "ok   $1: $3" ;;
    exposed) echo "EXPOSED: $1 $3" >&2; exposed=1 ;;
    *) echo "could not verify: $1 $3" >&2; unverified=1 ;;
  esac
}
permission_denied() { grep -q '"code" *: *"42501"' "$1"; }

rest="$(request "$tmp/rest" "$base/rest/v1/server_keys?select=kid&limit=1")"
case "$rest" in
  200) saw "GET /rest/v1/server_keys" exposed "answered 200" ;;
  404)
    if grep -q 'PGRST205' "$tmp/rest"; then
      saw "GET /rest/v1/server_keys" refused "answered 404: no server_keys table in an exposed schema (before the first deploy this proves nothing)"
    else
      saw "GET /rest/v1/server_keys" refused "answered 404 (the Data API is off)"
    fi
    ;;
  406) if grep -q 'PGRST106' "$tmp/rest"; then saw "GET /rest/v1/server_keys" refused "answered 406 PGRST106 (public is not exposed)"; else saw "GET /rest/v1/server_keys" unverified "answered 406 without PGRST106"; fi ;;
  401 | 403) if permission_denied "$tmp/rest"; then saw "GET /rest/v1/server_keys" refused "answered $rest 42501 (permission denied)"; else saw "GET /rest/v1/server_keys" unverified "answered $rest without a permission error (is the anon key right?)"; fi ;;
  *) saw "GET /rest/v1/server_keys" unverified "answered $rest" ;;
esac

graphql="$(request "$tmp/graphql" -X POST -H 'content-type: application/json' \
  --data '{"query":"{ serverKeysCollection(first: 1) { edges { node { kid } } } }"}' "$base/graphql/v1")"
case "$graphql" in
  200)
    if grep -q '"errors"' "$tmp/graphql"; then
      saw "POST /graphql/v1" refused "answered errors: serverKeysCollection is not served"
    elif grep -q '"serverKeysCollection"' "$tmp/graphql"; then
      saw "POST /graphql/v1" exposed "answered serverKeysCollection data"
    else
      saw "POST /graphql/v1" unverified "answered 200 with neither errors nor data"
    fi
    ;;
  404) saw "POST /graphql/v1" refused "answered 404 (off)" ;;
  401 | 403) if permission_denied "$tmp/graphql"; then saw "POST /graphql/v1" refused "answered $graphql 42501 (permission denied)"; else saw "POST /graphql/v1" unverified "answered $graphql without a permission error (is the anon key right?)"; fi ;;
  *) saw "POST /graphql/v1" unverified "answered $graphql" ;;
esac

key=''
if [ "$exposed" -ne 0 ]; then
  echo "the Data API serves Parley's tables: turn it off now (runbooks/deploy.md step 2; runbooks/incident.md)" >&2
  exit 1
fi
if [ "$unverified" -ne 0 ]; then
  echo "could not verify that $base refuses: check the project ref and anon key, and look again" >&2
  exit 2
fi
echo "data API check passed for $base"

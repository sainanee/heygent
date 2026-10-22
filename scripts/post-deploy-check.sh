#!/usr/bin/env bash
# post-deploy-check.sh <url> <expected mode: production|test>
#
# Checks a deployed Parley server from outside, as any peer sees it:
#   - discovery (GET /.well-known/parley) answers 200, and its "mode" is the expected mode;
#   - a production server names no "test_interface" and answers 404 on /test/v1/accounts (GET and POST);
#   - /healthz answers 200.
# Exits 0 when all hold, 1 when one fails, 2 on a usage error. Needs curl and jq.
set -euo pipefail

usage() { echo "usage: $0 <https url> <production|test>" >&2; exit 2; }
[ $# -eq 2 ] || usage
url="${1%/}"
mode="$2"
case "$mode" in production | test) ;; *) usage ;; esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failed=0
fail() { echo "FAIL $*" >&2; failed=1; }
ok() { echo "ok   $*"; }

# fetch <method> <path> <output file> [json body]: prints the status code (000 when there is no answer). Never follows
# redirects.
fetch() {
  if [ -n "${4:-}" ]; then
    curl -sS -o "$3" -w '%{http_code}' --max-time 15 -X "$1" -H 'content-type: application/json' --data "$4" "$url$2" 2>/dev/null || true
  else
    curl -sS -o "$3" -w '%{http_code}' --max-time 15 -X "$1" "$url$2" 2>/dev/null || true
  fi
}

# A machine that was just replaced may take a moment to answer: retry discovery for up to ~1 minute.
status=000
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  status="$(fetch GET /.well-known/parley "$tmp/discovery")"
  [ "$status" = 200 ] && break
  sleep 5
done

if [ "$status" != 200 ]; then
  fail "GET /.well-known/parley answered $status, not 200"
else
  ok "GET /.well-known/parley answered 200"
  got="$(jq -r '.mode // "(none)"' "$tmp/discovery" 2>/dev/null || echo '(not JSON)')"
  if [ "$got" = "$mode" ]; then ok "mode is $mode"; else fail "mode is $got, expected $mode"; fi
  if [ "$mode" = production ]; then
    if jq -e 'has("test_interface")' "$tmp/discovery" >/dev/null 2>&1; then
      fail "a production server names a test_interface in discovery"
    else
      ok "no test_interface in discovery"
    fi
  fi
fi

if [ "$mode" = production ]; then
  for method in GET POST; do
    body=''
    [ "$method" = POST ] && body='{"local":"post-deploy-check","timezone":"UTC"}'
    s="$(fetch "$method" /test/v1/accounts "$tmp/test-accounts" "$body")"
    if [ "$s" = 404 ]; then ok "$method /test/v1/accounts answered 404"; else fail "$method /test/v1/accounts answered $s, not 404"; fi
  done
fi

s="$(fetch GET /healthz "$tmp/healthz")"
if [ "$s" = 200 ]; then ok "GET /healthz answered 200"; else fail "GET /healthz answered $s, not 200"; fi

if [ "$failed" -ne 0 ]; then
  echo "post-deploy check FAILED for $url" >&2
  exit 1
fi
echo "post-deploy check passed for $url ($mode)"

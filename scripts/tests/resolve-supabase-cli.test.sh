#!/usr/bin/env bash
# Tests for scripts/lib/resolve-supabase-cli.sh and its callers (SMI-7223).
#
# Each case builds a throwaway repo root holding package.json, copies of the
# scripts under test, and stub CLIs. PATH is sealed to a stub dir plus
# /usr/bin:/bin, so a real supabase on the host (e.g. Homebrew's, which sits
# next to node) can never be picked up. A stub `npx` records any call; every
# case asserts it was never invoked.
set -uo pipefail

SRC=$(cd "$(dirname "$0")/.." && pwd)
PIN=2.111.0
NODE_BIN=$(command -v node)
fail=0
pass=0

ok() { pass=$((pass + 1)); echo "ok   $1"; }
bad() { fail=$((fail + 1)); echo "FAIL $1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; }

# new_root: fresh repo root; prints its path. Layout:
#   <root>/package.json, <root>/scripts/{lib/resolve-supabase-cli.sh,deploy-edge-functions.sh,validate-staging.sh}
#   <root>/stubbin/{node,npx,curl}  (prepended to PATH by run_in)
new_root() {
  local root
  root=$(cd "$(mktemp -d)" && pwd -P)
  mkdir -p "$root/scripts/lib" "$root/stubbin"
  cp "$SRC/lib/resolve-supabase-cli.sh" "$root/scripts/lib/"
  cp "$SRC/deploy-edge-functions.sh" "$SRC/validate-staging.sh" "$SRC/validate-edge-functions.sh" "$root/scripts/"
  # One function that passes validate-edge-functions.sh checks 1-3 cleanly.
  mkdir -p "$root/supabase/functions/health"
  : > "$root/supabase/functions/health/index.ts"
  printf '[functions.health]\nverify_jwt = false\n' > "$root/supabase/config.toml"
  printf '{"devDependencies":{"supabase":"%s"}}\n' "${1-$PIN}" > "$root/package.json"
  ln -s "$NODE_BIN" "$root/stubbin/node"
  cat > "$root/stubbin/npx" <<EOF
#!/bin/sh
echo "npx \$*" >> "$root/npx.log"
exit 97
EOF
  cat > "$root/stubbin/curl" <<'EOF'
#!/bin/sh
# Honour `-o FILE`, print a 200 for `-w %{http_code}`.
while [ $# -gt 0 ]; do
  case "$1" in -o) echo '{"ok":true}' > "$2"; shift 2 ;; *) shift ;; esac
done
printf '200'
EOF
  chmod +x "$root/stubbin/npx" "$root/stubbin/curl"
  echo "$root"
}

# make_cli PATH VERSION_STDOUT [VERSION_EXIT] [VERSION_STDERR]
# --version prints VERSION_STDOUT verbatim (printf %b) and logs to PATH.ver.
# Any other call logs its argv to PATH.log; `db push` fails when FAIL_DB_PUSH=1;
# `functions list` prints LIST_OUT (printf %b) when it is set.
make_cli() {
  local p="$1" out="$2" rc="${3:-0}" err="${4:-}"
  mkdir -p "$(dirname "$p")"
  cat > "$p" <<EOF
#!/bin/sh
if [ "\$1" = "--version" ]; then
  echo x >> "$p.ver"
  printf '%b' '$out'
  [ -n '$err' ] && printf '%s\n' '$err' >&2
  exit $rc
fi
echo "\$*" >> "$p.log"
if [ "\$1 \$2" = "db push" ] && [ "\${FAIL_DB_PUSH:-0}" = "1" ]; then exit 1; fi
if [ "\$1 \$2" = "functions list" ] && [ -n "\${LIST_OUT:-}" ]; then printf '%b' "\$LIST_OUT"; fi
exit 0
EOF
  chmod +x "$p"
}

# run_in ROOT CMD... : run with the sealed PATH, from ROOT.
run_in() {
  local root="$1"; shift
  (cd "$root" && env -i HOME="$root" PATH="$root/stubbin:/usr/bin:/bin" "$@")
}

# resolve ROOT : prints "rc=<n> cli=<SUPABASE_CLI[0]>" and the helper's stderr.
resolve() {
  # shellcheck disable=SC2016  # expanded by the inner bash, on purpose
  run_in "$1" bash -c 'source scripts/lib/resolve-supabase-cli.sh; resolve_supabase_cli "$PWD" >/dev/null 2>"$PWD/err.txt"; echo "rc=$? cli=${SUPABASE_CLI[0]:-}"'
}

no_npx() { [ ! -e "$1/npx.log" ]; }

# --- 1. local node_modules copy matches ---
r=$(new_root); make_cli "$r/node_modules/.bin/supabase" "$PIN\n"
got=$(resolve "$r")
if [ "$got" = "rc=0 cli=$r/node_modules/.bin/supabase" ] && no_npx "$r"; then ok "1 local copy selected"; else bad "1 local copy selected" "$got"; fi

# --- 2. CI shape: no node_modules, PATH copy matches ---
r=$(new_root); make_cli "$r/stubbin/supabase" "$PIN\n"
got=$(resolve "$r")
if [ "$got" = "rc=0 cli=$r/stubbin/supabase" ] && no_npx "$r"; then ok "2 PATH copy selected"; else bad "2 PATH copy selected" "$got"; fi

# --- 3. precedence: both match, local wins, PATH never consulted ---
r=$(new_root); make_cli "$r/node_modules/.bin/supabase" "$PIN\n"; make_cli "$r/stubbin/supabase" "$PIN\n"
# shellcheck disable=SC2016  # expanded by the inner bash, on purpose
got=$(run_in "$r" bash -c 'source scripts/lib/resolve-supabase-cli.sh; resolve_supabase_cli "$PWD" >/dev/null 2>&1 || exit 9; "${SUPABASE_CLI[@]}" functions list; echo "cli=${SUPABASE_CLI[0]}"')
if [ "$got" = "cli=$r/node_modules/.bin/supabase" ] && [ -s "$r/node_modules/.bin/supabase.log" ] \
  && [ ! -e "$r/stubbin/supabase.log" ] && [ ! -e "$r/stubbin/supabase.ver" ]; then
  ok "3 local wins when both match"
else
  bad "3 local wins when both match" "$got"
fi

# --- 4. local copy wrong version, PATH matches ---
r=$(new_root); make_cli "$r/node_modules/.bin/supabase" "2.99.0\n"; make_cli "$r/stubbin/supabase" "$PIN\n"
got=$(resolve "$r")
if [ "$got" = "rc=0 cli=$r/stubbin/supabase" ]; then ok "4 falls through to matching PATH copy"; else bad "4 falls through to matching PATH copy" "$got"; fi

# --- 5. every candidate mismatches ---
r=$(new_root); make_cli "$r/node_modules/.bin/supabase" "2.99.0\n"; make_cli "$r/stubbin/supabase" "3.1.0\n"
got=$(resolve "$r")
if [ "$got" = "rc=1 cli=" ] && grep -q "2.99.0" "$r/err.txt" && grep -q "3.1.0" "$r/err.txt" && grep -q "$PIN" "$r/err.txt"; then
  ok "5 all mismatch -> rc 1, both versions named"
else
  bad "5 all mismatch -> rc 1, both versions named" "$got / $(tr '\n' ' ' < "$r/err.txt")"
fi

# --- 6. no candidate at all ---
r=$(new_root)
got=$(resolve "$r")
if [ "$got" = "rc=1 cli=" ] && grep -q "no Supabase CLI found" "$r/err.txt"; then ok "6 no candidate -> rc 1"; else bad "6 no candidate -> rc 1" "$got"; fi

# --- 7. pin not exact ---
for p in '^2.111.0' ''; do
  r=$(new_root "$p"); make_cli "$r/stubbin/supabase" "$PIN\n"
  got=$(resolve "$r")
  if [ "$got" = "rc=1 cli=" ] && grep -q "not an exact" "$r/err.txt"; then ok "7 pin '$p' rejected"; else bad "7 pin '$p' rejected" "$got"; fi
done

# --- 8. strict parse ---
r=$(new_root); make_cli "$r/stubbin/supabase" "note\n$PIN\n"
got=$(resolve "$r"); if [ "$got" = "rc=1 cli=" ]; then ok "8a extra stdout rejected"; else bad "8a extra stdout rejected" "$got"; fi
r=$(new_root); make_cli "$r/stubbin/supabase" "$PIN\n" 3
got=$(resolve "$r"); if [ "$got" = "rc=1 cli=" ]; then ok "8b matching stdout + exit 3 rejected"; else bad "8b matching stdout + exit 3 rejected" "$got"; fi
r=$(new_root); make_cli "$r/stubbin/supabase" "$PIN\n" 0 "A new version of Supabase CLI is available"
got=$(resolve "$r"); if [ "$got" = "rc=0 cli=$r/stubbin/supabase" ]; then ok "8c stderr notice ignored"; else bad "8c stderr notice ignored" "$got"; fi

# --- 9. deploy-edge-functions.sh end to end ---
r=$(new_root); make_cli "$r/stubbin/supabase" "3.1.0\n"
run_in "$r" bash scripts/deploy-edge-functions.sh --project-ref testref --functions health > "$r/out.txt" 2>&1; rc=$?
if [ "$rc" -eq 1 ] && [ ! -e "$r/stubbin/supabase.log" ] && no_npx "$r"; then ok "9a deploy refuses on mismatch, nothing deployed"; else bad "9a deploy refuses on mismatch, nothing deployed" "rc=$rc $(tail -3 "$r/out.txt" | tr '\n' ' ')"; fi
r=$(new_root); make_cli "$r/stubbin/supabase" "$PIN\n"
run_in "$r" bash scripts/deploy-edge-functions.sh --project-ref testref --functions health > "$r/out.txt" 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ "$(cat "$r/stubbin/supabase.log")" = "functions deploy health --project-ref testref --no-verify-jwt" ] && no_npx "$r"; then
  ok "9b deploy runs the pinned CLI"
else
  bad "9b deploy runs the pinned CLI" "rc=$rc log=$(cat "$r/stubbin/supabase.log" 2>/dev/null) npx=$(cat "$r/npx.log" 2>/dev/null)"
fi

# --- 10. validate-staging.sh end to end ---
staging() { run_in "$1" env STAGING_SUPABASE_PROJECT_REF=stgref SUPABASE_PROJECT_REF=prodref STAGING_SUPABASE_DB_PASSWORD=x ${2:+FAIL_DB_PUSH=1} bash scripts/validate-staging.sh > "$1/out.txt" 2>&1; }
r=$(new_root); make_cli "$r/stubbin/supabase" "$PIN\n"
staging "$r"; rc=$?
log="$r/stubbin/supabase.log"
if [ "$rc" -eq 0 ] && [ "$(head -1 "$log")" = "link --project-ref stgref" ] && grep -qx "db push --linked" "$log" \
  && grep -q "^functions deploy health --project-ref stgref" "$log" && [ "$(tail -1 "$log")" = "link --project-ref prodref" ] && no_npx "$r"; then
  ok "10a staging run: every call on the pinned CLI, trap re-links prod"
else
  bad "10a staging run: every call on the pinned CLI, trap re-links prod" "rc=$rc $(tail -3 "$r/out.txt" | tr '\n' ' ')"
fi
r=$(new_root); make_cli "$r/stubbin/supabase" "$PIN\n"
staging "$r" fail; rc=$?
log="$r/stubbin/supabase.log"
if [ "$rc" -ne 0 ] && [ "$(cat "$log")" = "$(printf 'link --project-ref stgref\ndb push --linked\nlink --project-ref prodref')" ] && no_npx "$r"; then
  ok "10b staging failure in step 2: trap re-link uses the pinned CLI"
else
  bad "10b staging failure in step 2: trap re-link uses the pinned CLI" "rc=$rc log=$(tr '\n' '|' < "$log" 2>/dev/null)"
fi
r=$(new_root); make_cli "$r/stubbin/supabase" "3.1.0\n"
staging "$r"; rc=$?
if [ "$rc" -eq 1 ] && [ ! -e "$r/stubbin/supabase.log" ] && ! grep -q "Re-linking" "$r/out.txt" && no_npx "$r"; then ok "10c staging refuses on mismatch, no link and no re-link"; else bad "10c staging refuses on mismatch, no link and no re-link" "rc=$rc"; fi

# --- 11. validate-edge-functions.sh --check-deployment (SMI-7226) ---
# A `functions list` table in the CLI's pipe-delimited shape; NAME is column 2.
listing() { printf '  ID | NAME | SLUG\\n  ---|------|-----\\n  u1 | %s | %s\\n' "$1" "$1"; }
vef() {
  local root="$1"; shift
  run_in "$root" env "$@" bash scripts/validate-edge-functions.sh --check-deployment > "$root/out.txt" 2>&1
}
# 11a: the pinned local copy and a mismatched PATH copy; only the resolved
# (local) CLI may list. A bare `supabase functions list` would hit the PATH stub.
r=$(new_root); make_cli "$r/node_modules/.bin/supabase" "$PIN\n"; make_cli "$r/stubbin/supabase" "3.1.0\n"
vef "$r" SUPABASE_ACCESS_TOKEN=t SUPABASE_PROJECT_REF=ref "LIST_OUT=$(listing health)"; rc=$?
if [ "$rc" -eq 0 ] && [ "$(cat "$r/node_modules/.bin/supabase.log" 2>/dev/null)" = "functions list --project-ref ref" ] \
  && [ ! -e "$r/stubbin/supabase.log" ] && grep -q "health: Deployed" "$r/out.txt" && no_npx "$r"; then
  ok "11a check-deployment lists with the resolved CLI only"
else
  bad "11a check-deployment lists with the resolved CLI only" "rc=$rc local=$(cat "$r/node_modules/.bin/supabase.log" 2>/dev/null) path=$(cat "$r/stubbin/supabase.log" 2>/dev/null)"
fi
# 11b: no CLI matches the pin: error, exit 1, nothing listed.
r=$(new_root); make_cli "$r/stubbin/supabase" "3.1.0\n"
vef "$r" SUPABASE_ACCESS_TOKEN=t SUPABASE_PROJECT_REF=ref "LIST_OUT=$(listing health)"; rc=$?
if [ "$rc" -eq 1 ] && grep -q "no Supabase CLI matching" "$r/out.txt" && [ ! -e "$r/stubbin/supabase.log" ] && no_npx "$r"; then
  ok "11b check-deployment refuses on mismatch, nothing listed"
else
  bad "11b check-deployment refuses on mismatch, nothing listed" "rc=$rc $(tail -4 "$r/out.txt" | tr '\n' ' ')"
fi
# 11c: no token: skipped before any candidate is consulted.
r=$(new_root); make_cli "$r/stubbin/supabase" "$PIN\n"
vef "$r" SUPABASE_PROJECT_REF=ref; rc=$?
if [ "$rc" -eq 0 ] && grep -q "skipping deployment check" "$r/out.txt" && [ ! -e "$r/stubbin/supabase.ver" ] && no_npx "$r"; then
  ok "11c check-deployment without a token skips the resolver"
else
  bad "11c check-deployment without a token skips the resolver" "rc=$rc"
fi
# 11d: the pinned CLI lists a different function: health is NOT DEPLOYED.
r=$(new_root); make_cli "$r/stubbin/supabase" "$PIN\n"
vef "$r" SUPABASE_ACCESS_TOKEN=t SUPABASE_PROJECT_REF=ref "LIST_OUT=$(listing other-fn)"; rc=$?
if [ "$rc" -eq 1 ] && grep -q "health: NOT DEPLOYED" "$r/out.txt" \
  && [ "$(cat "$r/stubbin/supabase.log" 2>/dev/null)" = "functions list --project-ref ref" ] && no_npx "$r"; then
  ok "11d check-deployment reports a function missing from the listing"
else
  bad "11d check-deployment reports a function missing from the listing" "rc=$rc $(grep -i deployed "$r/out.txt" | tr '\n' ' ')"
fi

echo ""
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]

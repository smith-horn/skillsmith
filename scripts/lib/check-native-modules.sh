#!/bin/sh
# scripts/lib/check-native-modules.sh
# SMI-5513: Container native-binding health preflight.
#
# Catches a broken better-sqlite3 binding in the dev container, whatever the
# cause -- see ADR-165 and the SMI-6684 Wave 3 spec. A broken binding
# otherwise surfaces DOWNSTREAM as dozens of cryptic `db.close()`-on-undefined
# test failures in unrelated suites during the pre-push coverage phase. Turn
# that invisible failure into a loud, actionable one: fail fast, and on
# failure ask the mount-composition checker
# (scripts/lib/check-mount-composition.sh) WHY the binding is broken, before
# the Phase 2/4 test runs.
#
# Probe strategy: load better-sqlite3 THROUGH its real consumer —
# `@skillsmith/core`'s createDatabaseSync — not a root-level
# `require('better-sqlite3')`. better-sqlite3 has non-hoisted workspace-local
# copies (packages/core/node_modules, packages/doc-retrieval-mcp/...), so a root
# probe can pass while the copy the tests actually use is broken. The consumer
# path resolves whichever copy core uses, and the SYNC path has no WASM fallback,
# so a broken binding fails loudly — exactly what the DB/repository tests hit.
#
# Runs only when the pre-push TESTS run in the container (USE_DOCKER=1). On the
# host-fallback route (macOS worktree without SKILLSMITH_PRE_PUSH_DOCKER) the
# tests use the WASM fallback, so a container native binding is irrelevant.
#
# READ-ONLY (P-5) toward the repo tree and container, aside from transient
# temp state: loads a module, opens an in-memory DB, and -- only inside the
# failure path -- runs a read-only mount-composition check (ADR-165), which
# creates/removes a host mktemp(1) file and an in-container `mktemp -d` dir,
# both cleaned up on every exit path the code controls (Wave 3 spec §1.2/§6).
# The one DURABLE exception is one append-only JSON line written to
# $HOME/.skillsmith/logs/native-attribution.jsonl on every failure-path run
# (SMI-6684 Wave 3); never on success, never when USE_DOCKER != 1.
# RETENTION: none, deliberately -- one line per FAILED push, and ADR-165's
# falsifier and retirement test need a lifetime denominator to divide by.
# Opt-out: SKILLSMITH_SKIP_NATIVE_CHECK=1 (see docs/internal/process/guards-and-opt-outs.md).
# Attribution-only opt-out: SKILLSMITH_NATIVE_CHECK_ATTRIBUTION_DISABLE=1
# (still records; see nca_record below). Watchdog override (test-only, not a
# disable var): SKILLSMITH_NATIVE_CHECK_ATTRIBUTION_WATCHDOG_SECS.
#
# POSIX sh — no `local`, no `[[ ]]`, no arrays.

# Opt-out escape hatch.
if [ "${SKILLSMITH_SKIP_NATIVE_CHECK:-0}" = "1" ]; then
    exit 0
fi

# Test seam (SMI-5513): let the vitest suite drive the probe deterministically
# without a real container. SKILLSMITH_NATIVE_CHECK_TEST forces the code path:
#   ok   -> behave as if the probe passed (exit 0)
#   fail -> emit the remedy and exit 1
if [ -n "${SKILLSMITH_NATIVE_CHECK_TEST:-}" ]; then
    case "$SKILLSMITH_NATIVE_CHECK_TEST" in
        ok)   exit 0 ;;
        fail) USE_DOCKER=1 ; run_cmd() { return 1; } ;;
        *)    exit 0 ;;
    esac
else
    # Source the shared Docker-vs-host detection (USE_DOCKER, run_cmd, RUN_PREFIX).
    # Graceful degradation: if the helper is absent (older branch), skip.
    DETECT_LIB="$(dirname "$0")/hook-docker-detect.sh"
    if [ ! -r "$DETECT_LIB" ]; then
        exit 0
    fi
    # shellcheck source=./hook-docker-detect.sh
    . "$DETECT_LIB"

    # Only meaningful when the pre-push tests actually run in the container.
    if [ "${USE_DOCKER:-0}" != "1" ]; then
        exit 0
    fi
fi

# Probe better-sqlite3 through its real consumer.
if run_cmd node -e "require('@skillsmith/core').createDatabaseSync(':memory:').close()" >/dev/null 2>&1; then
    exit 0
fi

# ---- failure path (everything below runs only after a failed probe) ------
# Defined AFTER the success-path `exit 0` above, so a healthy push never
# parses it. Design: ADR-165 + smi-6684-verification-surface-integrity.md §
# Wave 3 (SMI-6684) -- this file implements that design, not restates it.
# ----------------------------------------------------------------------------
trap 'exit 1' PIPE

# ---- attribution: constants, JSON validator, in-container producer -------
NCA_TIMEOUT_SECS=10          # in-container checker budget (ADR-165 D-7)
NCA_EXEC_MARGIN_SECS=8       # host watchdog margin; UNMEASURED (spec R-5)
NCA_CHECKER=scripts/lib/check-mount-composition.sh

# JSON validation, run by node INSIDE the container. No single quotes allowed.
NCA_JS='
const fs=require("fs");let o;
try{o=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch(e){console.log("NCA1 parse invalid-json");process.exit(0)}
const bad=f=>{console.log("NCA1 parse bad:"+f);process.exit(0)};
if(o===null||typeof o!=="object"||Array.isArray(o))bad("root");
if(o.schema!==2)bad("schema");
for(const k of ["findings","not_evaluated","missing"]){if(!Number.isInteger(o[k])||o[k]<0)bad(k)}
if(o.mode!=="main"&&o.mode!=="worktree")bad("mode");
if(o.live_probes!==1)bad("live_probes");
const m=o.missing_destinations;
if(!Array.isArray(m)||m.some(x=>typeof x!=="string"||x===""||/[\n\r]/.test(x)))bad("missing_destinations");
if(m.length!==o.missing)bad("missing");
console.log("NCA1 parse ok");console.log("NCA1 mode "+o.mode);
console.log("NCA1 f "+o.findings);console.log("NCA1 e "+o.not_evaluated);
for(const x of m)console.log("NCA1 missing "+x);
'

# Runs INSIDE the container via run_cmd. Always exits 0 once it starts;
# every outcome is reported in the envelope, terminated by "NCA1 eof".
NCA_PRODUCER='
t=$1 c=$2 dis=$3 js=$4
if [ ! -f "$c" ]; then echo "NCA1 pre checker-absent"; echo "NCA1 eof"; exit 0; fi
for x in bash timeout node mktemp; do
  command -v "$x" >/dev/null 2>&1 || { echo "NCA1 pre $x-absent"; echo "NCA1 eof"; exit 0; }
done
d=$(mktemp -d 2>/dev/null) || d=
if [ -z "$d" ] || [ ! -d "$d" ]; then echo "NCA1 pre mktemp-failed"; echo "NCA1 eof"; exit 0; fi
trap "rm -rf \"\$d\"" EXIT
trap "exit 143" HUP INT PIPE TERM
if [ "$dis" = 1 ]; then SKILLSMITH_MOUNT_COMPOSITION_DISABLE=1; export SKILLSMITH_MOUNT_COMPOSITION_DISABLE; fi
echo "NCA1 pre ok"
echo "NCA1 dir $d"
echo "NCA1 disable ${SKILLSMITH_MOUNT_COMPOSITION_DISABLE:-0}"
timeout "$t" bash "$c" --mode auto --live --report "$d/report.json" >"$d/out" 2>&1
echo "NCA1 rc $?"
if [ -f "$d/report.json" ]; then
  echo "NCA1 report present"
  node -e "$js" "$d/report.json" || echo "NCA1 parse node-failed"
else
  echo "NCA1 report absent"
fi
echo "NCA1 out-begin"
cat "$d/out"
echo
echo "NCA1 out-end"
echo "NCA1 eof"
'

# nca_tier <path>: sets nca_t=1 (package-local copy) or 2 (root copy) when
# <path> is AT a better-sqlite3 path on @skillsmith/core's resolution chain:
# equal, a descendant, or an ancestor. Both /app and clamp-resolved forms.
nca_tier() {
    # This loop var was `nca_c` -- colliding with the GLOBAL `nca_c`
    # (container name; no `local` in POSIX sh). D-a's record-before-render
    # reorder exposed it (R-JSONL-2/R-PIPE went red); renamed to stop it.
    nca_x=${1%/}
    [ -n "$nca_x" ] || return 1
    for nca_cand in 1:/app/packages/core/node_modules/better-sqlite3 \
                 1:/packages/core/node_modules/better-sqlite3 \
                 2:/app/node_modules/better-sqlite3 \
                 2:/node_modules/better-sqlite3; do
        nca_n=${nca_cand%%:*}
        nca_p=${nca_cand#*:}
        case $nca_x in "$nca_p" | "$nca_p"/*) nca_t=$nca_n; return 0 ;; esac
        case $nca_p in "$nca_x"/*) nca_t=$nca_n; return 0 ;; esac
    done
    return 1
}

nca_note() { # kind tier path -- keep the FIRST evidence per kind+tier
    case "$1$2" in
        FALL1) [ -n "$nca_FALL1" ] || nca_FALL1=$3 ;;  FALL2) [ -n "$nca_FALL2" ] || nca_FALL2=$3 ;;
        MISS1) [ -n "$nca_MISS1" ] || nca_MISS1=$3 ;;  MISS2) [ -n "$nca_MISS2" ] || nca_MISS2=$3 ;;
        SUBS1) [ -n "$nca_SUBS1" ] || nca_SUBS1=$3 ;;  SUBS2) [ -n "$nca_SUBS2" ] || nca_SUBS2=$3 ;;
        SEED1) [ -n "$nca_SEED1" ] || nca_SEED1=$3 ;;  SEED2) [ -n "$nca_SEED2" ] || nca_SEED2=$3 ;;
        OTHR1) [ -n "$nca_OTHR1" ] || nca_OTHR1=$3 ;;  OTHR2) [ -n "$nca_OTHR2" ] || nca_OTHR2=$3 ;;
    esac
}

nca_scan_line() { # one COMPLETE line of checker stdout
    case $1 in
        'FAIL ['*) nca_fails=$((nca_fails + 1)) ;;
        '[mount-composition] '*' in-scope destination(s) checked; '*) nca_summary=1; return 0 ;;
        *) return 0 ;;
    esac
    case $1 in
        'FAIL [A2] declared but NOT mounted: '*) return 0 ;; # mount absence comes from JSON only
        'FAIL [A4] STALE SEED at '*)
            nca_r=${1#'FAIL [A4] STALE SEED at '}; nca_s=${nca_r%%: *}; nca_k=OTHR ;;
        'FAIL [A4] '*' -- destination is NOT mounted -- READ-ONLY-PARENT FALL-THROUGH: '*)
            nca_r=${1#'FAIL [A4] '}; nca_s=${nca_r%% *}; nca_k=FALL ;;
        'FAIL [A4] '*' -- destination IS mounted, so the SEEDED VOLUME CONTENT itself is wrong (not a fall-through)')
            nca_r=${1#'FAIL [A4] '}; nca_s=${nca_r%% *}; nca_k=SEED ;;
        'FAIL [A2] '*' is mounted but SUBSTITUTED: '*)
            nca_r=${1#'FAIL [A2] '}; nca_s=${nca_r%% *}; nca_k=SUBS ;;
        'FAIL [A6] declared :ro but mounted rw: '*) return 0 ;; # MED-1: mode mismatch on an ALREADY-mounted dest says nothing about the binding
        'FAIL ['*'] '*)
            # F-6/F-7: any assertion ID; subject is the FIRST " /"-prefixed
            # token, then stops scanning (LOW-4) -- some lines open with prose.
            nca_r=" ${1#*'] '}"
            case $nca_r in *' /'*) ;; *) return 0 ;; esac
            nca_s=/${nca_r#*' /'}; nca_s=${nca_s%% *}; nca_s=${nca_s%[:,)]}; nca_k=OTHR ;;
        *) return 0 ;;
    esac
    nca_tier "$nca_s" || return 0
    nca_note "$nca_k" "$nca_t" "$nca_s"
}

# nca_attrib: classifies the ONE attribution run into (NCA_CATEGORY,
# NCA_REASON) per the staged classifier, and a separate (NCA_CAUSE,
# NCA_TIER, NCA_EVIDENCE) attribution layer. Always returns 0 once it has
# classified something -- including every error state (TIMEOUT, UNEXPECTED,
# UNAVAILABLE, ...), which are classifications, not failures of this
# function. A non-zero return means nca_attrib itself broke (a bug, not a
# documented state); the caller's `|| printf` fallback exists for that.
nca_attrib() {
    NCA_CATEGORY= NCA_REASON= NCA_CAUSE=NOT-DETERMINED NCA_EVIDENCE= NCA_TIER=
    NCA_MODE= NCA_F= NCA_E= NCA_MISMATCH=0
    nca_FALL1= nca_FALL2= nca_MISS1= nca_MISS2= nca_SUBS1= nca_SUBS2=
    nca_SEED1= nca_SEED2= nca_OTHR1= nca_OTHR2=
    nca_pre= nca_rc= nca_report= nca_parse= nca_eof=0 nca_fails=0 nca_summary=0 nca_disable=0
    nca_env=$(mktemp 2>/dev/null) || { NCA_CATEGORY=UNEXPECTED; NCA_REASON=host-mktemp; return 0; }
    nca_wd=$((NCA_TIMEOUT_SECS + NCA_EXEC_MARGIN_SECS))
    # F-8: a range check, not a single `0` exclusion -- `00`/`000` pass an
    # all-digits check without being literally `0`. LOW-2: normalize
    # leading zeros too (`05`/`010`), or they survive verbatim into the reason.
    case ${SKILLSMITH_NATIVE_CHECK_ATTRIBUTION_WATCHDOG_SECS:-} in
        '') ;;
        *[!0-9]*) ;;
        *) nca_kv=$SKILLSMITH_NATIVE_CHECK_ATTRIBUTION_WATCHDOG_SECS
            while :; do case $nca_kv in 0?*) nca_kv=${nca_kv#0} ;; *) break ;; esac; done
            [ "$nca_kv" -ge 1 ] 2>/dev/null && [ "$nca_kv" -le 600 ] 2>/dev/null && nca_wd=$nca_kv ;;
    esac

    (run_cmd sh -c "$NCA_PRODUCER" nca "$NCA_TIMEOUT_SECS" "$NCA_CHECKER" \
        "${SKILLSMITH_MOUNT_COMPOSITION_DISABLE:-0}" "$NCA_JS") >"$nca_env" 2>"$nca_env.err" </dev/null &
    nca_pid=$!
    (
        trap 'kill "$nca_sl" 2>/dev/null; exit 0' TERM
        sleep "$nca_wd" &
        nca_sl=$!
        wait "$nca_sl"
        : >"$nca_env.fired"
        kill "$nca_pid" 2>/dev/null
    ) >/dev/null 2>&1 </dev/null &
    nca_wdp=$!
    wait "$nca_pid" 2>/dev/null
    nca_xrc=$?
    kill "$nca_wdp" 2>/dev/null
    wait "$nca_wdp" 2>/dev/null

    nca_st=meta nca_prev= nca_hp=0
    # F-10/MED-2: nca_nl tracks whether this line ended in a real newline --
    # an unterminated final line is never trustworthy evidence, so BOTH meta
    # (e.g. a cut "NCA1 missing ...") and tail (a cut "NCA1 eof") skip it.
    while nca_nl=1; IFS= read -r nca_line || { nca_nl=0; [ -n "$nca_line" ]; }; do
        case $nca_st in
            meta)
                [ "$nca_nl" = 1 ] || continue
                case $nca_line in
                    'NCA1 pre '*) nca_pre=${nca_line#'NCA1 pre '} ;;
                    'NCA1 disable '*) nca_disable=${nca_line#'NCA1 disable '} ;;
                    'NCA1 rc '*) nca_rc=${nca_line#'NCA1 rc '} ;;
                    'NCA1 report '*) nca_report=${nca_line#'NCA1 report '} ;;
                    'NCA1 parse '*) nca_parse=${nca_line#'NCA1 parse '} ;;
                    'NCA1 mode '*) NCA_MODE=${nca_line#'NCA1 mode '} ;;
                    'NCA1 f '*) NCA_F=${nca_line#'NCA1 f '} ;;
                    'NCA1 e '*) NCA_E=${nca_line#'NCA1 e '} ;;
                    'NCA1 missing '*) nca_m=${nca_line#'NCA1 missing '}
                        nca_tier "$nca_m" && nca_note MISS "$nca_t" "$nca_m" ;;
                    'NCA1 out-begin') nca_st=out ;;
                    'NCA1 eof') nca_eof=1 ;;
                esac ;;
            out)
                if [ "$nca_line" = 'NCA1 out-end' ]; then
                    nca_st=tail   # the held-back line is the producer's newline or a partial line: dropped
                else
                    [ "$nca_hp" = 1 ] && nca_scan_line "$nca_prev"
                    nca_prev=$nca_line nca_hp=1
                fi ;;
            tail) [ "$nca_nl" = 1 ] && [ "$nca_line" = 'NCA1 eof' ] && nca_eof=1 ;;
        esac
    done <"$nca_env"

    # ---- category: staged (spec §3.1) ----
    if [ -f "$nca_env.fired" ] && [ "$nca_eof" != 1 ]; then
        NCA_CATEGORY=TIMEOUT; NCA_REASON=host-watchdog:${nca_wd}s
    elif [ "$nca_xrc" != 0 ]; then
        NCA_CATEGORY=UNEXPECTED; NCA_REASON=exec-exit:$nca_xrc
    elif [ "$nca_eof" != 1 ]; then
        NCA_CATEGORY=UNEXPECTED; NCA_REASON=envelope-truncated
    elif [ "$nca_pre" = checker-absent ]; then
        NCA_CATEGORY=UNAVAILABLE; NCA_REASON=checker-absent
    elif [ "$nca_pre" != ok ]; then
        NCA_CATEGORY=UNEXPECTED; NCA_REASON=precondition:$nca_pre
    elif [ "$nca_rc" = 124 ]; then
        NCA_CATEGORY=TIMEOUT; NCA_REASON=checker-timeout:${NCA_TIMEOUT_SECS}s
    elif [ "$nca_rc" != 0 ]; then
        NCA_CATEGORY=UNEXPECTED; NCA_REASON=checker-exit:$nca_rc
    elif [ "$nca_report" != present ]; then
        NCA_CATEGORY=NO-REPORT
        if [ "$nca_disable" = 1 ]; then NCA_REASON=checker-disabled
        else NCA_REASON=report-absent; fi
    elif [ "$nca_parse" != ok ]; then
        NCA_CATEGORY=MALFORMED; NCA_REASON=report:$nca_parse
    else
        case $NCA_F in '' | *[!0-9]*) NCA_CATEGORY=MALFORMED; NCA_REASON=report:parser-incomplete ;; esac
        case $NCA_E in '' | *[!0-9]*) NCA_CATEGORY=MALFORMED; NCA_REASON=report:parser-incomplete ;; esac
        if [ -z "$NCA_CATEGORY" ]; then
            if [ "$NCA_F" = 0 ] && [ "$NCA_E" = 0 ]; then NCA_CATEGORY=CLEAN
            elif [ "$NCA_F" = 0 ]; then NCA_CATEGORY=PARTIAL
            elif [ "$NCA_E" = 0 ]; then NCA_CATEGORY=FINDINGS
            else NCA_CATEGORY='FINDINGS + PARTIAL'; fi
        fi
    fi
    nca_grid=0
    case $NCA_CATEGORY in CLEAN | PARTIAL | FINDINGS | 'FINDINGS + PARTIAL') nca_grid=1 ;; esac
    if [ "$nca_grid" = 1 ] && [ "$nca_summary" = 1 ] && [ "$nca_fails" != "$NCA_F" ]; then
        NCA_MISMATCH=1
    fi

    # ---- cause: separate layer; precedence per tier ----
    # nca_ct: nca_t is nca_tier()'s return (3rd such collision; no `local`).
    if [ "$NCA_MISMATCH" != 1 ]; then
        for nca_ct in 1 2; do
            eval "nca_fa=\$nca_FALL$nca_ct nca_mi=\$nca_MISS$nca_ct nca_su=\$nca_SUBS$nca_ct nca_se=\$nca_SEED$nca_ct nca_ot=\$nca_OTHR$nca_ct"
            if [ -n "$nca_fa" ]; then NCA_CAUSE=FALL-THROUGH NCA_EVIDENCE=$nca_fa
            elif [ -n "$nca_mi" ]; then NCA_CAUSE=MOUNT-MISSING NCA_EVIDENCE=$nca_mi
            elif [ -n "$nca_su" ]; then NCA_CAUSE=MOUNT-SUBSTITUTED NCA_EVIDENCE=$nca_su
            elif [ -n "$nca_se" ]; then NCA_CAUSE=SEED-CONTENT NCA_EVIDENCE=$nca_se
            elif [ -n "$nca_ot" ]; then NCA_CAUSE=OTHER-NATIVE-FINDING NCA_EVIDENCE=$nca_ot
            else continue; fi
            NCA_TIER=$nca_ct
            break
        done
        if [ -z "$NCA_TIER" ] && [ "$nca_grid" = 1 ] && [ "$nca_summary" = 1 ]; then
            NCA_CAUSE=NO-NATIVE-FINDING
        fi
    fi
    rm -f "$nca_env" "$nca_env.err" "$nca_env.fired"
    return 0
}

# nca_render: the attribution block, <=5 lines, printf only (the READ-ONLY
# source guard exempts printf lines -- see scripts/tests/check-native-modules.test.ts).
nca_render() {
    nca_c=${DOCKER_CONTAINER:-skillsmith-dev-1}
    case $NCA_CATEGORY in
        CLEAN | PARTIAL | FINDINGS | 'FINDINGS + PARTIAL') nca_det="$NCA_F findings, $NCA_E not evaluated" ;;
        *) nca_det=$NCA_REASON ;;
    esac
    if [ "$NCA_MISMATCH" = 1 ]; then
        printf '  Mount check: %s, REPORT/OUTPUT MISMATCH -- cause: %s [report says %s findings; output shows %s]\n' "$NCA_CATEGORY" "$NCA_CAUSE" "$NCA_F" "$nca_fails"
    else
        printf '  Mount check: %s -- cause: %s [%s]\n' "$NCA_CATEGORY" "$NCA_CAUSE" "$nca_det"
    fi
    nca_w=; [ "$NCA_TIER" = 2 ] && nca_w=' (root copy)'
    # spec §4.4: positive evidence is used in every state, including a
    # non-grid one (e.g. TIMEOUT with a partial-output FALL-THROUGH) -- when
    # that happens, the cause's own L2 line is shown with this suffix rather
    # than the generic "cause was not examined" text.
    nca_pfx=
    if [ "$nca_grid" != 1 ] && [ "$NCA_CAUSE" != NOT-DETERMINED ]; then
        nca_pfx=' (from partial output)'
    fi
    case $NCA_CAUSE in
        FALL-THROUGH) printf '    better-sqlite3 mount is detached; the host macOS binary is served in its place%s: %s%s\n' "$nca_w" "$NCA_EVIDENCE" "$nca_pfx" ;;
        MOUNT-MISSING) printf '    the declared mount at or above better-sqlite3 is not mounted%s: %s%s\n' "$nca_w" "$NCA_EVIDENCE" "$nca_pfx" ;;
        MOUNT-SUBSTITUTED) printf '    something other than the declared volume is mounted at better-sqlite3%s: %s%s\n' "$nca_w" "$NCA_EVIDENCE" "$nca_pfx" ;;
        SEED-CONTENT) printf '    the better-sqlite3 volume is mounted but holds a non-Linux binary%s: %s%s\n' "$nca_w" "$NCA_EVIDENCE" "$nca_pfx" ;;
        OTHER-NATIVE-FINDING) printf '    the checker reported a finding at better-sqlite3 that this message does not classify%s: %s%s\n' "$nca_w" "$NCA_EVIDENCE" "$nca_pfx" ;;
        NO-NATIVE-FINDING) printf '    nothing is wrong at better-sqlite3 now: never built, or a mount fault already repaired -- not distinguishable here\n' ;;
        *)
            case $NCA_CATEGORY in
                UNAVAILABLE) printf '    this branch predates the mount checker, so the cause was not examined; this is not a clean result\n' ;;
                *)
                    # F-4: spec §5.2's per-state L2 table, keyed on
                    # CATEGORY:REASON (NCA_CAUSE is NOT-DETERMINED here).
                    if [ "$NCA_MISMATCH" = 1 ]; then
                        printf '    the report and the checker output disagree, so no cause is named; this is not a clean result\n'
                    else
                        case $NCA_CATEGORY:$NCA_REASON in
                            TIMEOUT:checker-timeout*) printf '    the check did not finish within %ss, so the cause was not examined; this is not a clean result\n' "$NCA_TIMEOUT_SECS" ;;
                            TIMEOUT:*) printf '    the check did not finish within %ss, so the cause was not examined; this is not a clean result\n' "$nca_wd" ;;
                            UNEXPECTED:*) printf '    the check could not run to completion, so the cause was not examined; this is not a clean result\n' ;;
                            MALFORMED:*) printf '    the check ran but its report was unusable, so the cause was not examined; this is not a clean result\n' ;;
                            NO-REPORT:checker-disabled) printf '    the checker is disabled (SKILLSMITH_MOUNT_COMPOSITION_DISABLE=1), so the cause was not examined; this is not a clean result\n' ;;
                            NO-REPORT:*) printf '    the check exited without writing a report, so the cause was not examined; this is not a clean result\n' ;;
                            *) printf '    the cause was not examined; this is not a clean result\n' ;;
                        esac
                    fi ;;
            esac ;;
    esac
    case $NCA_CAUSE in
        MOUNT-SUBSTITUTED)
            if [ "$NCA_MODE" = worktree ]; then printf '  Next: ./scripts/worktree-docker.sh stop && ./scripts/worktree-docker.sh start\n'
            else printf '  Next: docker compose --profile dev up -d --force-recreate dev   (from the main checkout)\n'; fi ;;
        SEED-CONTENT) printf '  Next: attach the full check output below to SMI-6547 -- a restart or rebuild re-seeds the same content\n' ;;
        OTHER-NATIVE-FINDING) printf '  Next: run the full check below and act on its better-sqlite3 FAIL line\n' ;;
        *) printf '  Next: docker restart %s\n' "$nca_c" ;;
    esac
    if [ "$NCA_CAUSE" = FALL-THROUGH ] || { [ "$NCA_CAUSE" = MOUNT-MISSING ] && [ "$NCA_MODE" != worktree ]; }; then
        printf '  Still shown after the restart: docker stop %s && docker start %s\n' "$nca_c" "$nca_c"
    elif [ "$NCA_CAUSE" = MOUNT-MISSING ] && [ "$NCA_MODE" = worktree ]; then
        printf '  Still shown after the restart: docker stop %s && docker start %s; survives that too: ./scripts/repair-worktrees.sh (main checkout), then ./scripts/worktree-docker.sh stop && ./scripts/worktree-docker.sh start\n' "$nca_c" "$nca_c"
    fi
    if [ "$NCA_CATEGORY" = UNAVAILABLE ]; then
        printf '  The checker ships on main; rebase this branch to get it.\n'
    elif [ "$NCA_CATEGORY" = TIMEOUT ]; then
        printf '  Full check (no time limit): docker exec -w /app %s bash %s --live --no-report\n' "$nca_c" "$NCA_CHECKER"
    else
        printf '  Full check: docker exec -w /app %s bash %s --live --no-report\n' "$nca_c" "$NCA_CHECKER"
    fi
}

# nca_json_safe <value>: prints <value> if every char is in the conservative
# allow-list, else prints "invalid" -- addendum A-1. Never trust a container
# name or other operator-influenced string to be JSON-safe on its own.
# `=` is added to the addendum's literal allow-list ([A-Za-z0-9 ._:/+,@-]):
# measured (2026-09-16, host smoke test) that without it the OFF reason
# "SKILLSMITH_NATIVE_CHECK_ATTRIBUTION_DISABLE=1" -- the exact label this
# same spec's §7.1 requires -- always degraded to "invalid" on the one
# guaranteed-legitimate OFF run. `=` carries no JSON-escaping risk.
# F-17: letters are spelled out literally, not an A-Z/a-z RANGE -- a shell
# bracket-expression range is collation-order-dependent: measured under
# LC_ALL=en_US.UTF-8 that an accented letter sorts inside A-Z and wrongly
# passes as "safe". The literal set depends only on the ASCII bytes.
nca_json_safe() {
    case $1 in
        *[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789\ ._:/+,@=-]*) printf 'invalid' ;;
        *) printf '%s' "$1" ;;
    esac
}

# nca_record <container> <mode> <state> <reason> <cause> <tier> <wall_secs>:
# append-only, best-effort JSONL to $HOME/.skillsmith/logs/native-attribution.jsonl
# (addendum A-1). A failure to write it never changes the exit status --
# always returns 0 -- and (F-3: `2>/dev/null` applied BEFORE the `>>` append
# target below) never writes to stdout or stderr either.
nca_record() {
    nca_rec_home=${HOME:-}
    [ -n "$nca_rec_home" ] || return 0
    nca_rec_dir="$nca_rec_home/.skillsmith/logs"
    mkdir -p "$nca_rec_dir" 2>/dev/null || return 0
    nca_rec_at=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)
    printf '{"schema":1,"at":"%s","container":"%s","mode":"%s","state":"%s","reason":"%s","cause":"%s","tier":%s,"wall_secs":%s}\n' \
        "$(nca_json_safe "$nca_rec_at")" "$(nca_json_safe "$1")" "$(nca_json_safe "$2")" \
        "$(nca_json_safe "$3")" "$(nca_json_safe "$4")" "$(nca_json_safe "$5")" \
        "${6:-0}" "${7:-0}" \
        2>/dev/null >>"$nca_rec_dir/native-attribution.jsonl"
    return 0
}

# ---- frame: header + description (spec §5.1) ------------------------------
if [ -t 1 ]; then
    NCA_HDR_RED="${HOOK_DETECT_RED:-\033[0;31m}"
    NCA_HDR_NC="${HOOK_DETECT_NC:-\033[0m}"
else
    NCA_HDR_RED=
    NCA_HDR_NC=
fi
printf '\n'
printf "${NCA_HDR_RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NCA_HDR_NC}\n"
printf "${NCA_HDR_RED}  ✗ Native SQLite binding is broken in the dev container${NCA_HDR_NC}\n"
printf "${NCA_HDR_RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NCA_HDR_NC}\n"
printf '\n'
nca_c=${DOCKER_CONTAINER:-skillsmith-dev-1}
printf '  @skillsmith/core could not open a database (better-sqlite3 binding) in %s.\n' "$nca_c"
printf '  More than one cause produces this; the mount check below names the one it\n'
printf '  observed, if any. Left unfixed it surfaces later as dozens of cryptic\n'
printf '  `db.close()`-on-undefined test failures in unrelated suites.\n'
printf '\n'

# ---- pick one: OFF / skip on /dev/null / run attribution (spec §1.1) -----
if [ "${SKILLSMITH_NATIVE_CHECK_ATTRIBUTION_DISABLE:-0}" = "1" ]; then
    printf '  Mount check: OFF -- cause: NOT-DETERMINED [SKILLSMITH_NATIVE_CHECK_ATTRIBUTION_DISABLE=1]\n'
    printf '    cause attribution is switched off (SKILLSMITH_NATIVE_CHECK_ATTRIBUTION_DISABLE=1)\n'
    printf '  Next: docker restart %s\n' "$nca_c"
    printf '  Full check: docker exec -w /app %s bash %s --live --no-report\n' "$nca_c" "$NCA_CHECKER"
    nca_record "$nca_c" unknown OFF 'SKILLSMITH_NATIVE_CHECK_ATTRIBUTION_DISABLE=1' NOT-DETERMINED 0 0
elif [ /dev/stdout -ef /dev/null ]; then
    # Attribution is skipped -- no exec, no block -- but this is still a
    # real failure-path exposure, so it is still recorded (addendum A-1).
    nca_record "$nca_c" unknown SKIPPED-DEVNULL '' NOT-DETERMINED 0 0
else
    (
        # D-a: record BEFORE render (overrides addendum "after rendering")
        # -- render can die of SIGPIPE mid-block, so recording first leaves
        # one row even then. wall_secs stays scoped to nca_attrib alone.
        nca_t0=$(date +%s 2>/dev/null || echo 0)
        nca_attrib
        nca_attrib_rc=$? # LOW-3: was `nca_rc`, colliding with nca_attrib's OWN internal nca_rc (checker rc) -- same class as nca_cand
        nca_t1=$(date +%s 2>/dev/null || echo 0)
        nca_rec_state=$NCA_CATEGORY
        if [ "$NCA_MISMATCH" = 1 ]; then nca_rec_state="$NCA_CATEGORY, REPORT/OUTPUT MISMATCH"; fi
        nca_record "$nca_c" "${NCA_MODE:-unknown}" "$nca_rec_state" "$NCA_REASON" "$NCA_CAUSE" \
            "${NCA_TIER:-0}" "$((nca_t1 - nca_t0))"
        if [ "$nca_attrib_rc" = 0 ]; then nca_render; fi
        [ "$nca_attrib_rc" = 0 ]
    ) || printf '  Mount check: UNEXPECTED -- cause: NOT-DETERMINED [attribution-error]\n'
fi

# ---- frame: footer (spec §5.1) --------------------------------------------
printf '\n'
printf '  Never run `npm install` in the container. To refresh dependencies, run\n'
printf '  ./scripts/regen-lockfile.sh from the main checkout -- it runs the mount gate first.\n'
printf '  Certain it is a false positive? SKILLSMITH_SKIP_NATIVE_CHECK=1 git push\n'
exit 1

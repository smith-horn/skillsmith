#!/usr/bin/env bash
# scripts/lib/entrypoint-tier-b-pairs.sh
# SMI-7201 Wave 2: container-boot Tier-B pair check. Sourced by
# docker-entrypoint.sh after the Tier-B restore block.
#
#   check_tier_b_pairs <checker-path> <flag-path> <checkout-kind>
#
# kind is "worktree" or "main". Runs scripts/lib/check-tier-b-pairs.mjs (the
# Wave 1 check), prints a block saying what it found, and records the state in
# the flag file. ALWAYS returns 0: the container starts on every outcome, so a
# broken pair is reported loudly, never turned into a crash loop. The restore
# block's "seed marker current" wording says nothing about the pair; this does.
#
# Flag file: line 1 "state=<mismatch|not-evaluated|disabled|unavailable>",
# line 2 "source=boot", then the check's own "[tier-b-pairs]" lines (names,
# versions and specs only). A CLEAN result removes the flag; there is no
# "clean" state.
#
# Opt-out: SKILLSMITH_TIER_B_PAIR_CHECK_DISABLE=1 runs no check and records
# state=disabled (registered in docs/internal/process/guards-and-opt-outs.md).

# _tbp_say <color> <text>: the text is printed verbatim (%s), never as an escape
# sequence, so a backslash in the check's output cannot be reinterpreted.
_tbp_say() {
    printf '%b%s%b\n' "$1" "$2" "${NC:-}"
}

_tbp_remedy() {
    if [ "$1" = "worktree" ]; then
        echo "Remedy: run on the host from this worktree's root: docker compose --profile dev build dev && ./scripts/worktree-docker.sh stop && ./scripts/worktree-docker.sh start"
    else
        echo "Remedy: run on the host from the main checkout's root: sh scripts/lib/print-deps-refresh-advice.sh \"\$PWD\", then run the sequence it prints. A rebuild alone does not change the named node_modules volume."
    fi
}

# _tbp_write_flag <flag> <state> <body>: atomic (temp file in the same
# directory, then mv). Returns non-zero on any failure; the caller reports it.
_tbp_write_flag() {
    local flag="$1" state="$2" body="$3" dir tmp=""
    dir="$(dirname "$flag")"
    if mkdir -p "$dir" 2>/dev/null \
        && tmp="$(mktemp "$dir/.tier-b-pairs.XXXXXX" 2>/dev/null)" \
        && { printf 'state=%s\nsource=boot\n' "$state"; [ -z "$body" ] || printf '%s\n' "$body"; } >"$tmp" 2>/dev/null \
        && mv -f "$tmp" "$flag" 2>/dev/null; then
        return 0
    fi
    [ -z "$tmp" ] || rm -f "$tmp" 2>/dev/null || true
    return 1
}

# _tbp_record <flag> <state> <body>: write the flag, and say so (red) if it fails.
_tbp_record() {
    local r="${RED:-}"
    if ! _tbp_write_flag "$1" "$2" "$3"; then
        _tbp_say "$r" "[entrypoint] Tier-B pair check: could not write the state flag ${1} (state=${2}); the result above is only on this console."
    fi
}

# _tbp_lines <output> <needle>: the output lines containing <needle>.
_tbp_lines() {
    printf '%s\n' "$1" | grep -F -- "$2" || true
}

check_tier_b_pairs() {
    local checker="$1" flag="$2" kind="$3"
    local r="${RED:-}" y="${YELLOW:-}" g="${GREEN:-}"
    local out="" rc=0 clean_line="" info_lines="" args=()

    if [ "${SKILLSMITH_TIER_B_PAIR_CHECK_DISABLE:-}" = "1" ]; then
        _tbp_say "$y" "[entrypoint] Tier-B pair check DISABLED via SKILLSMITH_TIER_B_PAIR_CHECK_DISABLE=1 (SMI-7201): native/JS pairs NOT verified."
        _tbp_record "$flag" disabled ""
        return 0
    fi

    if [ ! -f "$checker" ]; then
        _tbp_say "$y" "[entrypoint] Tier-B pair check UNAVAILABLE (SMI-7201): ${checker} is missing, so native/JS pairs are NOT verified. Rebuild or update this branch."
        _tbp_record "$flag" unavailable "[tier-b-pairs] UNAVAILABLE checker missing"
        return 0
    fi

    [ "$kind" = "worktree" ] && args=(--worktree)
    # stdout is discarded: the checker writes everything to stderr. Status is
    # taken from the command itself, never inferred through a pipe.
    out="$(node "$checker" "${args[@]}" 2>&1 >/dev/null)" || rc=$?

    case "$rc" in
        0)
            clean_line="$(_tbp_lines "$out" "] CLEAN" | head -n 1)"
            if [ -n "$clean_line" ]; then
                _tbp_say "$g" "[entrypoint] Tier-B pair check: ${clean_line} (SMI-7201)"
                # A worktree run can also name obsolete seed entries (INFO); show them.
                info_lines="$(_tbp_lines "$out" "] INFO")"
                [ -z "$info_lines" ] || _tbp_say "$y" "$info_lines"
                rm -f "$flag" 2>/dev/null || _tbp_say "$r" "[entrypoint] Tier-B pair check: could not remove the old state flag ${flag}"
                return 0
            fi
            _tbp_say "$y" "[entrypoint] Tier-B pair check NOT EVALUATED (SMI-7201): the check exited 0 without a CLEAN summary line, so it is not reported as clean."
            _tbp_record "$flag" not-evaluated "$out"
            ;;
        1)
            _tbp_say "$r" "[entrypoint] Tier-B pair check: MISMATCH (SMI-7201)"
            _tbp_say "$r" "$(_tbp_lines "$out" "] MISMATCH")"
            _tbp_say "$r" "  The native half no longer matches its JS parent; for example sharp then fails to load, and EmbeddingService silently serves mock embeddings."
            _tbp_say "$r" "  $(_tbp_remedy "$kind")"
            _tbp_record "$flag" mismatch "$out"
            ;;
        2)
            _tbp_say "$y" "[entrypoint] Tier-B pair check NOT EVALUATED (SMI-7201): native/JS pairs are NOT verified."
            _tbp_say "$y" "$(_tbp_lines "$out" "] NOT-EVALUATED")"
            _tbp_record "$flag" not-evaluated "$out"
            ;;
        *)
            _tbp_say "$y" "[entrypoint] Tier-B pair check NOT EVALUATED (SMI-7201): the check exited with status ${rc} (node missing or a crash), so native/JS pairs are NOT verified."
            [ -z "$out" ] || _tbp_say "$y" "${out}"
            _tbp_record "$flag" not-evaluated "[tier-b-pairs] NOT-EVALUATED checker exited with status ${rc}
${out}"
            ;;
    esac
    return 0
}

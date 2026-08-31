# scripts/ci/check-submodule-pointer.helpers.sh
# SMI-6260 Wave 1 — rule-evaluation engine for check-submodule-pointer.sh.
# Split out of that file per CLAUDE.md's 500-line convention. Sourced only,
# never run standalone. Bash (not POSIX sh) — arrays are used throughout.
#
# Implements the R0-R11 + R-FETCH accept/reject rule table from
# docs/internal/implementation/smi-6260-docs-internal-pointer-regression-gate.md's
# "Design decisions" section (binding, reviewed twice). Definitions:
#   M = a gitlink mount path from .gitmodules
#   S = the gitlink SHA in the ref under test (--ref)
#   T = tip of M's configured upstream branch (branch= in .gitmodules), in
#       its own remote, after a full fetch of all refs
#   B = the gitlink SHA at the diff-base ref (--before if given, else
#       --target) — "the pointer already registered" on the target/base ref
#
# Two-layer evaluation model (binding, see plan doc):
#   Layer 1 (preconditions) — R-FETCH, R1 (S exists), R10/R11 (B absent vs.
#     unresolvable). A Layer-1 failure short-circuits Layer 2 entirely: no
#     R2-R7 comparison is attempted (merge-base --is-ancestor against a
#     nonexistent/unresolvable SHA is not a well-formed call).
#   Layer 2 (comparisons) — R2-R7, independently evaluated and AND-combined
#     (not first-match): the overall per-mount verdict is FAIL if ANY
#     applicable FAIL-yielding rule matches, even when a PASS-yielding rule
#     (R2/R4) also matches on its own axis (the T<S<B combined-state case).
#     Primary-message priority when multiple FAILs match:
#     R1 > R8 > R11 > R7 > R5 > R6 > R3.

# Parse every `path = ...` value out of a .gitmodules file, regardless of
# which [submodule "..."] section it sits in — mirrors
# scripts/ci/classify-changes.ts's getSubmoduleMounts() (a plain per-line
# regex over the whole file, not a per-section parse).
parse_gitmodules_mounts() {
    awk '
        /^[ \t]*path[ \t]*=/ {
            v = $0
            sub(/^[ \t]*path[ \t]*=[ \t]*/, "", v)
            gsub(/^"|"$/, "", v)
            if (length(v) > 0) print v
        }
    ' "$1"
}

# Read one INI-style key for the [submodule "..."] section whose `path`
# value exactly equals $2 (e.g. get_mount_field .gitmodules docs/internal
# branch). Exact string match on path, never a glob — mirrors
# scripts/ci/classify-changes.ts's isSubmoduleMount() doc comment: a mount
# path is data read from .gitmodules, not an authored pattern.
get_mount_field() {
    awk -v target="$2" -v want="$3" '
        function flush() { if (vals["path"] == target && (want in vals)) print vals[want] }
        /^\[submodule/ { flush(); delete vals; next }
        /^[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*=/ {
            key = $0
            sub(/[ \t]*=.*/, "", key)
            gsub(/^[ \t]+|[ \t]+$/, "", key)
            v = $0
            sub(/^[^=]*=[ \t]*/, "", v)
            gsub(/^"|"$/, "", v)
            vals[key] = v
            next
        }
        END { flush() }
    ' "$1"
}

# Friendly "org/repo:branch" slug for a mount's R3 message, derived from its
# configured url + branch. Falls back to the mount path itself if the url
# can't be parsed into a slug (e.g. a non-GitHub URL).
repo_slug() {
    _CSP_URL="$(get_mount_field "$1" "$2" url)"
    _CSP_BRANCH="$(get_mount_field "$1" "$2" branch)"
    [ -z "$_CSP_BRANCH" ] && _CSP_BRANCH="main"
    _CSP_SLUG="$(printf '%s' "$_CSP_URL" | sed -E 's#^[a-zA-Z]+://[^/]+/##; s#^[^:]+:##; s#\.git$##')"
    [ -z "$_CSP_SLUG" ] && _CSP_SLUG="$2"
    printf '%s:%s' "$_CSP_SLUG" "$_CSP_BRANCH"
}

# print_result — unified output line. severity: PASS|PASS-WARN|SKIP|FAIL.
# is_blocking (0/1) downgrades a FAIL's displayed severity to WARN (mount
# not in BLOCKING_MOUNTS) without changing the caller's exit-code decision,
# which is made separately in check-submodule-pointer.sh's main loop.
print_result() {
    _CSP_SEV="$1" _CSP_MOUNT="$2" _CSP_LINE="$3" _CSP_BLOCKING="$4"
    if [ "$_CSP_SEV" = "FAIL" ] && [ "$_CSP_BLOCKING" != "1" ]; then
        _CSP_SEV="WARN (non-blocking mount)"
    fi
    printf '%s [%s]: %s\n' "$_CSP_SEV" "$_CSP_MOUNT" "$_CSP_LINE"
}

# evaluate_mount repo_root mount ref diff_base changed_files mode
#                pat_available is_blocking
# Returns 0 (PASS/SKIP) or 1 (FAIL) — the caller decides whether a FAIL on
# this mount affects the process exit code (BLOCKING_MOUNTS x --mode=block).
evaluate_mount() {
    _CSP_ROOT="$1" _CSP_MOUNT="$2" _CSP_REF="$3" _CSP_BASE="$4"
    _CSP_CHANGED="$5" _CSP_MODE="$6" _CSP_PAT="$7" _CSP_BLOCK="$8"

    _CSP_TOUCHED=0
    if printf '%s\n' "$_CSP_CHANGED" | grep -qxF "$_CSP_MOUNT"; then
        _CSP_TOUCHED=1
    fi

    if [ "$_CSP_TOUCHED" -eq 0 ]; then
        if [ "$_CSP_PAT" = "false" ]; then
            print_result "SKIP-PASS (R9)" "$_CSP_MOUNT" "PAT unavailable, but diff does not touch this mount — nothing to check" "$_CSP_BLOCK"
        else
            print_result "SKIP-PASS (R0)" "$_CSP_MOUNT" "diff does not touch this mount" "$_CSP_BLOCK"
        fi
        return 0
    fi

    if [ "$_CSP_PAT" = "false" ]; then
        print_result "FAIL" "$_CSP_MOUNT" "R8: external contributors cannot bump \`$_CSP_MOUNT\`; ask a maintainer to push this pointer bump on your behalf" "$_CSP_BLOCK"
        return 1
    fi

    _CSP_S="$(git -C "$_CSP_ROOT" ls-tree "$_CSP_REF" -- "$_CSP_MOUNT" 2>/dev/null | awk '{print $3}')"
    _CSP_B="$(git -C "$_CSP_ROOT" ls-tree "$_CSP_BASE" -- "$_CSP_MOUNT" 2>/dev/null | awk '{print $3}')"

    if [ -z "$_CSP_S" ]; then
        print_result "SKIP-PASS" "$_CSP_MOUNT" "no gitlink entry at --ref (path removed, or never a submodule at this ref) — nothing to check" "$_CSP_BLOCK"
        return 0
    fi

    # Not-initialized check: test for a LITERAL .git entry directly under the
    # mount directory (file or dir — a submodule's own .git is a file
    # pointing at ../../.git/modules/<path> since git 1.7.8+). Deliberately
    # NOT `git -C "$_CSP_DIR" rev-parse --git-dir`: for an uninitialized
    # mount (an empty directory with no .git of its own), git's repo
    # discovery walks UP the directory tree and silently finds the PARENT
    # repo's own .git instead of failing — that would make this check
    # always report "initialized" even when the submodule plainly isn't.
    _CSP_DIR="$_CSP_ROOT/$_CSP_MOUNT"
    if [ ! -e "$_CSP_DIR/.git" ]; then
        print_result "SKIP" "$_CSP_MOUNT" "local submodule checkout not initialized — cannot verify ancestry locally (CI initializes this before running; a developer pushing without the submodule checked out is never blocked)" "$_CSP_BLOCK"
        return 0
    fi

    _CSP_BRANCH="$(get_mount_field "$_CSP_ROOT/.gitmodules" "$_CSP_MOUNT" branch)"
    [ -z "$_CSP_BRANCH" ] && _CSP_BRANCH="main"

    _CSP_ATTEMPTS=1
    [ "$_CSP_MODE" = "block" ] && _CSP_ATTEMPTS=2
    _CSP_FETCH_OK=0
    _CSP_I=0
    while [ "$_CSP_I" -lt "$_CSP_ATTEMPTS" ]; do
        if git -C "$_CSP_DIR" fetch origin --prune --quiet 2>/dev/null; then
            _CSP_FETCH_OK=1
            break
        fi
        _CSP_I=$((_CSP_I + 1))
    done

    if [ "$_CSP_FETCH_OK" -ne 1 ]; then
        print_result "FAIL" "$_CSP_MOUNT" "R-FETCH: infra: fetch failed, not a content problem — re-run the check" "$_CSP_BLOCK"
        return 1
    fi

    _CSP_T="$(git -C "$_CSP_DIR" rev-parse -q --verify "refs/remotes/origin/$_CSP_BRANCH" 2>/dev/null)"
    if [ -z "$_CSP_T" ]; then
        print_result "FAIL" "$_CSP_MOUNT" "R-FETCH: infra: fetch failed, not a content problem — re-run the check" "$_CSP_BLOCK"
        return 1
    fi

    # --- Layer 1 preconditions: R1 (S exists), R10/R11 (B) ---
    if ! git -C "$_CSP_DIR" cat-file -e "${_CSP_S}^{commit}" 2>/dev/null; then
        print_result "FAIL" "$_CSP_MOUNT" "R1: \`$_CSP_S\` was never pushed, or its branch was deleted; push a valid commit at that SHA (or a valid replacement) and re-bump" "$_CSP_BLOCK"
        return 1
    fi

    _CSP_B_AVAILABLE=0
    _CSP_B_RESOLVABLE=0
    if [ -n "$_CSP_B" ]; then
        _CSP_B_AVAILABLE=1
        if git -C "$_CSP_DIR" cat-file -e "${_CSP_B}^{commit}" 2>/dev/null; then
            _CSP_B_RESOLVABLE=1
        fi
    fi

    if [ "$_CSP_B_AVAILABLE" -eq 1 ] && [ "$_CSP_B_RESOLVABLE" -eq 0 ]; then
        print_result "FAIL" "$_CSP_MOUNT" "R11: \`$_CSP_REF\`'s already-registered pointer \`$_CSP_B\` for \`$_CSP_MOUNT\` cannot be resolved — this predates this PR/push and was not caused by it (see the \`git update-index --cacheinfo\` hazard in 'What exists today'); a maintainer must repair \`$_CSP_REF\`'s pointer directly (see the \`docs-internal-pointer-repair\` runbook note in ADR-143) before R7 can validate new bumps against it" "$_CSP_BLOCK"
        return 1
    fi

    evaluate_layer2 "$_CSP_ROOT" "$_CSP_MOUNT" "$_CSP_REF" "$_CSP_DIR" "$_CSP_BRANCH" \
        "$_CSP_S" "$_CSP_T" "$_CSP_B" "$_CSP_B_AVAILABLE" "$_CSP_BLOCK"
}

# evaluate_layer2 — R2-R7, independently AND-combined. Split out of
# evaluate_mount() for the 500-line cap; still logically "the rest of
# evaluate_mount" (same _CSP_* naming convention, called with a fully
# resolved S/T/B triple that has already cleared every Layer-1
# precondition).
evaluate_layer2() {
    _CSP_ROOT="$1" _CSP_MOUNT="$2" _CSP_REF="$3" _CSP_DIR="$4" _CSP_BRANCH="$5"
    _CSP_S="$6" _CSP_T="$7" _CSP_B="$8" _CSP_B_AVAILABLE="$9"
    _CSP_BLOCK="${10}"

    _CSP_FAIL_RULES=()
    _CSP_FAIL_MSGS=()
    # SMI-6260 review fix: tracks whether the T-axis already emitted R4's own
    # "PASS-WARN" verdict line, so the unconditional-PASS fallback below (for
    # the no-FAIL-rules case) doesn't ALSO print a second, redundant generic
    # "PASS: ... OK relative to ..." line for the same mount immediately
    # after it. Confirmed live before this fix: a pure R4 case (S ahead of T
    # on a live branch, no B-axis R7 match) printed BOTH lines back-to-back —
    # every rule in the R0-R11 table is defined as exactly one verdict per
    # mount (see this file's own "print_result — unified output line" and
    # "Returns 0 (PASS/SKIP) or 1 (FAIL)" contract above), and R4's own
    # verdict is "PASS + warning annotation", not "PASS + warning annotation,
    # then also a second unrelated PASS". Must NOT just `return 0`
    # immediately after printing R4's line — the combined-state (T<S<B) case
    # requires the B-axis (R7) check below to still run and can still FAIL
    # even though R4 passed on the T-axis alone (see check-submodule-pointer.test.ts's
    # "combined state T < S < B" case) — this flag only suppresses the later
    # redundant PASS print, it does not skip any evaluation.
    _CSP_R4_WARNED=0

    # T-axis: S vs T (R2/R3/R4/R5/R6 — mutually exclusive with each other).
    if [ "$_CSP_S" = "$_CSP_T" ]; then
        : # R2 PASS
    elif git -C "$_CSP_DIR" merge-base --is-ancestor "$_CSP_S" "$_CSP_T" 2>/dev/null; then
        _CSP_BEHIND="$(git -C "$_CSP_DIR" rev-list --count "${_CSP_S}..${_CSP_T}" 2>/dev/null || echo '?')"
        _CSP_SLUG="$(repo_slug "$_CSP_ROOT/.gitmodules" "$_CSP_MOUNT")"
        _CSP_FAIL_RULES+=("R3")
        _CSP_FAIL_MSGS+=("R3: stale: behind \`$_CSP_SLUG\` by $_CSP_BEHIND commits; re-bump with \`scripts/bump-docs-pointer.sh\`")
    elif git -C "$_CSP_DIR" merge-base --is-ancestor "$_CSP_T" "$_CSP_S" 2>/dev/null; then
        if git -C "$_CSP_DIR" branch -r --contains "$_CSP_S" 2>/dev/null | grep -q .; then
            print_result "PASS-WARN (R4)" "$_CSP_MOUNT" "\`$_CSP_S\` is ahead of \`$_CSP_T\` and lives on a live remote branch (legitimate 'docs PR merged just after' case, SMI-5666)" "$_CSP_BLOCK"
            _CSP_R4_WARNED=1
        else
            _CSP_FAIL_RULES+=("R5")
            _CSP_FAIL_MSGS+=("R5: orphaned tip: \`$_CSP_S\`'s branch was force-pushed or deleted after this pointer was set; re-bump to a commit on a live branch, or to \`$_CSP_T\`")
        fi
    else
        _CSP_FAIL_RULES+=("R6")
        _CSP_FAIL_MSGS+=("R6: diverged: rebase \`$_CSP_MOUNT\` onto \`origin/$_CSP_BRANCH\` and re-bump with \`scripts/bump-docs-pointer.sh\`")
    fi

    # B-axis: S vs B (R7) — only when B is available (R10: absent => skip
    # this axis, not the whole mount; T-axis above still stands).
    if [ "$_CSP_B_AVAILABLE" -eq 1 ] && [ "$_CSP_S" != "$_CSP_B" ] \
        && git -C "$_CSP_DIR" merge-base --is-ancestor "$_CSP_S" "$_CSP_B" 2>/dev/null; then
        _CSP_FAIL_RULES+=("R7")
        _CSP_FAIL_MSGS+=("R7: backward regression: this pointer already registers \`$_CSP_B\` on \`$_CSP_REF\`, which is ahead of the proposed \`$_CSP_S\`; re-bump to \`$_CSP_B\` or a descendant of it, never to an ancestor")
    fi

    if [ "${#_CSP_FAIL_RULES[@]}" -eq 0 ]; then
        if [ "$_CSP_R4_WARNED" -ne 1 ]; then
            print_result "PASS" "$_CSP_MOUNT" "\`$_CSP_S\` OK relative to \`$_CSP_T\`" "$_CSP_BLOCK"
        fi
        return 0
    fi

    _CSP_PRIMARY=""
    for _CSP_WANT in R7 R5 R6 R3; do
        for _CSP_J in "${!_CSP_FAIL_RULES[@]}"; do
            if [ "${_CSP_FAIL_RULES[$_CSP_J]}" = "$_CSP_WANT" ]; then
                _CSP_PRIMARY="${_CSP_FAIL_MSGS[$_CSP_J]}"
                break 2
            fi
        done
    done

    print_result "FAIL" "$_CSP_MOUNT" "$_CSP_PRIMARY" "$_CSP_BLOCK"
    for _CSP_J in "${!_CSP_FAIL_MSGS[@]}"; do
        if [ "${_CSP_FAIL_MSGS[$_CSP_J]}" != "$_CSP_PRIMARY" ]; then
            printf '  (also matched: %s)\n' "${_CSP_FAIL_MSGS[$_CSP_J]}"
        fi
    done
    return 1
}

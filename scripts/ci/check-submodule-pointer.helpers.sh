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

# git_sub <submodule-dir> <git-args...> — run git against a SUBMODULE working
# directory, immune to an inherited GIT_DIR (SMI-6569).
#
# `git -C <dir>` does NOT override GIT_DIR: -C changes the working directory,
# but an ABSOLUTE GIT_DIR still wins over repo discovery, so the command runs
# against the OUTER repo while appearing to target the submodule. Git exports
# an absolute GIT_DIR into hooks on a push FROM A LINKED WORKTREE — this
# repo's default workspace — so `.husky/pre-push`'s invocation hit this on
# every run. Measured on git 2.50.0 against docs/internal:
#
#   GIT_DIR unset             -> git -C docs/internal cat-file -e <sha>^{commit} -> exit 0
#   GIT_DIR=<absolute>        -> same command                                    -> exit 128
#   GIT_DIR=".git" (RELATIVE) -> same command                                    -> exit 0
#
# A relative GIT_DIR re-resolves against -C's new cwd and is harmless; only an
# absolute one redirects. End-to-end on one identical tree, the symptom was a
# fabricated R1 ("was never pushed") for a commit that is pushed and reachable,
# which ALSO suppressed the true verdict (R3) because R1 is a Layer-1
# precondition that short-circuits Layer 2 entirely.
#
# Every git call in this file that targets the submodule must go through this
# wrapper, not just the R1 existence check: under a contaminated GIT_DIR the
# fetch, the origin/<branch> rev-parse, and every merge-base/rev-list/branch
# comparison were all reading the OUTER repo too. R1 simply failed first and
# masked the rest.
#
# Calls targeting the OUTER repo (`git -C "$_CSP_ROOT" ls-tree`, and
# check-submodule-pointer.sh's own rev-parse/diff) deliberately do NOT use
# this wrapper: they want the outer repo, and an inherited worktree GIT_DIR
# already names it. Verified — `rev-parse --show-toplevel` and `ls-tree HEAD`
# return identical results with and without GIT_DIR set.
#
# WHICH vars are unset, and why it is not just GIT_DIR. An earlier version of
# this wrapper unset only GIT_DIR and GIT_WORK_TREE and claimed that "removes
# the remaining way a caller's environment could redirect these reads". That
# claim was false, and measurement is what caught it — governance review found
# it, and it reproduced here against docs/internal:
#
#   GIT_COMMON_DIR=<outer .git>          + env -u GIT_DIR -u GIT_WORK_TREE -> exit 128
#   GIT_OBJECT_DIRECTORY=<outer objects> + env -u GIT_DIR -u GIT_WORK_TREE -> exit 128
#
# Both redirect straight through a GIT_DIR-only unset, producing the same
# failure class as the original bug. The other six discovery vars
# (GIT_INDEX_FILE, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_NAMESPACE,
# GIT_PREFIX, GIT_CEILING_DIRECTORIES, GIT_DISCOVERY_ACROSS_FILESYSTEM)
# measured harmless for these call shapes, and git exports none of the eight
# into hooks natively — so this is hardening against a class, not a live
# trigger. It is unset anyway because enumerating "which ones happen to matter
# for today's exact commands" is the brittle version of this fix.
#
# The list mirrors GIT_DISCOVERY_VARS in scripts/tests/_lib/git-fixture-env.ts
# (SMI-4693, audited 2026-05-03), which is this repo's single source of truth
# for the discovery-redirect threat model. Keep them in sync.
#
# DELIBERATE DIVERGENCE from that list: its last two entries, GIT_CONFIG and
# XDG_CONFIG_HOME, are NOT unset here. Those route config resolution, not repo
# discovery, and this wrapper runs a real authenticated `git fetch` whose
# credentials come from the `url.<base>.insteadOf` rewrite that CI installs
# with `git config --global`. Narrowing to the discovery class keeps the fix
# scoped to the defect. (Measured that it would in fact have been safe either
# way: `git config --global` writes to $HOME/.gitconfig even when
# XDG_CONFIG_HOME is set, and the rewrite is still visible with
# XDG_CONFIG_HOME unset — so this is a scoping choice, not a workaround.)
git_sub() {
    _CSP_GIT_SUB_DIR="$1"
    shift
    env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY \
        -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_COMMON_DIR -u GIT_NAMESPACE \
        -u GIT_PREFIX -u GIT_CEILING_DIRECTORIES -u GIT_DISCOVERY_ACROSS_FILESYSTEM \
        git -C "$_CSP_GIT_SUB_DIR" "$@"
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
    # NOT `git_sub "$_CSP_DIR" rev-parse --git-dir`: for an uninitialized
    # mount (an empty directory with no .git of its own), git's repo
    # discovery walks UP the directory tree and silently finds the PARENT
    # repo's own .git instead of failing — that would make this check
    # always report "initialized" even when the submodule plainly isn't.
    # SMI-6569 makes this MORE true, not less: git_sub exists precisely to
    # strip the env hints that would otherwise short-circuit discovery, so it
    # guarantees the upward walk this check must avoid. A plain filesystem
    # test is the right tool here and no wrapper changes that.
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
        if git_sub "$_CSP_DIR" fetch origin --prune --quiet 2>/dev/null; then
            _CSP_FETCH_OK=1
            break
        fi
        _CSP_I=$((_CSP_I + 1))
    done

    if [ "$_CSP_FETCH_OK" -ne 1 ]; then
        print_result "FAIL" "$_CSP_MOUNT" "R-FETCH: infra: fetch failed, not a content problem — re-run the check" "$_CSP_BLOCK"
        return 1
    fi

    _CSP_T="$(git_sub "$_CSP_DIR" rev-parse -q --verify "refs/remotes/origin/$_CSP_BRANCH" 2>/dev/null)"
    if [ -z "$_CSP_T" ]; then
        print_result "FAIL" "$_CSP_MOUNT" "R-FETCH: infra: fetch failed, not a content problem — re-run the check" "$_CSP_BLOCK"
        return 1
    fi

    # --- Layer 1 preconditions: R1 (S exists), R10/R11 (B) ---
    if ! git_sub "$_CSP_DIR" cat-file -e "${_CSP_S}^{commit}" 2>/dev/null; then
        print_result "FAIL" "$_CSP_MOUNT" "R1: \`$_CSP_S\` was never pushed, or its branch was deleted; push a valid commit at that SHA (or a valid replacement) and re-bump" "$_CSP_BLOCK"
        return 1
    fi

    _CSP_B_AVAILABLE=0
    _CSP_B_RESOLVABLE=0
    if [ -n "$_CSP_B" ]; then
        _CSP_B_AVAILABLE=1
        if git_sub "$_CSP_DIR" cat-file -e "${_CSP_B}^{commit}" 2>/dev/null; then
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
    elif git_sub "$_CSP_DIR" merge-base --is-ancestor "$_CSP_S" "$_CSP_T" 2>/dev/null; then
        _CSP_BEHIND="$(git_sub "$_CSP_DIR" rev-list --count "${_CSP_S}..${_CSP_T}" 2>/dev/null || echo '?')"
        _CSP_SLUG="$(repo_slug "$_CSP_ROOT/.gitmodules" "$_CSP_MOUNT")"
        _CSP_FAIL_RULES+=("R3")
        _CSP_FAIL_MSGS+=("R3: stale: behind \`$_CSP_SLUG\` by $_CSP_BEHIND commits; re-bump with \`scripts/bump-docs-pointer.sh\`")
    elif git_sub "$_CSP_DIR" merge-base --is-ancestor "$_CSP_T" "$_CSP_S" 2>/dev/null; then
        if git_sub "$_CSP_DIR" branch -r --contains "$_CSP_S" 2>/dev/null | grep -q .; then
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
        && git_sub "$_CSP_DIR" merge-base --is-ancestor "$_CSP_S" "$_CSP_B" 2>/dev/null; then
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

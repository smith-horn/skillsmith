# scripts/ci/git-env-sanitize.sh
# SMI-6569 — single source of truth for the git environment variables that can
# change this guard's verdict, plus the entry-point sanitizer that clears them.
# Sourced only, never run standalone. Bash (not POSIX sh) — arrays are used.
#
# ## Why this exists
#
# `git -C <dir>` does NOT override an inherited git environment. `-C` changes
# the working directory; the environment still wins over repo discovery. Git
# exports an absolute GIT_DIR into hooks on a push from a linked worktree,
# which is this repo's default workspace, so `.husky/pre-push` hit this on
# every run: every submodule-directed call in check-submodule-pointer.helpers.sh
# was reading the OUTER repo, producing a fabricated R1 that also suppressed
# the true verdict.
#
# ## Why the contract is "verdict-affecting", not "discovery"
#
# An earlier fix scoped this to repo *discovery* and unset ten variables. Two
# separate reviews found that insufficient, both with executed counterexamples:
#
#   1. GIT_COMMON_DIR and GIT_OBJECT_DIRECTORY redirect a submodule-directed
#      call even with GIT_DIR and GIT_WORK_TREE unset (exit 128 on a
#      `cat-file -e` for a commit that exists).
#
#   2. GIT_SHALLOW_FILE is not a discovery variable at all, and does not
#      redirect anything — it rewrites the repository's *ancestry*:
#
#          clean                      -> rev-parse --is-shallow-repository = false
#          GIT_SHALLOW_FILE=/dev/null -> rev-parse --is-shallow-repository = true
#
#      Shallow boundaries change what `merge-base --is-ancestor` and
#      `rev-list --count` return, which is exactly what R3-R7 are decided on.
#      A guard that classifies ancestry cannot ignore an ancestry override.
#      GIT_GRAFT_FILE rewrites parentage the same way.
#
# So the boundary this file defends is "anything an inherited environment can
# use to change which commits this guard believes exist or how they are
# related" — a superset of discovery. Adding a variable here is cheap; missing
# one produces a confident wrong verdict.
#
# ## Relationship to GIT_DISCOVERY_VARS
#
# The first ten entries mirror GIT_DISCOVERY_VARS in
# scripts/tests/_lib/git-fixture-env.ts (SMI-4693, audited 2026-05-03), which
# is the test-fixture side of the same threat model. Keep them in sync. Every
# entry AFTER the discovery block is an addition this file needs and that list
# does not have, because a fixture builds its own repos from scratch and never
# evaluates inherited ancestry or inherited config routing.
#
# (An earlier version of this sentence said "the last two are additions" and
# went stale the first time the list grew — the third stale-comment defect in
# this one file. Describing the category rather than counting survives a
# change; a count does not.)
#
# Two entries of that list are deliberately NOT mirrored: GIT_CONFIG and
# XDG_CONFIG_HOME. `GIT_CONFIG` affects `git config` itself rather than the
# fetch/ancestry commands this guard runs. `XDG_CONFIG_HOME` participates in
# NORMAL global-config resolution, which is where CI's authenticated
# url.<base>.insteadOf rewrite lives — clearing it was measured safe (`git
# config --global` writes to $HOME/.gitconfig even when it is set, and the
# rewrite stays visible with it unset), so this is a scoping choice rather
# than a dependency.
#
# GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM / GIT_CONFIG_NOSYSTEM are a KNOWN,
# MEASURED, DELIBERATELY DEFERRED gap — SMI-6600, not an oversight. They
# replace the normal config sources outright, so any of them can introduce or
# hide a `url.*.insteadOf` and redirect the fetch that produces T:
#
#   $ git config --get-all 'url.https://evil.example/.insteadOf'   -> (empty)
#   $ GIT_CONFIG_GLOBAL=<file with that rule> git config --get-all -> https://github.com/
#
# They are not cleared here because doing so breaks the shared test harness.
# scripts/tests/_lib/git-fixture-env.ts uses GIT_CONFIG_GLOBAL=/dev/null as its
# ONLY global-config isolation and deliberately leaves HOME alone (SMI-4699,
# stated in its own comments). Unsetting it mid-script punches through that —
# measured, the scripts under test went from seeing no global config to seeing
# the developer's real ~/.gitconfig. Closing this properly means changing that
# helper, which is audit-enforced (Audit-39, SMI-4693) and has a byte-identical
# mirror; that is SMI-6600's scope, not this file's.
#
# Unlike GIT_CONFIG_PARAMETERS below, nothing in ordinary git usage SETS these
# — it takes a deliberate act — which is why they are the deferrable half and
# GIT_CONFIG_PARAMETERS was not.

SKILLSMITH_GIT_VERDICT_VARS=(
    # --- repo discovery (mirrors GIT_DISCOVERY_VARS) ---
    GIT_DIR
    GIT_WORK_TREE
    GIT_INDEX_FILE
    GIT_OBJECT_DIRECTORY
    GIT_ALTERNATE_OBJECT_DIRECTORIES
    GIT_COMMON_DIR
    GIT_NAMESPACE
    GIT_PREFIX
    GIT_CEILING_DIRECTORIES
    GIT_DISCOVERY_ACROSS_FILESYSTEM
    # --- ancestry rewriting (this file's own additions) ---
    GIT_SHALLOW_FILE
    GIT_GRAFT_FILE
    # --- object-graph replacement (SMI-6598 round 2) ---
    # Replacement refs rewrite commit parentage, so they change exactly what
    # merge-base and rev-list report — the R3-R7 decision inputs. Measured on a
    # 4-commit chain, replacing the tip with a parentless rewrite:
    #
    #   baseline                              is-ancestor c1 c4 -> 0, count 3
    #   with a replacement ref                is-ancestor c1 c4 -> 1, count 1
    #   + GIT_NO_REPLACE_OBJECTS=1            is-ancestor c1 c4 -> 0  (bypassed)
    #   + GIT_REPLACE_REF_BASE=refs/nowhere   is-ancestor c1 c4 -> 0  (hidden)
    #
    # Both directions are a verdict change: setting them suppresses a
    # replacement a repo legitimately has, and leaving them unset lets an
    # inherited one apply. Same class as GIT_SHALLOW_FILE and GIT_GRAFT_FILE
    # above, which this file already covers — these were simply missed.
    GIT_REPLACE_REF_BASE
    GIT_NO_REPLACE_OBJECTS
    # --- config injection (SMI-6598) ---
    # An earlier version of this file listed these two in a comment as "a
    # separate, unaddressed surface — tracked rather than guessed at". That
    # understated them. Accidental inheritance is the SAME class as the
    # GIT_DIR-from-a-linked-worktree trigger this file exists for: any
    # ordinary `git -c key=val <cmd>` that fires a hook exports the parameter
    # into that hook's environment, with no attacker involved. Measured:
    #
    #   $ git -c some.key=someval commit -qam second
    #     PROBE GIT_CONFIG_PARAMETERS=['some.key'='someval']
    #
    # And the indexed form injects config that reads back live — including
    # `url.<other>.insteadOf`, which redirects a fetch EVEN WHEN
    # remote.origin.url is set normally, as every initialized submodule's is.
    # That manipulates T, the value R2-R6 are decided on.
    #
    # GIT_CONFIG_COUNT alone neutralizes the indexed form; the KEY_N/VALUE_N
    # pairs are inert without it, so they do not need enumerating (measured).
    # GIT_CONFIG_PARAMETERS is gated independently and needs its own entry.
    GIT_CONFIG_COUNT
    GIT_CONFIG_PARAMETERS
)

# Contract version. Bump this whenever SKILLSMITH_GIT_VERDICT_VARS GAINS an
# entry, and raise the minimum each entry point requires to match.
#
# This exists because `declare -F sanitize_git_env` proves the function is
# DEFINED, not that it covers what the caller needs. A mixed or partial
# deployment — an older copy of this file next to newer entry points — defines
# the function with a shorter list and sails through an existence check.
# Demonstrated: a stub defining only `unset GIT_DIR` satisfied `declare -F`
# while GIT_CONFIG_COUNT stayed live through "sanitization".
#
# A postcondition check alone does not fix that either, because it would probe
# the function against THIS file's own list — and a stale file's list is
# exactly what is wrong with it. So entry points check both: the version (does
# this file claim to cover what I need) and the postcondition (does the
# function actually do what this file claims).
#
#   1 — initial: discovery vars
#   2 — + GIT_SHALLOW_FILE, GIT_GRAFT_FILE
#   3 — + GIT_CONFIG_COUNT, GIT_CONFIG_PARAMETERS
#   4 — + GIT_REPLACE_REF_BASE, GIT_NO_REPLACE_OBJECTS
SKILLSMITH_GIT_SANITIZE_CONTRACT=4

# assert_git_env_sanitize_contract <minimum-version> — verify this file both
# CLAIMS and DELIVERS what the caller requires. Returns non-zero with a reason
# on stdout; the caller decides how loudly to fail.
assert_git_env_sanitize_contract() {
    _SGE_WANT="$1"
    if [ "${SKILLSMITH_GIT_SANITIZE_CONTRACT:-0}" -lt "$_SGE_WANT" ]; then
        echo "git-env-sanitize.sh declares contract v${SKILLSMITH_GIT_SANITIZE_CONTRACT:-0}, caller requires v${_SGE_WANT} — stale or mixed deployment"
        return 1
    fi
    # Postcondition: set a sentinel for every variable the list claims, run the
    # function in a subshell, and report any that survived. Catches a
    # current-version file whose function is broken rather than merely old.
    _SGE_SURVIVORS="$(
        for _SGE_V in "${SKILLSMITH_GIT_VERDICT_VARS[@]}"; do
            export "${_SGE_V}=skillsmith-sanitize-probe"
        done
        sanitize_git_env
        for _SGE_V in "${SKILLSMITH_GIT_VERDICT_VARS[@]}"; do
            if [ -n "$(eval "printf '%s' \"\${${_SGE_V}+set}\"")" ]; then
                printf '%s ' "$_SGE_V"
            fi
        done
    )"
    if [ -n "$_SGE_SURVIVORS" ]; then
        echo "sanitize_git_env left these set: ${_SGE_SURVIVORS}"
        return 1
    fi
    return 0
}

# sanitize_git_env — clear the whole set for the remainder of this process.
#
# Call this ONCE at the entry point of any script that evaluates gitlink
# ancestry, BEFORE resolving the repo root. Sanitizing at process entry rather
# than per call is what makes the OUTER-repo calls safe too: an earlier fix
# wrapped only the submodule-directed calls, on the reasoning that an inherited
# worktree GIT_DIR already names the outer repo. That reasoning held only for
# the specific value a hook exports. Executed counterexample — GIT_DIR pointed
# at the submodule's own gitdir while running an OUTER call:
#
#   clean    ls-tree HEAD -- docs/internal -> 160000 commit f87c529… docs/internal
#   poisoned ls-tree HEAD -- docs/internal -> (empty), exit 0
#
# An empty S is read by evaluate_mount as "no gitlink entry at --ref … nothing
# to check" and returns PASS. That is a wrong answer delivered as a pass, which
# is the exact failure class this guard exists to prevent — and in
# submodule-pointer-autorepair.sh the same class reaches `add`, `commit` and
# `push`.
sanitize_git_env() {
    unset "${SKILLSMITH_GIT_VERDICT_VARS[@]}"
}

# git_sanitized <git-args...> — run git with the verdict-affecting environment
# cleared for that one invocation. Defence in depth for callers that source
# this file without going through an entry point that called
# sanitize_git_env(), and for anything spawned with an environment this process
# does not control.
git_sanitized() {
    _SGE_ENV_ARGS=()
    for _SGE_VAR in "${SKILLSMITH_GIT_VERDICT_VARS[@]}"; do
        _SGE_ENV_ARGS+=(-u "$_SGE_VAR")
    done
    env "${_SGE_ENV_ARGS[@]}" git "$@"
}

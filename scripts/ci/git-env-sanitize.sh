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
# is the test-fixture side of the same threat model. Keep them in sync. The
# last two are additions this file needs and that list does not have, because
# a fixture builds its own repos from scratch and never evaluates inherited
# ancestry.
#
# Two entries of that list are deliberately NOT mirrored: GIT_CONFIG and
# XDG_CONFIG_HOME. Those route config resolution rather than repo state, and
# this guard runs a real authenticated `git fetch` whose credentials come from
# the url.<base>.insteadOf rewrite CI installs with `git config --global`.
# Measured that clearing them would in fact have been safe — `git config
# --global` writes to $HOME/.gitconfig even when XDG_CONFIG_HOME is set, and
# the rewrite stays visible with it unset — so this is a scoping choice, not a
# workaround. The `GIT_CONFIG_COUNT` / `GIT_CONFIG_PARAMETERS` family IS
# handled — see the config-injection block in the list below; an earlier
# version of this comment dismissed it as out of scope and was wrong.

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

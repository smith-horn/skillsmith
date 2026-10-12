#!/usr/bin/env bash
#
# remove-worktree.sh - Remove git worktrees with Docker network cleanup
#
# Removes a git worktree and cleans up associated Docker resources
# (containers, networks) to prevent stale network accumulation that
# degrades Docker Desktop DNS.
#
# Usage: ./scripts/remove-worktree.sh <worktree-path> [--force]
#
# SMI-2365: Docker network cleanup during worktree removal

set -euo pipefail

# Source shared utilities (colors, logging, get_main_git_dir, is_git_crypt_encrypted)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"
# SMI-6401: Docker cleanup helpers split into their own file once the
# SMI-6401 volume-cleanup fix pushed this script over the 500-line gate.
# shellcheck source=lib/remove-worktree-docker.sh
source "$SCRIPT_DIR/lib/remove-worktree-docker.sh"
# SMI-7089: the Compose-project attribution check that gates every Docker step
# below, and the lifecycle helpers it uses. Functions only.
# shellcheck source=lib/worktree-lifecycle.sh
source "$SCRIPT_DIR/lib/worktree-lifecycle.sh"
# shellcheck source=lib/worktree-project-attribution.sh
source "$SCRIPT_DIR/lib/worktree-project-attribution.sh"

#######################################
# Print usage information
#######################################
usage() {
    cat << EOF
Usage: $(basename "$0") <worktree-path> [--force] [--prune] [--keep-docker] [--no-orphan-prune]

Remove a git worktree and clean up associated Docker resources.

Arguments:
  worktree-path   Path to the worktree to remove (relative or absolute)

Options:
  --force         Force removal even if worktree has dirty files
  --prune         Also prune stale Docker networks, dangling images, and build
                  cache (aggressive image -a / volume prune stay manual — see
                  the post-removal reclaimable report)
  --keep-docker   Preserve the per-worktree Docker image and volumes (default:
                  both are removed by the automatic orphan prune once the
                  worktree is deregistered). Also skips that prune. The
                  containers are still stopped
  --no-orphan-prune
                  Skip the automatic targeted orphan prune (SMI-5750) that
                  otherwise runs on every removal (it may delete only the
                  removed worktree's own Compose project; other orphans are
                  report-only). Since SMI-7089 that prune is this script's
                  ONLY deleter, so this flag (and
                  SKILLSMITH_ORPHAN_PRUNE_DISABLE=1) leaves the removed
                  worktree's own volumes and image in place
  -h, --help      Show this help message and exit

Examples:
  $(basename "$0") worktrees/my-feature
  $(basename "$0") worktrees/my-feature --force
  $(basename "$0") worktrees/my-feature --force --prune
  $(basename "$0") worktrees/my-feature --keep-docker

What this script does:
  1. Refuses, changing nothing, if the worktree's Compose project is also used by
     another checkout or cannot be attributed to this worktree alone (SMI-7089):
     another registered worktree, the main checkout, a .worktrees directory, a
     container created from a different directory, or any unreadable listing
  2. Refuses if the worktree has uncommitted changes, unless --force is passed (SMI-5000)
  3. Stops and removes the worktree's Docker containers and project network
     (never a volume or an image)
  4. Removes the git worktree (always passes --force to git worktree remove
     so submodule presence — post-SMI-4829 every worktree has 4 — does not block)
  5. Checks Docker network count and reports global reclaimable Docker
     resources (images / volumes / build cache) with manual reclaim commands
  6. Optionally prunes stale networks + dangling images + build cache (--prune);
     this refers only to the BLANKET docker volume prune / image prune -a
     shown in the reclaimable report, which stay manual-only — see item 7
  7. Automatically runs a targeted orphan prune (SMI-5750) AFTER the worktree
     is deregistered: deletes only this worktree's own owned volumes and
     images, one at a time under the worktree lifecycle lock, safe against a
     concurrent create-worktree.sh (not against a plain 'git worktree add');
     skip with --no-orphan-prune or SKILLSMITH_ORPHAN_PRUNE_DISABLE=1. If it
     fails the script exits 1 after the worktree is already removed and prints
     the command to re-run it

EOF
}

#######################################
# Main entry point
#######################################
main() {
    local worktree_path=""
    local force_flag=""
    local prune_flag=false
    local keep_docker=false
    local no_orphan_prune=false

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            -h|--help)
                usage
                exit 0
                ;;
            --force)
                force_flag="--force"
                shift
                ;;
            --prune)
                prune_flag=true
                shift
                ;;
            --keep-docker)
                keep_docker=true
                shift
                ;;
            --no-orphan-prune)
                no_orphan_prune=true
                shift
                ;;
            -*)
                error "Unknown option: $1\n\nRun '$(basename "$0") --help' for usage information."
                ;;
            *)
                if [[ -z "$worktree_path" ]]; then
                    worktree_path="$1"
                else
                    error "Unexpected argument: $1"
                fi
                shift
                ;;
        esac
    done

    if [[ -z "$worktree_path" ]]; then
        error "Missing required argument: worktree-path\n\nRun '$(basename "$0") --help' for usage information."
    fi

    # Validate we're in a git repository
    local repo_root
    repo_root="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
    if [[ -z "$repo_root" ]]; then
        error "Not in a git repository."
    fi

    # Convert to absolute path if relative
    if [[ ! "$worktree_path" = /* ]]; then
        worktree_path="$repo_root/$worktree_path"
    fi

    # The Compose project this removal may prune, derived with the SAME sanitizer
    # the Compose project name uses and BEFORE anything is removed. It is the only
    # project the orphan prune (Step 3.5) is allowed to delete from.
    local orphan_project
    orphan_project="$(sanitize_project_name "$(basename "$worktree_path")")"

    # Check worktree exists
    if [[ ! -d "$worktree_path" ]]; then
        error "Worktree not found at: $worktree_path"
    fi

    # Critical guard: refuse to operate on the main repo BEFORE any side effects.
    # Without this, stop_worktree_containers below would `docker compose down`
    # the live skillsmith-dev-1 container if invoked on the main repo path.
    # Resolves before any docker/git/rm operation runs.
    local _main_dir _main_repo=""
    _main_dir="$(get_main_git_dir "$worktree_path" 2>/dev/null || true)"
    if [[ -n "$_main_dir" ]]; then
        _main_repo="$(dirname "$_main_dir")"
        # Normalize trailing slashes by resolving both paths
        if [[ -d "$_main_repo" ]]; then
            _main_repo="$(cd "$_main_repo" && pwd -P)"
        fi
        local _resolved_worktree
        _resolved_worktree="$(cd "$worktree_path" && pwd -P)"
        if [[ "$_resolved_worktree" == "$_main_repo" ]]; then
            error "Refusing to remove the main repo as a worktree: $worktree_path"
        fi
    fi

    echo ""
    info "Removing worktree: $worktree_path"
    echo ""

    # Step 0 (SMI-7089): attribution. Every Docker step below acts on a Compose
    # project that is a COMPUTED name, so first show that nothing this script can
    # see shares it -- or refuse, changing nothing, here. Runs before the dirty
    # check and before any side effect, --keep-docker included (Step 1 still
    # runs `compose down` under it). A plain statement, never in $(...): error()
    # inside a substitution would only end the subshell. Sets WPA_DOCKER.
    worktree_project_attribution_or_die "$_main_repo" "$worktree_path" "$orphan_project" docker-optional
    if [[ "$WPA_DOCKER" != reachable ]]; then
        warn "Docker is $WPA_DOCKER: Docker resources will not be touched and the Docker cleanup steps are skipped."
    fi

    # Step 0b: SMI-5000 -- script-level dirty-tree check, BEFORE any side effect
    # (SMI-7089: it used to run after the Docker deletes, so a refused removal had
    # already destroyed the worktree's volumes).
    #
    # Post-SMI-4829, every worktree has 4 initialized submodules
    # (docs/internal + 3 strategy mounts), and `git worktree remove`
    # refuses without --force when submodules are present:
    #     "fatal: working trees containing submodules cannot be moved or removed"
    # We pass --force unconditionally in Step 2 to bypass that submodule
    # check (verified empirically: `git worktree remove --force` from
    # outside the worktree does NOT modify main/.git/config's submodule
    # sections; the deinit-corruption concern only applies to
    # `git submodule deinit --all` from inside a worktree).
    #
    # But --force also bypasses git's dirty-tree protection. To preserve
    # that safety, we implement the dirty check ourselves at the script
    # level. Untracked entries (??) are excluded -- they're typically
    # node_modules / build artifacts and don't represent unsaved work.
    if [[ "$force_flag" != "--force" ]]; then
        # `grep -v '^??'` exits 1 when zero non-?? lines match. Under
        # `set -euo pipefail`, that exit propagates through the pipe and
        # prevents `wc -l` from running. Wrapping in `{ ... || true; }`
        # absorbs the no-match exit so wc -l always receives input and
        # produces a clean single-line integer -- no double-output, no
        # spurious syntax error in the -gt comparison below.
        local dirty_count
        dirty_count=$(cd "$worktree_path" && git status --porcelain 2>/dev/null | { grep -v '^??' || true; } | wc -l | tr -d ' ')
        if [[ "$dirty_count" -gt 0 ]]; then
            error "Worktree has $dirty_count uncommitted change(s).

Commit or discard them first, or re-run with --force to discard:
  $(basename "$0") $worktree_path --force"
        fi
    fi

    # Step 1: stop and remove the worktree's containers and project network (no
    # volume or image is deleted here -- see Step 3.5).
    stop_worktree_containers "$worktree_path"

    # Step 1b: Unlink node_modules symlink so `git worktree remove` sees a
    # clean tree (SMI-4377). A dangling symlink could confuse the removal
    # check; explicit cleanup keeps intent clear.
    if [[ -L "$worktree_path/node_modules" ]]; then
        rm -f "$worktree_path/node_modules"
    fi

    # Step 2: Remove the worktree (--force is now unconditional -- see Step 0b
    # rationale above). The user-visible --force flag remains for parity with
    # `git worktree remove --force` semantics, but the script already enforced
    # the dirty check above. SMI-5000.
    info "Removing git worktree..."
    if git worktree remove "$worktree_path" --force 2>&1; then
        success "  Worktree removed"
    else
        error "Failed to remove worktree."
    fi

    # Step 3: Check Docker resources — network count + global reclaimable report
    echo ""
    if [[ "$WPA_DOCKER" == reachable ]]; then
        check_docker_networks
        check_docker_reclaimable
    else
        info "Skipping the Docker network and reclaimable report (Docker is $WPA_DOCKER)"
    fi

    # Step 4: Prune networks + SAFE global categories (dangling images + build
    # cache) if requested. Aggressive image -a / volume prune stay manual.
    # Best-effort, never part of the per-project guarantee: skipped when Step 0
    # found Docker unavailable, and the helpers warn rather than abort.
    if [[ "$prune_flag" == true ]]; then
        if [[ "$WPA_DOCKER" == reachable ]]; then
            prune_docker_networks
            prune_docker_safe
        else
            info "Skipping the global prune (--prune): the global prune was skipped because Docker is $WPA_DOCKER"
        fi
    fi

    # Step 3.5: Targeted orphaned-volume/image prune (SMI-5750) -- runs
    # unconditionally on every removal, not gated behind --prune. Deliberately
    # placed here, LAST, after `git worktree remove` (Step 2, so the
    # just-removed worktree is already deregistered from `git worktree list`)
    # and after every other docker-call-producing step above.
    #
    # SMI-7089: this is now the ONLY place this script deletes a volume or an
    # image. The pruner takes the worktree lifecycle lock for each delete, re-reads
    # liveness under it, and refuses the whole run when any registered worktree or
    # .worktrees directory still resolves to this project -- so a colliding peer
    # keeps its resources (the old by-name deletes did not).
    #
    # Skipped (the call is never attempted) when --keep-docker, --no-orphan-prune
    # or SKILLSMITH_ORPHAN_PRUNE_DISABLE=1 is set, or when Step 0 found Docker
    # unavailable. All of them therefore KEEP this worktree's own volumes and image.
    local prune_failed=false prune_reason="the targeted orphan prune failed or refused"
    if [[ "$keep_docker" == true ]]; then
        info "Skipping targeted orphan prune (--keep-docker: this worktree's image and volumes are kept)"
    elif [[ "$no_orphan_prune" == true || "${SKILLSMITH_ORPHAN_PRUNE_DISABLE:-}" == "1" ]]; then
        info "Skipping targeted orphan prune (--no-orphan-prune or SKILLSMITH_ORPHAN_PRUNE_DISABLE=1: this worktree's image and volumes are kept)"
    elif [[ "$WPA_DOCKER" == unreachable ]]; then
        # Docker is installed but its daemon did not answer at Step 0: the user asked
        # for this worktree's image and volumes to go (no --keep-docker, no opt-out)
        # and they are still there. That is an incomplete removal, not a success:
        # same tail as a failed prune, so the re-run command is printed and exit is 1.
        prune_failed=true
        prune_reason="the Docker daemon was unreachable, so its image and volumes were NOT removed"
    elif [[ "$WPA_DOCKER" != reachable ]]; then
        info "Skipping targeted orphan prune (Docker is $WPA_DOCKER: no Docker resources were touched)"
    else
        # Only THIS worktree's project is deletable; every other orphan is report-only.
        if ! "$SCRIPT_DIR/prune-orphaned-docker-volumes.sh" --only-project "$orphan_project"; then
            prune_failed=true
        fi
    fi

    if [[ "$prune_failed" == true ]]; then
        echo ""
        warn "Worktree removed; Docker cleanup incomplete ($prune_reason)."
        warn "  Re-run it once the cause above is fixed (Docker must be reachable):"
        warn "    $SCRIPT_DIR/prune-orphaned-docker-volumes.sh --only-project $orphan_project"
        exit 1
    fi

    echo ""
    success "Worktree removal complete!"
}

main "$@"

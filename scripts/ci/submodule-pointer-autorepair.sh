#!/usr/bin/env bash
# scripts/ci/submodule-pointer-autorepair.sh
# SMI-6260 Wave 2 — post-merge TOCTOU closure for docs/internal's gitlink.
# Invoked by the `pointer-autorepair` job in
# .github/workflows/submodule-pointer-check.yml on every push to `main`
# touching a .gitmodules mount. Lives here rather than inline in the workflow
# YAML to keep that file's complexity bounded, matching this repo's existing
# convention of a dedicated script behind a thin workflow step (see
# scripts/prod-deploy-cancel-monitor.sh + .github/workflows/prod-deploy-cancel-monitor.yml).
# SMI-6260's plan named only the workflow YAML and SMI-6580's draft repeated
# that error; the corrected plan names THIS file as the alerting surface.
#
# Design (binding):
# docs/internal/implementation/smi-6260-docs-internal-pointer-regression-gate.md
# "TOCTOU closure" section. Only docs/internal (the sole v1 BLOCKING_MOUNTS
# entry in check-submodule-pointer.sh) drives auto-repair or issue-opening
# here — a non-blocking-mount warning never reaches this script's FAIL
# branch, matching check-submodule-pointer.sh's own --mode=block exit-code
# semantics (only a BLOCKING_MOUNTS failure sets the non-zero exit).
#
# SMI-6580 Wave 1 — this alerting path failed SILENTLY in production: it
# correctly detected a real ADR-143 ancestry violation, then failed to open
# the alert issue and still concluded `success`. Root cause (confirmed via
# workflow run 34719995369, the line immediately above the swallowed
# `::warning::`): `gh issue create --label submodule-pointer-regression`
# failed with `could not add label: 'submodule-pointer-regression' not
# found` — the label had never been created on this repo (`gh api
# repos/smith-horn/skillsmith/labels --paginate` returned 49 labels, none of
# them this one). Five independent silent-success paths, all fixed together
# here (fixing the label without the rest would just move the failure
# elsewhere; fixing the rest without the label would still fail the exact
# same way):
#   (a) `open_or_skip_issue` now runs an idempotent `gh label create`
#       immediately before `gh issue create`, matching the established
#       shape in scripts/prod-deploy-cancel-monitor.sh:178 and
#       scripts/status-external-probe.sh:148. This label is also now
#       pre-registered in scripts/setup-github-labels.sh, so a fresh repo
#       never depends on this call-site create running first.
#   (b) A failed `gh issue create` now captures stderr, emits it as a
#       `::error::` naming the actual cause, and returns non-zero — the
#       previous `|| echo "::warning::…"` discarded the cause and always
#       returned 0.
#   (c) Every caller of `open_or_skip_issue` now propagates that non-zero
#       into this script's own exit status instead of the previous
#       unconditional `exit 0` after every branch.
#   (d) The dedupe `gh issue list` query's own failure is now distinguished
#       from "no existing issue" (previously folded together by
#       `|| echo ""`) — a `gh` outage no longer silently disables dedup and
#       proceeds as though nothing were already reported.
#   (e) A `check-submodule-pointer.sh` exit code of 2 (a BROKEN INVOCATION —
#       unknown argument, an unresolvable --ref/--target/--before; see that
#       script's own :69-71, :76, :94-101) is now distinguished from exit 1
#       (a normal FAIL/R-FETCH content verdict) and fails loudly instead of
#       being folded into "nothing actionable, exit 0".
#
# Testability: the body that was previously top-level imperative code (the
# GITHUB_SHA/BEFORE_SHA requireds, the check-submodule-pointer.sh subprocess
# call, and the FAIL_LINE/RULE dispatch) now lives in main(), called only
# when this file is executed directly (the BASH_SOURCE guard at the very
# bottom) — exactly what `run: ./scripts/ci/submodule-pointer-autorepair.sh`
# does in the workflow. This lets scripts/tests/submodule-pointer-autorepair.test.ts
# `source` the file to unit-test `open_or_skip_issue` directly (with a faked
# `gh` on PATH) without triggering any of main()'s side effects or requiring
# a real git fixture.
#
# Required env (only read inside main(), i.e. only when executed directly):
#   GITHUB_SHA        the pushed commit (T-side ref for check-submodule-pointer.sh)
#   BEFORE_SHA         resolved B_prev source (github.event.before, or the
#                      workflow's HEAD~1 fallback for a null/new-branch before)
#   SHADOW             '1' (default posture) suppresses only the R3 auto-repair
#                      PUSH — alerting/issue-opening still happens (per the
#                      plan's explicit shadow-mode-scope clarification)
#   MAIN_PUSH_PAT      may be empty — SKILLSMITH_MAIN_PUSH_PAT is unprovisioned
#                      as of this Wave 2 implementation (confirmed via
#                      `gh secret list`, see the Wave 2 report); empty means
#                      degrade to alert-only for R3 too
#   GH_TOKEN            used by `gh issue` calls (github.token is sufficient —
#                       issues:write, no push needed for issue creation)
#   GITHUB_REPOSITORY   owner/repo, for `gh issue --repo`

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MOUNT="docs/internal"
MOUNT_DIR="$REPO_ROOT/$MOUNT"

# SMI-6569: clear the inherited git environment for this whole process. This
# script's own git calls include `add`, `commit` and `push` against the OUTER
# repo — the highest-consequence calls in the guard — and an earlier fix
# wrapped only the submodule-directed ones. See git-env-sanitize.sh for the
# executed counterexample showing an outer call returning a wrong answer with
# exit 0 under a poisoned GIT_DIR.
#
# Not a live trigger here (a GitHub Actions step exports none of these, unlike
# a hook on a push from a linked worktree), but this script is the one that can
# push to main, so it gets the same treatment rather than an argument about why
# it does not need it.
# shellcheck source=git-env-sanitize.sh
source "$(dirname "${BASH_SOURCE[0]}")/git-env-sanitize.sh"
sanitize_git_env

# git_mount <git-args...> — run git against the SUBMODULE working directory.
# Delegates the variable list to git-env-sanitize.sh; see git_sub() in
# check-submodule-pointer.helpers.sh for the sibling wrapper.
git_mount() {
    git_sanitized -C "$MOUNT_DIR" "$@"
}

# ---------------------------------------------------------------------------
# Deduped GitHub issue helper — dedupe key is the exact commit SHA this run
# is reacting to (a fresh regression on a later push always gets its own
# issue, even if an older one for a prior SHA is still open).
#
# Reads globals set by main() before dispatch: GITHUB_REPOSITORY, GITHUB_SHA,
# FAIL_LINE, RULE. A unit test that sources this file directly must set
# those four (plus a faked `gh` on PATH) before calling this function.
#
# Returns 0 on success OR on a legitimate skip (already reported). Returns
# 1 on any failure that means the alert was NOT actually delivered — the
# dedupe query failing (SMI-6580d) or the issue create failing (SMI-6580b) —
# so callers must propagate this to the script's own exit status
# (SMI-6580c), never assume success just because the function returned.
# ---------------------------------------------------------------------------
open_or_skip_issue() {
    _SPA_REMEDIATION="$1"

    # SMI-6580(F-4): a machine-readable dedupe key, embedded in the body and
    # searched for verbatim. The previous key was the prose `commit <sha>`,
    # which matches ANY issue whose body happens to mention that commit —
    # combined with `--state all`, an old closed incident write-up discussing
    # the same SHA would suppress a real pointer alert and return success.
    # This marker cannot appear by accident, and the query below is also
    # constrained by label.
    _SPA_DEDUPE_KEY="pointer-autorepair-key:${MOUNT}:${GITHUB_SHA}"

    # Label creation comes FIRST, before the dedupe query, because that query
    # is label-constrained (below) and `gh issue list --label` against a label
    # that does not exist is not a state this function should have to reason
    # about. It is also the SMI-6580 root cause, so it belongs ahead of every
    # other gh call rather than immediately before the create.
    #
    # SMI-6580(F-5): `|| true` on its own would make a failed label write
    # indistinguishable from success. Tolerate failure only when the label
    # demonstrably already exists; otherwise say so, because the next call is
    # the one SMI-6580 was about.
    _SPA_ERR_FILE="$(mktemp)" || {
        echo "::error::[pointer-autorepair] mktemp failed — cannot capture gh diagnostics, refusing to run the alert path blind"
        return 1
    }
    if ! gh label create submodule-pointer-regression --color b60205 \
        --description "docs/internal pointer regression pointer-autorepair could not safely auto-repair (SMI-6260/SMI-6580)" \
        >/dev/null 2>"$_SPA_ERR_FILE"; then
        if gh label list --repo "$GITHUB_REPOSITORY" \
            --search submodule-pointer-regression --json name \
            -q '.[].name' 2>/dev/null | grep -qx submodule-pointer-regression; then
            : # already exists — the expected steady state, nothing to report
        else
            echo "::warning::[pointer-autorepair] could not create label 'submodule-pointer-regression' and could not confirm it exists: $(cat "$_SPA_ERR_FILE"). The issue create below will fail if the label is genuinely missing, and that failure is now fatal."
        fi
    fi

    if ! _SPA_EXISTING="$(gh issue list --repo "$GITHUB_REPOSITORY" \
        --label submodule-pointer-regression \
        --search "\"${_SPA_DEDUPE_KEY}\" in:body" --state all \
        --json number -q '.[0].number' 2>"$_SPA_ERR_FILE")"; then
        echo "::error::[pointer-autorepair] dedupe query failed (gh issue list) — cannot safely determine whether ${RULE} on ${GITHUB_SHA} was already reported, refusing to proceed as though it wasn't: $(cat "$_SPA_ERR_FILE")"
        rm -f "$_SPA_ERR_FILE"
        return 1
    fi
    rm -f "$_SPA_ERR_FILE"
    if [ -n "${_SPA_EXISTING:-}" ] && [ "$_SPA_EXISTING" != "null" ]; then
        echo "[pointer-autorepair] already reported as issue #${_SPA_EXISTING}, skipping"
        return 0
    fi

    # shellcheck disable=SC2016  # single-quoted ON PURPOSE: the backticked
    # `pointer-autorepair`/`main`/etc. spans are literal Markdown, not shell
    # command substitution — the %s placeholders are printf format specs,
    # substituted via printf's own args below, never shell-expanded.
    #
    # The trailing HTML comment carries the dedupe key. It is invisible in
    # rendered Markdown and is what the query above matches on, so dedupe no
    # longer depends on prose that an unrelated issue could reproduce.
    _SPA_BODY="$(printf '%s\n\nDetected by `pointer-autorepair` (SMI-6260) on push to `main`, commit %s.\n\n**Remediation**: %s\n\n_Auto-generated by `.github/workflows/submodule-pointer-check.yml` (SMI-6260)._\n\n<!-- %s -->' \
        "$FAIL_LINE" "$GITHUB_SHA" "$_SPA_REMEDIATION" "$_SPA_DEDUPE_KEY")"

    # SMI-6580(b): capture stderr and surface the actual cause instead of
    # discarding it into a generic `::warning::` that always returned 0.
    # stderr to a FILE (not `2>&1`) so stdout stays clean for the created
    # issue's URL, which is echoed below — the pre-SMI-6580 code let `gh`
    # print that URL straight to the job log, and losing it would make a
    # successful alert harder to find than a failed one.
    _SPA_ERR_FILE="$(mktemp)" || {
        echo "::error::[pointer-autorepair] mktemp failed — cannot capture gh's diagnostics for the issue create, refusing to attempt the alert blind"
        return 1
    }
    if ! _SPA_URL="$(gh issue create --repo "$GITHUB_REPOSITORY" \
        --label submodule-pointer-regression \
        --title "docs/internal pointer regression on main (${RULE}) — commit ${GITHUB_SHA:0:7}" \
        --body "$_SPA_BODY" 2>"$_SPA_ERR_FILE")"; then
        echo "::error::[pointer-autorepair] gh issue create failed for ${RULE} on ${GITHUB_SHA}: $(cat "$_SPA_ERR_FILE")"
        rm -f "$_SPA_ERR_FILE"
        return 1
    fi
    rm -f "$_SPA_ERR_FILE"
    echo "[pointer-autorepair] opened issue for ${RULE} on ${GITHUB_SHA}: ${_SPA_URL}"
    return 0
}

# main — the actual driver, previously top-level imperative code. Only
# invoked by the BASH_SOURCE guard at the bottom of this file, never when
# the file is merely `source`d (e.g. by a unit test wanting only
# open_or_skip_issue). Returns the same exit-status contract the script
# always had: 0 for "handled" (including every legitimate skip/degrade
# path), 1 for anything that means an alert or repair did NOT actually
# happen when it should have (SMI-6580 fix).
main() {
    # SMI-6580(F-5): mktemp's own failure was unchecked, and the file was never
    # removed. An unchecked mktemp means `>"$OUTPUT_FILE"` writes to the empty
    # string and the evaluator's output is lost, which this function would then
    # scan for a FAIL line and find none.
    OUTPUT_FILE="$(mktemp)" || {
        echo "::error::[pointer-autorepair] mktemp failed — cannot capture the evaluator's output, refusing to run blind"
        return 1
    }
    trap 'rm -f "$OUTPUT_FILE"' RETURN

    : "${GITHUB_SHA:?GITHUB_SHA required}"
    : "${BEFORE_SHA:?BEFORE_SHA required}"
    SHADOW="${SHADOW:-1}"
    MAIN_PUSH_PAT="${MAIN_PUSH_PAT:-}"
    GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-smith-horn/skillsmith}"

    "$REPO_ROOT/scripts/ci/check-submodule-pointer.sh" \
        --mode=block \
        --ref="$GITHUB_SHA" \
        --before="$BEFORE_SHA" \
        >"$OUTPUT_FILE" 2>&1
    EXIT_CODE=$?
    cat "$OUTPUT_FILE"

    if [ "$EXIT_CODE" -eq 0 ]; then
        echo "[pointer-autorepair] no blocking-mount violation on this push — nothing to do."
        return 0
    fi

    # SMI-6580(e): capture grep's OWN status instead of ending the pipeline
    # with `| head -1 || true`, which masked both producer and consumer
    # failure. grep exits 1 for "no match" (expected and benign) and >1 for a
    # real error — an unreadable output file, a bad pattern. Those are not the
    # same event and must not both read as "no FAIL line".
    FAIL_LINE=""
    if GREP_OUT="$(grep -E "^FAIL \[${MOUNT}\]: " "$OUTPUT_FILE")"; then
        FAIL_LINE="$(printf '%s\n' "$GREP_OUT" | head -1)"
    else
        GREP_STATUS=$?
        if [ "$GREP_STATUS" -gt 1 ]; then
            echo "::error::[pointer-autorepair] could not scan the evaluator's output for a ${MOUNT} FAIL line (grep exited ${GREP_STATUS}, not 0-match-found or 1-no-match) — the verdict is unknown, refusing to report success"
            return 1
        fi
    fi

    if [ -z "$FAIL_LINE" ]; then
        # ALLOWLIST, not a denylist. An earlier version special-cased exit 2
        # and let every other non-zero status fall through to "nothing
        # actionable, return 0" — so 126 (not executable), 127 (interpreter
        # missing), a signal death, or any future status meant this job
        # reported success on a run that never produced a verdict.
        #
        # Only exit 1 is a content verdict. Exit 2 is a broken invocation
        # (unknown argument, or --ref/--target/--before not resolving — see
        # check-submodule-pointer.sh's own argument parsing and ref checks).
        if [ "$EXIT_CODE" -ne 1 ]; then
            echo "::error::[pointer-autorepair] check-submodule-pointer.sh exited ${EXIT_CODE} with no ${MOUNT} FAIL line. Only exit 1 is a content verdict; 2 means this script invoked it wrongly, and anything else means it crashed, was signalled, or could not run at all. See its output above. Not treating this as 'nothing to do'."
            return 1
        fi
        echo "[pointer-autorepair] exit 1 with no blocking-mount FAIL line for $MOUNT — nothing actionable (an R-FETCH or a non-blocking-mount warning, already handled by the caller's own fetch-outcome gate)."
        return 0
    fi

    RULE="$(printf '%s' "$FAIL_LINE" | sed -E 's/^FAIL \[[^]]+\]: (R[0-9]+):.*/\1/')"
    echo "[pointer-autorepair] matched rule: $RULE"

    if [ "$RULE" = "R3" ]; then
        # The only auto-repairable case: fast-forward the gitlink to T.
        BRANCH="$(git config -f "$REPO_ROOT/.gitmodules" --get submodule."$MOUNT".branch 2>/dev/null || echo main)"
        T_SHA="$(git_mount rev-parse "origin/$BRANCH")"

        # No `set -e` in this script (the push result below needs explicit
        # if/else branching), so this sequence must fail loudly and stop here
        # rather than silently falling through to the push-or-shadow branch
        # below with a HEAD that never actually advanced (governance review
        # finding — a job with write access to main must never risk pushing a
        # stale HEAD because an earlier step in the same run silently failed).
        if ! git_mount checkout --detach --quiet "$T_SHA" \
            || ! git -C "$REPO_ROOT" -c user.name="skillsmith-bot" -c user.email="bot@skillsmith.app" add "$MOUNT" \
            || ! git -C "$REPO_ROOT" -c user.name="skillsmith-bot" -c user.email="bot@skillsmith.app" \
                commit --quiet -m "chore(docs): fast-forward docs/internal pointer to ${T_SHA:0:7} [auto-repair SMI-6260]"; then
            echo "::error::[pointer-autorepair] failed to prepare the R3 repair commit (checkout/add/commit) — aborting without pushing or alerting on a stale HEAD; re-run the workflow"
            return 1
        fi

        if [ "$SHADOW" = "1" ]; then
            echo "[pointer-autorepair] shadow mode — R3 detected, auto-repair PUSH suppressed, but still alerting (per plan's shadow-mode-scope clarification)."
            if ! open_or_skip_issue "SHADOW MODE: would fast-forward to ${T_SHA} (commit prepared locally, not pushed). Once shadow mode ends, or manually now: \`./scripts/bump-docs-pointer.sh\`"; then
                return 1
            fi
        elif [ -z "$MAIN_PUSH_PAT" ]; then
            echo "::warning::SKILLSMITH_MAIN_PUSH_PAT not provisioned — degrading to alert-only for this R3 detection."
            if ! open_or_skip_issue "SKILLSMITH_MAIN_PUSH_PAT is not provisioned; auto-repair cannot push. Run manually: \`./scripts/bump-docs-pointer.sh\`"; then
                return 1
            fi
        else
            if git -C "$REPO_ROOT" push "https://x-access-token:${MAIN_PUSH_PAT}@github.com/${GITHUB_REPOSITORY}.git" HEAD:main; then
                echo "[pointer-autorepair] pushed fast-forward repair to main: ${T_SHA}"
            else
                echo "::warning::auto-repair push failed — falling back to alerting"
                if ! open_or_skip_issue "Auto-repair push failed (see workflow run log). Run manually: \`./scripts/bump-docs-pointer.sh\`"; then
                    return 1
                fi
            fi
        fi
        return 0
    fi

    case "$RULE" in
        R1 | R5 | R6 | R7)
            open_or_skip_issue "Run \`./scripts/bump-docs-pointer.sh\` (see the rule message above for the exact target)." || return 1
            ;;
        R11)
            open_or_skip_issue "A maintainer must manually repair main's docs/internal pointer directly (see ADR-143's docs-internal-pointer-repair note) before R7 can validate new bumps against it." || return 1
            ;;
        R8)
            open_or_skip_issue "R8 should not occur on a push to main (PAT is always available server-side) — investigate the workflow run directly." || return 1
            ;;
        *)
            open_or_skip_issue "See the rule message above." || return 1
            ;;
    esac

    return 0
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
    exit $?
fi

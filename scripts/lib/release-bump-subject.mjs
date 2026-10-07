/**
 * SMI-7012 — the single matcher for "is this commit subject a release bump?".
 * @module scripts/lib/release-bump-subject
 *
 * Two copies of this predicate existed, byte-identical, and both carried the
 * same defect: `startsWith('chore(release):')` cannot match a subject whose
 * conventional-commit **breaking marker** sits where the colon is expected.
 * `chore(release)!:` is a release commit and was invisible to both.
 *
 * That went live on 2026-10-05: core 0.13.0 squashed as
 * `chore(release)!: SMI-6983 …`, so the boundary commit for that release could
 * not be found by the function whose only job is finding it. The marker was
 * added deliberately and correctly to signal a breaking change, and the tooling
 * then failed to read its own release commit *because* conventional commits were
 * used properly. Measured: 1 of the 30 most recent `chore(release)` commits was
 * missed, and it was that one — every earlier release used the unbanged form.
 *
 * Consolidated here rather than patched in both places, per the governance
 * rule that one tested implementation is far harder to regress than two. The
 * duplication is what produced the defect's second instance.
 *
 * **This is `.mjs`, deliberately.** `scripts/check-source-version-drift.mjs`
 * runs under plain `node` in CI and imports only builtins, so it cannot import
 * TypeScript at runtime. A `.mjs` can be imported from both that file and from
 * `release-changelog.ts` under `tsx`; the reverse is not true. The sibling
 * `.d.mts` carries the types, which is the established pairing here (see
 * `project-dir.d.mts`, `linear-client.d.mts`).
 */

/**
 * True iff a commit subject is a release-version-bump commit.
 *
 * **Two arms, both exact forms.** There is deliberately no free-text arm.
 *
 * Arm 1 tolerates an optional `!` before the colon. It is scoped to
 * `chore(release)` and so does not admit a bare `chore!:` or an unrelated scope.
 * Arm 2 is a literal prefix, kept because `check-source-version-drift.mjs`'s
 * own tests assert it and the 0.1.x-era releases it matches used that exact
 * wording.
 *
 * **A third arm existed and was deleted rather than narrowed a third time.**
 * It was `/^chore:.*bump.*\d+\.\d+\.\d+/` — any bare `chore:` subject
 * containing "bump" and something version-shaped. It produced two separate
 * review findings in two rounds:
 *
 *   1. It matched `chore: bump npm from 10.9.4 to 11.9.0` (8ac96f7a4), a
 *      toolchain dependency bump. Patched with a negative lookahead excluding
 *      `… from <version> to <version>`.
 *   2. A cross-family review then measured that the patched arm still accepted
 *      `chore: bump minimum Node version to 20.1.0`, `chore: bump API docs for
 *      1.2.3`, `chore: bump lockfile format to 3.0.0` and
 *      `chore: bump docs for 1.2.3beta`, and that the lookahead had introduced
 *      a false negative on `chore: bump core from 0.5.0 to 0.6.0`.
 *
 * Narrowing it a third time would have been the wrong move. The arm matched
 * free text a human writes at squash time, and the caller takes the FIRST match
 * scanning newest-first — so a false positive does not fail, it silently
 * returns a different boundary. That is the failure this module exists to
 * remove, and an unconstrained arm reproduces it indefinitely.
 *
 * Deleting it was measured to cost nothing. `findLastVersionBumpCommit` searches
 * `BOUNDARY_SEARCH_DEPTH` (50) commits. Within the most recent 50 commits on
 * `main`, arm 1 matches 3 and the legacy arms match 0. Across all 3,351 commits,
 * exactly 9 need a legacy arm and the nearest sits 2,258 commits from HEAD —
 * roughly 45x beyond any window this function reads. The claim that removing
 * them "would orphan boundaries the matcher can currently find" was in this
 * docblock, was never measured, and is false.
 *
 * What this costs instead, stated plainly: the matcher now recognises two exact
 * forms and nothing else, so a release worded some third way is not recognised
 * rather than guessed at. The caller refuses in that case (ADR-177 section 5)
 * instead of silently using a wrong boundary. Resolving from published tags is
 * the real answer and is SMI-7016.
 *
 * @param {unknown} subject a commit subject line
 * @returns {boolean}
 */
export function isReleaseBumpSubject(subject) {
  if (typeof subject !== 'string') return false
  return /^chore\(release\)!?:/.test(subject) || subject.startsWith('chore: bump version')
}

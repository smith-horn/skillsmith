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
 * Three arms, and the two legacy ones are kept on purpose: they match release
 * commits that exist in this repository's history, and removing them would
 * orphan boundaries the matcher can currently find. Measured against all 3,351
 * commits on `main`: arm 1 matches 50, arm 2 matches 6, arm 3 matches 3. None
 * of the three arms is dead. Dating their removal needs historical-reachability
 * evidence that SMI-7012 does not gather.
 *
 * The first arm tolerates an optional `!` before the colon. It is scoped to
 * `chore(release)` and so does not admit a bare `chore!:` or an unrelated
 * scope.
 *
 * The third arm **excludes the dependency-bump idiom** `… from <version> to
 * <version>`. Without that exclusion it matched `chore: bump npm from 10.9.4 to
 * 11.9.0` (8ac96f7a4), a toolchain dependency bump and not a release — and
 * since the caller takes the FIRST match scanning newest-first, one such commit
 * landing after a release silently wins over the real boundary. That is the same
 * wrong-boundary-reported-confidently failure this module exists to remove, so
 * it is excluded rather than tolerated. Dependabot's own commits are scoped
 * (`chore(deps):`) and never reached this arm; the one that did was hand-written.
 * The exclusion is deliberately anchored on `from` followed by a digit, so a
 * subject that merely contains the word (`chore: bump core 0.5.0 from the
 * cadence run`) still matches.
 *
 * @param {unknown} subject a commit subject line
 * @returns {boolean}
 */
export function isReleaseBumpSubject(subject) {
  if (typeof subject !== 'string') return false
  return (
    /^chore\(release\)!?:/.test(subject) ||
    subject.startsWith('chore: bump version') ||
    /^chore:(?!.*\bfrom\s+v?\d).*bump.*\d+\.\d+\.\d+/.test(subject)
  )
}

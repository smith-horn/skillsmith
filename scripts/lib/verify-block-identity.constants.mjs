/**
 * Workflow-shaped constants for the `publish.yml` verify-block identity gate
 * (SMI-6513). Split out of `verify-block-identity.mjs` to keep both files under
 * this repo's 500-line policy (`scripts/file-length-policy.mjs`).
 *
 * The split is along a real boundary, not an arbitrary chop: everything here is
 * *data about the workflow* — which blocks exist, how block 4 legitimately differs,
 * what the tail currently is. Everything in the sibling file is the analysis engine
 * and is independent of any particular workflow.
 *
 * That boundary matters for maintenance: **any edit to a value in this file
 * requires a matching test case in `scripts/tests/verify-block-identity.test.ts`
 * in the same PR** (CLAUDE.md § CI Health Requirements — source changes ship with
 * their test updates). These are the values whose silent drift the gate exists to
 * prevent, so they are the ones that must never move unobserved.
 */

/**
 * The tail-boundary marker, used verbatim. Follows the established `# audit:<name>`
 * convention in this repo (`# audit:carveout-pure-js`, `# audit:allow-continue-on-error`).
 *
 * It replaces an earlier design that split block 4 at the first `/^SMOKE_DIR=/`
 * line. That anchor cannot match a guarded assignment
 * (`if ! SMOKE_DIR="$(mktemp -d)"; then`), nor a `readonly` or `mktemp --directory`
 * refactor — and the split fails *before* the tail digest is computed, so bumping
 * the pinned digest could not repair it. An explicit marker states the conceptual
 * boundary instead of encoding one transient implementation of it.
 */
export const TAIL_MARKER = '# audit:verify-block-smoke-tail'

/** Substitution sentinels. A body already containing either is rejected. */
export const PKG_SENTINEL = '__PKG__'
export const MANIFEST_SENTINEL = '__MANIFEST__'

/**
 * Discovery predicate for a *candidate* verify step.
 *
 * Do not loosen this. The `pre-publish-check` job contains a step named
 * `Verify dependencies`; a bare `/Verify/` matches FIVE steps, not four, and the
 * "exactly these four" assertion then misfires on a wholly unrelated step.
 * Requiring `on npm` correctly excludes it. The exact-identity registration below
 * is the real defence — this predicate only decides what gets *offered* for
 * registration — but the loosening is a live trap, named here so it is rejected
 * deliberately rather than rediscovered.
 */
export const CANDIDATE_STEP_NAME = /^Verify\b.*\bon npm\b/

/**
 * The registered blocks. The identity is the PAIR `(jobId, stepName)`, not the step
 * name alone: a verify step that moves between the genuinely distinct jobs
 * `publish-cli` and `publish-skillsmith-cli` changes its predicates, dependencies,
 * permissions and publish association while changing no digest at all.
 *
 * `class: 'scoped'` blocks must all share one digest (Stage 2). The single
 * `class: 'reshaped'` block is compared via the forward rewrite in Stage 3.
 *
 * SMI-6498 adds an `@smith-horn/enterprise` verify block — that job has no verify
 * block at all today, which is deliberately out of SMI-6513's scope. When SMI-6498
 * adds one it must register its `(jobId, stepName)` pair here (as `scoped`, if it
 * is byte-identical to the other three, which it should be) or E1's extra-name arm
 * fires `VB-UNREGISTERED-VERIFY-STEP` and the build stays red. That coupling is
 * deliberate: a new verify block nobody registered is exactly the drift this check
 * exists to catch.
 */
export const REGISTRY = [
  {
    jobId: 'publish-core',
    stepName: 'Verify core on npm',
    pkg: '@skillsmith/core',
    manifestPath: 'packages/core/package.json',
    class: 'scoped',
  },
  {
    jobId: 'publish-mcp-server',
    stepName: 'Verify mcp-server on npm',
    pkg: '@skillsmith/mcp-server',
    manifestPath: 'packages/mcp-server/package.json',
    class: 'scoped',
  },
  {
    jobId: 'publish-cli',
    stepName: 'Verify cli on npm',
    pkg: '@skillsmith/cli',
    manifestPath: 'packages/cli/package.json',
    class: 'scoped',
  },
  {
    jobId: 'publish-skillsmith-cli',
    stepName: 'Verify skillsmith-cli on npm + smoke the wrapper',
    pkg: 'skillsmith-cli',
    manifestPath: 'packages/skillsmith-cli/package.json',
    class: 'reshaped',
  },
]

/** The canonical block Stage 3 rewrites forward into block 4's expected shape. */
export const CANONICAL_STEP_NAME = 'Verify core on npm'

/** The one `class: 'reshaped'` block. */
export const RESHAPED_STEP_NAME = 'Verify skillsmith-cli on npm + smoke the wrapper'

/**
 * R2 — ASCII transliteration. A CLOSED, fixed table: each mapping is the one
 * specific replacement block 4 uses. Deliberately not "strip all non-ASCII", which
 * would let block 4 substitute anything at all for a glyph.
 *
 * These are exactly the three non-ASCII codepoints present in the normalized
 * canonical block. A new glyph without a table entry fails `VB-NON-ASCII-UNMAPPED`
 * rather than silently under-transliterating into a confusing digest mismatch.
 */
export const R2_TABLE = [
  ['✓', 'OK'],
  ['…', '...'],
  ['—', '-'],
]

/**
 * R3 — the control-flow reshape, as ONE exact multiline fragment.
 *
 * Not a script of ordered line edits: in the normalized canonical block the line
 * `fi` occurs twice and `exit 0` occurs twice, so anchors like "the first `exit 0`"
 * are ordinal and contextual rather than exact-unique, and replacing one shifts the
 * other's position — two conforming implementations could legitimately transform
 * different lines. A single whole-fragment substitution has no such ambiguity.
 *
 * The five differences this fragment encodes, for the reader only — they are NOT
 * applied as separate edits: insert `LIVE=''` before the loop; `exit 0` → `break`
 * inside the loop; wrap the final-probe region in `if [ "$LIVE" != "$VERSION" ]`;
 * the final-probe `exit 0` → `LIVE="$VERSION"`; the inner closing `fi` → `else`,
 * with two `fi` lines closing the nested structure. The preamble (`VERSION=…`,
 * `VERIFY_MAX_ATTEMPTS=…`, `VERIFY_INTERVAL=…`) is outside the fragment and shared
 * unchanged.
 *
 * Both fragments are in NORMALIZED form (comments stripped, lines trimmed, empty
 * lines dropped, package/manifest substituted) and post-R2 ASCII. They were
 * generated mechanically from the real `publish.yml`, not transcribed by hand.
 */
export const R3_SOURCE = [
  'for attempt in $(seq 1 "$VERIFY_MAX_ATTEMPTS"); do',
  'LIVE=$(npm view "__PKG__@${VERSION}" version --no-json --offline=false --prefer-offline=false --registry=https://registry.npmjs.org 2>/dev/null || echo \'\')',
  'if [ "$LIVE" = "$VERSION" ]; then',
  'echo "OK __PKG__@${VERSION} verified live on npm (attempt ${attempt})"',
  'exit 0',
  'fi',
  'echo "... __PKG__@${VERSION} not yet visible (attempt ${attempt}/${VERIFY_MAX_ATTEMPTS}); waiting ${VERIFY_INTERVAL}s"',
  'sleep "$VERIFY_INTERVAL"',
  'done',
  'echo "Final probe for __PKG__@${VERSION} - any npm output follows:"',
  'FINAL=$(npm view "__PKG__@${VERSION}" version --no-json --offline=false --prefer-offline=false --registry=https://registry.npmjs.org) || true',
  'if [ "$FINAL" = "$VERSION" ]; then',
  'echo "OK __PKG__@${VERSION} verified live on npm (final probe)"',
  'exit 0',
  'fi',
  'echo "Final probe stdout was: ${FINAL:-<empty>}"',
  'echo "::error::__PKG__@${VERSION} is not live on npm after ${VERIFY_MAX_ATTEMPTS} attempts over $((VERIFY_MAX_ATTEMPTS * VERIFY_INTERVAL))s - failing the job."',
  'exit 1',
].join('\n')

export const R3_REPLACEMENT = [
  "LIVE=''",
  'for attempt in $(seq 1 "$VERIFY_MAX_ATTEMPTS"); do',
  'LIVE=$(npm view "__PKG__@${VERSION}" version --no-json --offline=false --prefer-offline=false --registry=https://registry.npmjs.org 2>/dev/null || echo \'\')',
  'if [ "$LIVE" = "$VERSION" ]; then',
  'echo "OK __PKG__@${VERSION} verified live on npm (attempt ${attempt})"',
  'break',
  'fi',
  'echo "... __PKG__@${VERSION} not yet visible (attempt ${attempt}/${VERIFY_MAX_ATTEMPTS}); waiting ${VERIFY_INTERVAL}s"',
  'sleep "$VERIFY_INTERVAL"',
  'done',
  'if [ "$LIVE" != "$VERSION" ]; then',
  'echo "Final probe for __PKG__@${VERSION} - any npm output follows:"',
  'FINAL=$(npm view "__PKG__@${VERSION}" version --no-json --offline=false --prefer-offline=false --registry=https://registry.npmjs.org) || true',
  'if [ "$FINAL" = "$VERSION" ]; then',
  'echo "OK __PKG__@${VERSION} verified live on npm (final probe)"',
  'LIVE="$VERSION"',
  'else',
  'echo "Final probe stdout was: ${FINAL:-<empty>}"',
  'echo "::error::__PKG__@${VERSION} is not live on npm after ${VERIFY_MAX_ATTEMPTS} attempts over $((VERIFY_MAX_ATTEMPTS * VERIFY_INTERVAL))s - failing the job."',
  'exit 1',
  'fi',
  'fi',
].join('\n')

/**
 * Pinned digest of `sha256(normalize(BLOCK4_TAIL))`.
 *
 * The smoke tail is the only region of the four blocks with no sibling to compare
 * against, so a deliberate acknowledgement is the only available evidence that a
 * change to it was intended. A legitimate tail edit bumps this constant in the same
 * PR, adding a bump-log line below.
 *
 * This is CHANGE ACKNOWLEDGEMENT, not semantic proof of non-fatality. The tail's
 * `SMOKE_DIR="$(mktemp -d)"` and `sleep 8` are unguarded, and GitHub Actions runs
 * `run:` steps under `bash -e` (this workflow declares no `shell:` and no
 * `defaults:`, so errexit is on while pipefail and nounset are not) — a failing
 * `mktemp` therefore still kills the step. The textual guard alongside this digest
 * claims only "no registry probe, no explicit `exit 1`". Making non-fatality a real
 * invariant would need either a behavioural test executing the tail with failing
 * stubs for every fallible external command, or a `publish.yml` change wrapping the
 * smoke operation in an explicit guard; SMI-6513 deliberately does neither and
 * names the cost instead.
 *
 * Bump log:
 *   SMI-6513, 2026-09-12 — initial pin.
 */
export const PINNED_TAIL_DIGEST = '333b16ccc3a6558a1bd58386b8c0ed24b1ac88f6ecbd455d21ed34c6594566b5'

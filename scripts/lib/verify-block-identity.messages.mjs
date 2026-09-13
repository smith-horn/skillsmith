/**
 * Diagnostic prose for the `publish.yml` verify-block identity gate (SMI-6513).
 *
 * Separated from the engine deliberately: `findings[].code` is the stable,
 * machine-readable identifier that tests assert on, so **this prose can be improved
 * without touching a single test**. Keep it that way — if a test ever starts
 * matching on message text, the prose has become an interface and stops being
 * improvable.
 *
 * Every message should say what broke AND what to do about it. A named failure code
 * with a specific remedy is the reason this check can ship blocking rather than
 * warn-first; a mystery red would not be.
 */

import { TAIL_MARKER } from './verify-block-identity.constants.mjs'

export const MSG = {
  parseYaml: (detail) => `publish.yml is not parseable YAML: ${detail}`,

  parseNoJobs: () => 'publish.yml parsed but has no `jobs:` mapping',

  parseBadRun: (stepName) => `step "${stepName}" has an absent, non-string or empty \`run:\` body.`,

  duplicateStep: (count, stepName, jobs) =>
    `${count} steps share the name "${stepName}" (in job(s): ${jobs}). Step names must be ` +
    'unique so each body is compared exactly once. Note the key set can still look correct ' +
    'while a drifted body silently replaces the right one.',

  unregistered: (stepName) =>
    `step "${stepName}" matches the verify-step predicate but is not registered in REGISTRY ` +
    '(scripts/lib/verify-block-identity.constants.mjs). Register its (jobId, stepName) pair, ' +
    'or rename the step so it is not a verify block.',

  missingStep: (stepName, jobId) =>
    `registered step "${stepName}" was not found in job "${jobId}" (or anywhere in the ` +
    'workflow).',

  wrongJob: (stepName, expectedJob, actualJob) =>
    `registered step "${stepName}" is expected in job "${expectedJob}" but was found in job ` +
    `"${actualJob}". Moving a verify step between jobs changes its predicates, dependencies, ` +
    'permissions and publish association while changing no digest at all.',

  unsafeWhitespace: (kind, samples) =>
    `normalization cannot safely handle this body: ${kind}. ` +
    `Offending line(s): ${samples}. ` +
    'Leading indentation and blank lines are stripped before comparison because they are ' +
    'inert in shell -- but they are NOT inert here, so stripping them could make a block ' +
    'that is broken at runtime compare equal to one that works. Fix the line rather than ' +
    'relaxing this guard.',

  sentinelCollision: (pkgSentinel, manifestSentinel) =>
    `body already contains the literal ${pkgSentinel} or ${manifestSentinel}, which would ` +
    'defeat the substitution. Rename the offending token.',

  zeroSubstitution: (pkg, pkgCount, manifestPath, manifestCount) =>
    `registration does not describe this body: package "${pkg}" matched ${pkgCount} time(s) ` +
    `and manifest path "${manifestPath}" matched ${manifestCount} time(s); both must be ` +
    'non-zero.',

  countDisagreement: (ref, other) =>
    `substitution counts disagree: "${ref.name}" has pkg=${ref.pkg}/manifest=${ref.manifest} ` +
    `but "${other.name}" has pkg=${other.pkg}/manifest=${other.manifest}.`,

  scopedMismatch: (other, ref, diff) =>
    `"${other.name}" (job ${other.job}) is not byte-identical to "${ref.name}" (job ` +
    `${ref.job}) after normalization. These blocks are the same program modulo their ` +
    'package; a difference is a bug, not a variant. Normalized difference:\n' +
    diff,

  nonAsciiUnmapped: (char, codePoint, index) =>
    'after the R2 transliteration table, the canonical block still contains the non-ASCII ' +
    `character ${JSON.stringify(char)} (U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}) ` +
    `at index ${index} of the normalized body. A new glyph entered the canonical block ` +
    'without a table entry. Add the exact replacement block 4 uses to R2_TABLE ' +
    '(scripts/lib/verify-block-identity.constants.mjs) — do not strip it.',

  r3FragmentLost: (occurrences) =>
    `the R3 source fragment occurs ${occurrences} time(s) in the transliterated canonical ` +
    'block; exactly one is required. The canonical verify block changed shape, so the R3 ' +
    'rewrite fragment no longer describes how block 4 differs from it. Re-derive R3 ' +
    'deliberately; do not delete the fragment.',

  block4Mismatch: (diff) =>
    "block 4's verify head differs from the canonical block in a way the known rewrites (R2 " +
    'transliteration, R3 control-flow reshape) do not account for. Either propagate the ' +
    'change to the other three blocks, or — if block 4 really must differ — encode the ' +
    'difference in R2_TABLE/R3_REPLACEMENT deliberately. Normalized difference:\n' +
    diff,

  tailContainsProbe: (probes) =>
    `the smoke tail contains ${probes}. The tail is the bonus bin-delegation smoke check, ` +
    'excised from the byte-identity comparison; it must not re-probe the registry or fail ' +
    'the job explicitly. Registry verification belongs in the head, above the marker.',

  tailDrift: (actual, pinned) =>
    `the smoke tail's normalized digest is ${actual} but PINNED_TAIL_DIGEST is ${pinned}. ` +
    'The tail has no sibling block to compare against, so a deliberate acknowledgement is ' +
    'the only available evidence the change was intended. If this change is intended, update ' +
    'PINNED_TAIL_DIGEST in scripts/lib/verify-block-identity.constants.mjs to the value ' +
    'above and add a bump-log line naming the SMI and date — in this same PR, with a ' +
    'matching test case.',

  coverageShortfall: (expected, actual) =>
    `expected to compare ${expected} verify block(s) but actually compared ${actual}. The ` +
    'missing block(s) fell out before their digest assertion ran — see the other findings ' +
    'for why. A block that could not be compared is never counted as identical.',

  notEvaluated: (reason) => `the verify-block identity check could not be evaluated: ${reason}`,

  markerMissing: () =>
    `block 4's smoke-tail marker \`${TAIL_MARKER}\` is missing. It marks the boundary ` +
    'between the verify head (compared byte-for-byte against the canonical block) and the ' +
    'non-fatal smoke tail (pinned by digest). Restore it immediately before the smoke tail; ' +
    'do not delete it to silence this.',

  markerDuplicate: (count) =>
    `block 4 contains ${count} smoke-tail markers (\`${TAIL_MARKER}\`); exactly one is ` +
    'required. An ambiguous boundary must never resolve silently to the first match. Delete ' +
    'the extra marker(s), keeping the one immediately before the smoke tail.',
}

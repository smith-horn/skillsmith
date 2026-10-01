/**
 * @fileoverview ADR-171 § 8: the four required properties of a manifest refusal
 * message, and the bounding of every untrusted value that enters one.
 * @module @skillsmith/core/services/skill-manifest.read-state.messages
 * @see docs/internal/adr/171-manifest-read-state-contract.md
 * @see SMI-6915 — why this is a sibling rather than more of its classifier
 *
 * Split out of `skill-manifest.read-state.ts` under the 500-line pre-commit gate.
 * The classifier decides WHICH state a manifest is in; this module decides what a
 * user READS about it. Imports run one direction only — the classifier imports
 * from here, never the reverse at runtime — so `ManifestRefusalState` arrives as a
 * type-only import, which is erased at compile time and creates no cycle.
 */
import type { ManifestRefusalState } from './skill-manifest.read-state.js'

/** SMI-6862: tracks file-level repair, named in the § 8 refusal message. */
const REPAIR_FOLLOW_UP_ISSUE = 'SMI-6862'

/** Longest untrusted substring allowed into a diagnostic. */
const MAX_DIAGNOSTIC_VALUE_LENGTH = 120

/**
 * A bound on what is echoed, NOT a proof of validity — gate round 3 was right that
 * the stronger claim was wrong. Linux's limit counts the terminating NUL and is in
 * BYTES, while `String.length` is UTF-16 units, so a value at or below this is not
 * guaranteed openable. What it does guarantee: every path a filesystem accepts
 * (macOS 1024, Linux 4096) is echoed whole, and nothing larger is echoed at all.
 */
const MAX_ECHOABLE_PATH_LENGTH = 4096

/**
 * Bound every value read out of the manifest FILE before interpolating it into a
 * message. `loadManifestLenient`'s warning reaches a tool response root and so an
 * LLM context window, and SMI-6588 already states the rule: an unbounded message
 * from an arbitrary throw site is not something to pass back to a caller. Bound
 * at the producer, not at each consumer. Evidence: SMI-6733.
 */
export function capDiagnostic(value: string, max: number = MAX_DIAGNOSTIC_VALUE_LENGTH): string {
  return value.length > max ? `${value.slice(0, max)}… (${value.length} chars total)` : value
}

/**
 * ALL-OR-NOTHING, and never a prefix. § 8 requires NAMING the file while the
 * warning stays bounded, and truncation serves neither: it destroys identity
 * exactly when the path is long, and emits a string that looks like a path and is
 * not one. Echo it whole, or echo only its length. Do not reintroduce a cap here
 * — that was tried twice and failed twice (SMI-6733).
 */
function pathForMessage(value: string): string {
  return value.length <= MAX_ECHOABLE_PATH_LENGTH
    ? value
    : `<a supplied path of ${value.length} characters, too long to name a file>`
}

/**
 * Takes NO path, by design. Gate round 3 removed the only interpolation of one
 * here, and dropping the parameter is what stops a future edit from reintroducing
 * it: message construction does not need the path, and the two wrappers below
 * already prepend it exactly once through {@link pathForMessage}.
 */
function describeManifestProblem(result: ManifestRefusalState): {
  detail: string
  remedy: string
} {
  switch (result.state) {
    case 'corrupt': {
      // `position` is EXTRACTED from `reason`, so appending it restated the
      // same byte offset twice in one sentence ("… at position 1 (line 1
      // column 2), at position 1"). It stays on the state as structured data
      // for callers that want the number without parsing prose; the message
      // takes it from `reason`, which is where a user reads it.
      if (result.kind === 'unparseable') {
        return {
          detail: `the file exists but is not valid JSON (${capDiagnostic(result.reason)})`,
          remedy:
            'Fix it by hand (a JSON validator will find the break) or restore a copy your ' +
            'editor or backup tool kept, then retry. Repairing a corrupt manifest file is not ' +
            `implemented yet — ${REPAIR_FOLLOW_UP_ISSUE} tracks it; apply_manifest_reconcile ` +
            'repairs a corrupt entry inside a readable file, not a file that cannot be parsed.',
        }
      }
      // Well-formed JSON, wrong document. A JSON validator finds nothing
      // here, so it must not be the advice — and the rule that was broken is
      // named in the user's own vocabulary rather than as an ADR section
      // number they cannot open.
      return {
        detail: `the file is valid JSON but is not a Skillsmith manifest (${result.reason})`,
        remedy:
          'Open the file and correct that field — "version" is a string like "1.0.0", and ' +
          '"installedSkills" is a JSON object whose keys are skill names (an empty object, ' +
          '{}, if nothing is installed) — or restore a copy your editor or backup tool kept, ' +
          `then retry. Repairing a corrupt manifest file is not implemented yet — ` +
          `${REPAIR_FOLLOW_UP_ISSUE} tracks it; apply_manifest_reconcile repairs a corrupt ` +
          'entry inside a well-formed manifest, not a file whose own shape is wrong.',
      }
    }
    case 'unreadable': {
      const code = result.code ?? capDiagnostic(result.reason)
      return {
        detail: `the file exists but could not be read (${code})`,
        // The path is NOT repeated here. Gate round 3: it already opens the
        // warning, and a second copy doubled the response for every unreadable
        // manifest — measured 8,407 chars for a 4096-char path, and 49,369 once
        // JSON-serialized when that path held NUL bytes, because `length` is not
        // serialized size. Worse, the over-limit sentinel rendered as
        // `ls -l <a supplied path of N characters…>`, where `<a` is shell
        // redirection: an invalid command presented as advice. Keep the prose
        // generic; the path lives at the start of the message and, raw, on
        // `ManifestUnwritableError.path`.
        remedy:
          "Check the file's owner and permissions, and that the volume is neither full " +
          'nor read-only, then retry.',
      }
    }
    case 'version_unsupported': {
      return {
        detail:
          `it records version ${result.found} and this Skillsmith understands version ` +
          `${result.expected}, so a newer Skillsmith wrote it`,
        remedy: 'Upgrade Skillsmith, or point this client at a different manifest.',
      }
    }
    /* c8 ignore next 4 -- exhaustiveness guard; TS rejects a missing case at compile time */
    default: {
      const exhaustive: never = result
      throw new Error(`unreachable manifest read state: ${JSON.stringify(exhaustive)}`)
    }
  }
}

/** ADR-171 § 8: the four required properties in one message per state. */
export function buildRefusalMessage(manifestPath: string, result: ManifestRefusalState): string {
  const shownPath = pathForMessage(manifestPath)
  const { detail, remedy } = describeManifestProblem(result)
  const notModified =
    result.state === 'version_unsupported'
      ? 'Your manifest has NOT been modified — treating it as corrupt would discard the skills ' +
        'that newer version recorded.'
      : 'Your manifest has NOT been modified — every skill it records is still recorded. This ' +
        'file is the only record of what Skillsmith has installed, so Skillsmith never repairs, ' +
        'replaces or moves it automatically.'
  return `Refusing to write ${shownPath}: ${detail}. ${notModified} ${remedy}`
}

/** Read-only framing of the same diagnostic, for {@link loadManifestLenient}. */
export function buildLenientWarning(manifestPath: string, result: ManifestRefusalState): string {
  const shownPath = pathForMessage(manifestPath)
  const { detail, remedy } = describeManifestProblem(result)
  return `${shownPath} could not be read (treated as empty): ${detail}. ${remedy}`
}

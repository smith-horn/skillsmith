/**
 * @fileoverview ADR-171: the installed-skills manifest read-state classifier
 * and its two named policy wrappers.
 * @module @skillsmith/core/services/skill-manifest.read-state
 * @see docs/internal/adr/171-manifest-read-state-contract.md
 * @see SMI-6733 — the destructive-read investigation this classifier answers
 *
 * The classifier ({@link readManifestState}) supplies five states; the two
 * wrappers below are the POLICY. `missing` and `ok` permit a write; `corrupt`,
 * `unreadable` and `version_unsupported` all refuse it and leave the file
 * byte-identical — never moved aside, renamed, repaired or replaced (ADR-171
 * § 1: this file is the only record of what is installed, unlike the
 * regenerable fan-out link manifest at `../install/fan-out.manifest.ts`).
 *
 * ADR-171 § 4a: the union carries `manifest` ONLY on the two write-permitting
 * states, so `(await readManifestState(p)).manifest` is a compile error on
 * the three refusing states — the direct fix for the
 * `fan-out.manifest.ts:103-105` shape (`ManifestRead` there carries
 * `manifest` on every state, which is what made its one-line fail-open
 * unwrapper type-check). `raw` carries the untransformed `JSON.parse` value
 * ADR-171 § 3's content-addressed-storage comparison requires — canonical
 * form is taken BEFORE any schema coercion or defaulting, so the shape
 * predicate below validates and returns a boolean; it never builds a new
 * object, fills a default, or coerces a type, and unknown keys are permitted
 * at every depth, on the top-level object and on every entry alike.
 *
 * ADR-171 § 4: kept module-private where the package boundary allows it —
 * `readManifestState` is exported from this module for its own tests only
 * (`ManifestManager` imports the two WRAPPERS, not the classifier —
 * `skill-manifest.ts`'s import list is the check), and is deliberately NOT
 * re-exported through `@skillsmith/core`'s barrel (`exports/services.install.ts`)
 * the way the two wrappers are. An import allow-list test was considered and
 * rejected (too many known bypasses to be worth the maintenance cost); this
 * is what remains of that mechanism.
 */
import * as fs from 'fs/promises'

import type { SkillManifest } from './skill-installation.types.js'

/** ADR-171 § 6: all three `SkillManifest` declarations use this literal today. */
const CURRENT_MANIFEST_VERSION = '1.0.0'

/** ADR-171 § 6: the major component this Skillsmith understands. */
const SUPPORTED_MAJOR_VERSION = 1

/** SMI-6862: tracks file-level repair, named in the § 8 refusal message. */
const REPAIR_FOLLOW_UP_ISSUE = 'SMI-6862'

function emptyManifest(): SkillManifest {
  // Returned by value (namespace-overrides.ts's own `emptyLedger()`
  // convention) so callers never share state with a private const.
  return { version: CURRENT_MANIFEST_VERSION, installedSkills: {} }
}

/**
 * ADR-171 § 5 (revised same day, SMI-6732): `readManifestState` validates
 * the CONTAINER shape only — `version` is a string, and `installedSkills`,
 * if present, is a non-null non-array object. It does not validate what is
 * inside each entry, so this type says so: `installedSkills` values are
 * `unknown`, not {@link SkillManifestEntry}. A caller that wants to
 * dereference an entry's fields must narrow it first (a type guard, a `zod`
 * parse, or an explicit assertion) — the compiler enforces the same
 * boundary `uninstall()`'s runtime tolerance already assumes (SMI-6732's
 * six `skill-installation.uninstall.guard.test.ts` positive-control tests).
 */
export interface UnvalidatedSkillManifest {
  version: string
  installedSkills?: Record<string, unknown>
}

/**
 * ADR-171 § 4a. `manifest` appears only on `ok` and `missing` — the states
 * that permit a write. The three refusing states carry no `manifest` field.
 * Carries {@link UnvalidatedSkillManifest}, not `SkillManifest` — see that
 * type's own doc comment for why.
 */
export type ManifestReadState =
  | { state: 'ok'; manifest: UnvalidatedSkillManifest; raw: unknown }
  | { state: 'missing'; manifest: UnvalidatedSkillManifest; raw: null }
  | { state: 'corrupt'; kind: ManifestCorruptKind; reason: string; position: number | null }
  | { state: 'unreadable'; reason: string; code: string | null }
  | { state: 'version_unsupported'; found: string; expected: string }

/**
 * Why a `corrupt` manifest is corrupt. One POLICY outcome (refuse the write,
 * § 2) but three genuinely different next actions, so the message has to
 * distinguish them — the same argument § 6 makes for `version_unsupported`
 * being its own state rather than folded into `unreadable`.
 *
 * `unparseable` — `JSON.parse` itself rejected the bytes. A JSON validator
 * will find the break, so "fix it by hand" is real advice.
 *
 * `shape` — the file IS well-formed JSON; it is the document's own shape that
 * is wrong (`installedSkills: "hello"`, `installedSkills: []`, a non-string
 * `version`). Telling this user to run a JSON validator sends them to a tool
 * that reports no problem, which is worse than saying nothing.
 *
 * `version_malformed` — `version` is a string but not `major.minor.patch`
 * (§ 6's first rider: never `version_unsupported`, which would assert a newer
 * writer exists). Also well-formed JSON; the fix is one field.
 */
export type ManifestCorruptKind = 'unparseable' | 'shape' | 'version_malformed'

/** The three states {@link loadManifestForWrite} refuses on. */
type ManifestRefusalState = Extract<
  ManifestReadState,
  { state: 'corrupt' | 'unreadable' | 'version_unsupported' }
>

/**
 * ADR-171 § 6: parse a manifest `version` string's major component.
 * `null` = unparseable (classifies `corrupt`, never `version_unsupported` —
 * the latter asserts a newer writer exists, and an unparseable version is no
 * evidence of one). Every known manifest writes `'1.0.0'` (full
 * major.minor.patch); a bare `'1'` or `'1.0'` is treated as malformed rather
 * than guessed at, matching that literal.
 */
function parseMajorVersion(version: string): number | null {
  const match = /^(\d+)\.\d+\.\d+/.exec(version)
  if (!match) return null
  return Number.parseInt(match[1], 10)
}

/** `JSON.parse`'s own error message embeds `... at position N ...` when available. */
function extractJsonErrorPosition(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error)
  const match = /position (\d+)/.exec(message)
  return match ? Number.parseInt(match[1], 10) : null
}

/**
 * ADR-171 § 5: taken verbatim from the one correct guard in this repo,
 * `packages/mcp-server/src/utils/local-inventory.helpers.ts:306` — `typeof`
 * alone treats an array as `'object'`, so `Array.isArray` must be checked
 * explicitly or `{"installedSkills":[true]}`-shaped manifests slip through.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * ADR-171 § 5 (revised same day, SMI-6732; nullish carve-out SMI-6733 Phase
 * 1): the container-level shape predicate ONLY. Top level must be a
 * non-null, non-array object; `version` must be a string; `installedSkills`,
 * if present and non-nullish, must be a non-null, non-array object. It does
 * NOT validate what is inside each entry — see {@link UnvalidatedSkillManifest}'s
 * doc comment for why per-entry field validation was removed (it overrode
 * `uninstall()`'s own deliberate tolerance of a malformed `installedSkills`,
 * SMI-6732). Unknown keys are permitted at every depth, on the top-level
 * object and on every entry alike — this function never strips, defaults, or
 * coerces anything, so the object that flows onward is always the original
 * `JSON.parse` value.
 *
 * `installedSkills: null` classifies `ok`, not `corrupt`, exactly like an
 * absent key (SMI-6733 Phase 1 — re-measured from a wrong "any non-object
 * installedSkills is corrupt" premise). `null` is byte-identical to absent
 * for every consumer: `{...null}` spreads to `{}` and every ad-hoc tolerance
 * guard elsewhere in this repo already treats it that way (`manifest
 * .installedSkills && typeof …` short-circuits on null). The hazard set
 * measured to cause real harm (SMI-6752) is non-empty strings and non-empty
 * arrays — a string spreads char-indexed and an array of entries spreads
 * index-keyed, both of which corrupt `installedSkills` on the next write.
 * Strings, numbers, and both array forms (empty and populated) still
 * classify `corrupt`; the array rejection in particular is load-bearing
 * (see the "array trap" test in `skill-manifest.read-state.test.ts`).
 *
 * CONTAINER-LEVEL ABSENCE IS NOT ENTRY-LEVEL TOLERANCE, and conflating the
 * two is how SMI-6733's MAJOR 3 got through. The justification above
 * measured `{...null}` (spreading) and the repo's ad-hoc
 * `manifest.installedSkills && typeof …` guards (a truthiness test); both
 * are null-safe, and both are the wrong operation. Consumers DEREFERENCE —
 * `manifest.installedSkills[key]` — which throws on `null` exactly as it
 * throws on `undefined`. Same value, different operation, opposite answer.
 * The classifier still does not transform (§ 3 forbids it); the fix is on
 * the consumer side, via {@link installedSkillsOf}.
 */
function isValidManifestShape(value: unknown): value is UnvalidatedSkillManifest {
  if (!isPlainObject(value)) return false
  if (typeof value.version !== 'string') return false

  const installedSkills = value.installedSkills
  if (installedSkills === undefined || installedSkills === null) return true
  return isPlainObject(installedSkills)
}

/** What a JSON value actually is, for a message a user can act on. */
function describeJsonType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'a list'
  return typeof value
}

/**
 * Names the FIRST container rule {@link isValidManifestShape} rejected on, in
 * that function's own order. Called only after it returned `false`, so the
 * fallback is unreachable in practice and exists so a future rule added there
 * without a matching clause here degrades to a vague message rather than a
 * wrong one.
 */
function describeShapeProblem(value: unknown): string {
  if (!isPlainObject(value)) {
    return `its top level is ${describeJsonType(value)}, not a JSON object`
  }
  if (typeof value.version !== 'string') {
    return `its "version" field is ${describeJsonType(value.version)}, not a string`
  }
  return (
    `its "installedSkills" field is ${describeJsonType(value.installedSkills)}, not a JSON ` +
    'object mapping each installed skill to its record'
  )
}

/**
 * Read the manifest at `manifestPath` and classify what was found.
 *
 * `ENOENT` -> `missing`. Any other read error -> `unreadable`, carrying the
 * errno. A version that is present but does not parse as major.minor.patch
 * -> `corrupt` (ADR-171 § 6's first rider — never `version_unsupported`,
 * which asserts a newer writer exists). A newer MAJOR version ->
 * `version_unsupported`; a newer MINOR version -> `ok` (the comparison is on
 * the major component only). Anything that fails {@link isValidManifestShape}
 * -> `corrupt`.
 */
export async function readManifestState(manifestPath: string): Promise<ManifestReadState> {
  let raw: string
  try {
    raw = await fs.readFile(manifestPath, 'utf-8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return { state: 'missing', manifest: emptyManifest(), raw: null }
    }
    return {
      state: 'unreadable',
      reason: error instanceof Error ? error.message : String(error),
      code: code ?? null,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      state: 'corrupt',
      kind: 'unparseable',
      reason: error instanceof Error ? error.message : String(error),
      position: extractJsonErrorPosition(error),
    }
  }

  // Version check BEFORE the shape check: a newer writer's manifest may not
  // match this Skillsmith's own shape rules, and that must not be reported
  // as `corrupt` (ADR-171 § 6 / § "Why the two manifests get opposite
  // answers" analog — discarding a newer version's records is the harm this
  // state exists to prevent).
  const versionValue = isPlainObject(parsed) ? parsed.version : undefined
  if (typeof versionValue === 'string') {
    const major = parseMajorVersion(versionValue)
    if (major === null) {
      return {
        state: 'corrupt',
        kind: 'version_malformed',
        reason: `its "version" field is "${versionValue}", which is not a major.minor.patch string`,
        position: null,
      }
    }
    if (major > SUPPORTED_MAJOR_VERSION) {
      return {
        state: 'version_unsupported',
        found: versionValue,
        expected: CURRENT_MANIFEST_VERSION,
      }
    }
  }

  if (!isValidManifestShape(parsed)) {
    return {
      state: 'corrupt',
      kind: 'shape',
      reason: describeShapeProblem(parsed),
      position: null,
    }
  }

  return { state: 'ok', manifest: parsed, raw: parsed }
}

/** Diagnostic sentence plus one concrete next action for a refusing state. */
function describeManifestProblem(
  manifestPath: string,
  result: ManifestRefusalState
): { detail: string; remedy: string } {
  switch (result.state) {
    case 'corrupt': {
      // `position` is EXTRACTED from `reason`, so appending it restated the
      // same byte offset twice in one sentence ("… at position 1 (line 1
      // column 2), at position 1"). It stays on the state as structured data
      // for callers that want the number without parsing prose; the message
      // takes it from `reason`, which is where a user reads it.
      if (result.kind === 'unparseable') {
        return {
          detail: `the file exists but is not valid JSON (${result.reason})`,
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
      const code = result.code ?? result.reason
      return {
        detail: `the file exists but could not be read (${code})`,
        remedy:
          `Check the file's owner and permissions (\`ls -l ${manifestPath}\`), and that the ` +
          'volume is neither full nor read-only, then retry.',
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
function buildRefusalMessage(manifestPath: string, result: ManifestRefusalState): string {
  const { detail, remedy } = describeManifestProblem(manifestPath, result)
  const notModified =
    result.state === 'version_unsupported'
      ? 'Your manifest has NOT been modified — treating it as corrupt would discard the skills ' +
        'that newer version recorded.'
      : 'Your manifest has NOT been modified — every skill it records is still recorded. This ' +
        'file is the only record of what Skillsmith has installed, so Skillsmith never repairs, ' +
        'replaces or moves it automatically.'
  return `Refusing to write ${manifestPath}: ${detail}. ${notModified} ${remedy}`
}

/** Read-only framing of the same diagnostic, for {@link loadManifestLenient}. */
function buildLenientWarning(manifestPath: string, result: ManifestRefusalState): string {
  const { detail, remedy } = describeManifestProblem(manifestPath, result)
  return `${manifestPath} could not be read (treated as empty): ${detail}. ${remedy}`
}

/**
 * ADR-171 § 4b, write-side wrapper. Every writer that must not proceed on an
 * unverified read calls this — with one deliberate, documented exception:
 * {@link ManifestManager.updateSafely}'s `{ tolerant: true }` option routes
 * to {@link loadManifestLenient} instead, for untracked-skill adoption. See
 * that option's own doc comment, and `adoptUntrackedSkillEntry`'s, for the
 * `force` gate that bounds it. Returns the document on `ok` / `missing`;
 * throws a typed {@link ManifestUnwritableError} on every other state,
 * carrying `state`, `path`, and the § 8 message.
 *
 * The return type stays `SkillManifest` (not {@link UnvalidatedSkillManifest})
 * so `ManifestManager.load()` — the only caller — keeps its own
 * long-standing, source-compatible public signature; the cast below is the
 * documented trust boundary, not an oversight. **What it is and is not safe
 * for, on two independent axes** (SMI-6733 MAJOR 3 — an earlier version of
 * this comment grounded the whole cast in the ENTRY-level axis and was silent
 * on the CONTAINER-level one, which is the axis that actually crashes):
 *
 * - ENTRY level — `installedSkills`' VALUES are unchecked, and that is safe
 *   because `uninstall()` and every other consumer downstream of
 *   `ManifestManager.load()` is already required to treat entries
 *   defensively (SMI-6732).
 * - CONTAINER level — `installedSkills` itself may be absent or `null` and
 *   still classify `ok` (§ 5's nullish carve-out), while `SkillManifest`
 *   declares it non-optional. Consumers are NOT already defensive about
 *   that: a bare `manifest.installedSkills[key]` type-checks and throws.
 *   Read it through {@link installedSkillsOf}, which exists for exactly this.
 */
export async function loadManifestForWrite(manifestPath: string): Promise<SkillManifest> {
  const result = await readManifestState(manifestPath)
  if (result.state === 'ok' || result.state === 'missing') {
    return result.manifest as SkillManifest
  }
  throw new ManifestUnwritableError(
    result.state,
    manifestPath,
    buildRefusalMessage(manifestPath, result)
  )
}

/** {@link loadManifestLenient}'s return shape. */
export interface ManifestLenientRead {
  manifest: SkillManifest
  /**
   * `null` on `ok` AND on `missing` — an absent manifest is the normal state
   * of a machine that has installed nothing, and warning there would train
   * users to ignore this field. Non-null on every refusing state.
   */
  warning: string | null
}

/**
 * ADR-171 § 4b, read-side wrapper for read-only scans that must degrade
 * rather than fail. Always returns the empty document on every non-`ok`
 * state; `warning` is a VALUE (never a `console.warn`) so a read-only tool
 * can surface it in its own response instead of a log nobody reads.
 */
export async function loadManifestLenient(manifestPath: string): Promise<ManifestLenientRead> {
  const result = await readManifestState(manifestPath)
  if (result.state === 'ok' || result.state === 'missing') {
    // Same documented trust boundary as `loadManifestForWrite` above.
    return { manifest: result.manifest as SkillManifest, warning: null }
  }
  return {
    manifest: emptyManifest(),
    warning: buildLenientWarning(manifestPath, result),
  }
}

/**
 * ADR-171 § 4b: thrown by {@link loadManifestForWrite} on every state except
 * `ok` and `missing`. `state` and `path` let a caller build its own
 * structured response (e.g. `apply_manifest_reconcile`'s file-level
 * pre-check, ADR-171 § 8 part 3) without re-parsing the message text.
 */
export class ManifestUnwritableError extends Error {
  readonly state: ManifestRefusalState['state']
  readonly path: string

  constructor(state: ManifestRefusalState['state'], path: string, message: string) {
    super(message)
    this.name = 'ManifestUnwritableError'
    this.state = state
    this.path = path
  }
}

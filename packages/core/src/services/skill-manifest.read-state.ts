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
 * `readManifestState` is exported from this module for {@link ManifestManager}
 * (same package) and this module's own tests, but is deliberately NOT
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
  | { state: 'corrupt'; reason: string; position: number | null }
  | { state: 'unreadable'; reason: string; code: string | null }
  | { state: 'version_unsupported'; found: string; expected: string }

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
 * ADR-171 § 5 (revised same day, SMI-6732): the container-level shape
 * predicate ONLY. Top level must be a non-null, non-array object; `version`
 * must be a string; `installedSkills`, if present, must be a non-null,
 * non-array object. It does NOT validate what is inside each entry — see
 * {@link UnvalidatedSkillManifest}'s doc comment for why per-entry field
 * validation was removed (it overrode `uninstall()`'s own deliberate
 * tolerance of a malformed `installedSkills`, SMI-6732). Unknown keys are
 * permitted at every depth, on the top-level object and on every entry
 * alike — this function never strips, defaults, or coerces anything, so the
 * object that flows onward is always the original `JSON.parse` value.
 */
function isValidManifestShape(value: unknown): value is UnvalidatedSkillManifest {
  if (!isPlainObject(value)) return false
  if (typeof value.version !== 'string') return false

  const installedSkills = value.installedSkills
  if (installedSkills === undefined) return true
  return isPlainObject(installedSkills)
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
        reason: `manifest version "${versionValue}" is not a valid major.minor.patch string`,
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
      reason: 'manifest does not match the expected shape (see ADR-171 § 5)',
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
      const position = result.position !== null ? `, at position ${result.position}` : ''
      return {
        detail: `the file exists but is not valid JSON (${result.reason}${position})`,
        remedy:
          'Fix it by hand (a JSON validator will find the break) or restore a copy your editor ' +
          'or backup tool kept, then retry. Repairing a corrupt manifest file is not implemented ' +
          `yet — ${REPAIR_FOLLOW_UP_ISSUE} tracks it; apply_manifest_reconcile repairs a corrupt ` +
          'entry inside a readable file, not a file that cannot be parsed.',
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
 * ADR-171 § 4b, write-side wrapper. Every writer calls this. Returns the
 * document on `ok` / `missing`; throws a typed {@link ManifestUnwritableError}
 * on every other state, carrying `state`, `path`, and the § 8 message.
 *
 * The return type stays `SkillManifest` (not {@link UnvalidatedSkillManifest})
 * so `ManifestManager.load()` — the only caller — keeps its own
 * long-standing, source-compatible public signature; the cast below is the
 * documented trust boundary, not an oversight. It is safe for the same
 * reason it was always safe before per-entry validation briefly existed:
 * `uninstall()` and every other consumer downstream of `ManifestManager.load()`
 * is already required to treat entries defensively (SMI-6732), so re-widening
 * to `SkillManifest` here asserts a shape this function does not itself
 * check, rather than lying about having checked it.
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

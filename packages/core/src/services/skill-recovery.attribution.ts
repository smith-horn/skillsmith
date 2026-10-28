/**
 * SMI-6531 (A1 step 6b-i): O1's reader side, the attribution of an op dir that
 * has no readable record (design § 2 O1, as amended by bf-1k0's minors).
 *
 * The swap writes `client`, `scope`, `dirName`, `manifestKey` and `stateRoot`
 * into `owner.json`, and the `abort-new` intent (schema 2) copies them (6b-ii,
 * `skill-swap.attribution.ts`); an op dir made before that carries none, and
 * the fallback below is what runs for it. The fields are **routing hints, not authority**: they
 * decide only where a kept tree is filed and what its sidecar and parked-index
 * line say, never what is kept, whether an action is offered, or which skill
 * is changed.
 *
 * Validation is all or nothing. The attribution is accepted only when every
 * check passes:
 *  - `client` is one of `CLIENT_IDS`;
 *  - `scope` is an install scope, `global` or `workspace` (`InstallScope`, the
 *    update target's scope the swap records; 6b-i's design said `user`, which
 *    no writer produces);
 *  - `dirName` and `manifestKey` are single path components;
 *  - `stateRoot` is a state root doctor discovered or was given (the set
 *    `RecoveryRequest.stateRoots` carries);
 *  - when both `owner.json` and the intent carry one, they are equal field by
 *    field.
 * Otherwise (or when there is none) the whole attribution is discarded and
 * the client-`none` layout (UD23) is used: validated and fallback fields are
 * never mixed. That layout's area is `<primary>/backups/update/none/
 * <rootKey(R)>/<opId>/`, its sidecar fields are client `none`, scope `none`,
 * an empty `manifestKey` and the opId as `dirName`, and its parked-index line
 * goes to `<primary>`: the first state root given or discovered, or none.
 *
 * Pure: it reads nothing, and it imports no filesystem module, so the
 * classifier resolves the attribution itself (6b-ii: a no-record op dir's
 * keep area is listed through the reader, so the re-plan digest covers it).
 * Its inputs are what the classifier read through the reader. The writer
 * side is `skill-swap.attribution.ts`.
 *
 * @module @skillsmith/core/services/skill-recovery.attribution
 */
import path from 'node:path'
import { CLIENT_IDS } from '../install/client-ids.js'
import { PARKED_INDEX_FILE } from '../install/parked-index.name.js'
import { backupAreaPath } from './skill-swap.area.js'
import { INSTALL_SCOPES } from '../install/scope-ids.js'
import type { InstallScope } from '../install/workspace-scope.js'
import { ATTRIBUTION_FIELDS } from './skill-swap.attribution.js'

export interface AttributionFields {
  client: string
  /** The update target's install scope (`InstallScope`: `global` or `workspace`). */
  scope: InstallScope
  dirName: string
  manifestKey: string
  stateRoot: string
}

export type Attribution =
  | ({ kind: 'attributed' } & AttributionFields)
  | {
      kind: 'fallback'
      /** Why the attribution was discarded (or that there was none). */
      why: string
      /** `<primary>`: the first state root given or discovered; null when there is none. */
      primary: string | null
    }

const oneComponent = (s: string): boolean =>
  s !== '' && s !== '.' && s !== '..' && !s.includes('/') && !s.includes('\\') && !s.includes('\0')

/** Whether the object carries any attribution field at all. */
const carries = (o: Record<string, unknown> | null): o is Record<string, unknown> =>
  o !== null && ATTRIBUTION_FIELDS.some((k) => k in o)

/** One source's fields, every check passed; or why not. */
function validate(
  o: Record<string, unknown>,
  stateRoots: readonly string[]
): { ok: true; fields: AttributionFields } | { ok: false; why: string } {
  const { client, scope, dirName, manifestKey, stateRoot } = o
  if (typeof client !== 'string' || !(CLIENT_IDS as readonly string[]).includes(client)) {
    return { ok: false, why: `client ${JSON.stringify(client)} is not a known client` }
  }
  if (typeof scope !== 'string' || !(INSTALL_SCOPES as readonly string[]).includes(scope)) {
    return {
      ok: false,
      why: `scope ${JSON.stringify(scope)} is not an install scope (${INSTALL_SCOPES.join(' or ')})`,
    }
  }
  for (const [name, v] of [
    ['dirName', dirName],
    ['manifestKey', manifestKey],
  ] as const) {
    if (typeof v !== 'string' || !oneComponent(v)) {
      return { ok: false, why: `${name} ${JSON.stringify(v)} is not a single path component` }
    }
  }
  if (typeof stateRoot !== 'string' || !stateRoots.includes(stateRoot)) {
    return {
      ok: false,
      why: `stateRoot ${JSON.stringify(stateRoot)} is not a state root doctor discovered or was given`,
    }
  }
  return {
    ok: true,
    fields: {
      client,
      scope: scope as InstallScope,
      dirName: dirName as string,
      manifestKey: manifestKey as string,
      stateRoot,
    },
  }
}

/**
 * The attribution of a no-record (or unreadable-record) op dir from its
 * `owner.json` and its intent, both as parsed objects (null when absent).
 */
export function resolveAttribution(a: {
  owner: Record<string, unknown> | null
  intent?: Record<string, unknown> | null
  stateRoots: readonly string[]
}): Attribution {
  const primary = a.stateRoots[0] ?? null
  const fallback = (why: string): Attribution => ({ kind: 'fallback', why, primary })
  const sources = [a.owner, a.intent ?? null].filter(carries)
  if (sources.length === 0) return fallback('the op dir carries no attribution')
  const checked = sources.map((s) => validate(s, a.stateRoots))
  const bad = checked.find((c) => !c.ok)
  if (bad !== undefined && !bad.ok) return fallback(bad.why)
  const fields = checked.map((c) => (c.ok ? c.fields : null)) as AttributionFields[]
  const [first, second] = fields
  if (second !== undefined && ATTRIBUTION_FIELDS.some((k) => first![k] !== second[k])) {
    return fallback("owner.json's attribution and the intent's differ")
  }
  return { kind: 'attributed', ...first! }
}

/** The client a park names: the attributed one, else `none`. */
export const parkClientOf = (a: Attribution): string =>
  a.kind === 'attributed' ? a.client : 'none'

/** The parked index a park appends to: the attributed state root's, the primary's, or none. */
export function parkIndexOf(a: Attribution): string | null {
  const root = routeRootOf(a)
  return root === null ? null : path.join(root, PARKED_INDEX_FILE)
}

/** The state root a keep or a park of this op dir routes to: the attributed one, the primary, or null. */
export const routeRootOf = (a: Attribution): string | null =>
  a.kind === 'attributed' ? a.stateRoot : a.primary

/** The backup area a keep of this op dir files into (6b-ii `--clean-staging`), or null with no state root. */
export function keepAreaOf(a: Attribution, root: string, opId: string): string | null {
  if (a.kind === 'attributed') return backupAreaPath(a.stateRoot, a.client, root, a.dirName)
  return a.primary === null ? null : backupAreaPath(a.primary, 'none', root, opId)
}

/** The sidecar fields a keep of this op dir names (the client-`none` convention when unattributed). */
export function keepSidecarOf(
  a: Attribution,
  opId: string
): { client: string; scope: string; manifestKey: string; dirName: string } {
  return a.kind === 'attributed'
    ? { client: a.client, scope: a.scope, manifestKey: a.manifestKey, dirName: a.dirName }
    : { client: 'none', scope: 'none', manifestKey: '', dirName: opId }
}

/** What a keep of this op dir in R's area must name: its sidecar fields and `skillsDir` R. */
export const keepExpectOf = (a: Attribution, root: string, opId: string) => ({
  ...keepSidecarOf(a, opId),
  skillsDir: root,
})

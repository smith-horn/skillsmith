/**
 * SMI-6531 (A1 step 6b-ii): the park route of a no-record op dir's intent
 * carries ONE rule for its client and its scope. A move-source intent's client
 * comes from its `backupPath`'s `target`, so O1's scope may be used only when
 * O1's attribution names that same park (client, state root and folder);
 * otherwise the scope is `none` next to the target's client, never a field of
 * another park's attribution. The scope is not observable in a finished park
 * (the park reads the client only), so the route is pinned directly.
 */
import { describe, expect, it } from 'vitest'
import { routeOf } from '../../../../src/services/skill-recovery.intent-park.js'
import type { Attribution } from '../../../../src/services/skill-recovery.attribution.js'
import type {
  NoRecordIntent,
  RecoveryClass,
} from '../../../../src/services/skill-recovery.types.js'

type NoRecord = Extract<RecoveryClass, { kind: 'no-record' }>

const TARGET = { stateRoot: '/state/a', client: 'cursor', dirName: 'skill-x' }
const OP_ID = 'a'.repeat(32)

const attributed = (over: Partial<TargetFields> = {}): Attribution => ({
  kind: 'attributed',
  client: TARGET.client,
  scope: 'workspace',
  dirName: TARGET.dirName,
  manifestKey: 'skill-x',
  stateRoot: TARGET.stateRoot,
  ...over,
})

interface TargetFields {
  client: string
  dirName: string
  stateRoot: string
}

const fallback: Attribution = { kind: 'fallback', why: 'no attribution', primary: '/state/a' }

function classOf(attribution: Attribution): NoRecord {
  return {
    kind: 'no-record',
    opId: OP_ID,
    opDir: '/op',
    clean: { attribution },
  } as unknown as NoRecord
}

const moveSource = {
  kind: 'move-source',
  backupPath: `/state/a/backups/update/cursor/key/${OP_ID}`,
  target: TARGET,
} as unknown as NoRecordIntent

const abortNew = { kind: 'abort-new', backupPath: null, target: null } as unknown as NoRecordIntent

describe('routeOf: a move-source intent', () => {
  it('uses the attributed scope when the attribution names the same park as the target', () => {
    const r = routeOf(classOf(attributed()), moveSource)
    expect(r).toMatchObject({ client: 'cursor', scope: 'workspace', dirName: 'skill-x' })
  })

  const DISAGREE: Array<[string, Attribution]> = [
    ['another client', attributed({ client: 'copilot' })],
    ['another folder name', attributed({ dirName: 'skill-y' })],
    ['another state root', attributed({ stateRoot: '/state/b' })],
    ['no validated attribution at all', fallback],
  ]
  for (const [label, a] of DISAGREE) {
    it(`gets scope none, beside the target's client, when the attribution names ${label}`, () => {
      const r = routeOf(classOf(a), moveSource)
      expect(r).toMatchObject({
        client: TARGET.client,
        scope: 'none',
        stateRoot: TARGET.stateRoot,
        dirName: TARGET.dirName,
      })
    })
  }
})

describe('routeOf: an abort-new intent takes client and scope from the one attribution', () => {
  it('attributed: its client and its scope', () => {
    const r = routeOf(classOf(attributed({ client: 'copilot' })), abortNew)
    expect(r).toMatchObject({ client: 'copilot', scope: 'workspace' })
  })

  it('fallback: client none and scope none', () => {
    const r = routeOf(classOf(fallback), abortNew)
    expect(r).toMatchObject({ client: 'none', scope: 'none' })
  })
})

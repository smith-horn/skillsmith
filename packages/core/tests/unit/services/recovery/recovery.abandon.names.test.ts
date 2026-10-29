/**
 * SMI-6531 (A1 step 6b-iii): `freeKeptName`, the name the `--abandon` plan
 * states for a fresh keep, is the one `destFor` will choose (`taken`: a tree,
 * a sidecar or a sidecar temp at the name; a copy temp does not take one), and
 * a P0 temp of the role being kept does not take it either, because `keepRole`
 * unlinks that temp before the publish.
 */
import { describe, expect, it } from 'vitest'
import { freeKeptName } from '../../../../src/services/skill-recovery.plan.abandon.js'
import type { KeepGroup, OpFacts } from '../../../../src/services/skill-recovery.types.js'

const AREA = '/state/backups/update/claude-code/k/my-skill'
const OP = 'a'.repeat(32)
const ID = { dev: '1', ino: '2', birthtimeNs: '3', fmt: '16384' }
const ABSENT = { present: false as const, errno: null }
const DIR = {
  present: true as const,
  type: 'dir' as const,
  identity: ID,
  empty: false,
  hash: 'h',
  hashError: null,
}

function group(base: string, over: Partial<KeepGroup>): KeepGroup {
  return {
    base,
    destPath: `${AREA}/${base}`,
    kind: 'abandoned-new',
    role: 'N',
    sidecar: null,
    sidecarTmp: null,
    dest: ABSENT,
    copyTmp: ABSENT,
    src: ABSENT,
    state: null,
    unclassified: null,
    verified: false,
    hashChanged: false,
    crossDevice: false,
    otherCopy: false,
    pendingTemp: null,
    ...over,
  }
}

const SIDECAR = {
  path: 'p',
  validForOp: true,
  invalid: null,
  kind: 'abandoned-new',
  identity: ID,
  treeHash: 'h',
  opDirIdentity: null,
}
const TEMP = {
  path: 't',
  thisOps: false,
  treeHash: null,
  identity: null,
  sameInodeAsSidecar: false,
  emptySingleLink: true,
}

/** The facts `freeKeptName` reads, with N a source (a keep to make) or absent. */
function facts(
  groups: KeepGroup[],
  n: 'source' | 'absent'
): Pick<OpFacts, 'area' | 'opId' | 'groups' | 'roles'> {
  const N =
    n === 'source'
      ? { kind: 'source' as const, obs: DIR, started: null }
      : { kind: 'absent' as const }
  return {
    area: AREA,
    opId: OP,
    groups,
    roles: { O: { kind: 'absent' }, N, U: { kind: 'absent' } },
  }
}

const base = `${OP}.abandoned-new`

describe('freeKeptName', () => {
  it('a base held only by a sidecar is taken: .1', () => {
    expect(
      freeKeptName(facts([group(base, { sidecar: SIDECAR })], 'absent'), 'abandoned-new')
    ).toBe(`${AREA}/${base}.1`)
  })

  it('a base held only by a sidecar temp (no role of it to keep) is taken: .1', () => {
    const g = group(base, { sidecarTmp: TEMP, state: 'P0' })
    expect(freeKeptName(facts([g], 'absent'), 'abandoned-new')).toBe(`${AREA}/${base}.1`)
  })

  it('a P0 temp of the role being kept is unlinked first, so the base stays free', () => {
    const g = group(base, { sidecarTmp: TEMP, state: 'P0', src: DIR })
    expect(freeKeptName(facts([g], 'source'), 'abandoned-new')).toBe(`${AREA}/${base}`)
  })

  it('a base held only by a copy temp is free (the copy temp is kept first)', () => {
    const g = group(base, { copyTmp: DIR })
    expect(freeKeptName(facts([g], 'source'), 'abandoned-new')).toBe(`${AREA}/${base}`)
  })
})

/**
 * SMI-6531 (A1 step 6b-ii): fixtures for `doctor recovery --clean-staging`.
 *
 * Every no-record op dir here is one a real `swapInPlace` left: an abort
 * before rename 1 (step 4's re-hash refusing, no record) whose cleanup is
 * stopped at one of its own points by a throwing hook (the in-process stand-in
 * for a kill: cleanup's own catch leaves OP as it was), or whose park is
 * stubbed to not finish. So `owner.json` and the intent are the writer's own,
 * O1's attribution included, and doctor is proven against what the writer
 * leaves. `owner.json` names this test process, which is alive: the owner
 * probe is injected (`DEAD`, `ALIVE`) so a dead owner can be stood for
 * without a second process.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect } from 'vitest'
import type { OwnerProbe } from '../../../../src/services/skill-recovery.clean.types.js'
import type { RecoveryRequest } from '../../../../src/services/skill-recovery.run.types.js'
import type { SwapHookPoint, SwapOptions } from '../../../../src/services/skill-swap.js'
import { refusedOf } from '../skill-swap.abort.helpers.js'
import { abortAt } from '../skill-swap.abort.triggers.js'
import { areaOf, makeFixture, modify, OP_ID, plan, run } from '../skill-swap.helpers.js'
import type { Fixture } from '../skill-swap.helpers.js'
import type { State } from './recovery.helpers.js'

export const FILES = { 'SKILL.md': '# v1\n', 'a.txt': 'a\n', 'sub/b.txt': 'b\n' }
export const file = (): Fixture => makeFixture(FILES)

/** This host, and every pid gone: `owner.json`'s owner reads `same-host-dead`. */
export const DEAD: OwnerProbe = { host: os.hostname(), alive: () => false }
/** This host, and every pid running. */
export const ALIVE: OwnerProbe = { host: os.hostname(), alive: () => true }

/** The request overrides for a dead owner (the default for these suites). */
export const dead: Partial<RecoveryRequest> = { ownerProbe: DEAD }

/** The line N carries when it was edited after the build. */
export const EDIT = 'edited in N\n'

export interface LeftOptions {
  /** Edit N after the build (abort cleanup then keeps it as `edited-new`). */
  editN?: boolean
  /** Extra swap options (a park stub). */
  swap?: SwapOptions
}

/**
 * A real update aborted at step 4 (no record), its cleanup stopped at `stopAt`
 * (a hook that throws), or, with `stopAt` null, run to its end (a park stub
 * in `o.swap` decides how that ends). The cleanup leaves OP for doctor.
 */
export async function abortLeft(
  stopAt: SwapHookPoint | null,
  o: LeftOptions = {},
  fx: Fixture = file()
): Promise<State> {
  const p = plan(fx, [modify('SKILL.md', '# v2\n')])
  const newA = path.join(fx.opDir, 'new', 'a.txt')
  const hooks: NonNullable<SwapOptions['hooks']> = {
    abortAfterCheck: () => {
      if (o.editN === true) fs.appendFileSync(newA, EDIT)
      if (stopAt === 'abortAfterCheck') throw new Error('killed at abortAfterCheck')
    },
  }
  if (stopAt !== null && stopAt !== 'abortAfterCheck') {
    hooks[stopAt] = () => {
      throw new Error(`killed at ${stopAt}`)
    }
  }
  const t = abortAt(fx, 'step4', hooks)
  try {
    const r = await run(p, { ...t.options, ...o.swap, hooks: t.options.hooks! })
    expect(refusedOf(r.result).staged).toBe('left')
  } finally {
    t.restore()
  }
  return { fx, p, opId: OP_ID, opDir: fx.opDir }
}

/** OP's entries, sorted. */
export const opNames = (st: State): string[] => fs.readdirSync(st.opDir).sort()

/** `<area>/<opId>.<kind>` in the fixture's own (attributed) area. */
export const keptAt = (fx: Fixture, kind: string): string =>
  path.join(areaOf(fx), `${OP_ID}.${kind}`)

/** Rewrites `owner.json` with `over` merged in (a forged or broken attribution, another host). */
export function editOwner(st: State, over: Record<string, unknown>, drop: string[] = []): void {
  const f = path.join(st.opDir, 'owner.json')
  const v = JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown>
  for (const k of drop) delete v[k]
  fs.writeFileSync(f, JSON.stringify({ ...v, ...over }, null, 2) + '\n')
}

/** The sidecar JSON next to a kept tree. */
export const sidecarAt = (tree: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(`${tree}.json`, 'utf8')) as Record<string, unknown>

/** `<primary>/backups/update/none/<rootKey(R)>/<opId>` (UD23's client-`none` layout). */
export function noneArea(fx: Fixture, primary: string): string {
  const key = path.basename(path.dirname(areaOf(fx)))
  return path.join(primary, 'backups', 'update', 'none', key, OP_ID)
}

/**
 * SMI-6531 (A1 step 4b): the abort kinds T-X13 runs after a completed build,
 * each as swap options that make the transaction abort there, plus a capture
 * of what the build left in N.
 *
 *  - `step4`: the live folder edited after the build, so step 4's re-hash
 *    refuses (`changed-since-plan`, no record).
 *  - `step5`: the record's temp cannot be created (`ENOSPC` from its `open`),
 *    so step 5 fails (`write-failed`, no record).
 *  - `step6`: the live folder replaced before step 6's `lstat`, so step 6
 *    refuses (`target-changed`) with `record.json` published.
 *
 * A step-3 refusal (the record scan) is SMI-6531 step 5's; it reaches the same
 * cleanup from under lock 1, as these do. The `busy` abort that gets lock 1 on
 * its second wait is T-X15's (`skill-swap.abort.busy.test.ts`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { bindIdentity } from '../../../src/install/park-tree.identity.js'
import type { BoundIdentity } from '../../../src/install/park-tree.identity.js'
import type { SwapHookPoint, SwapOptions } from '../../../src/services/skill-swap.js'
import { contentOf } from './skill-swap.abort.helpers.js'
import { hashOf } from './skill-swap.helpers.js'
import type { Fixture } from './skill-swap.helpers.js'

export type AbortKind = 'step4' | 'step5' | 'step6'
export const ABORT_KINDS: AbortKind[] = ['step4', 'step5', 'step6']
export const REASON: Record<AbortKind, string> = {
  step4: 'changed-since-plan',
  step5: 'write-failed',
  step6: 'target-changed',
}

/** What the build left: N's bytes, hash and inode, and OP's identity. */
export interface Built {
  content: Record<string, string> | null
  hash: string | null
  ino: bigint | null
  op: BoundIdentity | null
}

type Hooks = NonNullable<SwapOptions['hooks']>

/** Options for `kind`, merged with `extra` hooks; `built` is filled at `afterBuild`. */
export function abortAt(
  fx: Fixture,
  kind: AbortKind,
  extra: Hooks = {}
): { options: SwapOptions; built: Built; restore: () => void } {
  const built: Built = { content: null, hash: null, ino: null, op: null }
  const newDir = path.join(fx.opDir, 'new')
  const hooks: Hooks = { ...extra }
  const chain = (point: SwapHookPoint, fn: () => void): void => {
    const prev = hooks[point]
    hooks[point] = async () => {
      fn()
      await prev?.()
    }
  }
  chain('afterBuild', () => {
    built.content = contentOf(newDir)
    built.hash = hashOf(newDir)
    built.ino = fs.lstatSync(newDir, { bigint: true }).ino
    const op = bindIdentity(fx.opDir)
    if (op.ok) built.op = op
    if (kind === 'step4') fs.appendFileSync(path.join(fx.realDir, 'SKILL.md'), 'live edit\n')
  })
  let restore = (): void => undefined
  if (kind === 'step5') {
    const recordTmp = path.join(fx.opDir, 'record.json.tmp')
    const orig = fs.promises.open
    const p = fs.promises as unknown as Record<string, unknown>
    p.open = async (...args: unknown[]) => {
      if (args[0] === recordTmp) {
        const e = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException
        e.code = 'ENOSPC'
        throw e
      }
      return (orig as (...a: unknown[]) => Promise<unknown>)(...args)
    }
    restore = () => {
      p.open = orig
    }
  }
  if (kind === 'step6') {
    chain('beforeRename1Check', () => {
      fs.renameSync(fx.realDir, path.join(fx.base, 'original'))
      fs.mkdirSync(fx.realDir)
      fs.writeFileSync(path.join(fx.realDir, 'SKILL.md'), '# someone else\n')
    })
  }
  return { options: { hooks }, built, restore }
}

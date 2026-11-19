/**
 * @fileoverview `skillsmith restore <id>` (SMI-6531 6d-ii; A1 plan §3.9):
 * put a set-aside copy back where it came from. Plans without any lock, prints
 * the plan, asks once through the shared confirmation gate, then executes under
 * the lock core chose.
 *
 * Exit status: 0 restored, or declined at the prompt; 1 refused, or failed with
 * nothing changed; 3 not confirmed (no terminal, or `--json` without `--yes`);
 * 4 stopped after something changed; 130 Ctrl-C.
 * @module @skillsmith/cli/commands/restore.action
 */
import path from 'node:path'
import chalk from 'chalk'
import { withTelemetry } from '@skillsmith/core/telemetry'
import {
  executeRestore,
  planRestore,
  type DiscoverOptions,
  type RestoreHooks,
} from '@skillsmith/core'
import { confirmOrStop, type PromptAnswer } from './confirm-gate.js'
import { planLines, restoreJson, resultLines } from './restore.render.js'

export interface RestoreActionOptions {
  stateRoot?: string
  root?: string[]
  yes?: boolean
  json?: boolean
  /** @internal Test seam: overrides for root discovery. */
  discovery?: Partial<DiscoverOptions>
  /** @internal Test seam: whether stdin and stdout are terminals. */
  isTTY?: () => boolean
  /** @internal Test seam: the prompt. */
  prompt?: (question: string) => Promise<PromptAnswer>
  /** @internal Test seam: runs between the confirmation and the lock. */
  afterConfirm?: () => void | Promise<void>
  /** @internal Test seam: passed to `executeRestore`. */
  hooks?: RestoreHooks
}

const blankFlag = (o: RestoreActionOptions): string | null => {
  if (o.stateRoot !== undefined && o.stateRoot.trim() === '') return '--state-root'
  if (o.root?.some((r) => r.trim() === '') === true) return '--root'
  return null
}

export async function runRestore(id: string, options: RestoreActionOptions): Promise<void> {
  const json = options.json === true
  const blank = blankFlag(options)
  if (blank !== null || id.trim() === '') {
    console.error(
      chalk.red(blank !== null ? `${blank} needs a non-empty value.` : 'Give a copy id.')
    )
    process.exitCode = 1
    return
  }
  const planned = await planRestore(id, {
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
    ...(options.root === undefined || options.root.length === 0 ? {} : { roots: options.root }),
    ...(options.discovery === undefined ? {} : { discovery: options.discovery }),
  })
  if (planned.status === 'refused') {
    if (json) {
      console.log(
        restoreJson({
          status: 'refused',
          reason: planned.reason,
          plan: null,
          result: null,
          ...(planned.candidates === undefined ? {} : { candidates: planned.candidates }),
        })
      )
    } else {
      console.log('Nothing was restored.')
      console.log(planned.message)
    }
    process.exitCode = 1
    return
  }
  const { plan } = planned
  if (!json) for (const l of planLines(plan)) console.log(l)
  const gate = await confirmOrStop(
    options,
    () => console.log(restoreJson({ status: 'planned', reason: null, plan, result: null })),
    'restore: prompt'
  )
  if (gate === 'stop') return
  await options.afterConfirm?.()
  const result = await executeRestore(plan, options.hooks ?? {})
  if (json) {
    console.log(
      restoreJson({
        status: result.status,
        reason: result.status === 'restored' ? null : result.reason,
        plan,
        result,
      })
    )
  } else {
    const locksDir = plan.lock.kind === 'lock1prime' ? path.join(plan.lock.stateRoot, 'locks') : ''
    for (const l of resultLines(result, locksDir)) console.log(l)
  }
  if (result.status !== 'restored') process.exitCode = result.changed ? 4 : 1
}

export const restoreAction = withTelemetry(runRestore, {
  source: 'cli',
  extractSkillId: () => 'restore',
  extractFramework: () => 'cli',
})

/**
 * SMI-6531 (A1 steps 4a, 6a-i): the transaction's starting state and the
 * check of its input, split out of `skill-swap.ts` to keep that file under the
 * length limit.
 *
 * `assertSwapInput` (6a-i) holds the two equalities doctor relies on to find
 * what an update left: the backup area is computed from `stateRoot`, while the
 * record names `manifestPath` and `dirName` (so doctor re-derives the area from
 * `dirname(manifestPath)` and `basename(comparedPath)`). An input where they
 * disagree would write a record doctor reads as inconsistent, so it is refused
 * before anything is written. It is a `TypeError`: a bug in the caller, not a
 * state of the disk.
 *
 * @module @skillsmith/core/services/skill-swap.state
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { SkillsRootBinding } from './skill-write-lock.types.js'
import type { SwapState } from './skill-swap.ops.js'
import { backupAreaPath } from './skill-swap.area.js'
import type { SwapInput, SwapOptions, SwapWarning } from './skill-swap.types.js'

/** Refuses an input whose `stateRoot` or `dirName` doesn't match what the record will name. */
export function assertSwapInput(input: SwapInput): void {
  if (path.resolve(input.stateRoot) !== path.dirname(path.resolve(input.manifestPath))) {
    throw new TypeError(
      `invalid swap input: stateRoot ${JSON.stringify(input.stateRoot)} is not the directory ` +
        `holding manifestPath ${JSON.stringify(input.manifestPath)}`
    )
  }
  if (input.dirName !== path.basename(input.comparedPath)) {
    throw new TypeError(
      `invalid swap input: dirName ${JSON.stringify(input.dirName)} is not the name of ` +
        `comparedPath ${JSON.stringify(input.comparedPath)}`
    )
  }
}

export function newState(
  input: SwapInput,
  options: SwapOptions,
  binding: SkillsRootBinding,
  warnings: SwapWarning[]
): SwapState {
  const opId = options.opId ?? randomBytes(16).toString('hex')
  let stateRootReal: string
  try {
    stateRootReal = fs.realpathSync.native(input.stateRoot)
  } catch {
    stateRootReal = path.resolve(input.stateRoot)
  }
  const areaPath = backupAreaPath(stateRootReal, input.client, binding.root, input.dirName)
  return {
    input,
    options,
    opId,
    binding,
    warnings,
    opDir: path.join(binding.stagingDir, opId),
    ctx: null,
    opCreated: false,
    op: null,
    area: null,
    buildIdentity: null,
    published: null,
    moveSources: new Map(),
    owner: null,
    newIdentity: null,
    postTree: null,
    postRecord: null,
    stateRootReal,
    areaPath,
    backupDest: path.join(areaPath, opId),
    recordRemoved: false,
    record: null,
    owned: new Map(),
    blockedBy: null,
    phase: 'staging',
    step: 'audit',
  }
}

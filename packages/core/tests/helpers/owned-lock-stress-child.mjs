#!/usr/bin/env node
/**
 * Cross-process child harness for owned-lock-lost-update.test.ts (SMI-5883
 * §8f). Deliberately OUTSIDE every vitest glob (plain `.mjs`). No seam, no
 * barrier, no injection -- real contention among genuinely-alive processes,
 * exercising `acquireOwnedLock` + `atomicWriteFile` together exactly as a
 * real caller (`security-acceptance.ts`) would.
 *
 * Spawned as:
 *   node --import tsx owned-lock-stress-child.mjs <id> <target> <rounds>
 *
 * Each round: acquire -> read the JSON store (empty object if absent) -> add
 * this child's own distinct key (`<id>-<round>`) -> atomicWriteFile -> release.
 */

import { existsSync, readFileSync } from 'node:fs'
import { acquireOwnedLock } from '../../src/config/owned-lock.ts'
import { atomicWriteFile } from '../../src/config/config-atomic-write.ts'

const [id, target, roundsArg] = process.argv.slice(2)
const rounds = Number(roundsArg)

for (let round = 0; round < rounds; round++) {
  const release = acquireOwnedLock(target, { timeoutMs: 20_000, label: 'stress store' })
  try {
    const store = existsSync(target) ? JSON.parse(readFileSync(target, 'utf-8')) : {}
    store[`${id}-${round}`] = true
    atomicWriteFile(target, JSON.stringify(store, null, 2), 0o600)
  } finally {
    release()
  }
}

process.exit(0)

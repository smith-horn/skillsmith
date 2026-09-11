#!/usr/bin/env node
/**
 * Cross-process child for fan-out-lock-contention.test.ts (SMI-6529 round 8).
 * Deliberately OUTSIDE every vitest glob (plain `.mjs`). No seam: each round
 * takes the real per-destination lock and increments a shared counter file
 * inside it. A lost update means two holders overlapped; a thrown error means
 * a caller gave up under ordinary contention.
 *
 * Spawned as:
 *   node --import tsx fan-out-lock-contention-child.mjs <dest> <counter> <rounds>
 *
 * Prints one JSON line to stdout: {"failures": ["<name>: <message>", ...]}.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { withDestinationLock } from '../../src/install/fan-out.overwrite.ts'

const [dest, counter, roundsArg] = process.argv.slice(2)
const rounds = Number(roundsArg)
const failures = []

for (let round = 0; round < rounds; round++) {
  try {
    await withDestinationLock(dest, async () => {
      const n = Number(readFileSync(counter, 'utf-8'))
      writeFileSync(counter, String(n + 1))
    })
  } catch (err) {
    failures.push(err instanceof Error ? `${err.name}: ${err.message}` : String(err))
  }
}

process.stdout.write(JSON.stringify({ failures }) + '\n')
process.exit(0)

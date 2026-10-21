#!/usr/bin/env node
/**
 * Child for skill-tree.claim.test.ts (SMI-6531 A1 step 3, T-X9 kill half).
 * Plain `.mjs`, so it sits outside every vitest glob.
 *
 *   node --import tsx skill-tree.claim.child.mjs <staged> <dest> <mode>
 *
 *   mode  "kill": SIGKILL this process between the claim and the rename.
 *         "run":  let claimPublish finish (control: the child really publishes).
 *
 * Prints one JSON line (the result) in "run" mode; in "kill" mode it never gets there.
 */
import { claimPublish } from '../../../src/services/skill-tree.ts'

const [staged, dest, mode] = process.argv.slice(2)

const result = await claimPublish(staged, dest, {
  afterClaim: () => {
    if (mode === 'kill') process.kill(process.pid, 'SIGKILL')
  },
})
process.stdout.write(JSON.stringify(result) + '\n')
process.exit(0)

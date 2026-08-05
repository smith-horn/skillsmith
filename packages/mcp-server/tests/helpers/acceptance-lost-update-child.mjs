#!/usr/bin/env node
/**
 * Cross-process child harness for security-acceptance-lost-update.test.ts
 * (SMI-5883 §9 H-9). Deliberately OUTSIDE every vitest glob (plain `.mjs`).
 * Calls the REAL accept path (`acceptFinding`) for a distinct key, printing
 * `{ok, acceptKey}` as JSON on a single stdout line.
 *
 * Spawned as:
 *   node --import tsx acceptance-lost-update-child.mjs <id> <acceptancePath> <barrierDir>
 */

import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCANNER_RULESET_VERSION } from '@skillsmith/core'
import { acceptFinding } from '../../src/audit/security-acceptance.mutate.ts'
import { computeAcceptKey, findingFingerprint } from '../../src/audit/security-acceptance.ts'

const [id, acceptancePath, barrierDir] = process.argv.slice(2)

function waitFor(predicate, label, capMs = 30_000) {
  const deadline = Date.now() + capMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`[acceptance-lost-update-child ${id}] timed out waiting for ${label}`)
    }
  }
}

writeFileSync(join(barrierDir, `arrived-${id}`), '')
waitFor(() => existsSync(join(barrierDir, 'go')), 'go signal')

const contentDigest = createHash('sha256').update(`child-content-${id}`).digest('hex')
const finding = { type: 'jailbreak', severity: 'high', message: `child-${id}` }
const fp = findingFingerprint(finding)
const acceptKey = computeAcceptKey({
  contentDigest,
  findingFingerprint: fp,
  rulesetVersion: SCANNER_RULESET_VERSION,
})

const record = {
  acceptKey,
  sourcePath: `/skills/child-${id}/SKILL.md`,
  identifier: `child-${id}`,
  contentDigest,
  findingFingerprint: fp,
  rulesetVersion: SCANNER_RULESET_VERSION,
  display: {
    type: 'jailbreak',
    severity: 'high',
    message: `child-${id}`,
    location: null,
    lineNumber: null,
  },
  acceptedAt: new Date().toISOString(),
  reason: `accepted by child ${id}`,
}

const outcome = acceptFinding(acceptancePath, record)
console.log(
  JSON.stringify({ ok: outcome.ok, acceptKey, warnings: outcome.warnings.map((w) => w.code) })
)
process.exit(outcome.ok ? 0 : 1)

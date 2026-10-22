#!/usr/bin/env node
/**
 * Child for writer.lock5.test.ts (SMI-6531, lock 5). Plain `.mjs`, outside
 * every vitest glob.
 *
 *   SKILLSMITH_JOURNAL_DIR=<dir> node --import tsx writer.lock5.child.mjs <name> <count> <goFile>
 *
 * Writes `<goFile>.ready-<name>`, waits for <goFile>, then appends <count>
 * records with a 2 ms pause between them (so the other process gets turns). Prints
 * one JSON line: how many appends resolved and how many rejected.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { appendJournalRecord } from '../../../src/journal/writer.ts'

const [name, countText, go] = process.argv.slice(2)
const count = Number(countText)
writeFileSync(`${go}.ready-${name}`, '1')
const deadline = Date.now() + 20_000
while (!existsSync(go)) {
  if (Date.now() > deadline) throw new Error('timed out waiting for go')
  await new Promise((r) => setTimeout(r, 5))
}
let ok = 0
const failed = []
for (let i = 0; i < count; i++) {
  try {
    await appendJournalRecord({
      schema: 2,
      ts: Date.now(),
      session_id: name,
      tool: 'probe',
      action: 'apply',
      suggestion_id: `${name}-${i}`,
      target_path: null,
      before_hash: null,
      after_hash: null,
      approval: null,
      backup_ref: null,
      detail: null,
    })
    ok++
    await new Promise((r) => setTimeout(r, 2))
  } catch (err) {
    failed.push(String(err && err.message))
  }
}
process.stdout.write(
  JSON.stringify({ name, ok, failed: failed.length, firstFailure: failed[0] ?? null }) + '\n'
)
process.exit(0)

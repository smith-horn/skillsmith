#!/usr/bin/env node
/**
 * Child for the skill-swap suites (SMI-6531 A1 step 4a). Plain `.mjs`, so it
 * sits outside every vitest glob.
 *
 *   node --import tsx skill-swap.child.mjs kill <config.json>
 *     Plans and runs `swapInPlace` from the config ({ skillsDir, stateRoot,
 *     dirName, opId, writeSet: [{ rel, kind, text }], killAt }) and SIGKILLs
 *     itself at hook `killAt`. If it ever gets past that, it prints the result.
 *
 *   node --import tsx skill-swap.child.mjs hold <skillsDir> <markerDir>
 *     Takes lock 1 on <skillsDir>, writes <markerDir>/held, and stays inside
 *     until <markerDir>/release exists. Prints one JSON line.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bindIdentity } from '../../../src/install/park-tree.identity.ts'
import { swapInPlace } from '../../../src/services/skill-swap.ts'
import { treeHashOf } from '../../../src/services/skill-tree.ts'
import { withSkillWriteLock } from '../../../src/services/skill-write-lock.ts'

const [mode, ...args] = process.argv.slice(2)

if (mode === 'hold') {
  const [skillsDir, markers] = args
  const r = await withSkillWriteLock(skillsDir, 'hold', async () => {
    writeFileSync(join(markers, 'held'), '1')
    const deadline = Date.now() + 20_000
    while (!existsSync(join(markers, 'release'))) {
      if (Date.now() > deadline) throw new Error('timed out waiting for release')
      await new Promise((res) => setTimeout(res, 10))
    }
    return 'held'
  })
  process.stdout.write(JSON.stringify({ ok: r.ok }) + '\n')
  process.exit(0)
}

const cfg = JSON.parse(readFileSync(args[0], 'utf8'))
const realDir = join(cfg.skillsDir, cfg.dirName)
const oldIdentity = bindIdentity(realDir)
const pre = treeHashOf(realDir)
const port = {
  withManifestLock: (fn) =>
    fn({ casMatches: async () => true, preCommitCheck: async () => {}, write: async () => {} }),
}
const result = await swapInPlace(
  {
    skillsDir: cfg.skillsDir,
    client: 'claude-code',
    scope: 'user',
    stateRoot: cfg.stateRoot,
    manifestPath: join(cfg.stateRoot, 'manifest.json'),
    manifestKey: cfg.dirName,
    comparedPath: realDir,
    realDir,
    dirName: cfg.dirName,
    oldIdentity,
    preTree: pre.hash,
    writeSet: cfg.writeSet.map((w) => ({ rel: w.rel, kind: w.kind, bytes: Buffer.from(w.text) })),
    preEntry: { version: '1.0.0' },
    postEntry: { version: '2.0.0' },
    manifest: port,
  },
  {
    opId: cfg.opId,
    appendJournal: async () => {},
    hooks: { [cfg.killAt]: () => process.kill(process.pid, 'SIGKILL') },
  }
)
process.stdout.write(JSON.stringify(result) + '\n')
process.exit(0)

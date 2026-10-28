#!/usr/bin/env node
/**
 * Child for the skill-swap suites (SMI-6531 A1 step 4a). Plain `.mjs`, so it
 * sits outside every vitest glob.
 *
 *   node --import tsx skill-swap.child.mjs kill <config.json>
 *     Plans and runs `swapInPlace` from the config ({ skillsDir, stateRoot,
 *     dirName, opId, writeSet: [{ rel, kind, text }], killAt }) and SIGKILLs
 *     itself at hook `killAt` (or inside the park, `killFs`; or mid cross-device
 *     copy, `killMidCopy`). If it ever gets past that, it prints the result.
 *
 *   node --import tsx skill-swap.child.mjs hold <skillsDir> <markerDir> [go]
 *     Takes lock 1 on <skillsDir>, writes <markerDir>/held, and stays inside
 *     until <markerDir>/release exists. Prints one JSON line. With `go`, it
 *     first writes <markerDir>/ready and asks for the lock only once
 *     <markerDir>/go exists.
 */
import fs, {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { bindIdentity } from '../../../src/install/park-tree.identity.ts'
import { swapInPlace } from '../../../src/services/skill-swap.ts'
import { treeHashOf } from '../../../src/services/skill-tree.ts'
import { withSkillWriteLock } from '../../../src/services/skill-write-lock.ts'

const [mode, ...args] = process.argv.slice(2)

if (mode === 'hold') {
  const [skillsDir, markers, waitGo] = args
  // `go`: write <markerDir>/ready, then ask for lock 1 only once <markerDir>/go exists.
  if (waitGo === 'go') {
    writeFileSync(join(markers, 'ready'), '1')
    while (!existsSync(join(markers, 'go'))) await new Promise((res) => setTimeout(res, 5))
  }
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
const opDir = join(cfg.skillsDir, '.skillsmith-staging', cfg.opId)
const die = () => process.kill(process.pid, 'SIGKILL')

// SMI-6531 step 4b (T-X14): `abortAt` makes the run abort before rename 1
// ('build': a step-1 failure; 'step4': the live folder edited after the build;
// 'step6': the live folder replaced before step 6's lstat, record published),
// `editN` edits a file in N after the build, and `killFs` kills inside the
// park call, where there is no hook: just before OP's rename, just after it,
// or just after the parked copy's sidecar is written.
const hooks = {}
const on = (point, fn) => {
  const prev = hooks[point]
  hooks[point] = async () => {
    await fn()
    await prev?.()
  }
}
if (cfg.killAt) on(cfg.killAt, die)
if (cfg.abortAt === 'build') {
  on('afterCopy', () => {
    throw new Error('forced build failure')
  })
}
// SMI-6531 step 4c round 1: `editAfterSidecar` edits the old folder once its
// backup sidecar is published, so the cross-device copy rewrites the sidecar.
if (cfg.editAfterSidecar) {
  on('afterSidecar', () =>
    appendFileSync(join(opDir, 'old', 'a.txt'), 'edited after the sidecar\n')
  )
}
if (cfg.editN) {
  on('afterBuild', () => appendFileSync(join(opDir, 'new', 'a.txt'), 'edited in N\n'))
}
if (cfg.abortAt === 'step4') {
  on('afterBuild', () => appendFileSync(join(realDir, 'SKILL.md'), 'live edit\n'))
}
if (cfg.abortAt === 'step6') {
  on('beforeRename1Check', () => {
    renameSync(realDir, `${realDir}-original`)
    mkdirSync(realDir)
    writeFileSync(join(realDir, 'SKILL.md'), '# someone else\n')
  })
}
if (cfg.killFs === 'parkRenameBefore' || cfg.killFs === 'parkRenameAfter') {
  const orig = fs.renameSync
  fs.renameSync = (...a) => {
    if (a[0] === opDir && cfg.killFs === 'parkRenameBefore') die()
    const out = orig(...a)
    if (a[0] === opDir) die()
    return out
  }
}
if (cfg.killFs === 'parkSidecarAfter') {
  const orig = fs.writeFileSync
  fs.writeFileSync = (...a) => {
    const out = orig(...a)
    const p = String(a[0])
    if (p.includes('.skillsmith-parked') && p.endsWith('.json')) die()
    return out
  }
}
// SMI-6531 step 4c (T-X8): `killMidCopy` kills inside the cross-device copy,
// after its first entry; `deleteLog` appends the path of every fs delete call
// (sync, callback and promise) to that file before it runs, so a killed run
// can still be checked for a delete of a tree entry.
if (cfg.deleteLog) {
  const log = (p) => appendFileSync(cfg.deleteLog, `${String(p)}\n`)
  for (const n of ['unlinkSync', 'rmdirSync', 'rmSync', 'unlink', 'rmdir', 'rm']) {
    const orig = fs[n]
    fs[n] = (...a) => (log(a[0]), orig(...a))
  }
  for (const n of ['unlink', 'rmdir', 'rm']) {
    const orig = fs.promises[n]
    fs.promises[n] = (...a) => (log(a[0]), orig(...a))
  }
}
const oldIdentity = bindIdentity(realDir)
const pre = treeHashOf(realDir)
const port = {
  withManifestLock: (fn) =>
    fn({ classify: async () => 'pre', casMatches: async () => true, write: async () => {} }),
}
const result = await swapInPlace(
  {
    skillsDir: cfg.skillsDir,
    client: 'claude-code',
    scope: 'global',
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
    stderr: () => {},
    hooks,
    ...(cfg.killMidCopy ? { duringBackupCopy: die } : {}),
  }
)
process.stdout.write(JSON.stringify(result) + '\n')
process.exit(0)

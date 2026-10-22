/**
 * SMI-6531 (A1 step 4a): `swapInPlace` on one device: T-X1, T-X7, the record,
 * the backup name, the journal step, the pre-commit stop and `busy`.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { JOURNAL_DIR_ENV_VAR } from '../../../src/journal/path.js'
import { changedPaths } from '../../../src/services/skill-swap.writeset.js'
import {
  areaOf,
  create,
  hashOf,
  isSubsequence,
  listTree,
  makeFixture,
  manyFiles,
  modify,
  OP_ID,
  parseRecord,
  plan,
  readRecord,
  recordOf,
  run,
  tmp,
  useTmpCleanup,
} from './skill-swap.helpers.js'

useTmpCleanup()

const childPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'skill-swap.child.mjs')

describe('swapInPlace: the committed path', () => {
  it('T-X1: a 300-file folder with a 3-file write set changes exactly those files; the old folder is the backup', async () => {
    const fx = makeFixture(manyFiles(300))
    const before = recordOf(fx.realDir)
    const p = plan(fx, [
      modify('SKILL.md', '# skill v2\n'),
      modify('d1/f1.txt', 'file 1, changed\n'),
      create('d3/new.txt', 'brand new\n'),
    ])

    const { result, journal } = await run(p)

    expect(result).toMatchObject({ status: 'committed', opId: OP_ID, warnings: [] })
    if (result.status !== 'committed') throw new Error('unreachable')
    expect(result.incomplete).toBeUndefined()
    expect(changedPaths(before, recordOf(fx.realDir))).toEqual([
      'SKILL.md',
      'd1/f1.txt',
      'd3/new.txt',
    ])
    expect(fs.readFileSync(path.join(fx.realDir, 'SKILL.md'), 'utf8')).toBe('# skill v2\n')

    // The old folder, whole, at backupDest, with its sidecar.
    expect(result.backupDest).toBe(path.join(areaOf(fx), OP_ID))
    expect(hashOf(result.backupDest)).toBe(p.input.preTree)
    const sidecar = JSON.parse(fs.readFileSync(`${result.backupDest}.json`, 'utf8'))
    expect(sidecar).toMatchObject({
      opId: OP_ID,
      kind: 'backup',
      dirName: fx.dirName,
      treeHash: p.input.preTree,
      client: 'claude-code',
      skillsDir: fs.realpathSync(fx.skillsDir),
      scope: 'user',
      manifestKey: fx.dirName,
    })

    // Committed and journaled; staging is empty again.
    expect(p.manifest.entry).toEqual({ version: '2.0.0' })
    expect(journal).toHaveLength(1)
    expect(journal[0]).toMatchObject({ suggestion_id: OP_ID, backup_ref: result.backupDest })
    expect(fs.existsSync(fx.opDir)).toBe(false)
    expect(fs.readdirSync(fx.staging)).toEqual([])
  })

  it('T-X7: a new subdirectory is created in new/ only; nothing is made under the live folder before rename 2', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = plan(fx, [create('.claude/settings.json', '{"a":1}\n')])

    const { result, trace } = await run(p)

    // The spy first: whatever the outcome, no mkdir under the live folder's path before rename 2.
    const rename2 = trace.findIndex(
      (t) => t.op === 'rename' && t.path === path.join(fx.opDir, 'new') && t.dest === fx.realDir
    )
    const madeUnderLive = trace
      .slice(0, rename2 === -1 ? trace.length : rename2)
      .filter((t) => t.op === 'mkdir' && t.path.startsWith(fx.realDir + path.sep))
    expect(madeUnderLive).toEqual([])
    expect(rename2).toBeGreaterThan(0)
    expect(result.status).toBe('committed')
    if (result.status !== 'committed') throw new Error('unreachable')
    expect(fs.readFileSync(path.join(fx.realDir, '.claude', 'settings.json'), 'utf8')).toBe(
      '{"a":1}\n'
    )
    // The mkdir happened, and in new/.
    expect(trace).toContainEqual({ op: 'mkdir', path: path.join(fx.opDir, 'new', '.claude') })
    // The old folder (the backup) never gained the directory.
    expect(listTree(result.backupDest)).toEqual(['SKILL.md'])
  })

  it('record.json has the plan fields in order, bigint identities as strings, and a verifying recordSha256', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    let text: string | null = null
    let tmpLeft: boolean | null = null
    const { result } = await run(p, {
      hooks: {
        afterRecord: () => {
          text = fs.readFileSync(path.join(fx.opDir, 'record.json'), 'utf8')
          tmpLeft = fs.existsSync(path.join(fx.opDir, 'record.json.tmp'))
        },
      },
    })
    expect(text).not.toBeNull()
    const rec = parseRecord(text!) as unknown as Record<string, unknown>
    expect(tmpLeft).toBe(false)
    expect(result.status).toBe('committed')
    expect(Object.keys(rec)).toEqual([
      'schema',
      'opId',
      'pid',
      'host',
      'uid',
      'target',
      'rootIdentity',
      'opDirIdentity',
      'oldIdentity',
      'newIdentity',
      'preTree',
      'postTree',
      'preEntry',
      'postEntry',
      'backupDest',
      'recordSha256',
    ])
    expect(rec).toMatchObject({
      schema: 1,
      opId: OP_ID,
      pid: process.pid,
      preTree: p.input.preTree,
      postTree: hashOf(fx.realDir),
      preEntry: { version: '1.0.0' },
      postEntry: { version: '2.0.0' },
      backupDest: path.join(areaOf(fx), OP_ID),
      target: {
        comparedPath: fx.realDir,
        realDir: fx.realDir,
        skillsDir: fs.realpathSync(fx.skillsDir),
        manifestKey: fx.dirName,
        client: 'claude-code',
      },
    })
    expect((rec.oldIdentity as Record<string, unknown>).ino).toBe(p.oldIdentity.ino.toString())
  })

  it('a taken backup name gets a .<k> suffix, and the entry holding the name is untouched', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const area = areaOf(fx)
    fs.mkdirSync(path.join(area, OP_ID), { recursive: true })
    fs.writeFileSync(path.join(area, OP_ID, 'planted.txt'), 'planted')
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])

    const { result } = await run(p)

    expect(result).toMatchObject({ status: 'committed', backupDest: path.join(area, `${OP_ID}.1`) })
    expect(listTree(path.join(area, OP_ID))).toEqual(['planted.txt'])
    expect(hashOf(path.join(area, `${OP_ID}.1`))).toBe(p.input.preTree)
  })
})

describe('swapInPlace: stops after the swap', () => {
  it('a journal append failure is committed with incomplete audit; the record is kept and nothing is published', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])

    const { result } = await run(p, {
      appendJournal: async () => {
        throw new Error('ENOSPC: no space left on device')
      },
    })

    expect(result).toMatchObject({
      status: 'committed',
      incomplete: { step: 'audit', reason: 'journal-append-failed' },
      recordPath: path.join(fx.opDir, 'record.json'),
    })
    expect(p.manifest.entry).toEqual({ version: '2.0.0' })
    readRecord(path.join(fx.opDir, 'record.json'))
    expect(hashOf(path.join(fx.opDir, 'old'))).toBe(p.input.preTree)
    expect(fs.existsSync(path.join(fx.stateRoot, 'backups'))).toBe(false)
  })

  it('the real journal append records the opId and the backup', async () => {
    const dir = tmp('skill-swap-journal-')
    const prev = process.env[JOURNAL_DIR_ENV_VAR]
    process.env[JOURNAL_DIR_ENV_VAR] = dir
    try {
      const fx = makeFixture({ 'SKILL.md': '# v1\n' })
      const p = plan(fx, [modify('SKILL.md', '# v2\n')])
      const { result, trace } = await run(p, { appendJournal: undefined })
      expect(result.status).toBe('committed')
      const lines = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').trim().split('\n')
      expect(JSON.parse(lines[lines.length - 1]!)).toMatchObject({
        suggestion_id: OP_ID,
        backup_ref: path.join(areaOf(fx), OP_ID),
      })
      expect(trace.some((t) => t.op === 'journal-append')).toBe(true)
    } finally {
      if (prev === undefined) delete process.env[JOURNAL_DIR_ENV_VAR]
      else process.env[JOURNAL_DIR_ENV_VAR] = prev
    }
  })

  it('a failing pre-commit check stops with the record kept and the manifest unwritten', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    p.manifest.preCommitError = new Error('manifest lock lost')

    const { result } = await run(p)

    expect(result).toMatchObject({
      status: 'stopped',
      reason: 'pre-commit-check-failed',
      recordPath: path.join(fx.opDir, 'record.json'),
    })
    expect(p.manifest.writes).toBe(0)
    expect(fs.readFileSync(path.join(fx.realDir, 'SKILL.md'), 'utf8')).toBe('# v2\n')
    expect(hashOf(path.join(fx.opDir, 'old'))).toBe(p.input.preTree)
  })
})

describe('swapInPlace: step 13 on one device', () => {
  it('an op dir holding anything but its metadata stops with nothing removed (op-not-empty)', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])

    const { result } = await run(p, {
      hooks: { afterCommit: () => fs.writeFileSync(path.join(fx.opDir, 'stray.txt'), 'stray') },
    })

    expect(result).toMatchObject({
      status: 'committed',
      incomplete: { step: 'cleanup', reason: 'op-not-empty' },
      recordPath: path.join(fx.opDir, 'record.json'),
    })
    expect(fs.readdirSync(fx.opDir).sort()).toEqual(['owner.json', 'record.json', 'stray.txt'])
    readRecord(path.join(fx.opDir, 'record.json'))
    if (result.status !== 'committed') throw new Error('unreachable')
    expect(hashOf(result.backupDest)).toBe(p.input.preTree)
  })
})

describe('T-L16 (swap level): an absent skills root', () => {
  /** A plan whose skills root is `<base>/clients/skills`, with `clients` absent too. */
  function absentRootPlan() {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const parent = path.join(fx.base, 'clients')
    const root = path.join(parent, 'skills')
    const realDir = path.join(root, fx.dirName)
    p.input = { ...p.input, skillsDir: root, comparedPath: realDir, realDir }
    return { fx, p, parent, root }
  }

  it('the root and its missing parent are made (each followed by its parent sync) before OP', async () => {
    const { fx, p, parent, root } = absentRootPlan()

    const { result, trace } = await run(p)

    // There is no folder to update in a root that did not exist: the build's
    // copy of it fails, so this stops at step 1 (a fresh install is step 8's).
    // What matters is that it got past the bind, which needs the root to exist.
    expect(result).toMatchObject({ status: 'refused', reason: 'changed-since-plan' })
    expect(
      isSubsequence(trace, [
        { op: 'mkdir', path: parent },
        { op: 'dirsync', path: fx.base },
        { op: 'mkdir', path: root },
        { op: 'dirsync', path: parent },
        { op: 'mkdir', path: path.join(root, '.skillsmith-staging', OP_ID) },
      ])
    ).toEqual({ ok: true })
    expect(fs.lstatSync(root).isDirectory()).toBe(true)
  })

  it('a root that cannot be made is refused root-unsafe, with nothing staged', async () => {
    const { p, parent } = absentRootPlan()
    fs.writeFileSync(parent, 'a file where a directory should be')

    const { result, trace } = await run(p)

    expect(result).toMatchObject({
      status: 'refused',
      reason: 'root-unsafe',
      staged: 'none',
      opDir: null,
    })
    expect(trace.filter((t) => t.op === 'mkdir' && t.path.includes(OP_ID))).toEqual([])
    expect(fs.readFileSync(parent, 'utf8')).toBe('a file where a directory should be')
  })
})

describe('swapInPlace: busy', () => {
  let release: (() => void) | null = null
  afterEach(() => release?.())

  it('lock 1 held by another process: refused busy, OP left as it is, nothing renamed', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const markers = tmp('skill-swap-markers-')
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      childPath,
      'hold',
      fx.skillsDir,
      markers,
    ])
    const exited = new Promise<void>((res) => child.on('exit', () => res()))
    release = () => fs.writeFileSync(path.join(markers, 'release'), '1')
    const deadline = Date.now() + 20_000
    while (!fs.existsSync(path.join(markers, 'held'))) {
      if (Date.now() > deadline) throw new Error('child never took the lock')
      await new Promise((r) => setTimeout(r, 10))
    }
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])

    const { result, trace } = await run(p, { lockTimeoutMs: 200 })

    release()
    await exited
    expect(result).toMatchObject({
      status: 'refused',
      reason: 'busy',
      staged: 'left',
      opDir: fx.opDir,
      cleanStagingHint: `skillsmith doctor recovery --clean-staging ${OP_ID}`,
    })
    expect(fs.readdirSync(fx.opDir).sort()).toEqual(['new', 'owner.json'])
    expect(hashOf(fx.realDir)).toBe(p.input.preTree)
    expect(trace.filter((t) => t.op === 'rename' && t.path === fx.realDir)).toEqual([])
  })
})

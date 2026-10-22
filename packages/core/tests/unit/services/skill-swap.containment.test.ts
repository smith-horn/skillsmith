/**
 * SMI-6531 (A1 step 4a): T-X12, staging containment. Each case snapshots the
 * outside directory (and the live folder) before and after: nothing may be
 * created, moved or removed outside the skills root, the state root or the
 * planted directory.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  areaOf,
  hashOf,
  makeFixture,
  modify,
  plan,
  readRecord,
  run,
  snapshot,
  useTmpCleanup,
} from './skill-swap.helpers.js'
import type { Fixture } from './skill-swap.helpers.js'

useTmpCleanup()

const FILES = { 'SKILL.md': '# v1\n', 'a.txt': 'a\n' }

function before(fx: Fixture) {
  return { outside: snapshot(fx.outside), live: snapshot(fx.realDir) }
}

describe('T-X12: staging containment', () => {
  it('(a) .skillsmith-staging planted as a symlink to outside: staging-unsafe, nothing staged through it', async () => {
    const fx = makeFixture(FILES)
    fs.symlinkSync(fx.outside, fx.staging)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const b = before(fx)

    const { result, trace } = await run(p)

    expect(result).toMatchObject({ status: 'refused', reason: 'staging-unsafe', staged: 'none' })
    expect(trace).toEqual([])
    expect({ outside: snapshot(fx.outside), live: snapshot(fx.realDir) }).toEqual(b)
    expect(fs.readlinkSync(fx.staging)).toBe(fx.outside)
  })

  it('(b) an op dir planted at the chosen opId: staging-collision, the planted file untouched', async () => {
    const fx = makeFixture(FILES)
    fs.mkdirSync(fx.opDir, { recursive: true })
    fs.writeFileSync(path.join(fx.opDir, 'planted.txt'), 'planted')
    const planted = snapshot(fx.opDir)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const b = before(fx)

    const { result, trace } = await run(p)

    expect(result).toMatchObject({
      status: 'refused',
      reason: 'staging-collision',
      staged: 'none',
      opDir: null,
    })
    expect(trace).toEqual([])
    expect(snapshot(fx.opDir)).toEqual(planted)
    expect({ outside: snapshot(fx.outside), live: snapshot(fx.realDir) }).toEqual(b)
  })

  it('(c) OP replaced by a symlink to outside after the build: staging-unsafe, no record or rename', async () => {
    const fx = makeFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const b = before(fx)

    const { result, trace } = await run(p, {
      hooks: {
        afterBuild: () => {
          fs.renameSync(fx.opDir, path.join(fx.base, 'op-aside'))
          fs.symlinkSync(fx.outside, fx.opDir)
        },
      },
    })

    expect(result).toMatchObject({ status: 'refused', reason: 'staging-unsafe' })
    expect({ outside: snapshot(fx.outside), live: snapshot(fx.realDir) }).toEqual(b)
    expect(trace.filter((t) => t.op === 'rename' && t.path === fx.realDir)).toEqual([])
    expect(trace.some((t) => t.op === 'create' && t.path.endsWith('record.json.tmp'))).toBe(false)
  })

  it('(d) a backup-area component replaced by a symlink before publishTree: committed, incomplete publish backup-unsafe', async () => {
    const fx = makeFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const outsideBefore = snapshot(fx.outside)
    const area = areaOf(fx)

    const { result } = await run(p, {
      hooks: {
        beforePublish: () => {
          fs.renameSync(area, `${area}-aside`)
          fs.symlinkSync(fx.outside, area)
        },
      },
    })

    expect(result).toMatchObject({
      status: 'committed',
      incomplete: { step: 'publish', reason: 'backup-unsafe' },
      recordPath: path.join(fx.opDir, 'record.json'),
    })
    readRecord(path.join(fx.opDir, 'record.json'))
    expect(hashOf(path.join(fx.opDir, 'old'))).toBe(p.input.preTree)
    expect(snapshot(fx.outside)).toEqual(outsideBefore)
    expect(fs.readdirSync(`${area}-aside`)).toEqual([])
  })
})

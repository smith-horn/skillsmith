/**
 * SMI-6744 -- scripts/ruflo-seed/lock-gate.mjs test suite.
 * Pure Node builtins; runs on the host. The CLI is exercised as a real child
 * process against fixture lockfiles written to a fresh temp directory, and the
 * exported compareLocks() is unit-tested directly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
// @ts-expect-error -- plain .mjs module without type declarations
import { compareLocks, WATCHED_NAMES } from '../ruflo-seed/lock-gate.mjs'

const GATE = path.resolve(__dirname, '../ruflo-seed/lock-gate.mjs')

type Pk = Record<string, { version: string }>
const lock = (pk: Pk) => ({ lockfileVersion: 3, packages: { '': { name: 'seed' }, ...pk } })

let dir: string
let n = 0
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-gate-'))
})
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function write(content: unknown): string {
  const f = path.join(dir, `f${n++}.json`)
  fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content))
  return f
}

function run(before: unknown, after: unknown, accepts: string[] = []) {
  const args = [GATE, write(before), write(after)]
  for (const a of accepts) args.push('--accept', a)
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

const base: Pk = {
  'node_modules/agentdb': { version: '1.0.0' },
  'node_modules/agentic-flow': { version: '1.0.0' },
  'node_modules/agentic-flow/node_modules/agentdb': { version: '1.0.0' },
  'node_modules/lodash': { version: '4.0.0' },
}
const bump = (extra: Pk): Pk => ({ ...base, ...extra })

describe('lock-gate', () => {
  it('exports the watched-name list', () => {
    expect(WATCHED_NAMES).toContain('agentdb')
    expect(WATCHED_NAMES).toContain('@ruvector/core')
    expect(WATCHED_NAMES).toHaveLength(12)
  })

  it('identical locks exit 0 with nothing unaccepted', () => {
    const r = run(lock(base), lock(base))
    expect(r.code).toBe(0)
    expect(r.out).toContain('added 0, removed 0, changed 0')
    expect(r.out).not.toContain('UNACCEPTED')
  })

  it('unwatched version change exits 0 and is listed as changed', () => {
    const r = run(lock(base), lock(bump({ 'node_modules/lodash': { version: '4.1.0' } })))
    expect(r.code).toBe(0)
    expect(r.out).toContain('node_modules/lodash 4.0.0 -> 4.1.0')
    expect(r.out).toContain('changed 1')
  })

  it('R-4a: root agentdb change exits 1 naming the root path', () => {
    const r = run(lock(base), lock(bump({ 'node_modules/agentdb': { version: '2.0.0' } })))
    expect(r.code).toBe(1)
    expect(r.out).toContain('UNACCEPTED changed node_modules/agentdb 1.0.0 -> 2.0.0')
    expect(r.out).not.toContain('UNACCEPTED changed node_modules/agentic-flow/node_modules/agentdb')
  })

  it('R-4b: nested agentdb change names the nested path, not the root', () => {
    const nested = 'node_modules/agentic-flow/node_modules/agentdb'
    const r = run(lock(base), lock(bump({ [nested]: { version: '2.0.0' } })))
    expect(r.code).toBe(1)
    expect(r.out).toContain(`UNACCEPTED changed ${nested} 1.0.0 -> 2.0.0`)
    expect(r.out).not.toContain('UNACCEPTED changed node_modules/agentdb ')
  })

  it('R-4c: added nested better-sqlite3 exits 1 as kind added', () => {
    const p = 'node_modules/foo/node_modules/better-sqlite3'
    const r = run(lock(base), lock(bump({ [p]: { version: '9.0.0' } })))
    expect(r.code).toBe(1)
    expect(r.out).toContain(`UNACCEPTED added ${p} - -> 9.0.0`)
  })

  it('removed watched path exits 1 unless accepted with @removed', () => {
    const after: Pk = { ...base }
    delete after['node_modules/agentdb']
    const bad = run(lock(base), lock(after))
    expect(bad.code).toBe(1)
    expect(bad.out).toContain('UNACCEPTED removed node_modules/agentdb 1.0.0 -> -')
    const ok = run(lock(base), lock(after), ['node_modules/agentdb@removed'])
    expect(ok.code).toBe(0)
  })

  it('exact path@newVersion accepts; wrong version still fails', () => {
    const after = lock(bump({ 'node_modules/agentdb': { version: '2.0.0' } }))
    expect(run(lock(base), after, ['node_modules/agentdb@2.0.0']).code).toBe(0)
    const wrong = run(lock(base), after, ['node_modules/agentdb@3.0.0'])
    expect(wrong.code).toBe(1)
    expect(wrong.out).toContain('UNACCEPTED changed node_modules/agentdb')
    expect(wrong.out).toContain('UNUSED-ACCEPT node_modules/agentdb@3.0.0')
  })

  it('an accept naming the root path does not accept the nested path', () => {
    const nested = 'node_modules/agentic-flow/node_modules/agentdb'
    const after = lock(bump({ [nested]: { version: '2.0.0' } }))
    const r = run(lock(base), after, ['node_modules/agentdb@2.0.0'])
    expect(r.code).toBe(1)
    expect(r.out).toContain(`UNACCEPTED changed ${nested}`)
  })

  it('an unused accept spec exits 1 with UNUSED-ACCEPT', () => {
    const r = run(lock(base), lock(base), ['node_modules/agentdb@9.9.9'])
    expect(r.code).toBe(1)
    expect(r.out).toContain('UNUSED-ACCEPT node_modules/agentdb@9.9.9')
  })

  it('invalid JSON exits 2', () => {
    const r = run(lock(base), '{not json')
    expect(r.code).toBe(2)
  })

  it('a lock without packages exits 2', () => {
    expect(run(lock(base), { lockfileVersion: 3 }).code).toBe(2)
    expect(run({ packages: [] }, lock(base)).code).toBe(2)
  })

  it('usage errors exit 2', () => {
    const r = spawnSync(process.execPath, [GATE, write(lock(base))], { encoding: 'utf8' })
    expect(r.status).toBe(2)
  })

  it('compareLocks classifies by path and matches name after the last node_modules/', () => {
    const r = compareLocks(
      lock(base).packages,
      lock(bump({ 'node_modules/agentic-flow/node_modules/agentdb': { version: '2.0.0' } }))
        .packages,
      []
    )
    expect(r.changed.map((l: { path: string }) => l.path)).toEqual([
      'node_modules/agentic-flow/node_modules/agentdb',
    ])
    expect(r.watched).toHaveLength(1)
    expect(r.unaccepted[0].kind).toBe('changed')
    expect(r.unaccepted[0].name).toBe('agentdb')
  })

  it('compareLocks ignores the root key', () => {
    const a = { '': { version: '1' } }
    const b = { '': { version: '2' } }
    const r = compareLocks(a, b, [])
    expect(r.changed).toHaveLength(0)
  })
})

/**
 * SMI-6531: what happens at the ORIGIN after the rename, and the sidecar's
 * write rules, ported from the SMI-6676 spike's
 * `harness/test-quarantine-postmove-origin.mjs`.
 *
 * Owner decision A (ADR-166 D-10): never move back. After the root rename the
 * park may not rename onto, create, or write at the origin; a writer that
 * re-created the origin and holds it as its cwd must keep its later writes.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLIENT,
  buildFixture,
  cleanup,
  errnoError,
  field,
  guardOf,
  park,
  readJson,
  readText,
  runWithHooks,
  withFsStub,
  CALLER,
  KIND,
} from './park-tree.helpers.js'
import type { Fixture, HookRun } from './park-tree.helpers.js'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r)
})
const HEX64 = /^[0-9a-f]{64}$/
let seq = 0
const nextOp = () => `pmo-op-${process.pid}-${++seq}`
const fixture = (): Fixture => {
  const f = buildFixture('park-pmo-')
  roots.push(f.root)
  return f
}
const append = (f: Fixture) => fs.appendFileSync(path.join(f.target, 'orig-f1'), '-late')
const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const waitUntil = (pred: () => boolean, timeoutMs = 10_000): boolean => {
  const end = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > end) return false
    sleepMs(5)
  }
  return true
}

/** Calls at or inside the origin after the root rename. */
function originCallsAfterRename(run: HookRun): string[] {
  if (run.renameIdx === -1) return ['NO-ROOT-RENAME-IN-TRACE']
  return run.trace
    .slice(run.renameIdx + 1)
    .filter(
      (e) =>
        e.scope === 'origin' || e.scope === 'desc' || e.scope2 === 'origin' || e.scope2 === 'desc'
    )
    .map((e) => `${e.fn}(${e.p0}${e.p1 ? ` -> ${e.p1}` : ''})`)
}
/** Paired presence proof: recording continued past the rename. */
const destCallsAfterRename = (run: HookRun): number =>
  run.renameIdx === -1
    ? 0
    : run.trace.slice(run.renameIdx + 1).filter((e) => e.scope === 'dest').length

describe('the origin is never touched after the rename', () => {
  for (const variant of ['empty', 'non-empty'] as const) {
    it(`R7 ${variant}: an origin re-created before verification is left exactly as the writer made it`, () => {
      const f = fixture()
      let writerIno = 0
      const run = runWithHooks({
        parentAbs: f.parent,
        name: f.name,
        options: {
          client: CLIENT,
          caller: CALLER,
          kind: KIND,
          guardHash: guardOf(f.origin),
          opId: nextOp(),
        },
        onRecheck: () => append(f),
        onAfterRename: () => {
          fs.mkdirSync(f.origin)
          if (variant === 'non-empty') {
            fs.writeFileSync(path.join(f.origin, 'writer.txt'), 'writer-bytes')
          }
          writerIno = fs.lstatSync(f.origin).ino
        },
      })
      expect(run.fired.recheck && run.fired.afterRename && run.hookErrors.length === 0).toBe(true)
      expect(run.result.status).toBe('held')
      expect(fs.lstatSync(f.origin).ino).toBe(writerIno)
      expect(fs.readdirSync(f.origin).sort().join(',')).toBe(
        variant === 'empty' ? '' : 'writer.txt'
      )
      if (variant === 'non-empty') {
        expect(readText(path.join(f.origin, 'writer.txt'))).toBe('writer-bytes')
      }
      expect(originCallsAfterRename(run)).toEqual([])
      expect(destCallsAfterRename(run)).toBeGreaterThan(0)
    })
  }

  it('R-a: a writer holding the re-created origin as its cwd keeps its later write', () => {
    const f = fixture()
    const sig = path.join(f.root, 'sig')
    fs.mkdirSync(sig)
    let child: ChildProcess | null = null
    const script =
      'mkdir "$1" && cd "$1" && ls -di . | awk \'{print $1}\' > "$2/ino" && : > "$2/ready" && ' +
      'while [ ! -e "$2/go" ]; do sleep 0.02; done; printf %s writer-held-bytes > new-file && : > "$2/done"'
    try {
      const run = runWithHooks({
        parentAbs: f.parent,
        name: f.name,
        options: {
          client: CLIENT,
          caller: CALLER,
          kind: KIND,
          guardHash: guardOf(f.origin),
          opId: nextOp(),
        },
        onRecheck: () => append(f),
        onAfterRename: () => {
          child = spawn('/bin/sh', ['-c', script, 'ra', f.origin, sig], { stdio: 'ignore' })
          if (!waitUntil(() => fs.existsSync(path.join(sig, 'ready')))) {
            throw new Error('R-a writer never signalled ready')
          }
        },
      })
      fs.writeFileSync(path.join(sig, 'go'), '')
      const doneOk = waitUntil(() => fs.existsSync(path.join(sig, 'done')))
      expect(run.fired.afterRename && run.hookErrors.length === 0).toBe(true)
      expect(doneOk).toBe(true)
      expect(run.result.status).toBe('held')
      expect(String(fs.lstatSync(f.origin).ino)).toBe(readText(path.join(sig, 'ino')).trim())
      expect(readText(path.join(f.origin, 'new-file'))).toBe('writer-held-bytes')
      expect(originCallsAfterRename(run)).toEqual([])
      expect(destCallsAfterRename(run)).toBeGreaterThan(0)
    } finally {
      const c = child as ChildProcess | null
      if (c !== null && c.exitCode === null) c.kill()
      sleepMs(20)
    }
  })

  it('R12: an unguarded park runs no verification at all', () => {
    const f = fixture()
    const run = runWithHooks({
      parentAbs: f.parent,
      name: f.name,
      options: { client: CLIENT, caller: CALLER, kind: KIND, opId: nextOp() },
      onRename: () => append(f),
    })
    expect(run.fired.rename && run.hookErrors.length === 0).toBe(true)
    expect(run.result.status).toBe('parked')
    const sidecar = readJson(run.result.sidecarPath)
    expect(field(sidecar, 'hold')).toBe(undefined)
    expect(field(sidecar, 'postMoveVerified')).toBe(undefined)
    expect(field(sidecar, 'treeHash')).toBe(null)
  })
})

describe('sidecar write rules (ADR-166 D-10 §5)', () => {
  for (const mode of ['held', 'parked'] as const) {
    it(`wx ${mode}: a file already at the sidecar path is never overwritten`, () => {
      const f = fixture()
      let planted: string | null = null
      const run = runWithHooks({
        parentAbs: f.parent,
        name: f.name,
        options: {
          client: CLIENT,
          caller: CALLER,
          kind: KIND,
          guardHash: guardOf(f.origin),
          opId: nextOp(),
        },
        onRecheck: mode === 'held' ? () => append(f) : undefined,
        onAfterRename: ({ destPath }) => {
          planted = `${destPath}.json`
          fs.writeFileSync(planted, 'PRE-EXISTING')
        },
      })
      expect(planted !== null && run.hookErrors.length === 0).toBe(true)
      expect(run.result.status).toBe(mode)
      expect(readText(planted as unknown as string)).toBe('PRE-EXISTING')
      expect(run.result.sidecarError).toBe('EEXIST')
    })
  }

  it('S11: a sidecar write failure is recorded and does not change held', () => {
    // A stub, not chmod 0500 on the op directory, so the case also runs as root.
    const f = fixture()
    const run = withFsStub(
      'writeFileSync',
      (orig) =>
        (...args: unknown[]) => {
          if (String(args[0]).endsWith('.json')) throw errnoError('EACCES')
          return orig(...args)
        },
      () =>
        runWithHooks({
          parentAbs: f.parent,
          name: f.name,
          options: {
            client: CLIENT,
            caller: CALLER,
            kind: KIND,
            guardHash: guardOf(f.origin),
            opId: nextOp(),
          },
          onRecheck: () => append(f),
        })
    )
    expect(run.result.status).toBe('held')
    expect(run.result.sidecarError).toBe('EACCES')
    expect(readText(path.join(String(run.result.path), 'target', 'orig-f1'))).toBe(
      'original-content-f1-late'
    )
  })

  it('C-fd (residual): a write through an fd opened before the park lands in the parked copy after it is verified', () => {
    const f = fixture()
    const guardHash = guardOf(f.origin)
    const fd = fs.openSync(path.join(f.target, 'orig-f1'), 'a')
    let r
    try {
      r = park(f.parent, f.name, { guardHash, opId: nextOp() })
      fs.writeSync(fd, '-written-through-fd')
    } finally {
      fs.closeSync(fd)
    }
    const sidecar = readJson(r.sidecarPath)
    expect(r.status).toBe('parked')
    expect(HEX64.test(String(field(sidecar, 'postMoveTreeHash')))).toBe(true)
    expect(field(sidecar, 'postMoveTreeHash')).toBe(guardHash)
    expect(guardOf(String(r.path))).not.toBe(field(sidecar, 'postMoveTreeHash'))
    expect(readText(path.join(String(r.path), 'target', 'orig-f1'))).toBe(
      'original-content-f1-written-through-fd'
    )
  })
})

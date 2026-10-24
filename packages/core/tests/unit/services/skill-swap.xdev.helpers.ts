/**
 * SMI-6531 (A1 step 4c): fixtures for the cross-device suites.
 *
 * The state root goes on another filesystem: the container's `/dev/shm`
 * (tmpfs) against the skills root under `os.tmpdir()` (overlayfs). Measured
 * 2026-10-22 in the dev container: `/dev/shm` is st_dev 113 and `/tmp` 63, and
 * a `rename` between them fails `EXDEV`, so these tests exercise a real
 * `EXDEV`, not a stub. `xdevFixture` asserts the two devices differ, so a host
 * where they do not fails loudly instead of silently testing one device.
 */
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { afterEach, expect } from 'vitest'
import { treeDeletes } from './skill-swap.abort.helpers.js'
import type { Event, FsEvent } from './skill-swap.abort.helpers.js'
import { areaOf, makeFixture, OP_ID } from './skill-swap.helpers.js'
import type { Fixture } from './skill-swap.helpers.js'

const made: string[] = []

/** Register once per suite file (beside `useTmpCleanup`): removes the other-device temps. */
export function useOtherDeviceCleanup(): void {
  afterEach(() => {
    for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
}

/** A fresh directory on another device than `os.tmpdir()`. */
export function otherDevice(): string {
  const d = fs.realpathSync(fs.mkdtempSync('/dev/shm/step4c-'))
  made.push(d)
  return d
}

/** `makeFixture`, with the state root on another device than the skills root. */
export function xdevFixture(files: Record<string, string>): Fixture {
  const fx = makeFixture(files)
  const stateRoot = otherDevice()
  expect(fs.statSync(stateRoot).dev).not.toBe(fs.statSync(fx.skillsDir).dev)
  return { ...fx, stateRoot }
}

/** `ST/.skillsmith-parked/<opId>`. */
export const parkedArea = (fx: Fixture): string =>
  path.join(fx.staging, '.skillsmith-parked', OP_ID)

/** The parked op dirs (`<opId>-<rnd>`), without their sidecars. */
export function parkedCopies(fx: Fixture): string[] {
  const area = parkedArea(fx)
  if (!fs.existsSync(area)) return []
  return fs
    .readdirSync(area)
    .filter((n) => !n.endsWith('.json'))
    .sort()
    .map((n) => path.join(area, n))
}

/** The names in the backup area, sorted. */
export function areaNames(area: string): string[] {
  return fs.existsSync(area) ? fs.readdirSync(area).sort() : []
}

/** The `partial-copy` trees in the backup area (not their sidecars). */
export function partials(area: string): string[] {
  return areaNames(area)
    .filter((n) => n.includes('.partial-copy') && !n.endsWith('.json'))
    .map((n) => path.join(area, n))
}

/** A sidecar's JSON. */
export function sidecarOf(tree: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(`${tree}.json`, 'utf8')) as Record<string, unknown>
}

/** An `Error` with `code`, as `fs` throws it. */
export function errnoError(code: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: forced`) as NodeJS.ErrnoException
  e.code = code
  return e
}

/**
 * `treeDeletes`, also allowing the one other metadata delete a cross-device
 * publish makes: the backup's own sidecar, unlinked by a rewrite only after
 * its replacement's temp is synced (`rewriteSidecar`).
 */
export function treeDeletesX(fx: Fixture, events: Event[]): FsEvent[] {
  const sidecar = path.join(areaOf(fx), `${OP_ID}.json`)
  return treeDeletes(fx, events).filter((e) => e.path !== sidecar)
}

/**
 * Makes the next directory sync `when()` allows, of a directory `match` accepts,
 * fail with `code`: `syncDirectory` opens the directory through its named
 * `fs/promises` import, so the stub is published to ESM with
 * `syncBuiltinESMExports`. Restore with the returned function.
 */
export function failDirSync(
  match: (dir: string) => boolean,
  when: () => boolean = () => true,
  code = 'EIO'
): { fired: () => number; restore: () => void } {
  const p = fs.promises as unknown as Record<string, (...a: unknown[]) => unknown>
  const orig = p.open!
  let fired = 0
  p.open = (...a: unknown[]) => {
    if (fired === 0 && a[1] === 'r' && match(String(a[0])) && when()) {
      fired++
      return Promise.reject(errnoError(code))
    }
    return orig.apply(fs.promises, a)
  }
  syncBuiltinESMExports()
  return {
    fired: () => fired,
    restore: () => {
      p.open = orig
      syncBuiltinESMExports()
    },
  }
}

type AnyFn = (...a: unknown[]) => unknown

/**
 * Register once per suite file: returns `stub(obj, name, impl)`, which replaces
 * `obj[name]` with `impl(orig)` until the test ends. The restores run in reverse
 * and then republish the builtin ESM exports, so a named `fs/promises` import
 * (`syncDirectory`'s `open`) never keeps a stub that `failDirSync` published
 * while it was stacked on one.
 */
export function useStubs(): (obj: object, name: string, impl: (orig: AnyFn) => AnyFn) => void {
  const restores: Array<() => void> = []
  afterEach(() => {
    for (const r of restores.splice(0).reverse()) r()
    syncBuiltinESMExports()
  })
  return (obj, name, impl) => {
    const t = obj as Record<string, AnyFn>
    const orig = t[name]!
    t[name] = impl(orig.bind(obj) as AnyFn)
    restores.push(() => {
      t[name] = orig
    })
  }
}

/**
 * Whether open-call args `a` create a file under `dir`: a directory sync opens
 * with `'r'` and never counts, so a `failDirSync` stacked on a create counter
 * cannot shift its Nth create.
 */
export function isCreateUnder(a: unknown[], dir: string): boolean {
  return (
    String(a[0]).startsWith(`${dir}/`) &&
    typeof a[1] === 'number' &&
    (a[1] & fs.constants.O_CREAT) !== 0
  )
}

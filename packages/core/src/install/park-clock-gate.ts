/**
 * SMI-6531 (A1 step 3a): UD25's clock gate, a caller-side input to the park
 * (A1 plan §3.3 "Clock gate").
 *
 * Birthtimes are only as fine as the filesystem's clock: on overlayfs a
 * directory deleted and re-made in the same millisecond can come back with the
 * same inode and birthtime (E47). The gate makes two empty probe directories
 * and keeps the second's birthtime only once it is strictly greater than the
 * first's. A tree that existed before the gate is then strictly older than
 * probe 2, and one made after it is not, so the park refuses it with
 * `kept/identity-not-older-than-probe` (`maxBirthtimeNs`). It cannot tell apart
 * a substitute that recycles both inode and birthtime (§3.3).
 *
 * Both caller orders use `gateAndBind`: the gate, then the guard hash, then
 * the identity. A late-bound caller parks right after it; an early-bound one
 * keeps its result and passes it at park time.
 *
 * Each probe is removed right after it is read, by a non-recursive rmdir of
 * the directory this call made. A kill in between, or a stop that cannot or
 * will not remove it, leaves the probe path for doctor (§3.9), and the stop
 * names it as `leftProbe`. That rmdir is why this module is outside the
 * delete-free park graph; the boundary test pins that it is the only removal
 * here and takes one argument.
 *
 * @module @skillsmith/core/install/park-clock-gate
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { assertPathSegment, errCode } from './park-result.js'
import type { ParkIdentity } from './park-result.js'
import { computePathTreeHash } from './park-tree.js'
import { bindIdentity } from './park-tree.identity.js'

/** Probe names are `<prefix><opId>-1` and `-2` (A1 plan §3.8). */
export const PROBE_PREFIX = '.skillsmith-probe-'
/** How long probe 2 may take to get a later birthtime than probe 1 (UD25). */
export const CLOCK_GATE_CAP_MS = 100

/** Why the gate, or the bind after it, stopped. Nothing moved either way. */
export type ClockGateStop = {
  ok: false
  reason: 'identity-unverifiable'
  detail: string
  errno: string | null
  /**
   * A probe path this call made that is still present: its rmdir failed, or
   * the entry there was not a directory when read, so it was left alone.
   * Doctor removes leftover probes (§3.9).
   */
  leftProbe: string | null
}

export type ClockGateResult = { ok: true; maxBirthtimeNs: bigint } | ClockGateStop

const stop = (detail: string, errno: string | null = null, leftProbe: string | null = null) =>
  ({ ok: false, reason: 'identity-unverifiable', detail, errno, leftProbe }) as const

const absolute = (label: string, v: unknown): string => {
  if (typeof v !== 'string' || !path.isAbsolute(v)) {
    const got = typeof v === 'string' ? JSON.stringify(v) : typeof v
    throw new TypeError(`clock gate: ${label} must be an absolute path, got ${got}`)
  }
  return v
}

/** One probe: mkdir, lstat, rmdir, then the checks on what the lstat saw. */
function probe(p: string, parentDev: bigint): { ok: true; birthtimeNs: bigint } | ClockGateStop {
  try {
    fs.mkdirSync(p, { mode: 0o700 })
  } catch (err) {
    return stop(`probe ${p} could not be created`, errCode(err))
  }
  let st: BigIntStats | null = null
  let statErr: string | null = null
  try {
    st = fs.lstatSync(p, { bigint: true })
  } catch (err) {
    statErr = errCode(err)
  }
  // Try the rmdir for a directory, or for an entry the lstat could not read;
  // rmdir itself refuses anything not empty. An entry read as a non-directory
  // (a symlink or a file) is not this call's probe any more and is left.
  if (st === null || st.isDirectory()) {
    try {
      fs.rmdirSync(p)
    } catch (err) {
      return stop(`probe ${p} could not be removed`, errCode(err), p)
    }
  }
  if (st === null) return stop(`probe ${p} could not be read`, statErr)
  if (!st.isDirectory()) return stop(`probe ${p} was replaced before it was read`, null, p)
  if (st.birthtimeNs === 0n) return stop(`probe ${p} has no birthtime (0n)`)
  if (st.dev !== parentDev) return stop(`probe ${p} is on a different device than the parent`)
  return { ok: true, birthtimeNs: st.birthtimeNs }
}

/**
 * Runs UD25's gate in `probeDir`, which must be a Skillsmith-owned directory
 * on `parentAbs`'s device (A1 plan §3.8). Returns probe 2's birthtime to pass
 * as `maxBirthtimeNs`, or stops with `identity-unverifiable`: a probe with a
 * 0n birthtime, a probe on another device than the parent, or probe 2 not
 * later than probe 1 within `CLOCK_GATE_CAP_MS`. Invalid input rejects with a
 * TypeError before any filesystem work.
 */
export async function runClockGate(a: {
  probeDir: string
  parentAbs: string
  opId: string
}): Promise<ClockGateResult> {
  const probeDir = absolute('probeDir', a.probeDir)
  const parentAbs = absolute('parentAbs', a.parentAbs)
  assertPathSegment('opId', a.opId, { reserveLeadingDot: true })
  let parentDev: bigint
  try {
    parentDev = fs.statSync(parentAbs, { bigint: true }).dev
  } catch (err) {
    return stop(`parent ${parentAbs} could not be read`, errCode(err))
  }
  const p1 = probe(path.join(probeDir, `${PROBE_PREFIX}${a.opId}-1`), parentDev)
  if (!p1.ok) return p1
  const deadline = performance.now() + CLOCK_GATE_CAP_MS
  for (;;) {
    const p2 = probe(path.join(probeDir, `${PROBE_PREFIX}${a.opId}-2`), parentDev)
    if (!p2.ok) return p2
    if (p2.birthtimeNs > p1.birthtimeNs) return { ok: true, maxBirthtimeNs: p2.birthtimeNs }
    if (performance.now() >= deadline) {
      return stop(`probe 2's birthtime did not pass probe 1's within ${CLOCK_GATE_CAP_MS} ms`)
    }
    await delay(1)
  }
}

export type GateAndBindResult =
  | { ok: true; maxBirthtimeNs: bigint; guardHash: string; expectIdentity: ParkIdentity }
  | ClockGateStop
  | { ok: false; reason: 'bind-failed'; detail: string; errno: string | null }

/**
 * UD25's order for one park, usable by both caller orders (A1 plan §3.3): the
 * gate, then the guard hash of `<parentAbs>/<name>`, then its identity. Returns
 * the three park options a guarded, gated park takes. A tree whose bound
 * birthtime is 0n stops with `identity-unverifiable` (UD25): the park's
 * comparison with probe 2 would pass it whatever its age.
 */
export async function gateAndBind(a: {
  probeDir: string
  parentAbs: string
  name: string
  opId: string
}): Promise<GateAndBindResult> {
  assertPathSegment('name', a.name)
  const gate = await runClockGate(a)
  if (!gate.ok) return gate
  const target = path.join(a.parentAbs, a.name)
  const hash = computePathTreeHash(target)
  if (!hash.ok) {
    return {
      ok: false,
      reason: 'bind-failed',
      detail: `the tree hash failed (${hash.reason})`,
      errno: hash.errno ?? null,
    }
  }
  const id = bindIdentity(target)
  if (!id.ok) {
    return { ok: false, reason: 'bind-failed', detail: 'the identity bind failed', errno: id.errno }
  }
  if (id.birthtimeNs === 0n) return stop(`${target} has no birthtime (0n)`)
  return {
    ok: true,
    maxBirthtimeNs: gate.maxBirthtimeNs,
    guardHash: hash.treeHash,
    expectIdentity: { dev: id.dev, ino: id.ino, birthtimeNs: id.birthtimeNs, fmt: id.fmt },
  }
}

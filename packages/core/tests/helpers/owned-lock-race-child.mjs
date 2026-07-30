#!/usr/bin/env node
/**
 * Cross-process child harness for owned-lock-reclaim-race.test.ts (SMI-5883
 * §8b). Deliberately OUTSIDE every vitest glob (plain `.mjs`, not `*.test.ts`
 * / `*.spec.ts`) so it is never collected as a test itself -- it exists only
 * to be spawned as a real child process by the parent test.
 *
 * Spawned as:
 *   node --import tsx owned-lock-race-child.mjs <id> <target> <barrierDir> [flags...]
 *
 * `--import tsx` lets this plain `.mjs` file import the real TypeScript
 * source directly (including its own NodeNext `.js`-specifier imports,
 * which tsx remaps to the sibling `.ts` files) -- this harness exercises the
 * ACTUAL acquire loop (`acquireOwnedLockCore`), not a reimplementation --
 * imported from the internal `owned-lock.acquire.ts` (not the public
 * `owned-lock.ts` wrapper) specifically because this harness needs the
 * negative-control seam, which is deliberately unreachable from the public
 * `acquireOwnedLock()` entry point (SMI-5883 code-review round 1 finding 3).
 *
 * Flags (all optional):
 *   --gate-on=<name>              After the barrier releases, poll for
 *                                 barrierDir/<name> before proceeding (used
 *                                 by the delayed contender "B" in the
 *                                 deterministic race -- see §8b pause 2).
 *   --signal-held=<name>          Immediately after acquiring the lock,
 *                                 touch barrierDir/<name> (used by "A").
 *   --wait-release=<name>         Before releasing, poll for
 *                                 barrierDir/<name> (used by "A").
 *   --unsafe-skip-revalidation    Pass `unsafeSkipReclaimRevalidation: true`
 *                                 -- NEGATIVE CONTROL ONLY.
 *   --reclaim-probe-after=<ms>    Override `reclaimProbeAfterMs` (default 0).
 *   --timeout=<ms>                Override `timeoutMs` (default 20000).
 *
 * Barrier protocol (§8b): both children touch `arrived-<id>` inside
 * `onReclaimBoundary` (fired after the pre-filter validates a dead claim,
 * before any reclaim-lock acquisition or removal), then poll for BOTH
 * `arrived-*` markers before either proceeds -- this guarantees neither has
 * touched the reclaim lock before both have independently validated the
 * SAME seeded stale claim.
 */

import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acquireOwnedLockCore } from '../../src/config/owned-lock.acquire.ts'

const args = process.argv.slice(2)
const [id, target, barrierDir] = args
const flags = new Map()
for (const arg of args.slice(3)) {
  const eq = arg.indexOf('=')
  if (arg.startsWith('--') && eq !== -1) {
    flags.set(arg.slice(2, eq), arg.slice(eq + 1))
  } else if (arg.startsWith('--')) {
    flags.set(arg.slice(2), true)
  }
}

const WAIT_CAP_MS = 10_000

function touch(name) {
  writeFileSync(join(barrierDir, name), '')
}

function waitFor(predicate, label) {
  const deadline = Date.now() + WAIT_CAP_MS
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`[owned-lock-race-child ${id}] timed out waiting for ${label}`)
    }
  }
}

function countArrived() {
  return readdirSync(barrierDir).filter((f) => f.startsWith('arrived-')).length
}

let boundaryHits = 0

function onReclaimBoundary() {
  boundaryHits += 1
  if (boundaryHits > 1) return // one-shot per child
  touch(`arrived-${id}`)
  waitFor(() => countArrived() >= 2, 'both children to arrive at the barrier')
  const gateOn = flags.get('gate-on')
  if (gateOn) {
    waitFor(() => existsSync(join(barrierDir, String(gateOn))), `gate marker '${gateOn}'`)
  }
}

function onReclaimOutcome(outcome) {
  touch(`attempted-${id}-${outcome}`)
}

try {
  const release = acquireOwnedLockCore(target, {
    timeoutMs: Number(flags.get('timeout') ?? 20_000),
    reclaimProbeAfterMs: Number(flags.get('reclaim-probe-after') ?? 0),
    onReclaimBoundary,
    onReclaimOutcome,
    ...(flags.has('unsafe-skip-revalidation') ? { unsafeSkipReclaimRevalidation: true } : {}),
  })

  const signalHeld = flags.get('signal-held')
  if (signalHeld) touch(String(signalHeld))

  touch(`entered-${id}`)

  const waitRelease = flags.get('wait-release')
  if (waitRelease) {
    waitFor(
      () => existsSync(join(barrierDir, String(waitRelease))),
      `release marker '${waitRelease}'`
    )
  }

  release()
  process.exit(0)
} catch (err) {
  writeFileSync(join(barrierDir, `error-${id}`), String(err && err.stack ? err.stack : err))
  process.exit(1)
}

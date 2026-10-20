#!/usr/bin/env node
/**
 * Cross-process child for skill-write-lock.cross-process.test.ts (SMI-6531 A1
 * step 2, T-L6/T-L12/T-L14 lock level). Plain `.mjs`, so it sits outside every
 * vitest glob.
 *
 * Spawned as:
 *   node --import tsx skill-write-lock.child.mjs <role> <root> <markerDir> <mode>
 *
 *   role  A: take lock 1 on <root>, open a "mutation window" (a file), and stay
 *            inside until B has made its first attempt; then close the window.
 *         B: while A is inside, try lock 1 on <root> with a short wait (the
 *            first attempt), tell A, and, if that ended busy, try again with a
 *            long wait (the second attempt). Whatever B's fn runs, it records
 *            whether A's window was open when it ran.
 *   root  the spelling this child uses for the skills root.
 *   mode  "lock" (the real lock) or "nolock" (control: fn runs without any
 *         lock, so a harness that can see overlap must see it).
 *
 * The children rendezvous through marker files in <markerDir>, never sleeps.
 * Prints one JSON line to stdout.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withSkillWriteLock } from '../../../src/services/skill-write-lock.ts'

const [role, root, dir, mode] = process.argv.slice(2)

const mark = (name) => writeFileSync(join(dir, name), String(Date.now()))
const has = (name) => existsSync(join(dir, name))

async function waitFor(name) {
  const deadline = Date.now() + 20_000
  while (!has(name)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for marker ${name}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Run `fn`, under lock 1 in "lock" mode and bare in "nolock". */
async function attempt(label, timeoutMs, fn) {
  if (mode === 'nolock') return { ok: true, value: await fn() }
  return withSkillWriteLock(root, label, fn, { timeoutMs })
}

const describeAttempt = (r) =>
  r.ok ? { ran: true, value: r.value } : { ran: false, busy: r.stop.code, reason: r.stop.reason }

const out = { role, mode }

if (role === 'A') {
  const r = await attempt('A', 20_000, async () => {
    mark('a-in')
    writeFileSync(join(dir, 'window'), 'A') // A's mutation window opens
    await waitFor('b-first-done')
    rmSync(join(dir, 'window')) // ...and closes
    mark('a-done')
    return 'a'
  })
  out.result = describeAttempt(r)
  mark('a-released')
} else {
  await waitFor('a-in')
  const observe = async () => ({ windowOpen: has('window'), aDone: has('a-done') })
  const first = await attempt('B1', 400, observe)
  out.first = describeAttempt(first)
  mark('b-first-done')
  if (!first.ok) {
    const second = await attempt('B2', 20_000, observe)
    out.second = describeAttempt(second)
  }
}

process.stdout.write(JSON.stringify(out) + '\n')
process.exit(0)

// SMI-7123 Wave 5: shared helpers for the test-w5-*.mjs suites.
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import path from 'node:path'

/** A check() that logs PASS/FAIL per case, a notRun() for skipped blocks, and a done() that exits non-zero on any FAIL. */
export function makeCheck(tag) {
  let allOk = true
  let n = 0
  let skipped = 0
  const show = (v) => {
    const s = JSON.stringify(v) ?? String(v)
    return s.length <= 160
      ? s
      : `<${s.length} chars sha256:${crypto.createHash('sha256').update(s).digest('hex').slice(0, 12)}>`
  }
  const check = (label, actual, expected) => {
    n += 1
    const ok = Object.is(actual, expected)
    allOk = allOk && ok
    console.log(
      `${tag} ${label}: expected ${show(expected)}, got ${show(actual)} -- ${ok ? 'PASS' : 'FAIL'}`
    )
    return ok
  }
  // A block that could not run (false premise). Not a pass and not a failure, but counted so
  // done() cannot report full coverage for a run that skipped blocks (SMI-7132 F6).
  const notRun = (label, why) => {
    skipped += 1
    console.log(`${tag} ${label}: NOT RUN (${why})`)
  }
  const done = () => {
    if (n === 0) {
      console.log(`${tag} NO CASES RAN -- a suite that checks nothing must not read as a pass`)
      process.exit(1)
    }
    if (!allOk) {
      console.log(`${tag} SOME CASES FAILED`)
      process.exit(1)
    }
    console.log(`${tag} all ${n} cases passed${skipped > 0 ? `, ${skipped} blocks NOT RUN` : ''}`)
    process.exit(0)
  }
  return { check, done, notRun }
}

/**
 * The root every W5 fixture is created under: SMI6676_HARNESS_ROOT, else
 * os.tmpdir(). CANONICAL: realpath'd once here, at creation, so every path a
 * fixture hands to prune (and so every path in a walker trace) is spelled the
 * resolved way. A symlinked root (macOS /var -> /private/var) otherwise leaves
 * the trace and the matcher spelling the same directory two ways.
 */
export function w5Root() {
  const r = process.env.SMI6676_HARNESS_ROOT ?? os.tmpdir()
  fs.mkdirSync(r, { recursive: true })
  return fs.realpathSync(r)
}

/**
 * A base directory reached THROUGH A SYMLINK, for the symlinked-root regression
 * cases (macOS's /var -> /private/var is the real-world instance). Lives inside
 * w5Root(); returns {base (the link spelling), cleanup}.
 */
export function linkedBase() {
  const real = fs.mkdtempSync(path.join(w5Root(), 'w5-realroot-'))
  const link = `${real.replace(/w5-realroot-/, 'w5-linkroot-')}`
  fs.symlinkSync(real, link)
  return {
    base: link,
    cleanup() {
      fs.unlinkSync(link)
      rmFixture(real)
    },
  }
}

/** Best-effort recursive removal that restores permissions first. Never follows symlinks. */
export function rmFixture(root) {
  const fix = (p) => {
    let st
    try {
      st = fs.lstatSync(p)
    } catch {
      return
    }
    if (st.isSymbolicLink()) return
    try {
      fs.chmodSync(p, st.isDirectory() ? 0o700 : 0o600)
    } catch {
      /* best effort */
    }
    if (st.isDirectory()) {
      let names = []
      try {
        names = fs.readdirSync(p)
      } catch {
        /* best effort */
      }
      for (const n of names) fix(path.join(p, n))
    }
  }
  fix(root)
  fs.rmSync(root, { recursive: true, force: true })
}

/** `--against <name>` from argv, or null. Any other argument is an error. */
export function againstArg(argv = process.argv.slice(2)) {
  if (argv.length === 0) return null
  if (argv.length === 2 && argv[0] === '--against' && argv[1]) return argv[1]
  console.error(`usage: [--against <stub>]; got ${JSON.stringify(argv)}`)
  process.exit(2)
}

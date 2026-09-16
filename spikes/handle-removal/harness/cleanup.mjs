// SMI-6676 harness cleanup verification (plan §9).
//
// Attacks that create real mounts, disk images or Docker volumes must leave
// nothing behind. These helpers capture each check's exit status directly
// (never through a truncating pipe) and return a structured result rather
// than throwing, so a caller can assert on it explicitly.

// CLI: `node harness/cleanup.mjs [--tag <tag>] [--volume <name>]`. Until this
// existed the module was import-only, so the README's own instruction to run
// it produced a silent exit 0 that checked nothing -- a clean-looking result
// from an instrument that never ran, which is precisely the failure class this
// spike exists to detect. The CLI prints each check's COUNT beside its verdict
// and exits non-zero when anything is left behind, so "clean" and "did not
// look" can no longer read the same.

import { execFileSync, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * Runs a shell pipeline via execSync but returns {stdout, status} instead of
 * throwing, and never lets a `| head`/`| tail` in the caller hide the
 * producer's own exit status: we run the whole pipeline and read
 * PIPESTATUS-equivalent behavior by construction -- callers here use `grep
 * -c`, whose own exit status (0 = matches found, 1 = none) is what we
 * actually want, with no downstream truncation.
 */
function runCounted(cmd) {
  try {
    const stdout = execSync(cmd, { encoding: 'utf8' })
    return { stdout: stdout.trim(), status: 0 }
  } catch (err) {
    // `grep -c` exits 1 with "0" on stdout when there are no matches -- that
    // is the expected clean state, not a harness error.
    return { stdout: (err.stdout ?? '').toString().trim(), status: err.status ?? 1 }
  }
}

/**
 * Asserts no mount whose target/source contains `tag` (the run's s6676-<id>
 * marker) remains mounted.
 *
 * @param {string} tag - e.g. "s6676" for a sweep, or "s6676-<runId>" for one run
 * @returns {{clean: boolean, count: number, raw: string}}
 */
export function assertNoLeftoverMounts(tag) {
  const { stdout } = runCounted(`mount | grep -c ${JSON.stringify(tag)} || true`)
  const count = Number.parseInt(stdout, 10) || 0
  return { clean: count === 0, count, raw: stdout }
}

/**
 * macOS only: asserts no attached disk image name contains `tag`.
 * No-op (clean: true) on non-darwin platforms.
 */
export function assertNoLeftoverDiskImages(tag) {
  if (process.platform !== 'darwin') {
    return { clean: true, count: 0, raw: '(not darwin)' }
  }
  let info = ''
  try {
    info = execFileSync('hdiutil', ['info'], { encoding: 'utf8' })
  } catch (err) {
    return { clean: false, count: -1, raw: `hdiutil info failed: ${err.message}` }
  }
  const matches = info.split('\n').filter((line) => line.includes(tag))
  return { clean: matches.length === 0, count: matches.length, raw: matches.join('\n') }
}

/**
 * Removes a Docker volume by name, tolerating "no such volume" (already
 * gone). Returns the captured exit status -- never truncated.
 */
export function removeDockerVolume(name) {
  try {
    execFileSync('docker', ['volume', 'rm', name], { encoding: 'utf8', stdio: 'pipe' })
    return { removed: true, alreadyAbsent: false }
  } catch (err) {
    const stderr = (err.stderr ?? '').toString()
    if (/no such volume/i.test(stderr)) {
      return { removed: false, alreadyAbsent: true }
    }
    return { removed: false, alreadyAbsent: false, error: stderr || err.message }
  }
}

/**
 * Full end-of-run cleanup assertion, per §9's four bullets (mount attacks
 * only apply the first two; every run should apply the third and the
 * caller's own assertScratchEmpty from fixture-root.mjs for the fourth).
 */
export function assertCleanupComplete(tag, dockerVolumeName) {
  const mounts = assertNoLeftoverMounts(tag)
  const images = assertNoLeftoverDiskImages(tag)
  const volume = dockerVolumeName ? removeDockerVolume(dockerVolumeName) : null
  const clean = mounts.clean && images.clean && (!volume || volume.error === undefined)
  return { clean, mounts, images, volume }
}

/**
 * Runs the full assertion and reports it, one line per check, each carrying the
 * count it actually observed -- so a reader can tell a real zero from a check
 * that never looked. Exits 1 when anything is left behind.
 */
function main(argv) {
  let tag = 's6676'
  let volume = null
  // Every rejection below exists because the alternative is this script's own
  // failure mode: `--tag` with no value would leave `tag` undefined and grep for
  // the literal string "undefined", and a misspelled `--tags` would be skipped
  // and the default tag checked instead. Both report CLEAN while checking
  // something nobody asked about, which is the exact defect this file exists to
  // catch. Refuse the input rather than survey the wrong thing.
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--tag' || arg === '--volume') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        console.error(`[cleanup] ${arg} needs a value`)
        return 2
      }
      if (arg === '--tag') tag = value
      else volume = value
      i += 1
    } else {
      console.error(`[cleanup] unknown argument ${JSON.stringify(arg)}`)
      console.error('[cleanup] usage: node harness/cleanup.mjs [--tag <tag>] [--volume <name>]')
      return 2
    }
  }

  const r = assertCleanupComplete(tag, volume)
  console.log(`[cleanup] tag=${JSON.stringify(tag)} platform=${process.platform}`)
  console.log(
    `  mounts      : ${r.mounts.clean ? 'clean' : 'LEFTOVER'} (matched ${r.mounts.count})`
  )
  // count === -1 is assertNoLeftoverDiskImages' signal that `hdiutil info`
  // itself failed. That is "could not look", not "found leftovers" -- reporting
  // it as LEFTOVER would be wrong in the other direction, and reporting it as
  // clean would be the failure this file exists to prevent.
  if (r.images.count === -1) {
    console.log(`  disk images : COULD NOT CHECK -- ${r.images.raw}`)
  } else {
    console.log(
      `  disk images : ${r.images.clean ? 'clean' : 'LEFTOVER'} (matched ${r.images.count})` +
        (process.platform === 'darwin' ? '' : ' [skipped: not darwin]')
    )
  }
  if (r.volume === null) {
    console.log('  docker vol  : not checked (no --volume given)')
  } else if (r.volume.alreadyAbsent) {
    console.log(`  docker vol  : clean (${volume} already absent)`)
  } else if (r.volume.removed) {
    console.log(`  docker vol  : removed ${volume}`)
  } else {
    console.log(`  docker vol  : ERROR removing ${volume}: ${r.volume.error}`)
  }
  console.log(`[cleanup] ${r.clean ? 'CLEAN' : 'NOT CLEAN'}`)
  return r.clean ? 0 : 1
}

// Only when invoked directly -- importing this module must stay side-effect free.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}

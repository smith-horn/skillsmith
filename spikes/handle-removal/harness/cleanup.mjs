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

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'

/**
 * Asserts no mount whose target/source contains `tag` (the run's s6676-<id>
 * marker) remains mounted. `mount` is run on its own, with its exit status
 * checked, and filtered here -- never `mount | grep -c ... || true`, where a
 * failing `mount` produced an empty count and read as clean.
 *
 * count === -1 means `mount` itself failed: "could not look", never clean.
 *
 * @param {string} tag - e.g. "s6676" for a sweep, or "s6676-<runId>" for one run
 * @returns {{clean: boolean, count: number, raw: string}}
 */
export function assertNoLeftoverMounts(tag) {
  let out = ''
  try {
    out = execFileSync('mount', [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    return { clean: false, count: -1, raw: `mount failed: ${err.message}` }
  }
  const matches = out.split('\n').filter((line) => line.includes(tag))
  return { clean: matches.length === 0, count: matches.length, raw: matches.join('\n') }
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
  // count === -1 is the signal that `mount` (here) or `hdiutil info` (below)
  // itself failed. That is "could not look", not "found leftovers" -- reporting
  // it as LEFTOVER would be wrong in the other direction, and reporting it as
  // clean would be the failure this file exists to prevent.
  if (r.mounts.count === -1) {
    console.log(`  mounts      : COULD NOT CHECK -- ${r.mounts.raw}`)
  } else {
    console.log(
      `  mounts      : ${r.mounts.clean ? 'clean' : 'LEFTOVER'} (matched ${r.mounts.count})`
    )
  }
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
// realpathSync, not path.resolve: resolve() leaves symlinks in place, so a run
// through a symlinked path (a symlinked checkout, or /tmp on macOS) skipped
// main() and exited 0 having checked nothing (SMI-6715 governance, measured).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}

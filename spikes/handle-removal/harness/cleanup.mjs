// SMI-6676 harness cleanup verification (plan §9).
//
// Attacks that create real mounts, disk images or Docker volumes must leave
// nothing behind. These helpers capture each check's exit status directly
// (never through a truncating pipe) and return a structured result rather
// than throwing, so a caller can assert on it explicitly.

import { execFileSync, execSync } from 'node:child_process'

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

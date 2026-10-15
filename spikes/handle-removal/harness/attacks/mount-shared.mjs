// Shared Linux mount helpers for A1/A2. Real `mount`/`umount`, so these
// attacks only run inside a throwaway --privileged container -- never
// against a repo dev container, never outside one on the host.

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export function bindMount(sourceDir, targetDir) {
  execFileSync('mount', ['--bind', sourceDir, targetDir], { stdio: 'pipe' })
}

export function tmpfsMount(targetDir, sizeMb = 4) {
  execFileSync('mount', ['-t', 'tmpfs', '-o', `size=${sizeMb}m`, 'none', targetDir], {
    stdio: 'pipe',
  })
}

export function umountQuiet(targetDir) {
  try {
    execFileSync('umount', [targetDir], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

export function isMounted(targetDir) {
  try {
    const mounts = readFileSync('/proc/mounts', 'utf8')
    return mounts.split('\n').some((line) => line.split(' ')[1] === targetDir)
  } catch {
    return false
  }
}

/**
 * Fixture: tree/target/ is the mount point. Writes a marker file into
 * `target` BEFORE mounting (the underlying, soon-to-be-hidden content) and
 * returns everything needed to mount something over it and verify survival.
 */
export function buildMountFixture(root) {
  const treeRoot = path.join(root, 'tree')
  mkdirSync(path.join(treeRoot, 'target'), { recursive: true })
  writeFileSync(path.join(treeRoot, 'target', 'underlying.txt'), 'underlying-content')
  mkdirSync(path.join(treeRoot, 'zzz-sibling'), { recursive: true })
  writeFileSync(path.join(treeRoot, 'zzz-sibling', 'f1'), 'sibling-content')
  const targetAbs = path.join(treeRoot, 'target')
  const mountSourceDir = path.join(root, 'mount-source')
  mkdirSync(mountSourceDir, { recursive: true })
  return { treeRoot, targetAbs, mountSourceDir }
}

/** Verifies the mounted user file is still there, read through the mount. */
export function verifyMountedFileIntact(targetAbs, fileName, expectedContent) {
  const p = path.join(targetAbs, fileName)
  if (!existsSync(p)) return { checked: 1, lost: 1, changed: 0 }
  const actual = readFileSync(p, 'utf8')
  return { checked: 1, lost: 0, changed: actual === expectedContent ? 0 : 1 }
}

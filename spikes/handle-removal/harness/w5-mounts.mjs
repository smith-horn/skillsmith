// SMI-7123 Wave 5: real mounts for the prune suites and rows.
//   darwin: hdiutil volumes (no root needed; no bind mount exists on darwin).
//   linux:  tmpfs and same-filesystem bind mounts (root, throwaway --privileged container only).
// Every attach is recorded on the fixture handle so cleanup can prove it detached
// both the mount and (darwin) the disk-image device.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const PLATFORM = process.platform
export const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' }).toString()
const unescape = (p) =>
  p.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(Number.parseInt(o, 8)))

/** Whether this process can make real mounts here. */
export function canMount() {
  if (PLATFORM === 'darwin') return true
  if (PLATFORM === 'linux') return process.getuid() === 0
  return false
}

/** The mount kinds this platform runs. */
export const MOUNT_KINDS = PLATFORM === 'darwin' ? ['hdiutil'] : ['tmpfs', 'bind']

/** Every current mount point, as the kernel reports it. */
export function mountPoints() {
  if (PLATFORM === 'linux') {
    return fs
      .readFileSync('/proc/self/mountinfo', 'utf8')
      .split('\n')
      .map((l) => l.split(' ')[4])
      .filter(Boolean)
      .map(unescape)
  }
  return run('mount', [])
    .split('\n')
    .map((l) => {
      const a = l.indexOf(' on ')
      const b = l.lastIndexOf(' (')
      return a !== -1 && b > a ? l.slice(a + 4, b) : null
    })
    .filter(Boolean)
}

export const mountsUnder = (realRoot) =>
  mountPoints()
    .filter((m) => m === realRoot || m.startsWith(`${realRoot}/`))
    .sort((a, b) => b.length - a.length)

/**
 * Creates (darwin) a 4 MB HFS+ image under `dir`, optionally pre-populated with
 * `files` ({name: content}), and returns its path. The image is detached again
 * before returning.
 */
export function makeImage(dir, files = {}, tracker = null) {
  const img = path.join(dir, `vol-${process.pid}-${Math.random().toString(16).slice(2, 8)}.dmg`)
  run('hdiutil', ['create', '-size', '4m', '-fs', 'HFS+', '-volname', 'w5', '-quiet', img])
  if (Object.keys(files).length > 0) {
    const mp = fs.mkdtempSync(path.join(dir, 'imgmp-'))
    const dev = attachImage(img, mp, tracker)
    try {
      for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(mp, n), c)
    } finally {
      detachDevice(dev, mp)
      fs.rmdirSync(mp)
    }
  }
  return img
}

/** Attaches `img` at `mp`; returns the /dev/diskN device (recorded on `tracker.devices`). */
export function attachImage(img, mp, tracker = null) {
  const out = run('hdiutil', ['attach', '-nobrowse', '-quiet', '-mountpoint', mp, img])
  void out
  const info = run('hdiutil', ['info'])
  // Find the device whose mount point is mp (hdiutil -quiet prints nothing).
  let dev = null
  for (const line of info.split('\n')) {
    const m = /^(\/dev\/disk\d+(?:s\d+)?)\s+\S+\s+(.+)$/.exec(line.trim())
    if (m && m[2].trim() === fs.realpathSync(mp)) dev = m[1].replace(/s\d+$/, '')
  }
  if (tracker && dev) (tracker.devices ??= []).push(dev)
  return dev
}

export function detachDevice(dev, mp) {
  for (const args of [
    ['hdiutil', ['detach', '-quiet', dev ?? mp]],
    ['hdiutil', ['detach', '-force', '-quiet', dev ?? mp]],
    ['umount', ['-f', mp]],
  ]) {
    try {
      run(args[0], args[1])
      return
    } catch {
      /* try the next form */
    }
  }
}

/**
 * Mounts something at `mp` holding `files`. kind: 'hdiutil' | 'tmpfs' | 'bind'.
 * Returns {kind, mp, source} where `source` is the bind source (an outside
 * directory) or the volume itself.
 */
export function mountAt(kind, mp, f, files = { 'mounted-user.txt': 'mounted-user-bytes' }) {
  if (kind === 'hdiutil') {
    const img = makeImage(f.root, files, f)
    attachImage(img, mp, f)
    return { kind, mp, source: mp }
  }
  if (kind === 'tmpfs') {
    run('mount', ['-t', 'tmpfs', '-o', 'size=4m', 'none', mp])
    for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(mp, n), c)
    return { kind, mp, source: mp }
  }
  const src = fs.mkdtempSync(path.join(f.root, 'bind-src-'))
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(src, n), c)
  run('mount', ['--bind', src, mp])
  return { kind, mp, source: src }
}

/** Detaches everything under realRoot (deepest first); returns what is still attached. */
export function detachUnder(realRoot, f = null) {
  for (const mp of mountsUnder(realRoot)) {
    const forms =
      PLATFORM === 'linux'
        ? [
            ['umount', [mp]],
            ['umount', ['-l', mp]],
          ]
        : [
            ['hdiutil', ['detach', '-force', '-quiet', mp]],
            ['umount', ['-f', mp]],
          ]
    for (const [c, a] of forms) {
      try {
        run(c, a)
        break
      } catch {
        /* next form */
      }
    }
  }
  if (f && PLATFORM === 'darwin') {
    for (const dev of f.devices ?? []) {
      try {
        run('hdiutil', ['detach', '-force', '-quiet', dev])
      } catch {
        /* already gone */
      }
    }
  }
  return mountsUnder(realRoot)
}

/** True when hdiutil no longer lists any image under `root` (darwin); always true elsewhere. */
export function noImageAttachedUnder(root) {
  if (PLATFORM !== 'darwin') return true
  return !run('hdiutil', ['info']).includes(fs.realpathSync(root))
}

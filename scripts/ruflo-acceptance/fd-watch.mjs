#!/usr/bin/env node
// External observer for § 6's "verify the opened database inode in every run".
//
// strace is absent from the node:22-slim base image, so the instrument is
// /proc/<pid>/fd: a process OTHER than the one under test walks every running
// PID's descriptors and records any that resolve to the target path, with the
// device and inode of the object as this kernel reports them. Attribution is by
// /proc/<pid>/cmdline.
//
// This instrument is only trustworthy if it has been shown to return different
// answers for the two states it exists to distinguish, so the driver runs it
// against a known-positive (the served pass, which must be observed) and a
// known-negative (a process that never opens the file, which must not be).
//
// Usage: node fd-watch.mjs --target <path> --out <json> --stop-file <f> [--interval-ms N]

import fs from 'node:fs'

const opt = { target: null, out: null, stopFile: null, intervalMs: 2, maxMs: 120000, pidFile: null }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--target') opt.target = argv[(i += 1)]
  else if (argv[i] === '--out') opt.out = argv[(i += 1)]
  else if (argv[i] === '--stop-file') opt.stopFile = argv[(i += 1)]
  else if (argv[i] === '--interval-ms') opt.intervalMs = Number(argv[(i += 1)])
  else if (argv[i] === '--max-ms') opt.maxMs = Number(argv[(i += 1)])
  // With --pid-file the observer watches ONE pid instead of sweeping every
  // process. A full sweep of this host's ~11k pids costs more than the run
  // under observation lasts, so the sweep can complete zero times inside the
  // window and report a clean absence it never looked for -- which is a
  // manufactured negative, not a measurement. The pid is the HOST-namespace
  // pid: the observed container runs with --pid host so the number means the
  // same thing on both sides.
  else if (argv[i] === '--pid-file') opt.pidFile = argv[(i += 1)]
  else throw new Error(`unknown argument: ${argv[i]}`)
}

let targetInode = null
try {
  const s = fs.statSync(opt.target)
  targetInode = { dev: String(s.dev), ino: String(s.ino) }
} catch {
  targetInode = null
}

const observations = []
const seen = new Set()
const selfPid = String(process.pid)
const t0 = Date.now()

let sweepCount = 0
let pidsSeen = 0

function sweep() {
  let pids
  if (opt.pidFile) {
    try {
      const raw = fs.readFileSync(opt.pidFile, 'utf8').trim()
      pids = /^\d+$/.test(raw) ? [raw] : []
    } catch {
      pids = []
    }
  } else {
    try {
      pids = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))
    } catch {
      return
    }
  }
  sweepCount += 1
  pidsSeen = pids.length
  for (const pid of pids) {
    if (pid === selfPid) continue
    let fds
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      let link
      try {
        link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`)
      } catch {
        continue
      }
      if (link !== opt.target && link !== `${opt.target}-wal` && link !== `${opt.target}-shm`)
        continue
      let dev = null
      let ino = null
      try {
        const st = fs.statSync(`/proc/${pid}/fd/${fd}`)
        dev = String(st.dev)
        ino = String(st.ino)
      } catch {
        /* the descriptor closed between readlink and stat */
      }
      const k = `${pid}:${link}:${ino}`
      if (seen.has(k)) continue
      seen.add(k)
      let cmdline = ''
      try {
        cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
      } catch {
        /* exited */
      }
      observations.push({
        atMs: Date.now() - t0,
        pid,
        fd,
        path: link,
        dev,
        ino,
        cmdline: cmdline.slice(0, 200),
      })
    }
  }
}

const iv = setInterval(() => {
  sweep()
  const stop = opt.stopFile && fs.existsSync(opt.stopFile)
  if (stop || Date.now() - t0 > opt.maxMs) {
    sweep()
    clearInterval(iv)
    const matched = observations.filter(
      (o) =>
        targetInode &&
        o.path === opt.target &&
        o.ino === targetInode.ino &&
        o.dev === targetInode.dev
    )
    fs.writeFileSync(
      opt.out,
      `${JSON.stringify(
        {
          target: opt.target,
          targetInode,
          mode: opt.pidFile ? `single-pid (${opt.pidFile})` : 'full /proc sweep',
          sweeps: sweepCount,
          pidsPerSweep: pidsSeen,
          observations,
          matchedTargetInode: matched.length,
          stoppedBy: stop ? 'stop-file' : 'max-ms',
        },
        null,
        2
      )}\n`
    )
    process.stdout.write(
      `fd-watch sweeps=${sweepCount} observations=${observations.length} matchedTargetInode=${matched.length}\n`
    )
    process.exit(0)
  }
}, opt.intervalMs)

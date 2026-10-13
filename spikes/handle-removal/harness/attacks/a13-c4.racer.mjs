// A13-C4's own concurrent racer (SMI-6715, review R1-F1). Same rendezvous and
// randomisation as _shared.mjs's spawnConcurrentRacer, which stays
// byte-identical because A13 and A13-VR depend on it. This racer differs in
// what it REPORTS, because the shared one reports `applied:null` whenever any
// later syscall fails, which hides a destructive first step that DID land:
//
//   - every mutation is a sequence of single, atomic syscalls (unlink, rmdir,
//     rename, mkdir, writeFile, symlink), so each step either happened or did
//     not. A recursive rmSync is NOT used: it is several syscalls under one
//     call, and a failure part-way through leaves an effect the caller cannot
//     see. `rm -r target` is spelled out as unlink-each-entry + rmdir, which
//     is what rm does underneath. A subdirectory inside the target is refused
//     (the step fails before touching anything) rather than half-handled.
//   - unlink/rmdir/rename never use `force`, so a step against a path that is
//     already gone FAILS (ENOENT) instead of reporting a no-op as completed.
//   - each completed step is reported with its paths, any pre-state content it
//     moved (a rename reports the files it carried, read before the rename),
//     and its own start/end on the system monotonic clock (hrtime ms, the
//     clock _shared.mjs explains); the first failing step is reported too, and
//     the racer stops there.
//
// Mutation shapes (same four as _shared.mjs):
//   a5  unlink target/* ; rmdir target ; mkdir target ; write target/orig-f1
//   a3  rename target -> target.aside-<rnd> ; mkdir target ; write target/orig-f1
//   a7  unlink target/orig-f1 ; write target/orig-f1
//   a8  unlink target/* ; rmdir target ; symlink target -> /tmp

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export const RACER_MUTATIONS = Object.freeze(['a3', 'a5', 'a7', 'a8'])

const CHILD = `
const fs = require('node:fs');
const path = require('node:path');
const now = () => Number(process.hrtime.bigint()) / 1e6;
const [target, delayArg, mutation, readyMarker, goMarker] = process.argv.slice(1);
const delayMs = Number(delayArg);
const steps = [];
let failedStep = null;
function step(rec, fn) {
  if (failedStep) return false;
  const startAt = now();
  try {
    fn();
  } catch (err) {
    failedStep = Object.assign(rec, { startAt, endAt: now(), error: err.code || String(err) });
    return false;
  }
  steps.push(Object.assign(rec, { startAt, endAt: now() }));
  return true;
}
function unlinkAll(dir) {
  let names;
  const startAt = now();
  try {
    names = fs.readdirSync(dir).sort();
  } catch (err) {
    failedStep = { op: 'readdir', path: dir, startAt, endAt: now(), error: err.code || String(err) };
    return;
  }
  for (const n of names) {
    const p = path.join(dir, n);
    let st;
    try { st = fs.lstatSync(p); } catch (err) { failedStep = { op: 'lstat', path: p, startAt: now(), endAt: now(), error: err.code || String(err) }; return; }
    if (st.isDirectory()) { failedStep = { op: 'unlink', path: p, startAt: now(), endAt: now(), error: 'unsupported-subdir' }; return; }
    if (!step({ op: 'unlink', path: p }, () => fs.unlinkSync(p))) return;
  }
}
const content = 'racer-' + mutation + '-' + Date.now() + '-' + Math.random();
const file = path.join(target, 'orig-f1');
const markerWrittenAt = now();
fs.writeFileSync(readyMarker, '1');
let goSeenAt = null;
if (goMarker) {
  // GO-MARKER MODE (A13-C4-POSTHASH): wait, without mutating, until the parent
  // releases the racer at C4's hash end; then a sub-millisecond hrtime delay.
  while (!fs.existsSync(goMarker)) { /* tight poll -- deliberately not a timer */ }
  goSeenAt = now();
  while (now() - goSeenAt < delayMs) { /* busy-wait on hrtime */ }
} else {
  const t0 = Date.now();
  while (Date.now() - t0 < delayMs) { /* busy-wait: real jitter, no timer overhead */ }
}
if (mutation === 'a5' || mutation === 'a8') {
  unlinkAll(target);
  step({ op: 'rmdir', path: target }, () => fs.rmdirSync(target));
  if (mutation === 'a5') {
    step({ op: 'mkdir', path: target }, () => fs.mkdirSync(target));
    step({ op: 'write', path: file, content }, () => fs.writeFileSync(file, content));
  } else {
    step({ op: 'symlink', path: target, linkText: '/tmp' }, () => fs.symlinkSync('/tmp', target));
  }
} else if (mutation === 'a3') {
  const aside = target + '.aside-' + Math.random().toString(16).slice(2);
  // Pre-state the rename will carry, read BEFORE it so the read is not inside
  // the step's own interval. A read failure is reported as the failed step.
  let moved = null;
  const readAt = now();
  try {
    moved = {};
    for (const n of fs.readdirSync(target).sort()) moved[n] = fs.readFileSync(path.join(target, n), 'utf8');
  } catch (err) {
    failedStep = { op: 'read-prestate', path: target, startAt: readAt, endAt: now(), error: err.code || String(err) };
  }
  step({ op: 'rename', path: target, dest: aside, moved }, () => fs.renameSync(target, aside));
  step({ op: 'mkdir', path: target }, () => fs.mkdirSync(target));
  step({ op: 'write', path: file, content }, () => fs.writeFileSync(file, content));
} else if (mutation === 'a7') {
  step({ op: 'unlink', path: file }, () => fs.unlinkSync(file));
  step({ op: 'write', path: file, content }, () => fs.writeFileSync(file, content));
}
process.stdout.write(JSON.stringify({
  mutation, delayMs, markerWrittenAt, goSeenAt, steps, failedStep,
  complete: failedStep === null && steps.length > 0,
}));
`

/**
 * `opts.goMarkerPath` (A13-C4-POSTHASH): the child waits, mutating nothing,
 * until that file exists, then busy-waits `opts.delayMs` (a float, hrtime) and
 * mutates; it reports `goSeenAt`. Without it the behaviour is unchanged: a
 * random 0-2 ms integer delay right after the ready marker.
 * @returns {{wait: (timeoutMs?:number) => number, result: Promise<object>, mutation: string}}
 *   result: {mutation, delayMs, markerWrittenAt, steps[], failedStep|null,
 *   complete} or {error:'child-output-unparseable'|<spawn error>, steps:null}.
 *   `steps: null` means "unknown", never "none".
 */
export function spawnStepRacer(targetAbs, readyMarkerPath, mutation, opts = {}) {
  const m = mutation ?? RACER_MUTATIONS[Math.floor(Math.random() * RACER_MUTATIONS.length)]
  if (!RACER_MUTATIONS.includes(m)) throw new TypeError(`spawnStepRacer: unknown mutation ${m}`)
  const go = opts.goMarkerPath
  if (go !== undefined && (typeof go !== 'string' || go.length === 0)) {
    throw new TypeError('spawnStepRacer: goMarkerPath must be a non-empty string')
  }
  if (go !== undefined && !(Number.isFinite(opts.delayMs) && opts.delayMs >= 0)) {
    throw new TypeError('spawnStepRacer: go-marker mode needs a finite delayMs >= 0')
  }
  const delayMs = go === undefined ? Math.floor(Math.random() * 3) : opts.delayMs
  const child = spawn(
    process.execPath,
    ['-e', CHILD, '--', targetAbs, String(delayMs), m, readyMarkerPath, ...(go ? [go] : [])],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  )
  let out = ''
  const result = new Promise((resolve) => {
    child.stdout.on('data', (d) => {
      out += d
    })
    child.on('close', () => {
      try {
        resolve(JSON.parse(out))
      } catch {
        resolve({ mutation: m, error: 'child-output-unparseable', steps: null, failedStep: null })
      }
    })
    child.on('error', (err) =>
      resolve({ mutation: m, error: err.message, steps: null, failedStep: null })
    )
  })
  return {
    mutation: m,
    /** Blocks (tight poll) until the child is alive; returns the observed instant (hrtime ms). */
    wait(timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      while (!existsSync(readyMarkerPath) && Date.now() < deadline) {
        /* tight poll -- deliberately not a timer */
      }
      return Number(process.hrtime.bigint()) / 1e6
    },
    result,
  }
}

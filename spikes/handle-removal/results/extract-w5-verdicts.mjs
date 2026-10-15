#!/usr/bin/env node
// SMI-7123 Wave 5 (Sol PR #3091 finding PR-12): extracts the runner's printed
// verdict lines from the owner-approved W5 run logs into the immutable fixture
// results/w5-runner-verdicts.tsv, which harness/test-w5-summary.mjs compares the
// generated SUMMARY against. Run once per new owner-approved W5 run:
//
//   node results/extract-w5-verdicts.mjs apfs=<log> overlayfs=<log> tmpfs=<log> \
//     ext4=<log> virtiofs=<log> > results/w5-runner-verdicts.tsv
//
// Each <log> is run-w5-rows.mjs's stdout for that filesystem. Refuses (exit 2) if
// a log is missing, a filesystem is repeated, or a (row, fs) pair appears twice.
import fs from 'node:fs'

const LINE =
  /^(.+)\t(W5-\S+)\tran=(\d+) passed=(\d+)(?: held=\d+)? failed=(\d+) never-ran=(\d+)\tcontrol=(.*)$/
const FS_ORDER = ['apfs', 'overlayfs', 'tmpfs', 'ext4', 'virtiofs']

const refuse = (msg) => {
  process.stderr.write(`extract-w5-verdicts: ${msg}\n`)
  process.exit(2)
}

const logs = new Map()
for (const arg of process.argv.slice(2)) {
  const at = arg.indexOf('=')
  const label = arg.slice(0, at)
  if (at < 1 || !FS_ORDER.includes(label)) refuse(`expected <fs>=<log>, fs one of ${FS_ORDER}`)
  if (logs.has(label)) refuse(`${label} given twice`)
  logs.set(label, arg.slice(at + 1))
}
for (const label of FS_ORDER) if (!logs.has(label)) refuse(`no log for ${label}`)

const rows = new Map()
for (const label of FS_ORDER) {
  const file = logs.get(label)
  if (!fs.existsSync(file)) refuse(`${label}: ${file} is absent`)
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = LINE.exec(l)
    if (!m) continue
    const key = `${m[2]}\t${label}`
    if (rows.has(key)) refuse(`${m[2]} on ${label} appears twice`)
    rows.set(key, [m[2], label, m[1], m[3], m[4], m[5], m[6], m[7]])
  }
}

const sorted = [...rows.values()].sort(
  (a, b) => a[0].localeCompare(b[0]) || FS_ORDER.indexOf(a[1]) - FS_ORDER.indexOf(b[1])
)
process.stdout.write(
  '# W5 runner verdict lines, one per (row, fs), extracted by results/extract-w5-verdicts.mjs\n' +
    '# from the owner-approved W5 run logs. Do not hand-edit; regenerate with that script.\n' +
    '# row\tfs\tverdict\tran\tpassed\tfailed\tnever-ran\tcontrol\n' +
    sorted.map((r) => r.join('\t')).join('\n') +
    '\n'
)

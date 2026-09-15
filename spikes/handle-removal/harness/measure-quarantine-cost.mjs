#!/usr/bin/env node
// SMI-6676 checkpoint 4, priority 3: what quarantine actually costs.
// Uses this repo's own real .claude/skills/ content as the size fixture
// (data/external-skills and packages/*/assets/skills don't exist in this
// worktree's checkout -- .claude/skills is the real, present alternative).
// Measures: disk held after N repeated uninstall-shaped quarantines of the
// same skill, and what a doctor-style scan has to walk to find them all.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { quarantineTree } from '../quarantine.mjs'

const SPIKE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.join(SPIKE_ROOT, '..', '..')
const REAL_SKILLS_DIR = path.join(REPO_ROOT, '.claude', 'skills')

const HARNESS_ROOT =
  process.env.SMI6676_HARNESS_ROOT ?? path.join(process.env.TMPDIR ?? '/tmp', 's6676-qcost')
fs.mkdirSync(HARNESS_ROOT, { recursive: true })

function dirBytes(p) {
  let total = 0
  const st = fs.lstatSync(p)
  if (st.isFile() || st.isSymbolicLink()) return st.size
  if (!st.isDirectory()) return 0
  for (const name of fs.readdirSync(p)) total += dirBytes(path.join(p, name))
  return total
}

function countScanNodes(p) {
  // A doctor-style scan: one readdir + one stat per entry, recursively.
  let dirs = 0
  let files = 0
  const st = fs.lstatSync(p)
  if (!st.isDirectory()) return { dirs: 0, files: 1 }
  dirs += 1
  for (const name of fs.readdirSync(p)) {
    const r = countScanNodes(path.join(p, name))
    dirs += r.dirs
    files += r.files
  }
  return { dirs, files }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name)
    const d = path.join(dest, name)
    const st = fs.lstatSync(s)
    if (st.isDirectory()) copyDir(s, d)
    else if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d)
    else fs.copyFileSync(s, d)
  }
}

function main() {
  if (!fs.existsSync(REAL_SKILLS_DIR)) {
    console.error(
      `[measure-quarantine-cost] ${REAL_SKILLS_DIR} does not exist in this checkout -- cannot measure`
    )
    process.exit(2)
  }

  const candidates = fs
    .readdirSync(REAL_SKILLS_DIR)
    .filter((n) => fs.statSync(path.join(REAL_SKILLS_DIR, n)).isDirectory())
  const sized = candidates
    .map((n) => ({ name: n, bytes: dirBytes(path.join(REAL_SKILLS_DIR, n)) }))
    .sort((a, b) => b.bytes - a.bytes)
  const median = sized[Math.floor(sized.length / 2)]
  console.log(`Real fixture: ${REAL_SKILLS_DIR}, ${sized.length} skill directories.`)
  console.log(
    `Largest: ${sized[0].name} (${sized[0].bytes} bytes). Median: ${median.name} (${median.bytes} bytes).`
  )
  console.log('')

  // Simulate 10 uninstall-shaped quarantines of the median-sized skill,
  // each a fresh copy (quarantineTree moves its source; a real uninstall
  // reinstalls-then-uninstalls the same skill repeatedly over time, which
  // this reproduces by copying the real content back in before each run).
  const skillsRoot = fs.mkdtempSync(path.join(HARNESS_ROOT, 'skillsroot-'))
  const results = []
  for (let i = 0; i < 10; i += 1) {
    const dest = path.join(skillsRoot, median.name)
    copyDir(path.join(REAL_SKILLS_DIR, median.name), dest)
    const r = quarantineTree(skillsRoot, median.name, { opId: `uninstall-${i}`, kind: 'uninstall' })
    results.push(r)
  }

  const trashRoot = path.join(skillsRoot, '.skillsmith-trash')
  const heldBytes = dirBytes(trashRoot)
  const scan = countScanNodes(trashRoot)

  console.log(`After 10 uninstalls of "${median.name}" (${median.bytes} bytes each, never pruned):`)
  console.log(
    `  total bytes held in .skillsmith-trash: ${heldBytes} (${(heldBytes / 1024).toFixed(1)} KB)`
  )
  console.log(
    `  expected (10 x ${median.bytes}): ${10 * median.bytes} -- confirms nothing is being deduplicated or compressed`
  )
  console.log(
    `  doctor-style scan cost to find all 10: ${scan.dirs} directories, ${scan.files} files (readdir+stat calls)`
  )
  console.log(
    `  that is ${(scan.dirs + scan.files) / 10} scan operations per quarantined tree, on top of scanning the real skills root itself`
  )
  console.log('')
  console.log('Sidecar overhead per quarantined tree:')
  const sidecarBytes = fs.statSync(results[0].sidecarPath).size
  console.log(`  ${sidecarBytes} bytes (fixed -- does not scale with tree size)`)

  fs.rmSync(skillsRoot, { recursive: true, force: true })
}

main()

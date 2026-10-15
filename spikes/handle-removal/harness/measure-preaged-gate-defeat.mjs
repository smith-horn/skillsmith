#!/usr/bin/env node
// SMI-6676: does a genuinely pre-aged substitute -- no forgery, no
// in-process monkeypatch, no setattrlist/SetFile -- defeat C0's UD25 gate?
// Built in response to the coordinator's follow-up on A9: forging a
// timestamp assumes a capability (in-process code execution, or an
// unprivileged process calling a real macOS-only syscall); an attacker who
// simply creates the substitute BEFORE the removal call runs hands the gate
// a real, unforged old birthtime, needing no special capability and no
// timing precision at all. Not a re-implementation of anything cited --
// checked against reference-experiments/ and feasibility/ first (including
// e45-birthtime.mjs, which measures inode-reuse birthtime collision, a
// different property) and found nothing covering this question.
//
// Technique: create the substitute directory now, under an aside name; wait
// AGE_MS of REAL wall-clock time (an actual process sleep, not timer
// trickery); rename it into place over the real 'target' (rename(2) does
// not touch the SOURCE inode's own birthtime -- verified per run below, not
// assumed); then call removeC0/removeVR with no hooks at all -- the
// fixture is already in its final, attacked shape before the walker is even
// invoked, matching the real capability model: "created earlier, happened
// to be there when the deletion ran."
//
// Usage: node harness/measure-preaged-gate-defeat.mjs [--fs-label <name>]

import { removeC0 } from '../c0-walk.mjs'
import { removeVR } from '../walk.mjs'
import { loadShim } from '../native-c/load.mjs'
import { guardPass } from '../hash.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { resolveHarnessRoot } from './fixture-root.mjs'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function buildFixture(root) {
  const treeRoot = path.join(root, 'tree')
  fs.mkdirSync(path.join(treeRoot, 'target'), { recursive: true })
  fs.writeFileSync(path.join(treeRoot, 'target', 'orig-f1'), 'original-content-f1', 'utf8')
  fs.mkdirSync(path.join(treeRoot, 'zzz-sibling'), { recursive: true })
  fs.writeFileSync(path.join(treeRoot, 'zzz-sibling', 'f1'), 'sibling-content', 'utf8')
  return { treeRoot, targetAbs: path.join(treeRoot, 'target') }
}

function originalTreeHash(treeRoot) {
  const shim = loadShim()
  const T = shim.openDir(treeRoot)
  const g = guardPass(shim, T.fd, {})
  for (const fd of g.heldFds.values()) fs.closeSync(fd)
  return g.treeHash
}

async function runOnce(harnessRoot, ageMs, candidateFamily, guardMode) {
  const root = fs.mkdtempSync(path.join(harnessRoot, 'preaged-'))
  const { treeRoot, targetAbs } = buildFixture(root)

  // Must be captured from the ORIGINAL, pre-attack tree -- a real caller
  // with a guard would have computed it before the attack happened. Calling
  // this AFTER the swap below hashes the attacker's own substitute against
  // itself and trivially "matches" -- a bug an earlier draft of this script
  // had, caught by reading the first run's output before trusting it.
  const guardHash =
    candidateFamily !== 'C0' && guardMode === 'guardHash' ? originalTreeHash(treeRoot) : undefined

  const asideAbs = path.join(root, 'attacker-substitute')
  fs.mkdirSync(asideAbs)
  const replacementContent = `attacker-content-${Date.now()}-${Math.random()}`
  fs.writeFileSync(path.join(asideAbs, 'orig-f1'), replacementContent, 'utf8')
  const substituteBirthtimeNs = fs.lstatSync(asideAbs, { bigint: true }).birthtimeNs

  await sleep(ageMs)

  fs.rmSync(targetAbs, { recursive: true, force: true })
  fs.renameSync(asideAbs, targetAbs)
  const postRenameBirthtimeNs = fs.lstatSync(targetAbs, { bigint: true }).birthtimeNs
  const birthtimePreservedThroughRename = postRenameBirthtimeNs === substituteBirthtimeNs

  const outcome =
    candidateFamily === 'C0'
      ? removeC0(treeRoot, { hooks: {} })
      : removeVR(treeRoot, { variant: candidateFamily, guardHash, hooks: {} })
  const userFilesLost = fs.existsSync(path.join(targetAbs, 'orig-f1'))
    ? fs.readFileSync(path.join(targetAbs, 'orig-f1'), 'utf8') !== replacementContent
    : true

  fs.rmSync(root, { recursive: true, force: true })
  return { outcome, userFilesLost, substituteBirthtimeNs, birthtimePreservedThroughRename, ageMs }
}

async function main() {
  const fsLabel = process.argv.includes('--fs-label')
    ? process.argv[process.argv.indexOf('--fs-label') + 1]
    : process.platform
  const harnessRoot = resolveHarnessRoot()
  console.log(`[measure-preaged-gate-defeat] harnessRoot=${harnessRoot} fsLabel=${fsLabel}`)

  for (const ageMs of [0, 10, 500, 1000, 2000]) {
    for (const candidateFamily of ['C0', 'V0', 'V1', 'V2']) {
      if (candidateFamily === 'C0') {
        const r = await runOnce(harnessRoot, ageMs, 'C0', null)
        console.log(
          `age=${ageMs}ms candidate=C0 guard=n/a renamePreservedBirthtime=${r.birthtimePreservedThroughRename} outcome=${JSON.stringify(r.outcome)} userFilesLost=${r.userFilesLost}`
        )
      } else {
        for (const guardMode of ['none', 'guardHash']) {
          const r = await runOnce(harnessRoot, ageMs, candidateFamily, guardMode)
          console.log(
            `age=${ageMs}ms candidate=${candidateFamily} guard=${guardMode} renamePreservedBirthtime=${r.birthtimePreservedThroughRename} outcome=${JSON.stringify(r.outcome)} userFilesLost=${r.userFilesLost}`
          )
        }
      }
    }
  }
}

main()

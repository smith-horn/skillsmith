/**
 * SMI-6531 (A1 step 3): shared fixtures for the skill-tree suites.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'

const roots: string[] = []

/** A fresh temp directory, removed (links never followed) after each test. */
export function tmp(prefix = 'skill-tree-'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  roots.push(dir)
  return dir
}

/** Register once per suite file: restores modes the tests removed, then removes the temps. */
export function useTmpCleanup(): void {
  afterEach(() => {
    for (const r of roots.splice(0)) {
      restoreModes(r)
      fs.rmSync(r, { recursive: true, force: true })
    }
  })
}

function restoreModes(p: string): void {
  let st: fs.Stats
  try {
    st = fs.lstatSync(p)
  } catch {
    return
  }
  if (st.isSymbolicLink()) return
  try {
    fs.chmodSync(p, st.isDirectory() ? 0o700 : 0o600)
  } catch {
    /* best effort */
  }
  if (st.isDirectory()) for (const n of fs.readdirSync(p)) restoreModes(path.join(p, n))
}

/** Every entry under `dir` (links never followed), relative, sorted. */
export function listTree(dir: string): string[] {
  const out: string[] = []
  const walk = (abs: string, rel: string): void => {
    for (const n of fs.readdirSync(abs).sort()) {
      const childRel = rel ? `${rel}/${n}` : n
      out.push(childRel)
      if (fs.lstatSync(path.join(abs, n)).isDirectory()) walk(path.join(abs, n), childRel)
    }
  }
  walk(dir, '')
  return out
}

/** True when any REGULAR file under `dir` (lstat, never through a link) contains `needle`. */
export function anyFileContains(dir: string, needle: Buffer): boolean {
  for (const rel of listTree(dir)) {
    const abs = path.join(dir, rel)
    if (fs.lstatSync(abs).isFile() && fs.readFileSync(abs).includes(needle)) return true
  }
  return false
}

/** `lstat`, bigint, or null when absent. */
export const lstatBig = (p: string): fs.BigIntStats | null =>
  fs.lstatSync(p, { bigint: true, throwIfNoEntry: false }) ?? null

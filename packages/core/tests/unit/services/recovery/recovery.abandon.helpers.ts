/**
 * SMI-6531 (A1 step 6b-iii): fixtures for the `--abandon` suites.
 *
 * Every class is made from a real crash (`recovery.helpers.ts`), then moved
 * the way a user or a copy would move it:
 *  - `renamedOp`: the op dir renamed (`foreign-op-dir`: the record names the
 *    old name; OP keeps its identity);
 *  - `copiedOp`: the op dir replaced by a copy of itself under the same name
 *    (`op-dir-identity`);
 *  - `copiedRoot`: the whole skills root copied to a sibling directory, whose
 *    op dir then names the original root (`foreign-root`);
 *  - `abandonable`: an `anything-else` op with a verified record (S1 with T
 *    deleted after the old folder was set aside by hand: T-J11's own fixture).
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'
import { areaOf, hashOf } from '../skill-swap.helpers.js'
import type { Fixture } from '../skill-swap.helpers.js'
import { opIdN } from '../skill-swap.scan.helpers.js'
import { contentSnapshot } from './recovery.act.helpers.js'
import { opReport, s1, s2, keepTree, writeEntry } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'

/** The op dir renamed to `name` (`foreign-op-dir`). */
export function renamedOp(st: State, name: string = opIdN('b')): State {
  const to = path.join(st.fx.staging, name)
  fs.renameSync(st.opDir, to)
  return { ...st, opId: name, opDir: to }
}

/** The op dir replaced by a copy of itself (`op-dir-identity`). */
export function copiedOp(st: State): State {
  const aside = `${st.opDir}.orig`
  fs.renameSync(st.opDir, aside)
  fs.cpSync(aside, st.opDir, { recursive: true })
  fs.rmSync(aside, { recursive: true })
  return st
}

/** The skills root copied to `<base>/skills-b` (`foreign-root` there); the copy's fixture. */
export function copiedRoot(st: State): State {
  const to = path.join(st.fx.base, 'skills-b')
  fs.cpSync(st.fx.skillsDir, to, { recursive: true })
  const staging = path.join(to, '.skillsmith-staging')
  const fx: Fixture = {
    ...st.fx,
    skillsDir: to,
    realDir: path.join(to, st.fx.dirName),
    staging,
    opDir: path.join(staging, st.opId),
  }
  return { ...st, fx, opDir: fx.opDir }
}

/** `anything-else` with a verified record: S1 whose old folder was set aside by hand, T deleted. */
export async function abandonable(fx: Fixture): Promise<State & { aside: string }> {
  const st = await s1(fx)
  const aside = path.join(fx.base, 'old-by-hand')
  fs.renameSync(path.join(st.opDir, 'old'), aside)
  fs.rmSync(fx.realDir, { recursive: true, force: true })
  const cls = (await opReport(st)).cls
  expect(cls.kind, JSON.stringify(cls).slice(0, 400)).toBe('anything-else')
  return { ...st, aside }
}

/** Post-keep S2′: S2 with O kept as backup and the manifest entry neither pre nor post. */
export async function postKeepS2prime(fx: Fixture): Promise<State> {
  const st = await s2(fx)
  keepTree(st, 'old', 'backup')
  writeEntry(fx, { version: '9.9.9' })
  const cls = (await opReport(st)).cls
  expect(cls).toMatchObject({ kind: 'state', state: 'S2prime', postKeep: true })
  return st
}

/** The area `fx`'s keeps go to (its own root's). */
export const areaFor = (fx: Fixture): string => areaOf(fx)

/** Everything `--abandon` could touch: both roots' trees, the state root, the journal's base. */
export const world = (st: State): string => contentSnapshot(st.fx.base)

/** The kept trees under `area` whose name contains `.abandoned-`, by name, with their hashes. */
export function abandonedIn(area: string): Record<string, string> {
  if (!fs.existsSync(area)) return {}
  const out: Record<string, string> = {}
  for (const n of fs.readdirSync(area).sort()) {
    const p = path.join(area, n)
    if (n.includes('.abandoned-') && fs.lstatSync(p).isDirectory()) out[n] = hashOf(p)
  }
  return out
}

/** The sidecar of the kept tree at `dest`, parsed. */
export const sidecarAt = (dest: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(`${dest}.json`, 'utf8')) as Record<string, unknown>

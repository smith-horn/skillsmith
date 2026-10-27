/**
 * SMI-6531 (A1 step 7b): fixtures for the in-place update suites.
 *
 * A real temp skills root and state root (removed after each test), a manifest
 * file holding the folder's entry under `manifestKeyFor(dirName, client)`, and
 * a fake upstream served through a stubbed global `fetch` at the raw GitHub
 * URLs `fetchFromGitHub` asks for. The upstream repo is deliberately named
 * differently from the folder, so a key or path taken from the upstream name
 * names nothing that exists.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, vi } from 'vitest'
import type { ClientId } from '../../../src/install/paths.js'
import { manifestKeyFor } from '../../../src/services/skill-installation.helpers.js'
import type { JournalRecordInput } from '../../../src/journal/types.js'
import type { SwapOptions, TraceOp } from '../../../src/services/skill-swap.js'
import { tmp } from './skill-tree.helpers.js'

export { tmp, useTmpCleanup } from './skill-tree.helpers.js'

export const OP_ID = 'b'.repeat(32)
export const UPSTREAM_REPO = 'upstream-name'
export const SKILL_ID = `https://github.com/acme/${UPSTREAM_REPO}`
export const DIR_NAME = 'my-skill'

/** A SKILL.md `validateSkillMd` accepts (a `# ` heading, at least 100 characters). */
export function skillMd(version: string, extra = ''): string {
  return (
    `# My skill ${version}\n\n` +
    'This skill formats release notes from a list of merged changes for the team.\n' +
    'It reads the list and writes one short paragraph per change.\n' +
    extra
  )
}

/** The fake upstream: `files[rel]` is served at `rel`; anything else is a 404. Mutable. */
export function useUpstream(): Record<string, string> {
  const files: Record<string, string> = {}
  const prefix = `https://raw.githubusercontent.com/acme/${UPSTREAM_REPO}/main/`
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const u = String(url)
      const rel = u.startsWith(prefix) ? u.slice(prefix.length) : null
      if (rel !== null && Object.hasOwn(files, rel)) {
        return new Response(files[rel], { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })
  )
  return files
}

/** Register once per suite file (beside `useTmpCleanup`). */
export function useUpstreamCleanup(): void {
  afterEach(() => {
    vi.unstubAllGlobals()
  })
}

export interface UpdateFixture {
  base: string
  skillsDir: string
  stateRoot: string
  manifestPath: string
  realDir: string
  comparedPath: string
  dirName: string
  client: ClientId
  manifestKey: string
  /** The raw entry written for the folder. */
  entry: Record<string, unknown>
}

export interface FixtureOptions {
  client?: ClientId
  /** Overrides on the folder's entry. */
  entry?: Record<string, unknown>
  /** Other keys in the manifest. */
  others?: Record<string, unknown>
  /** Put the state root here instead of under the temp base (a cross-device test). */
  stateRoot?: string
}

/** A skills root holding `my-skill` with `files`, and a manifest tracking it. */
export function updateFixture(
  files: Record<string, string>,
  opts: FixtureOptions = {}
): UpdateFixture {
  const base = tmp('skill-update-')
  const skillsDir = path.join(base, 'skills')
  const stateRoot = opts.stateRoot ?? path.join(base, 'state')
  const realDir = path.join(skillsDir, DIR_NAME)
  fs.mkdirSync(realDir, { recursive: true })
  fs.mkdirSync(stateRoot, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(realDir, rel)), { recursive: true })
    fs.writeFileSync(path.join(realDir, rel), content)
  }
  const client = opts.client ?? 'claude-code'
  const manifestKey = manifestKeyFor(DIR_NAME, client)
  const entry: Record<string, unknown> = {
    id: SKILL_ID,
    name: DIR_NAME,
    version: '1.0.0',
    source: 'github:acme/upstream-name',
    installPath: realDir,
    installedAt: '2026-01-01T00:00:00.000Z',
    lastUpdated: '2026-01-01T00:00:00.000Z',
    provenance: 'registry',
    ...opts.entry,
  }
  const manifestPath = path.join(stateRoot, 'manifest.json')
  writeManifest(manifestPath, { ...opts.others, [manifestKey]: entry })
  return {
    base,
    skillsDir,
    stateRoot,
    manifestPath,
    realDir,
    comparedPath: realDir,
    dirName: DIR_NAME,
    client,
    manifestKey,
    entry,
  }
}

export function writeManifest(manifestPath: string, installedSkills: Record<string, unknown>) {
  fs.writeFileSync(manifestPath, JSON.stringify({ version: '1.0.0', installedSkills }, null, 2))
}

export function readInstalled(manifestPath: string): Record<string, unknown> {
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    installedSkills: Record<string, unknown>
  }
  return raw.installedSkills
}

export const sha256 = (bytes: Buffer | string): string =>
  crypto.createHash('sha256').update(bytes).digest('hex')

/**
 * Every entry under `dir` (links never followed): relative path → type plus
 * content hash (file), link text (symlink) or nothing (directory). `{}` for an
 * absent `dir`.
 */
export function walk(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const go = (abs: string, rel: string): void => {
    for (const n of fs.readdirSync(abs).sort()) {
      const a = path.join(abs, n)
      const r = rel ? `${rel}/${n}` : n
      const st = fs.lstatSync(a)
      if (st.isSymbolicLink()) out.set(r, `link:${fs.readlinkSync(a)}`)
      else if (st.isDirectory()) {
        out.set(r, 'dir')
        go(a, r)
      } else if (st.isFile()) out.set(r, `file:${sha256(fs.readFileSync(a))}`)
      else out.set(r, 'other')
    }
  }
  if (fs.existsSync(dir)) go(dir, '')
  return out
}

/** Relative paths whose entry differs between two walks, or exists in only one; sorted. */
export function changedBetween(a: Map<string, string>, b: Map<string, string>): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort()
}

/** `<state>/backups/update/<client>/<rootKey>/<dirName>`, relative to the state root. */
export function areaRel(fx: UpdateFixture): string {
  const key = sha256(fs.realpathSync.native(fx.skillsDir)).slice(0, 16)
  return path.join('backups', 'update', fx.client, key, fx.dirName)
}

export interface Recorded {
  trace: TraceOp[]
  journal: JournalRecordInput[]
  swap: SwapOptions
}

/** Swap seams for a test run: the fixed opId, a trace recorder, an in-memory journal, quiet stderr. */
export function recorded(extra: SwapOptions = {}): Recorded {
  const trace: TraceOp[] = []
  const journal: JournalRecordInput[] = []
  return {
    trace,
    journal,
    swap: {
      opId: OP_ID,
      trace: (op) => trace.push(op),
      appendJournal: async (j) => {
        journal.push(j)
      },
      stderr: () => undefined,
      ...extra,
    },
  }
}

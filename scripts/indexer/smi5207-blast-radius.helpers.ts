/**
 * SMI-5207 Wave 1 Step 4 — shared CLI/population plumbing for 4b/4e.
 * @module scripts/indexer/smi5207-blast-radius.helpers
 *
 * Deliberately small: unlike the 4a harness (`smi5879-simulate-full.*`),
 * neither 4b nor 4e needs claim/heartbeat/release, checkpointing, sharding,
 * or a GitHub fetch step — the core weekly-scanner surface's population is
 * already-fetched `{name, description}` text (see the plan's Context
 * section), not something this tool fetches itself. See
 * smi5207-blast-radius.fixtures.ts's header for why a real corpus run isn't
 * wired up any further than "supply your own --population file" here.
 */

import { readFileSync } from 'node:fs'
import {
  SecurityScanner,
  SCANNER_RULESET_VERSION,
} from '../../packages/core/src/security/scanner/index.js'
import {
  loadAllowlist,
  EMPTY_ALLOWLIST,
} from '../../packages/core/src/scripts/skill-scanner/allowlist.js'
import type { AllowlistMatcher } from '../../packages/core/src/scripts/skill-scanner/types.js'
import { SMI5207_FIXTURE_POPULATION } from './smi5207-blast-radius.fixtures.js'
import type { Smi5207PopulationSkill } from './smi5207-blast-radius.types.js'

export { SecurityScanner, SCANNER_RULESET_VERSION }

/** Default allowlist path — matches DEFAULT_CONFIG.allowlistPath in scanner.ts. */
export const DEFAULT_ALLOWLIST_PATH = './data/skills-security-allowlist.json'

export interface Smi5207CommonArgs {
  useFixtures: boolean
  populationPath?: string
  allowlistPath: string
  reportPath?: string
  csvPath?: string
}

/** Minimal, dependency-free flag parser — mirrors this repo's other one-off script CLIs. */
export function parseCommonArgs(
  argv: string[],
  defaults: { reportPath?: string } = {}
): Smi5207CommonArgs {
  const args: Smi5207CommonArgs = {
    useFixtures: false,
    allowlistPath: DEFAULT_ALLOWLIST_PATH,
    reportPath: defaults.reportPath,
  }
  for (const raw of argv) {
    if (raw === '--fixtures') {
      args.useFixtures = true
    } else if (raw.startsWith('--population=')) {
      args.populationPath = raw.slice('--population='.length)
    } else if (raw.startsWith('--allowlist-path=')) {
      args.allowlistPath = raw.slice('--allowlist-path='.length)
    } else if (raw.startsWith('--report-path=')) {
      args.reportPath = raw.slice('--report-path='.length)
    } else if (raw.startsWith('--csv=')) {
      args.csvPath = raw.slice('--csv='.length)
    } else if (raw === '--help' || raw === '-h') {
      // Handled by each script's own main() before parseCommonArgs is called
      // (so --help never trips the --fixtures/--population requirement below).
      continue
    } else {
      throw new Error(`Unknown argument: ${raw}`)
    }
  }
  if (!args.useFixtures && !args.populationPath) {
    throw new Error(
      "Either --fixtures (this worker's own hand-crafted verification sample) or " +
        '--population=<path> (a real corpus file, in Smi5207PopulationSkill[] JSON shape) is required.'
    )
  }
  if (args.useFixtures && args.populationPath) {
    throw new Error('--fixtures and --population=<path> are mutually exclusive.')
  }
  return args
}

/**
 * Load the population. Accepts a bare array or `{skills: [...]}`, matching
 * `readImportedSkills`'s own accepted shapes (file-scanner.ts) — deliberately
 * NOT reusing that function directly, since it returns `ImportedSkill[]` and
 * would silently strip the `beforeQuarantined` ground-truth field this
 * module's callers need; the accepted-shape logic itself is duplicated here
 * (three lines) rather than the type.
 */
export function loadPopulation(args: Smi5207CommonArgs): {
  population: Smi5207PopulationSkill[]
  source: string
} {
  if (args.useFixtures) {
    return { population: SMI5207_FIXTURE_POPULATION, source: 'fixtures (built-in)' }
  }
  const path = args.populationPath as string
  const raw = readFileSync(path, 'utf-8')
  const parsed = JSON.parse(raw) as unknown
  if (Array.isArray(parsed)) {
    return { population: parsed as Smi5207PopulationSkill[], source: path }
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'skills' in parsed &&
    Array.isArray((parsed as { skills: unknown }).skills)
  ) {
    return { population: (parsed as { skills: Smi5207PopulationSkill[] }).skills, source: path }
  }
  throw new Error(`${path}: expected a JSON array or an object with a "skills" array`)
}

/**
 * Load the version-controlled allowlist the same way the real weekly-scan
 * CLI does (scanner.ts's `scanImportedSkills`) — a missing file returns
 * EMPTY_ALLOWLIST, never throws (pre-SMI-4396 environments keep working); a
 * malformed file still throws (fail-safe toward quarantine).
 */
export function loadAllowlistMatcher(path: string): {
  matcher: AllowlistMatcher
  entryCount: number
} {
  const matcher = loadAllowlist(path)
  // loadAllowlist doesn't expose entry count directly; re-read defensively
  // (best-effort — a missing/malformed file already threw or returned
  // EMPTY_ALLOWLIST above, so this second read is purely for the report's
  // provenance field and never changes the matcher actually used to scan).
  let entryCount = 0
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as { allowlist?: unknown[] }
    entryCount = Array.isArray(parsed.allowlist) ? parsed.allowlist.length : 0
  } catch {
    entryCount = matcher === EMPTY_ALLOWLIST ? 0 : entryCount
  }
  return { matcher, entryCount }
}

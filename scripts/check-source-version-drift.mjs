#!/usr/bin/env node
/**
 * SMI-5120 AC #3: source-vs-version drift detector.
 *
 * Flags a publishable package whose package.json version has been static
 * across >= RELEASES_THRESHOLD release cycles while its src/ kept changing —
 * i.e. a published artifact that has silently frozen on its registry. This is
 * the @smith-horn/enterprise failure mode: published 0.1.2 on 2026-01-13, never
 * bumped, ~5 months of billing src landed since, all invisible to consumers.
 *
 * Companion to (not a replacement for) the orthogonal weekly checks:
 *   - check-version-drift.mjs  — local version BEHIND npm latest
 *   - detect-release-drift.mjs — npm-published version missing a GH Release
 * This one catches local src AHEAD of a static published version.
 *
 * Pure ESM with injected I/O (mirrors detect-release-drift.mjs) so the gate
 * logic is unit-testable without any network or git. Emits a JSON report:
 *   { sourceDrifted: [...], clean: [...], errors: [...] }
 * Exits 0 iff sourceDrifted.length === 0 AND errors.length === 0.
 *
 * Invoked from .github/workflows/version-drift-check.yml (its output is merged
 * into the shared version-drift Linear issue via linear-upsert-drift-issue.mjs).
 * Requires a full-history checkout (fetch-depth: 0) — baseline resolution and
 * the release-cycle count both walk git history/tags.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = join(__dirname, '..')

/** A package must be static across this many release cycles to be flagged. */
export const RELEASES_THRESHOLD = 3

/**
 * Publishable packages, grounded to PUBLISHABLE_PACKAGES_JSON in
 * .github/workflows/publish.yml (a unit test asserts the names stay in sync).
 * `registry` mirrors PACKAGE_SPECS in scripts/lib/version-utils.ts; `tagPrefix`
 * mirrors TRACKED_PACKAGES in detect-release-drift.mjs. @smith-horn/enterprise
 * publishes to GitHub Packages and has NO git tags, so it relies on the
 * version-string baseline fallback.
 */
export const PUBLISHABLE_SPECS = [
  { name: '@skillsmith/core', dir: 'core', tagPrefix: '@skillsmith/core-v' },
  { name: '@skillsmith/mcp-server', dir: 'mcp-server', tagPrefix: '@skillsmith/mcp-server-v' },
  { name: '@skillsmith/cli', dir: 'cli', tagPrefix: '@skillsmith/cli-v' },
  { name: '@smith-horn/enterprise', dir: 'enterprise', registry: 'https://npm.pkg.github.com' },
]

/**
 * Parse a 3-segment semver into [major, minor, patch]. Pre-release/build
 * suffixes are stripped. Returns null for anything that isn't X.Y.Z.
 */
export function parseSemver(s) {
  if (typeof s !== 'string') return null
  const core = s.split(/[-+]/, 1)[0]
  const parts = core.split('.').map((n) => Number.parseInt(n, 10))
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null
  return parts
}

/** True iff semver a > b. Invalid inputs return false (treated as equal). */
export function semverGt(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return false
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] > pb[i]) return true
    if (pa[i] < pb[i]) return false
  }
  return false
}

/**
 * True iff a commit subject is a release-version-bump commit, using the same
 * 3-pattern matcher as findLastVersionBumpCommit in lib/release-changelog.ts.
 * Used only by the countReleasesSince fallback (when no publishable tags are
 * reachable after the baseline).
 */
export function isReleaseBumpSubject(subject) {
  if (typeof subject !== 'string') return false
  return (
    subject.startsWith('chore(release):') ||
    subject.startsWith('chore: bump version') ||
    /^chore:.*bump.*\d+\.\d+\.\d+/.test(subject)
  )
}

function git(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/**
 * Default I/O using execFileSync (git/npm) + fs. Tests inject stubs.
 * @typedef {{
 *   readVersion: (dir: string) => string,
 *   resolveBaselineRef: (spec: object, version: string) => string | null,
 *   countReleasesSince: (baseline: string) => number,
 *   srcChangedSince: (baseline: string, dir: string) => boolean,
 *   publishedLatest: (name: string, registry?: string) => string | null | 'unverified',
 * }} IO
 */

/** @returns {IO} */
export function defaultIO() {
  return {
    readVersion: (dir) => {
      const pj = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', dir, 'package.json'), 'utf-8'))
      return pj.version
    },

    resolveBaselineRef: (spec, version) => {
      // Prefer the release tag (npmjs packages). The current version may be
      // ahead of the latest tag (a bump landed but isn't tagged yet) — then the
      // tag won't exist and we fall through to the version-string commit.
      if (spec.tagPrefix) {
        const tag = `${spec.tagPrefix}${version}`
        try {
          git(['rev-parse', '--verify', '--quiet', `${tag}^{commit}`])
          return tag
        } catch {
          // tag absent — fall through
        }
      }
      // Newest commit that introduced the current version into package.json
      // (pickaxe). Survives revert/reintroduce + squash relocation; the search
      // string is the prettier-canonical 2-space form.
      try {
        const out = git([
          'log',
          `-S"version": "${version}"`,
          '--format=%H',
          '--',
          `packages/${spec.dir}/package.json`,
        ]).trim()
        const newest = out.split('\n')[0]?.trim()
        return newest || null
      } catch {
        return null
      }
    },

    countReleasesSince: (baseline) => {
      // Primary: distinct commits targeted by a publishable version tag that are
      // reachable from HEAD but not from the baseline (one weekly release cuts
      // several package tags on one commit → dedup by SHA = one cycle).
      let tags = []
      try {
        const out = git([
          'tag',
          '--merged',
          'HEAD',
          '--no-merged',
          baseline,
          '--list',
          '@skillsmith/*-v*',
        ]).trim()
        tags = out
          ? out
              .split('\n')
              .map((t) => t.trim())
              .filter(Boolean)
          : []
      } catch {
        tags = []
      }
      if (tags.length > 0) {
        const shas = new Set()
        for (const tag of tags) {
          try {
            shas.add(git(['rev-list', '-n', '1', tag]).trim())
          } catch {
            // unreadable tag — ignore
          }
        }
        return shas.size
      }
      // Fallback: count release-bump commits in baseline..HEAD.
      try {
        const out = git(['log', `${baseline}..HEAD`, '--format=%s']).trim()
        if (!out) return 0
        return out.split('\n').filter(isReleaseBumpSubject).length
      } catch {
        return 0
      }
    },

    srcChangedSince: (baseline, dir) => {
      try {
        const out = git([
          'log',
          `${baseline}..HEAD`,
          '--format=%H',
          '--',
          `packages/${dir}/src`,
        ]).trim()
        return out.length > 0
      } catch {
        return false
      }
    },

    publishedLatest: (name, registry) => {
      const args = ['view', name, 'version']
      if (registry) args.push(`--registry=${registry}`)
      try {
        const out = execFileSync('npm', args, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30_000,
        }).trim()
        return out || null
      } catch (err) {
        const stderr = (err.stderr || '').toString()
        const message = err.message || ''
        if (/E404|404 Not Found|not in this registry/i.test(stderr)) return null
        const isAuth =
          /E401|E403|Unauthorized|ENEEDAUTH|need(?:s)? auth|authentication/i.test(stderr) ||
          /E401|E403|Unauthorized|ENEEDAUTH/i.test(message)
        // A registry-targeted lookup (GitHub Packages) needs auth; CI runs it
        // without a token. Degrade gracefully — never fail-close a GH-Packages
        // lookup — and let the git signal decide. Anonymous npmjs auth errors
        // are real, so fail-close those.
        if (registry && isAuth) return 'unverified'
        throw new Error(`npm view ${name} failed: ${message}${stderr ? '\n' + stderr : ''}`)
      }
    },
  }
}

/**
 * Evaluate one package. Pure given an IO. Returns a tagged result:
 *   { kind: 'drift' | 'clean', ... }
 */
export function evaluatePackage(spec, io) {
  const version = io.readVersion(spec.dir)
  const baseline = io.resolveBaselineRef(spec, version)
  if (!baseline) {
    return { kind: 'clean', pkg: spec.name, version, note: 'no_baseline' }
  }

  const releasesElapsed = io.countReleasesSince(baseline)
  const srcChanged = io.srcChangedSince(baseline, spec.dir)
  const published = io.publishedLatest(spec.name, spec.registry)

  if (published === null) {
    // Never published — that's detect-release-drift's / a never-released
    // concern, not a stale-published-artifact one.
    return { kind: 'clean', pkg: spec.name, version, note: 'not_published', releasesElapsed }
  }
  if (published !== 'unverified') {
    if (semverGt(published, version)) {
      return { kind: 'clean', pkg: spec.name, version, note: 'behind_npm', published }
    }
    if (semverGt(version, published)) {
      return { kind: 'clean', pkg: spec.name, version, note: 'pending_publish', published }
    }
    // version === published → frozen candidate
  }

  const registryUnverified = published === 'unverified'
  if (releasesElapsed >= RELEASES_THRESHOLD && srcChanged) {
    return { kind: 'drift', pkg: spec.name, version, releasesElapsed, baseline, registryUnverified }
  }
  return {
    kind: 'clean',
    pkg: spec.name,
    version,
    note: srcChanged ? 'within_threshold' : 'src_unchanged',
    releasesElapsed,
  }
}

/** Run the check across specs. The only side effects are inside `io`. */
export function runSourceDriftCheck(specs, io) {
  const report = { sourceDrifted: [], clean: [], errors: [] }
  for (const spec of specs) {
    try {
      const result = evaluatePackage(spec, io)
      const { kind, ...rest } = result
      if (kind === 'drift') report.sourceDrifted.push(rest)
      else report.clean.push(rest)
    } catch (err) {
      report.errors.push({ pkg: spec.name, error: String(err.message || err) })
    }
  }
  return report
}

function main() {
  const report = runSourceDriftCheck(PUBLISHABLE_SPECS, defaultIO())
  console.log(JSON.stringify(report, null, 2))
  const ok = report.sourceDrifted.length === 0 && report.errors.length === 0
  process.exit(ok ? 0 : 1)
}

// Only execute when run directly, not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}

/**
 * Tool-provenance helpers for the SMI-6444 bulk disposition producer:
 * `tool_commit` (the git SHA the producer ran at), `tool_source_digest`
 * (SHA-256 over the producer's OWN source at run time), and the
 * dirty-worktree guard with its `--allow-dirty-worktree=<reason>` override.
 * @module scripts/indexer/smi5879-dispose-terminal.provenance
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *   Item 7 — "`tool_commit` alone doesn't prove what code ran (a dirty
 *   worktree could execute something else). `tool_source_digest` closes this;
 *   the producer refuses to stage a batch from a dirty worktree (checked via
 *   `git status --porcelain` against its own file) unless an explicit
 *   `--allow-dirty-worktree=<reason>` override is passed, which itself gets
 *   recorded in the batch's `reason` field."
 *
 * Git is read here, never mutated: `rev-parse` and `status --porcelain` only.
 * Every invocation uses `execFileSync` with ARRAY args (never `execSync`
 * string interpolation), per the repo's shell-injection standard.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Injection seam — array args only, mirroring {@link defaultGitRunner}. */
export type GitRunner = (args: readonly string[], cwd: string) => string

export function defaultGitRunner(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export type SourceReader = (absolutePath: string) => string

const defaultSourceReader: SourceReader = (path) => readFileSync(path, 'utf8')

/**
 * Is this repo-relative path one of the producer's OWN modules ("CORE")?
 *
 * CORE is every `scripts/indexer/smi5879-dispose-terminal*` module plus the
 * two modules the producer owns under different names because they are
 * deliberately SHARED with gate-check (`smi5879-disposition-digest.ts`,
 * `smi5879-terminal-derivation.ts` — the plan requires one implementation of
 * each so producer and gate can never compute a different answer).
 *
 * Exported so the drift test in `smi5879-dispose-terminal.test.ts` derives
 * {@link PRODUCER_SOURCE_FILES} from the SAME rule this file documents,
 * rather than from a second hand-maintained copy of it.
 */
export function isProducerCoreModule(repoRelativePath: string): boolean {
  const prefix = 'scripts/indexer/'
  if (!repoRelativePath.startsWith(prefix)) return false
  const basename = repoRelativePath.slice(prefix.length)
  if (basename.includes('/')) return false
  return (
    basename.startsWith('smi5879-dispose-terminal') ||
    basename === 'smi5879-disposition-digest.ts' ||
    basename === 'smi5879-terminal-derivation.ts'
  )
}

/**
 * The source files, repo-root-relative, that `tool_source_digest` covers.
 *
 * THE BOUNDARY RULE (SMI-6444 adversarial review, queen-ratified): **CORE
 * ({@link isProducerCoreModule}) plus every RELATIVE import target of a CORE
 * file — one hop, not the transitive closure.**
 *
 * Why one hop, and not "the producer's own files" (the original, narrower
 * list): Item 7's whole point is that `tool_source_digest` pins *what code
 * ran*. A list of only CORE files did not do that. `parseSkillMdUrl`
 * (`_shared/skill-md-fetch.ts`) is the predicate deciding `url_parse`
 * classification, stratification, AND the `apiUrl` the live re-check actually
 * fetches; `smi5879-gate-check.ledger-validation.ts` owns every shape rule
 * and the reconstruction the ledger is serialized from;
 * `smi5879-merge-shards.population.ts` IS the digest-verification gate. All
 * were invisible to the digest while their thin CORE wrappers were covered —
 * incoherent on its own terms.
 *
 * Why NOT the transitive closure: that is 105 files, because
 * `smi5879-simulate-full.helpers.ts` reaches the whole security scanner. One
 * hop is the right stopping point because `computeToolSourceDigest` hashes a
 * FLAT LIST — each named file's own content, never its imports — so listing a
 * file pins exactly that file. One hop therefore covers every module whose
 * logic a CORE file directly invokes, at a cost of 14 extra entries rather
 * than 82, and without making an unrelated scanner edit refuse a staging run
 * or invalidate an in-flight `.sample.json` resume.
 *
 * Known, accepted residual of the one-hop rule: a two-hop module still
 * escapes the digest — most notably
 * `smi5879-gate-check.disposition-batch.ts` (reached via
 * `ledger-validation.ts`), which owns the per-batch accounting invariants.
 * The drift test pins the rule, so widening to two hops later is a deliberate
 * one-line change, not a silent one.
 *
 * Repo-relative (never absolute) so the digest is reproducible across
 * checkouts, worktrees, and the container's `/app` mount alike. Sorted, and
 * `computeToolSourceDigest` sorts again, so ordering here is presentational.
 */
export const PRODUCER_SOURCE_FILES: readonly string[] = [
  // --- one-hop: modules a CORE file directly imports ---
  'scripts/indexer/_shared/github-auth.ts',
  'scripts/indexer/_shared/rate-limit.ts',
  'scripts/indexer/_shared/skill-md-fetch.ts',
  'scripts/indexer/smi5879-census.pg.ts',
  // --- CORE: the producer's own modules ---
  'scripts/indexer/smi5879-dispose-terminal.action.dispose.ts',
  'scripts/indexer/smi5879-dispose-terminal.action.primary-not-found.fetch.ts',
  'scripts/indexer/smi5879-dispose-terminal.action.primary-not-found.ts',
  'scripts/indexer/smi5879-dispose-terminal.action.ts',
  'scripts/indexer/smi5879-dispose-terminal.action.unfetchable.ts',
  'scripts/indexer/smi5879-dispose-terminal.db.ts',
  'scripts/indexer/smi5879-dispose-terminal.io.ts',
  'scripts/indexer/smi5879-dispose-terminal.ledger.helpers.ts',
  'scripts/indexer/smi5879-dispose-terminal.ledger.mutations.ts',
  'scripts/indexer/smi5879-dispose-terminal.ledger.revocations.ts',
  'scripts/indexer/smi5879-dispose-terminal.ledger.ts',
  'scripts/indexer/smi5879-dispose-terminal.ledger.types.ts',
  'scripts/indexer/smi5879-dispose-terminal.provenance.ts',
  'scripts/indexer/smi5879-dispose-terminal.sidecar.derive.ts',
  'scripts/indexer/smi5879-dispose-terminal.sidecar.ts',
  'scripts/indexer/smi5879-dispose-terminal.sidecar.types.ts',
  'scripts/indexer/smi5879-dispose-terminal.sidecar.validation.ts',
  'scripts/indexer/smi5879-dispose-terminal.stats.helpers.ts',
  'scripts/indexer/smi5879-dispose-terminal.stats.ts',
  'scripts/indexer/smi5879-dispose-terminal.stats.types.ts',
  // The command surface itself — a digest that pinned "what the ledger/
  // sidecar core does" while leaving "what the CLI asked it to do" unpinned
  // would not pin what ran.
  'scripts/indexer/smi5879-dispose-terminal.ts',
  'scripts/indexer/smi5879-disposition-digest.ts',
  // --- one-hop, continued ---
  'scripts/indexer/smi5879-fetch-retry.ts',
  'scripts/indexer/smi5879-gate-check.field-parsers.ts',
  'scripts/indexer/smi5879-gate-check.helpers.ts',
  'scripts/indexer/smi5879-gate-check.io.ts',
  'scripts/indexer/smi5879-gate-check.ledger-validation.ts',
  'scripts/indexer/smi5879-gate-check.types.ts',
  'scripts/indexer/smi5879-merge-shards.population.ts',
  'scripts/indexer/smi5879-simulate-full.db.ts',
  'scripts/indexer/smi5879-simulate-full.helpers.ts',
  'scripts/indexer/smi5879-simulate-full.types.ts',
  // --- CORE, continued ---
  'scripts/indexer/smi5879-terminal-derivation.ts',
]

export interface ToolCommitOptions {
  repoRoot: string
  git?: GitRunner
}

/** `git rev-parse HEAD`, trimmed. Throws if git itself fails — a batch must
 *  never record an unknown or fabricated `tool_commit`. */
export function resolveToolCommit(opts: ToolCommitOptions): string {
  const git = opts.git ?? defaultGitRunner
  const sha = git(['rev-parse', 'HEAD'], opts.repoRoot).trim()
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`resolveToolCommit: "git rev-parse HEAD" returned an unexpected value: ${sha}`)
  }
  return sha
}

export interface ToolSourceDigestOptions {
  repoRoot: string
  /** Repo-relative paths. Order-insensitive — sorted before digesting. */
  files: readonly string[]
  readSource?: SourceReader
}

/**
 * SHA-256 over `"<relPath>\n<sha256(content)>\n"` for each file, sorted by
 * relative path. Per-file digests (rather than concatenated contents) keep
 * the computation streaming-friendly and make a mismatch attributable to one
 * file when debugging a refused resume.
 */
export function computeToolSourceDigest(opts: ToolSourceDigestOptions): string {
  const readSource = opts.readSource ?? defaultSourceReader
  const sorted = [...opts.files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const outer = createHash('sha256')
  for (const relPath of sorted) {
    const content = readSource(join(opts.repoRoot, relPath))
    outer.update(`${relPath}\n${createHash('sha256').update(content).digest('hex')}\n`)
  }
  return outer.digest('hex')
}

export interface DirtyWorktreeOptions {
  repoRoot: string
  /** Repo-relative paths to scope the status check to. */
  files: readonly string[]
  git?: GitRunner
}

/**
 * Repo-relative paths among `files` that `git status --porcelain` reports as
 * modified/staged/untracked. Scoped with an explicit `--` pathspec so an
 * unrelated dirty file elsewhere in the tree never blocks staging.
 */
export function detectDirtyWorktree(opts: DirtyWorktreeOptions): string[] {
  const git = opts.git ?? defaultGitRunner
  const output = git(['status', '--porcelain', '--', ...opts.files], opts.repoRoot)
  const dirty = new Set<string>()
  for (const line of output.split('\n')) {
    if (line.trim().length === 0) continue
    // Porcelain v1: two status columns, a space, then the path (or
    // "old -> new" for a rename; the post-rename path is what matters).
    const path = line.slice(3).trim()
    const renamed = path.split(' -> ')
    const finalPath = renamed[renamed.length - 1] ?? path
    dirty.add(finalPath.replace(/^"|"$/g, ''))
  }
  return [...dirty].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export interface ToolProvenance {
  tool_commit: string
  tool_source_digest: string
  /** Repo-relative dirty paths at run time; empty on a clean worktree. */
  dirtyPaths: string[]
  /** True iff the run proceeded over a dirty worktree via the override. */
  dirtyOverrideUsed: boolean
  /**
   * Sentence the caller MUST append to the batch's `reason` when the override
   * was used (empty string otherwise) — Item 7 requires the override reason
   * be recorded in the batch itself, not just passed on the command line.
   */
  reasonSuffix: string
}

export interface ResolveToolProvenanceOptions {
  repoRoot: string
  files?: readonly string[]
  /** The `--allow-dirty-worktree=<reason>` value, when supplied. */
  allowDirtyWorktreeReason?: string
  git?: GitRunner
  readSource?: SourceReader
}

/**
 * Resolve `tool_commit` + `tool_source_digest` and enforce the dirty-worktree
 * guard in one call. A dirty worktree with no override is a REFUSAL, not a
 * warning — `tool_commit` would otherwise name a commit whose content is not
 * what actually ran.
 */
export function resolveToolProvenance(
  opts: ResolveToolProvenanceOptions
): { ok: true; provenance: ToolProvenance } | { ok: false; reason: string } {
  const files = opts.files ?? PRODUCER_SOURCE_FILES
  const dirtyPaths = detectDirtyWorktree({
    repoRoot: opts.repoRoot,
    files,
    ...(opts.git !== undefined ? { git: opts.git } : {}),
  })
  const overrideReason =
    typeof opts.allowDirtyWorktreeReason === 'string' ? opts.allowDirtyWorktreeReason.trim() : ''
  if (dirtyPaths.length > 0 && overrideReason.length === 0) {
    return {
      ok: false,
      reason:
        `refusing to stage from a dirty worktree — ${dirtyPaths.length} producer source file(s) differ from HEAD ` +
        `(${dirtyPaths.join(', ')}); tool_commit would name a commit whose content is not what ran. ` +
        'Commit the changes, or re-run with --allow-dirty-worktree="<reason>" (the reason is recorded in the batch).',
    }
  }
  const dirtyOverrideUsed = dirtyPaths.length > 0 && overrideReason.length > 0
  return {
    ok: true,
    provenance: {
      tool_commit: resolveToolCommit({
        repoRoot: opts.repoRoot,
        ...(opts.git !== undefined ? { git: opts.git } : {}),
      }),
      tool_source_digest: computeToolSourceDigest({
        repoRoot: opts.repoRoot,
        files,
        ...(opts.readSource !== undefined ? { readSource: opts.readSource } : {}),
      }),
      dirtyPaths,
      dirtyOverrideUsed,
      reasonSuffix: dirtyOverrideUsed
        ? ` Staged from a DIRTY worktree via --allow-dirty-worktree="${overrideReason}" (dirty: ${dirtyPaths.join(', ')}).`
        : '',
    },
  }
}

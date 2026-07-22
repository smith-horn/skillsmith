#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createLogger } from '@skillsmith/core/logging'
import { probeEmbeddingCapability } from '@skillsmith/core/embeddings/probe'
import { repoRoot } from './config.js'
import { runIndexer } from './indexer.js'
import {
  readEntry,
  recordRun,
  resolveMainRepoKey,
  writeEntry,
} from './retrieval-log/reindex-state.js'

// SMI-5793: reuses the shared SMI-5615 structured logger (new 'doc-retrieval'
// surface) so every reindex run — success or failure — persists to
// ~/.skillsmith/logs/skillsmith-doc-retrieval-<date>.jsonl, surviving the
// fire-and-forget `.husky/post-commit` backgrounding that previously left
// this trigger with zero observability (the gap that let SMI-5786 run
// silently broken for ~3 months).
const reindexLogger = createLogger('doc-retrieval')

export async function main(argv: string[] = process.argv): Promise<void> {
  const [, , command, ...rest] = argv
  if (command === 'reindex') {
    // Reindex needs INFO-level success visibility by default — the shared
    // logger's global default (warn) would otherwise silently drop every
    // successful-run record, reproducing this feature's own root problem.
    // Guarded so an operator's explicit SKILLSMITH_LOG_LEVEL always wins.
    // Scoped to this short-lived one-shot process only — never touches the
    // MCP server's or other CLI commands' verbosity.
    if (!process.env.SKILLSMITH_LOG_LEVEL) process.env.SKILLSMITH_LOG_LEVEL = 'info'

    const mode = rest.includes('--full') ? 'full' : 'incremental'
    const quiet = rest.includes('--quiet')
    const t0 = Date.now()

    // SMI-5793: reindex.state is keyed by resolveMainRepoKey() — main-repo-
    // shared, matching auto-heal/liveness — since the reindex corpus itself
    // is always main-repo-shared (see reindex-state.ts's module doc). A null
    // key (git unavailable / cwd not a repo) fails soft: the run still logs
    // via reindexLogger, it just isn't reflected in the state-consumer banner.
    const stateKey = resolveMainRepoKey(repoRoot())
    const priorEntry = stateKey ? readEntry(stateKey) : null

    let sha: string | null = null
    try {
      sha = execFileSync('git', ['-C', repoRoot(), 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim()
    } catch {
      sha = null // detached/shallow edge state — banner's hung-check simply skips without a sha
    }

    // SMI-5039: lazy probe — reindex is the only CLI command that exercises
    // the embedding pipeline. `status` is metadata-only and doesn't need it.
    // `--quiet` (and the SKILLSMITH_QUIET env var) suppress the operator
    // warning; the probe still runs to warm the module-load cache.
    try {
      await probeEmbeddingCapability({ quiet })
      const result = await runIndexer(mode, { quiet })
      reindexLogger.info('reindex run completed', {
        event: 'reindex_run',
        mode: result.mode,
        filesScanned: result.filesScanned,
        chunksUpserted: result.chunksUpserted,
        chunksDeleted: result.chunksDeleted,
        durationMs: result.durationMs,
        sha,
      })
      if (stateKey) {
        writeEntry(
          stateKey,
          recordRun(priorEntry, {
            lastRunTs: new Date().toISOString(),
            lastRunSha: sha,
            mode: result.mode,
            filesScanned: result.filesScanned,
            chunksUpserted: result.chunksUpserted,
            chunksDeleted: result.chunksDeleted,
            durationMs: result.durationMs,
            success: true,
          })
        )
      }
      if (!quiet) {
        console.log(JSON.stringify(result, null, 2))
      }
      return
    } catch (err) {
      const durationMs = Date.now() - t0
      reindexLogger.error('reindex run failed', {
        event: 'reindex_run_failed',
        err,
        mode,
        durationMs,
      })
      if (stateKey) {
        writeEntry(
          stateKey,
          recordRun(priorEntry, {
            lastRunTs: new Date().toISOString(),
            lastRunSha: sha,
            mode,
            filesScanned: 0,
            chunksUpserted: 0,
            chunksDeleted: 0,
            durationMs,
            success: false,
            errorReason: (err instanceof Error ? err.message : String(err)).slice(0, 200),
          })
        )
      }
      throw err // preserves the existing outer main().catch() → process.exit(1) contract
    }
  }
  if (command === 'status') {
    const { getStatus } = await import('./status.js')
    const status = await getStatus()
    console.log(JSON.stringify(status, null, 2))
    return
  }
  console.error(
    'Usage: skillsmith-doc-retrieval-cli <reindex [--full|--incremental] [--quiet] | status>'
  )
  process.exit(2)
}

// SMI-5793: entry-point guard (mirrors server.ts's SMI-5718 guard exactly) —
// only run main() when this file is the process's actual entry point
// (`node dist/src/cli.js`), not when cli.test.ts imports it to exercise the
// reindex branch directly.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error('[doc-retrieval] error:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}

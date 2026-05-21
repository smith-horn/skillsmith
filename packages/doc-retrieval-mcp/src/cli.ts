#!/usr/bin/env node
import { probeEmbeddingCapability } from '@skillsmith/core/embeddings/probe'
import { runIndexer } from './indexer.js'

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv
  if (command === 'reindex') {
    const mode = rest.includes('--full') ? 'full' : 'incremental'
    const quiet = rest.includes('--quiet')
    // SMI-5039: lazy probe — reindex is the only CLI command that exercises
    // the embedding pipeline. `status` is metadata-only and doesn't need it.
    // `--quiet` (and the SKILLSMITH_QUIET env var) suppress the operator
    // warning; the probe still runs to warm the module-load cache.
    await probeEmbeddingCapability({ quiet })
    const result = await runIndexer(mode, { quiet })
    if (!quiet) {
      console.log(JSON.stringify(result, null, 2))
    }
    return
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

main().catch((err) => {
  console.error('[doc-retrieval] error:', err instanceof Error ? err.message : err)
  process.exit(1)
})

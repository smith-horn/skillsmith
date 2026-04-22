#!/usr/bin/env node
import { runIndexer } from './indexer.js'

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv
  if (command === 'reindex') {
    const mode = rest.includes('--full') ? 'full' : 'incremental'
    const quiet = rest.includes('--quiet')
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

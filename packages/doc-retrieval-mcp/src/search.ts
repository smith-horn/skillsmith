// SMI-4426: scaffold — see indexer.ts header comment.
import type { SearchHit } from './types.js'

export interface SearchOpts {
  query: string
  k?: number
  minScore?: number
  scopeGlobs?: string[]
  configPath?: string
}

const RUVECTOR_BLOCKED =
  'doc-retrieval: RuVector integration is blocked on SMI-4426 ' +
  '(https://linear.app/smith-horn-group/issue/SMI-4426). ' +
  'The scaffold in PR #722 (SMI-4417) has not been runtime-validated against ' +
  '@ruvector/core. See .claude/development/ruvector-dev-tooling.md.'

export async function search(_opts: SearchOpts): Promise<SearchHit[]> {
  throw new Error(RUVECTOR_BLOCKED)
}

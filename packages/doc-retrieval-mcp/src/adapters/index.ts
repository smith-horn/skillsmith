import type { AdapterConfig, SourceAdapter } from '../types.js'
import type { CorpusConfig } from '../config.js'
import { createMarkdownCorpusAdapter } from './markdown-corpus.js'
import { createMemoryTopicFilesAdapter } from './memory-topic-files.js'
import { createScriptHeadersAdapter } from './script-headers.js'
import { createSupabaseMigrationsAdapter } from './supabase-migrations.js'

/**
 * Adapter registry (SMI-4450 Wave 1 Step 4). Resolves a `CorpusConfig` into
 * the ordered list of `SourceAdapter` instances the indexer should run.
 *
 * Contract:
 * - The default `markdown-corpus` adapter is ALWAYS included first. It
 *   covers the legacy glob-based pipeline with identical semantics.
 * - Additional adapters are wired in by `kind` in `corpus.config.json`
 *   under the `adapters` array (new, optional field). Unknown kinds throw
 *   at load time so a typo in config surfaces immediately rather than
 *   silently producing an empty ingest for that source.
 * - `enabled: false` entries are skipped without throwing — operational
 *   off-switch for flaky adapters.
 */
export function buildRegistry(cfg: CorpusConfig): SourceAdapter[] {
  const adapters: SourceAdapter[] = [createMarkdownCorpusAdapter()]

  const extras = cfg.adapters ?? []
  for (const entry of extras) {
    if (entry.enabled === false) continue
    adapters.push(instantiate(entry))
  }

  return adapters
}

function instantiate(entry: AdapterConfig): SourceAdapter {
  switch (entry.kind) {
    case 'memory-topic-files':
      return createMemoryTopicFilesAdapter()
    case 'script-headers':
      return createScriptHeadersAdapter()
    case 'supabase-migrations':
      return createSupabaseMigrationsAdapter()
    // Remaining adapters land in subsequent commits of SMI-4451 Wave 1 Step 4.
    // Unknown kinds throw so typos in corpus.config.json surface immediately.
    default:
      throw new Error(
        `adapter registry: unknown adapter kind "${entry.kind}". ` +
          `Known kinds: markdown-corpus (implicit default), memory-topic-files, ` +
          `script-headers, supabase-migrations. Future kinds wired in ` +
          `SMI-4451 Wave 1 Step 4: github-pr-bodies, git-commits.`
      )
  }
}

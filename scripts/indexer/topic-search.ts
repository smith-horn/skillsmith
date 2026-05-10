/**
 * Topic-search types — Node-side shim (Wave 1 stub)
 * @module scripts/indexer/topic-search
 *
 * SMI-4852 Wave 1: This file exports ONLY the `GitHubRepository` type so the
 * helpers ported in Wave 1 (`skill-processor.helpers.ts`, `parity.test.ts`)
 * compile in isolation. The full `searchRepositories` + `countGitHubSkillFiles`
 * implementations are ported in Wave 1.5 (see `scripts/indexer/run.ts`
 * docblock); the type stays as the canonical Node-side surface here so
 * downstream files can import from `./topic-search.ts` once those ports land.
 *
 * Type body is byte-identical to the Deno parent at
 * `supabase/functions/indexer/topic-search.ts:20-46` — drift guarded by the
 * parity test once the runtime exports are added.
 */

export interface GitHubRepository {
  owner: string
  name: string
  fullName: string
  description: string | null
  url: string
  stars: number
  forks: number
  topics: string[]
  updatedAt: string
  defaultBranch: string
  installable: boolean
  // SMI-2376: Preserve GitHub repo name and skill path separately from display name.
  repoName: string
  skillPath?: string
  // SMI-2658: SPDX license identifier from GitHub API.
  license?: string | null
  // SMI-4387: Discovery path that surfaced this repo.
  discoveryPath?: string
}

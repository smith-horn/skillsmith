import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { loadConfig, resolveRepoPath } from './config.js'
import { MetadataStore } from './metadata-store.js'
import type { IndexState, StatusInfo } from './types.js'

export async function getStatus(configPath?: string): Promise<StatusInfo> {
  const cfg = await loadConfig(configPath)
  const metaAbs = resolveRepoPath(cfg.metadataPath)
  const stateAbs = resolveRepoPath(cfg.stateFile)
  const rvfAbs = resolveRepoPath(cfg.rvfPath)

  const store = existsSync(metaAbs) ? await MetadataStore.load(metaAbs) : null
  const state: IndexState | null = existsSync(stateAbs)
    ? (JSON.parse(await readFile(stateAbs, 'utf8')) as IndexState)
    : null

  return {
    chunkCount: store?.size() ?? 0,
    fileCount: store?.fileCount() ?? 0,
    lastIndexedSha: state?.lastIndexedSha ?? null,
    lastRunAt: state?.lastRunAt ?? null,
    rvfPath: rvfAbs,
    corpusVersion: state?.corpusVersion ?? 0,
  }
}

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { loadConfig, resolveRepoPath } from './config.js'
import { MetadataStore } from './metadata-store.js'
import { readTierBPairsState } from './tier-b-flag.js'
import type { IndexState, StatusInfo } from './types.js'

export async function getStatus(
  configPath?: string,
  opts?: { tierBFlagPath?: string }
): Promise<StatusInfo> {
  const cfg = await loadConfig(configPath)
  const metaAbs = resolveRepoPath(cfg.metadataPath)
  const stateAbs = resolveRepoPath(cfg.stateFile)
  const storagePathAbs = resolveRepoPath(cfg.storagePath)

  const store = existsSync(metaAbs) ? await MetadataStore.load(metaAbs) : null
  const state: IndexState | null = existsSync(stateAbs)
    ? (JSON.parse(await readFile(stateAbs, 'utf8')) as IndexState)
    : null

  // SMI-7201: surface the Tier-B pair flag; the field is absent when no flag exists.
  const tierBState = readTierBPairsState(opts?.tierBFlagPath)

  return {
    chunkCount: store?.size() ?? 0,
    fileCount: store?.fileCount() ?? 0,
    lastIndexedSha: state?.lastIndexedSha ?? null,
    lastRunAt: state?.lastRunAt ?? null,
    storagePath: storagePathAbs,
    corpusVersion: state?.corpusVersion ?? 0,
    ...(tierBState !== null ? { degraded: `tier-b-pairs ${tierBState}` } : {}),
  }
}

/**
 * SMI-4577: HNSW search backend for `EmbeddingService.findSimilar`.
 *
 * Lazily loads `hnswlib-node` (declared as `optionalDependencies` on
 * @skillsmith/core), builds or loads an on-disk index at
 * `~/.skillsmith/cache/hnsw-{modelName}.{bin,meta.json,labels.json}`,
 * and exposes incremental `addPoint`/`markDelete` semantics with a debounced
 * atomic-rename persist.
 *
 * Failure modes:
 *  - `MODULE_NOT_FOUND` on import → permanently disable; brute-force fallback
 *    in `EmbeddingService.findSimilar` covers the case.
 *  - `readIndex` failure on a corrupt cache → delete + rebuild on next call
 *    (treat as transient).
 *  - Concurrent writers → atomic-rename (`writeIndex` to `.tmp`,
 *    `fs.renameSync` to final). Loser-of-race acceptable; readers re-read
 *    via the atomic pointer.
 *
 * @see ADR-009 (2026-05 amendment): brute-force fallback retained for
 * environments where the optional dep failed to install.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { getCacheDir } from '../config/index.js'
import type { HierarchicalNSW, HierarchicalNSWConstructor } from './hnsw-store.types.js'

/**
 * Persisted metadata describing the on-disk HNSW index. Used to invalidate the
 * cached graph when the embedding count, model, or vector dimension drift.
 */
export interface HnswMeta {
  /** Schema version. Bump on incompatible meta changes. */
  version: 1
  /** Model identifier (e.g. `Xenova/all-MiniLM-L6-v2`). */
  modelName: string
  /** Vector dimensionality. */
  dim: number
  /** Number of points the cache was built from. */
  count: number
  /** ISO timestamp the cache was last persisted. */
  builtAt: string
}

/**
 * Wrapper exposing the live HNSW index plus the bookkeeping needed by
 * `EmbeddingService` to rewire incremental upserts/removes.
 */
export interface HnswHandle {
  /** The live HNSW index. */
  index: HierarchicalNSW
  /** label → skillId mapping (HNSW returns numeric labels). */
  labelToId: Map<number, string>
  /** skillId → label mapping (for incremental updates / deletes). */
  idToLabel: Map<string, number>
  /** Next label to assign for new points. */
  nextLabel: number
  /** Filesystem paths the index will read/write. Exposed for diagnostics/tests. */
  paths: HnswCachePaths
  /** Schedule a debounced persist (5s). Safe to call repeatedly. */
  schedulePersist: () => void
  /** Persist immediately (used at shutdown / for tests). */
  persistNow: () => void
}

export interface HnswCachePaths {
  bin: string
  meta: string
  labels: string
  binTmp: string
  metaTmp: string
  labelsTmp: string
}

/**
 * Status reported back to `EmbeddingService` so it can distinguish
 * "the optional dep is missing" (permanent) from "we hit a transient
 * write error" (try again next time).
 */
export type HnswStatus =
  | { kind: 'ok'; handle: HnswHandle }
  | { kind: 'permanently-unavailable'; reason: string }
  | { kind: 'temporarily-unavailable'; reason: string }

/**
 * One-shot module loader. Cached across calls; on `MODULE_NOT_FOUND` the
 * caller receives a sentinel and is expected to permanently disable HNSW.
 */
let cachedCtor: HierarchicalNSWConstructor | null | 'unavailable' = null

/**
 * Dynamically load `hnswlib-node`. Returns the constructor or `null` when the
 * optional dependency is not installed (Vercel build, restricted hosts).
 *
 * Uses a literal dynamic `import()` (not the `Function('return import(...)')()`
 * pattern that lives in `hnsw-store.helpers.ts`); vitest's vm-mode ESM rejects
 * the latter with "A dynamic import callback was not specified." A native
 * dynamic import is safe here because `hnswlib-node` is a CJS module that's
 * not type-imported anywhere — only TS will error on resolution failure, but
 * we catch that in the `catch` block below.
 */
async function loadHnswCtor(): Promise<HierarchicalNSWConstructor | null> {
  if (cachedCtor === 'unavailable') return null
  if (cachedCtor !== null) return cachedCtor
  try {
    // hnswlib-node is CJS; ESM dynamic import lifts its `module.exports` onto
    // `.default`. Some bundlers / older Node versions also surface named
    // exports at the top level — check both shapes so we work in every
    // environment.
    //
    // Note: a previous codebase pattern used `Function('return import(...)')()`
    // here. Vitest's vm-mode ESM rejects that with "A dynamic import callback
    // was not specified" so we use a literal dynamic `import()`. The string
    // literal is intentional to keep TypeScript from re-routing the specifier
    // (`hnswlib-node` is in `optionalDependencies`, not a hard dep).
    const mod = (await import('hnswlib-node')) as unknown as {
      HierarchicalNSW?: HierarchicalNSWConstructor
      default?: { HierarchicalNSW?: HierarchicalNSWConstructor }
    }
    const ctor = mod.HierarchicalNSW ?? mod.default?.HierarchicalNSW
    if (!ctor) {
      cachedCtor = 'unavailable'
      return null
    }
    cachedCtor = ctor
    return cachedCtor
  } catch {
    cachedCtor = 'unavailable'
    return null
  }
}

function cachePaths(modelName: string): HnswCachePaths {
  // Sanitize model name (slashes become double-underscore so we don't
  // accidentally create nested directories under cache/).
  const safeName = modelName.replace(/[/\\]/g, '__')
  const dir = getCacheDir()
  const base = join(dir, `hnsw-${safeName}`)
  return {
    bin: `${base}.bin`,
    meta: `${base}.meta.json`,
    labels: `${base}.labels.json`,
    binTmp: `${base}.bin.tmp`,
    metaTmp: `${base}.meta.json.tmp`,
    labelsTmp: `${base}.labels.json.tmp`,
  }
}

function readMeta(metaPath: string): HnswMeta | null {
  if (!existsSync(metaPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf-8')) as HnswMeta
    if (parsed.version !== 1) return null
    return parsed
  } catch {
    return null
  }
}

function readLabels(labelsPath: string): Array<[number, string]> | null {
  if (!existsSync(labelsPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(labelsPath, 'utf-8')) as Array<[number, string]>
    if (!Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

function writeAtomic(tmp: string, final: string, contents: string | Buffer): void {
  mkdirSync(dirname(tmp), { recursive: true })
  writeFileSync(tmp, contents, typeof contents === 'string' ? { encoding: 'utf-8' } : undefined)
  renameSync(tmp, final)
}

/**
 * Build (or load from cache) an HNSW index for the supplied embedding map.
 *
 * `embeddings` is the canonical source of truth (from `EmbeddingService`'s
 * SQLite cache). On a cold start with a populated cache file matching
 * meta.json, we `readIndex` and skip the rebuild. Otherwise we initialise
 * a fresh index and add every point — same I/O cost as a brute-force seed
 * but the resulting graph survives subsequent `findSimilar` calls.
 */
export async function loadOrBuildHnsw(args: {
  embeddings: Map<string, Float32Array>
  modelName: string
  dim: number
  /** Capacity hint. Defaults to ~2x current size, clamped to 1024 minimum. */
  maxElements?: number
  /** Override hyperparams. Defaults match `DEFAULT_HNSW_CONFIG` in hnsw-store.types.ts. */
  m?: number
  efConstruction?: number
  efSearch?: number
}): Promise<HnswStatus> {
  const Ctor = await loadHnswCtor()
  if (!Ctor) {
    return {
      kind: 'permanently-unavailable',
      reason: 'hnswlib-node not installed (optionalDependencies)',
    }
  }

  const paths = cachePaths(args.modelName)
  const meta = readMeta(paths.meta)
  const labels = readLabels(paths.labels)
  const count = args.embeddings.size
  // R2 mitigation: defaults tuned to clear the recall@10 ≥ 0.95 gate.
  // m=32/efConstruction=400/efSearch=200 is the `large` preset from
  // hnsw-store.types.ts and matches what the original SMI-1519 design
  // documented for 100k-scale skill registries. At 14k synthetic vectors
  // we still see >100x speedup vs brute-force p99.
  const m = args.m ?? 32
  const efConstruction = args.efConstruction ?? 400
  const efSearch = args.efSearch ?? 200
  const capacity = Math.max(args.maxElements ?? Math.max(count * 2, 1024), 1024)

  const reusable =
    meta !== null &&
    labels !== null &&
    meta.modelName === args.modelName &&
    meta.dim === args.dim &&
    meta.count === count &&
    existsSync(paths.bin)

  let index: HierarchicalNSW
  let labelToId: Map<number, string>
  let idToLabel: Map<string, number>
  let nextLabel: number

  if (reusable) {
    try {
      index = new Ctor('cosine', args.dim)
      // Use sync read; the async `readIndex` returns a Promise we'd have to
      // await, defeating the synchronous boot path. Sync is fine here — the
      // file is < a few MB at expected scale.
      index.readIndexSync(paths.bin, true)
      index.setEf(efSearch)
      labelToId = new Map(labels!)
      idToLabel = new Map(labels!.map(([label, id]) => [id, label]))
      nextLabel = labels!.reduce((max, [label]) => Math.max(max, label), -1) + 1
    } catch (err) {
      // Corrupt cache — wipe and recurse for a fresh build. The retry will
      // hit `reusable === false` because we just removed the artefacts.
      try {
        if (existsSync(paths.bin)) unlinkSync(paths.bin)
        if (existsSync(paths.meta)) unlinkSync(paths.meta)
        if (existsSync(paths.labels)) unlinkSync(paths.labels)
      } catch {
        /* best-effort cleanup */
      }
      try {
        return await loadOrBuildHnsw(args)
      } catch (retryErr) {
        return {
          kind: 'temporarily-unavailable',
          reason: `cache rebuild failed after corrupt-load: ${String(retryErr)} (initial: ${String(err)})`,
        }
      }
    }
  } else {
    index = new Ctor('cosine', args.dim)
    index.initIndex(capacity, m, efConstruction)
    index.setEf(efSearch)
    labelToId = new Map()
    idToLabel = new Map()
    let nextLabelLocal = 0
    for (const [skillId, vec] of args.embeddings) {
      // hnswlib-node@3 expects a plain Array<number> for addPoint, not a
      // typed array — passing Float32Array surfaces as
      // "Invalid the first argument type, must be an Array."
      index.addPoint(Array.from(vec), nextLabelLocal)
      labelToId.set(nextLabelLocal, skillId)
      idToLabel.set(skillId, nextLabelLocal)
      nextLabelLocal++
    }
    nextLabel = nextLabelLocal
  }

  const handle = createHandle({
    index,
    labelToId,
    idToLabel,
    nextLabel,
    dim: args.dim,
    modelName: args.modelName,
    paths,
  })

  // Immediate persist after a fresh build. Reusable path skips this — the
  // on-disk artefacts already match.
  if (!reusable) {
    try {
      handle.persistNow()
    } catch (err) {
      return {
        kind: 'temporarily-unavailable',
        reason: `persist after build failed: ${String(err)}`,
      }
    }
  }

  return { kind: 'ok', handle }
}

/**
 * Wrap the raw HNSW index with the bookkeeping needed for incremental upserts
 * + debounced persist. Caller owns the handle's lifecycle (no auto-cleanup).
 */
function createHandle(args: {
  index: HierarchicalNSW
  labelToId: Map<number, string>
  idToLabel: Map<string, number>
  nextLabel: number
  dim: number
  modelName: string
  paths: HnswCachePaths
}): HnswHandle {
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | null = null
  // Mutable closure state — we update via the handle methods below, but the
  // returned object exposes the current values via getters.
  const state = {
    nextLabel: args.nextLabel,
  }

  const persistNow = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!dirty && existsSync(args.paths.bin) && existsSync(args.paths.meta)) {
      // Nothing to write and the cache is already consistent on disk.
      return
    }
    // `writeIndex` is async (returns a Promise) — we want sync semantics so
    // the persist runs to completion inside the debounce callback / on close.
    args.index.writeIndexSync(args.paths.binTmp)
    renameSync(args.paths.binTmp, args.paths.bin)

    const labelsArr: Array<[number, string]> = Array.from(args.labelToId.entries())
    writeAtomic(args.paths.labelsTmp, args.paths.labels, JSON.stringify(labelsArr))

    const meta: HnswMeta = {
      version: 1,
      modelName: args.modelName,
      dim: args.dim,
      count: args.idToLabel.size,
      builtAt: new Date().toISOString(),
    }
    writeAtomic(args.paths.metaTmp, args.paths.meta, JSON.stringify(meta, null, 2))
    dirty = false
  }

  const schedulePersist = (): void => {
    dirty = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      try {
        persistNow()
      } catch (err) {
        // Persist failures are non-fatal — the in-memory index stays valid;
        // a future rebuild will recover from the cached embeddings map.
        // Log the cache path so a user can spot a read-only cache dir.
        console.warn(
          `[hnsw-search] debounced persist failed (path=${args.paths.bin}):`,
          err instanceof Error ? err.message : err
        )
      }
    }, 5000)
    // Don't keep the event loop alive just for this timer.
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  return {
    get index() {
      return args.index
    },
    get labelToId() {
      return args.labelToId
    },
    get idToLabel() {
      return args.idToLabel
    },
    get nextLabel() {
      return state.nextLabel
    },
    set nextLabel(v: number) {
      state.nextLabel = v
    },
    get paths() {
      return args.paths
    },
    schedulePersist,
    persistNow,
  }
}

/**
 * Top-K nearest-neighbour search via the supplied handle.
 *
 * @param handle - HNSW handle returned by `loadOrBuildHnsw`
 * @param query - Query vector (must match `handle.dim`)
 * @param topK - Maximum neighbours to return
 * @returns Result rows in HNSW score order; `score` is `1 - cosineDistance`.
 */
export function findSimilarHnsw(
  handle: HnswHandle,
  query: Float32Array,
  topK: number
): Array<{ skillId: string; score: number }> {
  const liveCount = handle.idToLabel.size
  if (liveCount === 0) return []
  const k = Math.min(topK, liveCount)
  // searchKnn also requires plain Array — Float32Array triggers
  // "Invalid the first argument type, must be an Array."
  const result = handle.index.searchKnn(Array.from(query), k)
  const out: Array<{ skillId: string; score: number }> = []
  for (let i = 0; i < result.neighbors.length; i++) {
    const skillId = handle.labelToId.get(result.neighbors[i])
    if (!skillId) continue // marked-deleted points may still surface; skip
    out.push({ skillId, score: 1 - result.distances[i] })
  }
  return out
}

/**
 * Add or replace a point. Used by `EmbeddingService.storeEmbedding` to keep
 * the in-memory graph aligned with the SQLite cache. Marks the handle dirty;
 * persist happens via the debounced 5s timer (or `persistNow`).
 */
export function upsertPoint(handle: HnswHandle, skillId: string, vector: Float32Array): void {
  const existing = handle.idToLabel.get(skillId)
  if (existing !== undefined) {
    // hnswlib supports `addPoint(..., replaceDeleted=true)` for true
    // replacement; for non-deleted points we mark + reinsert under a new
    // label to preserve correctness across efConstruction tuning.
    handle.index.markDelete(existing)
    handle.labelToId.delete(existing)
  }
  const label = handle.nextLabel
  // Plain Array required (see addPoint comment above).
  handle.index.addPoint(Array.from(vector), label)
  handle.idToLabel.set(skillId, label)
  handle.labelToId.set(label, skillId)
  handle.nextLabel = label + 1
  handle.schedulePersist()
}

/**
 * Mark a point deleted. The point stays in the graph for traversal correctness
 * but `findSimilarHnsw` filters it out via the labelToId lookup.
 */
export function removePoint(handle: HnswHandle, skillId: string): boolean {
  const label = handle.idToLabel.get(skillId)
  if (label === undefined) return false
  handle.index.markDelete(label)
  handle.idToLabel.delete(skillId)
  handle.labelToId.delete(label)
  handle.schedulePersist()
  return true
}

/**
 * Test-only helper — clears the cached `hnswlib-node` constructor reference so
 * tests can simulate "module reinstalled" scenarios. Not part of the public
 * API; do not use in production code.
 *
 * @internal
 */
export function __resetCachedHnswCtorForTests(): void {
  cachedCtor = null
}

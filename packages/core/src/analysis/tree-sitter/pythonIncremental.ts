/**
 * SMI-4293: Python Incremental Parser Controller
 *
 * Couples the WASM tree-sitter parser, per-file tree cache, and edit-based
 * incremental parsing into a single entry point for the Python adapter.
 *
 * Responsibilities:
 *   - Lazy-init the WASM parser (via web-tree-sitter) and Python language
 *     grammar (from tree-sitter-wasms).
 *   - Cache parse trees per file path with LRU eviction (max 100 trees) and
 *     proper `.delete()` lifecycle.
 *   - Apply tree.edit() and reuse the previous tree when content changes
 *     incrementally; fall back to full parse on cache miss or corruption.
 *   - Delegate extraction to pythonExtractor (query-based, replaces regex).
 *
 * @see docs/internal/implementation/github-wave-5c-tree-sitter-incremental.md
 * @module analysis/tree-sitter/pythonIncremental
 */

import * as fs from 'node:fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { ParseResult } from '../types.js'
import { calculateEdit, findMinimalEdit, type FileEdit } from '../incremental.js'
import { createLogger } from '../../utils/logger.js'
import { rateLimited } from '../../utils/rate-limit.js'
import type { TreeSitterLanguage, TreeSitterParser, TreeSitterTree } from './manager.js'
import { PythonQuerySet, extractPythonParseResult, type QueryCtor } from './pythonExtractor.js'

const logger = createLogger('PythonIncrementalParser')

/** First line of a string, truncated to 200 chars. Used to avoid leaking source content into logs. */
function firstLine(s: string): string {
  return s.split('\n', 1)[0]?.slice(0, 200) ?? ''
}

/** Maximum number of cached trees (per SMI-1309 / SMI-4293 spec). */
const DEFAULT_MAX_TREES = 100

/** Resolve the path to the Python WASM grammar distributed via tree-sitter-wasms. */
export function resolvePythonWasmPath(): string {
  // Caller is inside packages/core/dist or packages/core/src; tree-sitter-wasms
  // is hoisted to the repo root node_modules in every layout.
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    // Monorepo root (workspace hoist)
    path.resolve(
      here,
      '..',
      '..',
      '..',
      '..',
      '..',
      'node_modules',
      'tree-sitter-wasms',
      'out',
      'tree-sitter-python.wasm'
    ),
    // Package-local (npm-registry install consumers without hoist)
    path.resolve(
      here,
      '..',
      '..',
      '..',
      '..',
      'node_modules',
      'tree-sitter-wasms',
      'out',
      'tree-sitter-python.wasm'
    ),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  // Neither exists on disk; return the first so `doInit()` has a stable
  // error path to surface. Probe is best-effort — the real load failure
  // is still caught by `doInit()` below.
  return candidates[0]
}

/** Internal cache entry. */
interface CachedEntry {
  tree: TreeSitterTree
  content: string
  lastUsed: number
  /** Memoised extraction result; cleared whenever the tree is edited. */
  lastResult: ParseResult | null
}

/** Options for PythonIncrementalParser. */
export interface PythonIncrementalParserOptions {
  /** Maximum cached trees (default 100). */
  maxTrees?: number
  /** Override path to the Python WASM grammar (tests). */
  wasmPath?: string
}

/** Resolver that returns the WASM dependencies. Exposed for tests. */
export interface WebTreeSitterDeps {
  Parser: new () => TreeSitterParser
  Language: { load(path: string): Promise<TreeSitterLanguage> }
  Query: QueryCtor
  init: () => Promise<void>
}

/** Default loader uses web-tree-sitter. Tests may inject a stub. */
export type WebTreeSitterLoader = () => Promise<WebTreeSitterDeps>

const defaultLoader: WebTreeSitterLoader = async () => {
  // Optional peer; falls back to error if not installed at runtime.
  const mod = (await import('web-tree-sitter')) as unknown as {
    Parser: new () => TreeSitterParser
    Language: { load(path: string): Promise<TreeSitterLanguage> }
    Query: QueryCtor
  }
  return {
    Parser: mod.Parser,
    Language: mod.Language,
    Query: mod.Query,
    // Parser.init is a static method on the named export.
    init: async () => {
      const maybeInit = (mod.Parser as unknown as { init?: () => Promise<void> }).init
      if (typeof maybeInit === 'function') {
        await maybeInit.call(mod.Parser)
      }
    },
  }
}

/**
 * Incremental Python parser: lazily boots web-tree-sitter, parses with
 * `tree.edit()` reuse when possible, falls back gracefully otherwise.
 */
export class PythonIncrementalParser {
  private readonly maxTrees: number
  private readonly wasmPath: string
  private readonly loader: WebTreeSitterLoader
  private readonly cache = new Map<string, CachedEntry>()
  private parser: TreeSitterParser | null = null
  private language: TreeSitterLanguage | null = null
  private queries: PythonQuerySet | null = null
  private initPromise: Promise<void> | null = null
  private initFailed = false
  private useCounter = 0

  constructor(
    options: PythonIncrementalParserOptions = {},
    loader: WebTreeSitterLoader = defaultLoader
  ) {
    this.maxTrees = options.maxTrees ?? DEFAULT_MAX_TREES
    this.wasmPath = options.wasmPath ?? resolvePythonWasmPath()
    this.loader = loader
  }

  /** True when the WASM runtime and Python grammar loaded successfully. */
  get isReady(): boolean {
    return this.parser !== null && this.language !== null && this.queries !== null
  }

  /** True when a prior init attempt failed; callers should use regex fallback. */
  get hasFailedInit(): boolean {
    return this.initFailed
  }

  /**
   * Ensure the WASM parser + Python grammar are loaded. Callers should
   * `await` this once before relying on `parseSync` for a synchronous path.
   */
  async ensureReady(): Promise<void> {
    await this.ensureInit()
  }

  /**
   * Parse asynchronously: ensures init, then delegates to the sync path.
   * Returns null if init has permanently failed (caller falls back to regex).
   */
  async parse(content: string, filePath: string): Promise<ParseResult | null> {
    await this.ensureInit()
    return this.parseSync(content, filePath)
  }

  /**
   * Synchronous parse: usable only after `ensureReady()` has resolved. Uses
   * the previous tree via `tree.edit()` when content changed incrementally.
   *
   * Returns null when the parser isn't ready or any parse/extract step fails;
   * callers should fall back to regex extraction in that case.
   */
  parseSync(content: string, filePath: string): ParseResult | null {
    if (!this.isReady) return null
    const parser = this.parser as TreeSitterParser
    const queries = this.queries as PythonQuerySet

    try {
      const cached = this.cache.get(filePath)
      let tree: TreeSitterTree
      let reusedResult: ParseResult | null = null

      if (cached) {
        const diff = findMinimalEdit(cached.content, content)
        if (!diff) {
          // Unchanged content — reuse tree AND memoised extraction result
          // without re-parse or re-extract.
          this.touch(filePath, cached)
          tree = cached.tree
          reusedResult = cached.lastResult
        } else {
          const edit: FileEdit = calculateEdit(
            cached.content,
            content,
            diff.changeStart,
            diff.changeEnd,
            diff.newText
          )
          // Apply edit to the previous tree. `edit()` is in-place.
          const editable = cached.tree as unknown as { edit(e: FileEdit): void }
          editable.edit(edit)
          tree = parser.parse(content, cached.tree)
          // Replace cached tree; delete old to free WASM memory.
          if (tree !== cached.tree) this.safeDelete(cached.tree)
          this.store(filePath, tree, content)
        }
      } else {
        tree = parser.parse(content)
        this.store(filePath, tree, content)
      }

      if (reusedResult) return reusedResult
      const result = extractPythonParseResult(tree, queries, filePath)
      const entry = this.cache.get(filePath)
      if (entry) entry.lastResult = result
      return result
    } catch (error) {
      // Any failure (corrupt tree, grammar error) invalidates this file's
      // cache and signals the adapter to use regex fallback for this call.
      // Log rate-limited so a pathological grammar hit cannot flood logs.
      // Emit only `{ file, error(firstLine, <=200) }` — never the source
      // content or the stack (tree-sitter errors can quote source lines).
      if (rateLimited(`python-parse:${filePath}`)) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn('Python parseSync failed; regex fallback for this file', {
          file: filePath,
          error: firstLine(message),
        })
      }
      this.invalidate(filePath)
      return null
    }
  }

  /** Invalidate a single file's cache entry and free its tree. */
  invalidate(filePath: string): void {
    const entry = this.cache.get(filePath)
    if (!entry) return
    this.safeDelete(entry.tree)
    this.cache.delete(filePath)
  }

  /** Clear and dispose all cached trees. */
  dispose(): void {
    for (const entry of this.cache.values()) this.safeDelete(entry.tree)
    this.cache.clear()
    if (this.parser) {
      try {
        this.parser.delete()
      } catch {
        // ignore
      }
    }
    this.parser = null
    this.language = null
    this.queries = null
    this.initPromise = null
  }

  /** Current cache size (exposed for tests and instrumentation). */
  get cacheSize(): number {
    return this.cache.size
  }

  // ----------------------------------------------------------------
  // Private
  // ----------------------------------------------------------------

  private async ensureInit(): Promise<void> {
    if (this.isReady || this.initFailed) return
    if (this.initPromise) return this.initPromise
    this.initPromise = this.doInit()
    try {
      await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  private async doInit(): Promise<void> {
    try {
      const deps = await this.loader()
      await deps.init()
      const parser = new deps.Parser()
      const language = await deps.Language.load(this.wasmPath)
      ;(parser as { setLanguage(l: TreeSitterLanguage): void }).setLanguage(language)
      this.parser = parser
      this.language = language
      this.queries = new PythonQuerySet(deps.Query, language)
    } catch (error) {
      this.initFailed = true
      this.parser = null
      this.language = null
      this.queries = null
      // One-shot warn per parser instance: fires at most once in `doInit`.
      // Log `{ wasmPath, error, stack }` for operator diagnostics; the WASM
      // path is not secret, the stack points inside web-tree-sitter /
      // resolvePythonWasmPath, not user source.
      logger.warn('Python tree-sitter init failed; regex fallback in use', {
        wasmPath: this.wasmPath,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      })
    }
  }

  private store(filePath: string, tree: TreeSitterTree, content: string): void {
    if (!this.cache.has(filePath) && this.cache.size >= this.maxTrees) {
      this.evictLRU()
    }
    this.cache.set(filePath, {
      tree,
      content,
      lastUsed: ++this.useCounter,
      lastResult: null,
    })
  }

  private touch(filePath: string, entry: CachedEntry): void {
    entry.lastUsed = ++this.useCounter
    this.cache.set(filePath, entry)
  }

  private evictLRU(): void {
    let oldestKey: string | null = null
    let oldest = Infinity
    for (const [key, entry] of this.cache) {
      if (entry.lastUsed < oldest) {
        oldest = entry.lastUsed
        oldestKey = key
      }
    }
    if (oldestKey) this.invalidate(oldestKey)
  }

  private safeDelete(tree: TreeSitterTree): void {
    try {
      tree.delete()
    } catch {
      // Already-deleted trees throw; swallow for robustness.
    }
  }
}

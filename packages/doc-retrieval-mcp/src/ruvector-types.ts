// SMI-4426: @ruvector/core@0.1.30 ships an index.d.ts that lags the native
// binding. These surfaces work at runtime but are missing from the declared
// types; without this augmentation callers would reach for `as any` at every
// boundary. Pure declaration file — no runtime cost.
//
// A plain `.d.ts` suffix would be caught by the root `.gitignore`
// `packages/**/*.d.ts` rule (intended to exclude build output). Keeping the
// file as `.ts` + module-augmentation syntax produces identical semantics.
//
// Forensic rationale documented in
// docs/internal/implementation/smi-4426-ruvector-runtime-fix.md.

import type {} from '@ruvector/core'

declare module '@ruvector/core' {
  interface VectorEntry {
    metadata?: Record<string, unknown>
  }

  interface SearchQuery {
    filter?: unknown
  }

  interface SearchResult {
    metadata?: Record<string, unknown>
  }

  // `VectorDb.withDimensions(n)` is present at runtime but deliberately not
  // augmented here — the documented constructor `new VectorDb({ dimensions,
  // storagePath, distanceMetric })` is the path Step 2 uses. Adding a static
  // method to an already-exported class across module boundaries requires
  // brittle namespace-merging syntax we don't need for correctness.

  class CollectionManager {
    constructor(options: { storagePath: string })
    createCollection(name: string, options: { dimensions: number }): Promise<unknown>
    getCollection(name: string): Promise<unknown>
    listCollections(): Promise<string[]>
  }
}

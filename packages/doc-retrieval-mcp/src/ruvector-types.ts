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

  // `VectorDb.withDimensions(n)` and `CollectionManager` are present at
  // runtime in @ruvector/core@0.1.30 but deliberately not augmented here —
  // the documented constructor `new VectorDb({ dimensions, storagePath,
  // distanceMetric })` is the path Steps 2-3 use, and no current caller
  // needs `CollectionManager`. YAGNI per CLAUDE.md; add these back if/when
  // a caller actually needs them.
}

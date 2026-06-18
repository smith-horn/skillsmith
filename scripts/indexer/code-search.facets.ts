/**
 * Size-facet partitioner for the broad `filename:SKILL.md` code-search backfill
 * @module scripts/indexer/code-search.facets
 *
 * SMI-5286 Wave 1c: the broad community code-search query
 * (`filename:SKILL.md`) saturates GitHub's hard 1000-result ceiling, so a single
 * paginated pass can never reach the long tail. This module partitions that one
 * query by file SIZE into a fixed ladder of disjoint, exhaustive byte-size
 * buckets so each sub-query returns < 1000 results, with adaptive
 * bisect-on-saturation for the dense low buckets.
 *
 * Why size and not date: GitHub /search/code's `size:` qualifier IS a real,
 * probe-verified filter, whereas `created:`/`pushed:` are tokenized as
 * free-text content (SMI-5176) and crush results to files that literally
 * contain the date string. Size is therefore the only viable partitioner.
 *
 * This module is pure (no I/O, no GitHub dependency): it produces facet ranges,
 * stable labels, the `size:` qualifier string, and a bisection helper. The
 * caller (the facet driver) owns dispatch, pagination, and the checkpoint
 * cursor; it passes the already-formatted qualifier string into
 * `code-search.ts` so that file stays free of any facet dependency.
 */

/** A disjoint, inclusive byte-size bucket over the SKILL.md blob size. */
export interface SizeFacet {
  /** Inclusive lower byte bound (>= 0). */
  lo: number
  /** Inclusive upper byte bound; Number.POSITIVE_INFINITY for the open-ended final bucket. */
  hi: number
}

/**
 * The fixed, pre-enumerated size-bucket ladder. Returns the SAME array every
 * call so `facets_total = buildSizeFacets().length` is STATIC across dispatches
 * (the checkpoint cursor's `facets_completed` count is meaningless if the ladder
 * can change). Buckets are disjoint and EXHAUSTIVELY cover [0, ∞):
 *   facets[0].lo === 0; facets[i+1].lo === facets[i].hi + 1; last.hi === Infinity.
 *
 * The ladder doubles each bucket's width as size grows. SKILL.md files are
 * small, so the low buckets are dense and WILL bisect at runtime — that is the
 * expected, designed behaviour of the adaptive split.
 *
 * @returns The frozen 9-bucket size ladder (stable identity across calls)
 */
export function buildSizeFacets(): SizeFacet[] {
  return SIZE_FACETS
}

/**
 * The canonical size-bucket ladder, enumerated once at module load so
 * `buildSizeFacets()` returns a stable array identity. Buckets are
 * inclusive-inclusive, disjoint, contiguous, and exhaustively cover [0, ∞):
 * the first bucket starts at 0, each subsequent `lo` is the prior `hi + 1`, the
 * width doubles each step, and the final bucket is open-ended.
 */
const SIZE_FACETS: SizeFacet[] = Object.freeze([
  { lo: 0, hi: 127 },
  { lo: 128, hi: 255 },
  { lo: 256, hi: 511 },
  { lo: 512, hi: 1023 },
  { lo: 1024, hi: 2047 },
  { lo: 2048, hi: 4095 },
  { lo: 4096, hi: 8191 },
  { lo: 8192, hi: 16383 },
  { lo: 16384, hi: Number.POSITIVE_INFINITY },
]) as SizeFacet[]

/**
 * Stable label for a facet, used as the checkpoint cursor `facet` string.
 * Finite: `${lo}-${hi}`. Open-ended: `${lo}+`.
 *
 * @param facet - The size bucket to label
 * @returns A stable, human-readable facet identifier
 */
export function facetId(facet: SizeFacet): string {
  return facet.hi === Number.POSITIVE_INFINITY ? `${facet.lo}+` : `${facet.lo}-${facet.hi}`
}

/**
 * The GitHub /search/code size qualifier for this facet. INCLUSIVE-INCLUSIVE:
 * finite → `size:${lo}..${hi}`; open-ended (hi === Infinity) → `size:>=${lo}`.
 * (Off-by-one boundaries double-count — buckets are already inclusive-inclusive.)
 *
 * @param facet - The size bucket to render
 * @returns The `size:` qualifier string to append to the code-search query
 */
export function facetToQualifier(facet: SizeFacet): string {
  return facet.hi === Number.POSITIVE_INFINITY
    ? `size:>=${facet.lo}`
    : `size:${facet.lo}..${facet.hi}`
}

/**
 * Upper ceiling for open-ended bisection (bytes). A SKILL.md larger than 4 MiB is
 * not a real skill, so once an open-ended bucket's lower bound passes this the
 * tail is treated as unsplittable (the caller records it truncated rather than
 * bisecting forever — doubling an open-ended range never reaches `lo === hi`, so
 * a persistently-saturating open-ended facet would otherwise loop infinitely).
 */
const OPEN_ENDED_BISECT_CEILING = 4 * 1024 * 1024

/**
 * Split a facet into two disjoint, contiguous, inclusive halves that together
 * cover the SAME range (used when a facet saturates the 1000-result cap).
 * Finite: mid = lo + floor((hi - lo) / 2) → [{lo, hi: mid}, {lo: mid+1, hi}].
 * Open-ended (hi === Infinity): pivot by doubling →
 *   [{lo, hi: lo*2 - 1}, {lo: lo*2, hi: Infinity}] (requires 0 < lo < ceiling).
 * Returns null when the facet CANNOT subdivide (finite with lo >= hi; open-ended
 * with lo === 0; or open-ended past {@link OPEN_ENDED_BISECT_CEILING}).
 *
 * @param facet - The saturated size bucket to bisect
 * @returns A two-element tuple of contiguous halves, or null when unsplittable
 */
export function bisectFacet(facet: SizeFacet): [SizeFacet, SizeFacet] | null {
  if (facet.hi === Number.POSITIVE_INFINITY) {
    // Open-ended bucket: pivot by doubling the lower bound. A bucket starting at
    // 0 cannot double (0 * 2 === 0), and past the ceiling there are no real
    // skills left to partition — both are unsplittable, guard them so a
    // persistently-saturating open-ended tail terminates instead of doubling
    // forever.
    if (facet.lo <= 0 || facet.lo >= OPEN_ENDED_BISECT_CEILING) {
      return null
    }
    const pivot = facet.lo * 2
    return [
      { lo: facet.lo, hi: pivot - 1 },
      { lo: pivot, hi: Number.POSITIVE_INFINITY },
    ]
  }
  // Finite bucket: a single-byte (or inverted) range cannot subdivide.
  if (facet.lo >= facet.hi) {
    return null
  }
  const mid = facet.lo + Math.floor((facet.hi - facet.lo) / 2)
  return [
    { lo: facet.lo, hi: mid },
    { lo: mid + 1, hi: facet.hi },
  ]
}

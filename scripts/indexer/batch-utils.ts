/**
 * SMI-2380: Batch query utilities for Supabase PostgREST URL length limits.
 *
 * @module scripts/indexer/batch-utils
 *
 * SMI-4852: Node-flavored sibling of
 * `supabase/functions/indexer/batch-utils.ts`. Body is byte-identical — pure
 * helper with no Deno-only APIs. Parity guarded by
 * `scripts/indexer/tests/parity.test.ts`.
 *
 * PostgREST encodes .in() filter values in the URL query string.
 * At 700+ items with ~80 char URLs, the query string exceeds the 8-16KB limit.
 * These utilities split large arrays into batches and merge results.
 */

/** Maximum items per .in() query to stay under PostgREST URL length limits */
export const IN_QUERY_BATCH_SIZE = 100

/**
 * Batch a Supabase .in() query to prevent PostgREST URL length failures.
 * Splits large arrays into chunks of `batchSize` and merges results.
 *
 * @param buildQuery - Factory that returns a fresh query builder (called per batch)
 * @param column - The column name to filter on
 * @param values - The full array of values to filter by
 * @param batchSize - Max items per batch (default: IN_QUERY_BATCH_SIZE)
 * @returns Merged array of all results across batches
 */
export async function batchedIn<T>(
  buildQuery: () => { in: (column: string, values: string[]) => Promise<{ data: T[] | null }> },
  column: string,
  values: string[],
  batchSize = IN_QUERY_BATCH_SIZE
): Promise<T[]> {
  if (values.length === 0) return []
  if (values.length <= batchSize) {
    const { data } = await buildQuery().in(column, values)
    return data ?? []
  }

  const results: T[] = []
  for (let i = 0; i < values.length; i += batchSize) {
    const batch = values.slice(i, i + batchSize)
    const { data } = await buildQuery().in(column, batch)
    if (data) results.push(...data)
  }
  return results
}

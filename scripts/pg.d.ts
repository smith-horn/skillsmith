/**
 * SMI-6975 — minimal type declaration for the `pg` npm package.
 *
 * `pg` is NOT an installed dependency anywhere in this repo -- confirmed
 * independently in two other files' own header comments before this one
 * (scripts/generate-typosquat-snapshot.ts, scripts/indexer/smi5879-census.pg.ts)
 * and again in docs/internal/implementation/smi-6093-concurrency-test-harness.md:
 * neither `pg` nor `@types/pg` appears in any package.json, package-lock.json,
 * or node_modules, so scripts/run-sql.ts (the sole importer -- confirmed via
 * grep across non-test scripts/**) cannot actually run today. Adding the real
 * dependency is a package.json change, out of this gate's scope.
 *
 * So: a narrow declaration covering EXACTLY the three `Client` methods
 * run-sql.ts calls (`connect`, `query`, `end`) -- not the real package's full
 * surface, and not a blanket `any`. Shapes match the real, stable, widely-
 * documented `pg`/`@types/pg` public API for these methods.
 */
declare module 'pg' {
  export interface QueryResult<R = Record<string, unknown>> {
    rows: R[]
    rowCount: number | null
  }

  export class Client {
    constructor(config?: { connectionString?: string })
    connect(): Promise<void>
    query<R = Record<string, unknown>>(queryText: string): Promise<QueryResult<R>>
    end(): Promise<void>
  }

  const pg: { Client: typeof Client }
  export default pg
}

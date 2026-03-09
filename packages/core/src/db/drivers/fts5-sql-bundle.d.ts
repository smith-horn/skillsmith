/**
 * SMI-2742: Ambient module declaration for fts5-sql-bundle
 *
 * Interfaces match the runtime shapes used by sqljsDriver.ts (lines 27-49).
 * This replaces the inline Fts5SqlBundleModule cast and enables typed dynamic imports.
 */
declare module 'fts5-sql-bundle' {
  type SqlJsValue = string | number | null | Uint8Array
  type SqlJsBindParams = SqlJsValue[] | Record<string, SqlJsValue>

  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsDatabase
  }

  interface SqlJsDatabase {
    run(sql: string): void
    prepare(sql: string): SqlJsStatement
    export(): Uint8Array
    close(): void
  }

  interface SqlJsStatement {
    bind(params?: SqlJsBindParams): boolean
    step(): boolean
    get(): SqlJsValue[]
    getColumnNames(): string[]
    reset(): void
    free(): void
  }

  type InitSqlJsFn = (config?: object) => Promise<SqlJsStatic>

  export const initSqlJs: InitSqlJsFn
  export default function initSqlJs(config?: object): Promise<SqlJsStatic>
}

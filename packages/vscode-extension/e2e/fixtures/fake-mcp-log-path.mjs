/**
 * Shared, deterministic path for the fake MCP server's call log (SMI-5331).
 *
 * The fake server (a child of the VS Code extension host) appends each received
 * tool call / notification here; specs (in the wdio runner) read it back to assert
 * what the extension actually sent (e.g. `apply_namespace_rename {confirmed:true}`)
 * and to detect the MCP handshake before auditing.
 *
 * The path is derived from THIS module's own location (import.meta.url), NOT
 * `os.tmpdir()` — the extension host's `$TMPDIR` can differ from the wdio runner's,
 * which would split the log across two files. A location-derived path is identical
 * for both importers regardless of cwd or env. Lives under e2e/logs (gitignored).
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const FAKE_MCP_LOG =
  process.env.FAKE_MCP_LOG || join(here, '..', 'logs', 'fake-mcp-call-log.jsonl')

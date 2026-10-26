# memory-usage

Manage persistent memory storage.

## Usage
```bash
npx -y ruflo@3.14.2 memory <store|retrieve|delete> [options]
```

`memory usage` does not exist as a v3 subcommand — it silently falls through to family help (exit 0, no error) instead of failing loudly. The `--action` dispatch flag is gone too; each action below is now its own subcommand.

## Options
- `store`: `-k/--key <key>` (required), `--value <data>` (JSON) — use `--value`, not `-v`: the global `-v` flag means verbose, so carrying it over silently changes what the command does
- `retrieve`: `-k/--key <key>` (required), optional `--value-only`
- `list`: **do not run** — its MCP form `memory_list` is denied (SMI-7184), and the CLI form calls the same `listEntries`, whose sql.js fallback rewrites memory.db unguarded when the bridge is down. Read a known key with `retrieve` instead
- `delete`: `-k/--key <key>` removes a single key; there is no wipe-all `clear` — for stale/expired entries use `memory cleanup` instead

## Examples
```bash
# Store memory
memory store -k "project-config" --value '{"api": "v2"}'

# Retrieve memory
memory retrieve -k "project-config"

# Delete a key
memory delete -k "project-config"
```

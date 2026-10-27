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
- `list`: **do not run** — `memory_list` is denied (SMI-7184; see claude-flow-guide.md), and the CLI form reaches the same code. Read a known key with `retrieve` instead
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

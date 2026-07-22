# memory-persist

Persist memory across sessions.

## Usage
```bash
npx -y ruflo@3.14.2 memory <export|import|compress> [options]
```

`memory persist` does not exist as a v3 subcommand — it silently falls through to family help (exit 0, no error) instead of failing loudly. The concept splits across three real subcommands: `memory export`, `memory import`, and `memory compress`.

## Options
- `export`: `-o/--output <file>` (required), `-f/--format <type>`, `--include-vectors` — there is no `--compress` flag
- `import`: `-i <file>`
- `compress`: compresses entries already in the store, not an export file — it takes no file argument, so it is not a drop-in replacement for a "compressed export"

## Examples
```bash
# Export memory — both the subcommand name and the flag shape changed
# (old: memory persist --export <file>; new: memory export -o <file>)
memory export -o memory-backup.json

# Import memory — same rename: subcommand AND flag shape both changed
# (old: memory persist --import <file>; new: memory import -i <file>)
memory import -i memory-backup.json

# There is no combined "compressed export" — `--compress` does not exist on `export`.
# Compress the live store, or gzip the export file yourself:
memory compress
# or: memory export -o memory-backup.json && gzip memory-backup.json
```

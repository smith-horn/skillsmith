# memory-search

Search through stored memory.

## Usage
```bash
npx -y ruflo@3.14.2 memory search [options]
```

## Options
- `-q/--query <text>` - Search query (required)
- `-l/--limit <n>` - Result limit
- `-t/--type <type>` - `semantic` (default), `keyword`, or `hybrid`
- `--threshold <n>` - Similarity threshold
- `-s/--smart` - Smart search
- `--build-hnsw` - Build the HNSW index for faster search

There is no `--pattern`/regex matching in v3 — passing one errors. For literal matching, use `-t keyword`.

## Examples
```bash
# Search memory (v3 default search type is semantic)
memory search -q "authentication"

# Keyword (literal) search
memory search -q "authentication" -t keyword

# Limited results
memory search -q "config" -l 10
```

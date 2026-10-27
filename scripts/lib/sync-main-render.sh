#!/usr/bin/env bash
# scripts/lib/sync-main-render.sh — output rendering for scripts/sync-main.sh.
# Sourced, not executed. Nothing here may fail: a refusal must not become the
# ERR trap's exit 3 because its diagnostic could not be rendered (SMI-6465).

# Render up to 5 NUL-separated paths from a file as one line, each once, in
# bytewise order (deterministic, whichever git command listed them first).
# Newlines and tabs in a path are shown as \n and \t so it stays on one line.
render_paths() {
  local file=$1 out='' n=0 p
  while IFS= read -r -d '' p; do
    n=$((n + 1))
    [ "$n" -le 5 ] || continue
    p=${p//$'\n'/\\n}
    p=${p//$'\t'/\\t}
    out="${out:+$out, }$p"
  done < <(LC_ALL=C sort -zu "$file")
  [ "$n" -le 5 ] || out="$out (and $((n - 5)) more)"
  printf '%s' "$out"
}

# Count NUL-separated records in a file.
count_paths() {
  local n=0 p
  while IFS= read -r -d '' p; do n=$((n + 1)); done <"$1"
  printf '%s' "$n"
}

# one_line <file> <first|last>: the first or last non-blank line of git's
# output, safe to put on a refusal line. It reads at most 64 KiB (so no stage
# ever holds an unbounded line), runs every stage in the C locale (so no
# malformed byte can make a stage exit), keeps printable ASCII only (other
# bytes become '?'), and caps the result at 200 characters. Every stage reads
# to EOF, its stderr is discarded and its status ignored, so it cannot fail.
one_line() {
  local file=$1 pick=$2
  {
    if [ "$pick" = last ]; then tail -c 65536 "$file"; else head -c 65536 "$file"; fi |
      LC_ALL=C tr '\r\t\000' '\n  ' |
      LC_ALL=C awk -v pick="$pick" 'NF { if (pick == "last") l = $0; else if (!d) { print; d = 1 } } END { if (pick == "last" && l != "") print l }' |
      LC_ALL=C tr -d '\001-\037\177' |
      LC_ALL=C tr '\200-\377' '?' |
      LC_ALL=C cut -c1-200
  } 2>/dev/null || true
}

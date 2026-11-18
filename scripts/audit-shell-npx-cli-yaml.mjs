/**
 * YAML side of the Check 59 shell scan (SMI-7226), used by
 * audit-shell-npx-cli-helpers.mjs for workflow and composite-action files.
 *
 * decodeYamlRun() decodes one `run:` value in place, so a hit keeps its line.
 * resolvedRunValues() parses the whole file once, so a `run` value reached
 * through a YAML alias (`run: *cmd`, or a whole step `- *step`) is seen too.
 */

import { createRequire } from 'module'

const yaml = createRequire(import.meta.url)('js-yaml')

// A workflow or action `run:` key; group 1 is its indentation and list dash.
const YAML_RUN = /^(\s*(?:-\s+)?)run:(\s.*|)$/
// A YAML alias reference (`*name`) on a line.
const YAML_ALIAS = /(?:^|[\s:[,-])\*[A-Za-z0-9_.-]+/

/**
 * Decode the `run:` value starting at raw[i] (plain, quoted or block scalar).
 * The value runs to the first non-blank line indented no deeper than the
 * `run:` key. Returns { command, consumed, literal } or null when the key has
 * no string value or js-yaml rejects it (an alias, for one); the caller then
 * scans the lines as plain text. `literal` is true for a `|` block, whose
 * decoded lines map one to one onto the physical lines after the key.
 */
export function decodeYamlRun(raw, i) {
  const m = raw[i].match(YAML_RUN)
  if (!m) return null
  const keyCol = m[1].length
  const indent = (l) => l.length - l.trimStart().length
  let n = 1
  while (i + n < raw.length && (raw[i + n].trim() === '' || indent(raw[i + n]) > keyCol)) n++
  while (n > 1 && raw[i + n - 1].trim() === '') n--
  const body = [
    'run:' + m[2],
    ...raw.slice(i + 1, i + n).map((l) => l.slice(Math.min(keyCol, indent(l)))),
  ]
  let value
  try {
    value = yaml.load(body.join('\n'))?.run
  } catch {
    return null
  }
  if (typeof value !== 'string') return null
  return { command: value, consumed: n, literal: /^\s*\|/.test(m[2]) }
}

/**
 * Every string `run` value in the file as js-yaml resolves it, aliases
 * included, once per place it is used. Returns null when the file does not
 * parse; such a file is not a runnable workflow or action.
 */
export function resolvedRunValues(text) {
  let docs
  try {
    docs = yaml.loadAll(text)
  } catch {
    return null
  }
  const out = []
  const path = new Set() // nodes on the current path, to stop on a cycle
  const walk = (node) => {
    if (node === null || typeof node !== 'object' || path.has(node)) return
    path.add(node)
    for (const [key, value] of Array.isArray(node) ? node.entries() : Object.entries(node)) {
      if (key === 'run' && typeof value === 'string') out.push(value)
      else walk(value)
    }
    path.delete(node)
  }
  docs.forEach(walk)
  return out
}

/** 0-based index of the first line holding a YAML alias reference, or 0. */
export function firstAliasLine(raw) {
  const at = raw.findIndex((l) => YAML_ALIAS.test(l.replace(/^\s*#.*/, '')))
  return at === -1 ? 0 : at
}

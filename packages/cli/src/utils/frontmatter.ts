/**
 * @fileoverview Minimal YAML frontmatter parser (SMI-7018)
 *
 * Replaces `gray-matter`, whose `js-yaml@3 -> argparse@1 -> sprintf-js` chain
 * carries GHSA-hp3w-g68c-fv3c with no fixed release. Built on the `yaml`
 * package the CLI already depends on.
 *
 * Contract (measured against gray-matter 4.0.3, see frontmatter.test.ts):
 * - Frontmatter exists only when the first line (after an optional UTF-8 BOM)
 *   is `---`, optionally followed by spaces/tabs.
 * - The block ends at the next line that is `---` (optional trailing
 *   whitespace, so CRLF works). `---` inside the body is never a delimiter.
 * - An unterminated block is parsed to the end of input and `content` is ''.
 * - `content` is everything after the closing line's terminator, unmodified.
 * - Malformed YAML (including duplicate keys) throws.
 *
 * Deliberate differences from gray-matter:
 * - gray-matter closes on any line that merely STARTS with `---` (`----`,
 *   `---foo`) and leaves the remainder in `content`; this parser requires the
 *   whole line to be `---`.
 * - `---foo` / `---json` on the opening line selects a gray-matter "language"
 *   engine (and throws for unknown ones); here it is not frontmatter.
 * - A frontmatter document that is not a mapping (scalar, list, null) yields
 *   `data: {}`; gray-matter returned the raw value.
 * - YAML 1.2 core schema (`yaml` default) instead of js-yaml 3: timestamps,
 *   sexagesimal ints (`1:30`), `0b`/legacy-octal/underscore numbers stay or
 *   become plain strings/numbers differently. Merge keys (`<<`) are enabled
 *   to keep js-yaml's behaviour.
 */
import { parse as parseYaml } from 'yaml'

export interface FrontmatterResult {
  data: Record<string, unknown>
  content: string
}

const BOM = '\uFEFF'
const DELIMITER = /^---[ \t]*\r?$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Return the line starting at `from` (without terminator) and the offset after it. */
function readLine(input: string, from: number): { line: string; next: number } {
  const nl = input.indexOf('\n', from)
  if (nl === -1) return { line: input.slice(from), next: input.length }
  return { line: input.slice(from, nl), next: nl + 1 }
}

/**
 * Split `input` into YAML frontmatter data and the remaining body.
 * Throws if the frontmatter block is not valid YAML.
 */
export function parseFrontmatter(input: string): FrontmatterResult {
  const text = input.startsWith(BOM) ? input.slice(1) : input

  const open = readLine(text, 0)
  if (!DELIMITER.test(open.line)) {
    return { data: {}, content: text }
  }

  let cursor = open.next
  let yamlEnd = text.length
  let contentStart = text.length
  while (cursor < text.length) {
    const { line, next } = readLine(text, cursor)
    if (DELIMITER.test(line)) {
      yamlEnd = cursor
      contentStart = next
      break
    }
    cursor = next
  }

  const parsed: unknown = parseYaml(text.slice(open.next, yamlEnd), {
    prettyErrors: true,
    merge: true,
    logLevel: 'error',
  })
  return {
    data: isPlainObject(parsed) ? parsed : {},
    content: text.slice(contentStart),
  }
}

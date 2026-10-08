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
 * - A language tag on the opening line (`---yaml`, `--- json`) selects how
 *   gray-matter parses the block. Here `yaml`, `yml` and `json` (any case) are
 *   parsed as YAML, which covers JSON. `js` and `javascript` throw: gray-matter
 *   EXECUTES that frontmatter as code, and an imported SKILL.md must never run
 *   code. Any other tag throws, as it did in gray-matter.
 * - A frontmatter document that is not a mapping (scalar, list, null) yields
 *   `data: {}`; gray-matter returned the raw value.
 * - YAML 1.2 core schema (`yaml` default) instead of js-yaml 3: timestamps,
 *   sexagesimal ints (`1:30`), `0b`/legacy-octal/underscore numbers stay or
 *   become plain strings/numbers differently. Merge keys (`<<`) are enabled
 *   to keep js-yaml's behaviour.
 * - Unrecognised tags (`!foo`, `!!js/function`) resolve to their plain value
 *   with no warning, and nothing executes; gray-matter threw on them. Tags
 *   yaml does know (`!!binary`, `!!set`) yield a Buffer or Set, which
 *   parseSkillFile ignores because it reads only string values.
 * - yaml's default `maxAliasCount` (100) bounds alias expansion per anchor:
 *   100 aliases of one anchor throws, 99 parse. Aliases spread over many
 *   anchors are not counted together. js-yaml 3 had no limit at all.
 * - A closing line of `---` then `\r` then spaces is not a delimiter, so the
 *   rest of the file is parsed as YAML (and fails); gray-matter closed there.
 * - A lone `\r` inside a value is accepted, and a CR-only (classic Mac) file
 *   has no frontmatter; gray-matter threw on both.
 * - YAML longer than MAX_FRONTMATTER_BYTES (counted in UTF-8 bytes) throws
 *   before parsing. SKILL.md files come from directories the user imports,
 *   and some yaml costs grow with the square of the input: the duplicate-key
 *   check (20,000 keys took over a second), and error formatting, which
 *   rescans a long line once per error (a 64 KiB line of commas took about
 *   1.8 s). At 16 KiB the worst shapes measured took under 200 ms. Real
 *   frontmatter is far smaller: across 1,730 SKILL.md files the largest block
 *   was 2,011 bytes (SMI-7018, 2026-10-07).
 */
import { parse as parseYaml, YAMLParseError } from 'yaml'

export interface FrontmatterResult {
  data: Record<string, unknown>
  content: string
}

const BOM = '\uFEFF'
const DELIMITER = /^---[ \t]*\r?$/
/** Opening line: `---`, optionally followed by one language tag (not starting with `-`). */
const OPENER = /^---[ \t]*(?:([^\s-]\S*)[ \t]*)?\r?$/
const YAML_LANGUAGES = new Set(['yaml', 'yml', 'json'])
const EXECUTABLE_LANGUAGES = new Set(['js', 'javascript'])

/** Upper bound on the YAML block, in UTF-8 bytes; see the module header. */
export const MAX_FRONTMATTER_BYTES = 16 * 1024

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
  const opener = OPENER.exec(open.line)
  if (!opener) {
    return { data: {}, content: text }
  }
  const language = opener[1]?.toLowerCase()
  if (language !== undefined && !YAML_LANGUAGES.has(language)) {
    throw new Error(
      EXECUTABLE_LANGUAGES.has(language)
        ? `frontmatter language "${opener[1]}" is executable code and is not supported`
        : `frontmatter language "${opener[1]}" is not supported (use yaml)`
    )
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

  const yamlText = text.slice(open.next, yamlEnd)
  const size = Buffer.byteLength(yamlText, 'utf8')
  if (size > MAX_FRONTMATTER_BYTES) {
    throw new Error(
      `frontmatter is ${size} bytes, over the ${MAX_FRONTMATTER_BYTES}-byte limit; SKILL.md frontmatter is normally under 2 KB`
    )
  }

  let parsed: unknown
  try {
    parsed = parseYaml(yamlText, { prettyErrors: true, merge: true, logLevel: 'error' })
  } catch (error) {
    // A bare `---` line has already closed the block, so a second YAML document
    // here means a near-miss closing line such as `--- # note` or `...`.
    // yaml's own message ("please use YAML.parseAllDocuments()") names a library
    // call, not the problem in the user's file.
    if (error instanceof YAMLParseError && error.code === 'MULTIPLE_DOCS') {
      throw new Error(
        'frontmatter is not closed: the closing line must be exactly `---` ' +
          '(a line such as `--- # note` or `...` does not close it)'
      )
    }
    throw error
  }
  return {
    data: isPlainObject(parsed) ? parsed : {},
    content: text.slice(contentStart),
  }
}

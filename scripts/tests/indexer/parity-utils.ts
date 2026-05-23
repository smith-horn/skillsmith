/**
 * Parity test helpers
 * @module scripts/tests/indexer/parity-utils
 *
 * SMI-4960: extracted from parity.test.ts so the helper-parity and the
 * security-scanner-edge parity suites can share these source-extraction
 * utilities without either test file crossing the 500-line limit. Pure
 * string/AST-lite helpers used to assert byte-identity (after whitespace
 * normalization) between the Deno (`supabase/functions/`) and Node
 * (`scripts/indexer/`) twins.
 */

import { readFileSync } from 'node:fs'

/** Collapse all runs of whitespace to a single space and trim. */
export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * Extract just the function body (statements between the *body* opening
 * brace and its matching close), skipping any return-type annotation braces
 * in the signature. Strategy: find the function name, then walk forward
 * scanning for `{` characters; the body opens at the `{` whose preceding
 * non-whitespace character is `)` (no annotation), `}` (just closed a
 * return-type object), or an identifier letter (a named type) — not `:`.
 */
export function extractBody(filePath: string, fnName: string): string {
  const source = readFileSync(filePath, 'utf-8')
  const fnIdx = source.indexOf(`export function ${fnName}`)
  if (fnIdx < 0) throw new Error(`Function ${fnName} not found in ${filePath}`)

  // Walk parens to find the close of the parameter list.
  let i = source.indexOf('(', fnIdx)
  let parenDepth = 1
  i++
  while (i < source.length && parenDepth > 0) {
    if (source[i] === '(') parenDepth++
    else if (source[i] === ')') parenDepth--
    i++
  }
  // i is now just past the closing `)` of the parameter list.

  // Skip any return-type annotation. Walk forward until we find a `{` whose
  // preceding non-whitespace character is `)` (no annotation) or `}` (just
  // closed the return-type object) or an identifier letter (a named type).
  let braceDepth = 0
  while (i < source.length) {
    const c = source[i]
    if (c === '{') {
      if (braceDepth === 0) {
        let j = i - 1
        while (j >= 0 && /\s/.test(source[j])) j--
        const prev = source[j]
        if (prev === ':') {
          // entering return-type object annotation
          braceDepth = 1
          i++
          continue
        }
        // body open
        const start = i
        let bd = 1
        i++
        while (i < source.length && bd > 0) {
          if (source[i] === '{') bd++
          else if (source[i] === '}') bd--
          i++
        }
        return source.slice(start, i)
      } else {
        braceDepth++
      }
    } else if (c === '}') {
      if (braceDepth > 0) braceDepth--
    }
    i++
  }
  throw new Error(`Function body for ${fnName} not found in ${filePath}`)
}

/**
 * SMI-4843 Phase 5: Extract the body of an array literal
 * `export const NAME ... = [ ... ]` declaration. Returns the substring between
 * the matching `[` and `]` brackets. Skips bracket characters inside string
 * literals/comments so they don't confuse depth tracking.
 *
 * SMI-4941: the array literal's opening `[` is located by first finding the
 * declaration's `=`, then searching for `[` AFTER it — a type annotation such
 * as `: HighTrustAuthor[]` places a `[` before the `=` that would otherwise be
 * mis-matched (a silent always-pass).
 */
export function extractArrayBody(filePath: string, constName: string): string {
  const source = readFileSync(filePath, 'utf-8')
  const declIdx = source.indexOf(`export const ${constName}`)
  if (declIdx < 0) throw new Error(`const ${constName} not found in ${filePath}`)

  const eqIdx = source.indexOf('=', declIdx)
  if (eqIdx < 0) throw new Error(`'=' for ${constName} not found in ${filePath}`)
  const openIdx = source.indexOf('[', eqIdx)
  if (openIdx < 0 || openIdx < eqIdx)
    throw new Error(`array literal '[' for ${constName} not found after '=' in ${filePath}`)

  let depth = 1
  let i = openIdx + 1
  let inString: string | null = null
  let inLineComment = false
  let inBlockComment = false
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (inLineComment) {
      if (c === '\n') inLineComment = false
    } else if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false
        i++
      }
    } else if (inString) {
      if (c === '\\') {
        i++ // skip escaped char
      } else if (c === inString) {
        inString = null
      }
    } else {
      if (c === '/' && next === '/') {
        inLineComment = true
        i++
      } else if (c === '/' && next === '*') {
        inBlockComment = true
        i++
      } else if (c === "'" || c === '"' || c === '`') {
        inString = c
      } else if (c === '[') {
        depth++
      } else if (c === ']') {
        depth--
        if (depth === 0) return source.slice(openIdx + 1, i)
      }
    }
    i++
  }
  throw new Error(`array body for ${constName} not closed in ${filePath}`)
}

/**
 * SMI-4879: Extract the body of an `export interface NAME { ... }` declaration.
 * Returns the substring between the matching `{` and `}` braces (the member
 * list). Brace depth is tracked so nested object-type members don't confuse the
 * close.
 */
export function extractInterface(filePath: string, ifaceName: string): string {
  const source = readFileSync(filePath, 'utf-8')
  const declIdx = source.indexOf(`export interface ${ifaceName}`)
  if (declIdx < 0) throw new Error(`interface ${ifaceName} not found in ${filePath}`)

  const openIdx = source.indexOf('{', declIdx)
  if (openIdx < 0) throw new Error(`opening { for ${ifaceName} not found in ${filePath}`)

  let depth = 1
  let i = openIdx + 1
  while (i < source.length) {
    const c = source[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return source.slice(openIdx + 1, i)
    }
    i++
  }
  throw new Error(`interface body for ${ifaceName} not closed in ${filePath}`)
}

/**
 * SMI-4960: extract everything from the first `// ===` section marker to EOF.
 * The two security-scanner-edge twins differ ONLY in their leading module
 * doc-comment; from the first section banner onward they must be byte-identical
 * (after whitespace normalization). Comparing the whole body — not just a
 * handful of function bodies — is the strongest parity guarantee for the prod
 * quarantine gate.
 */
export function extractScannerBody(filePath: string): string {
  const source = readFileSync(filePath, 'utf-8')
  const markerIdx = source.indexOf('// ===')
  if (markerIdx < 0) throw new Error(`'// ===' section marker not found in ${filePath}`)
  return source.slice(markerIdx)
}

/**
 * SMI-4852: Returns true when the file is git-crypt-encrypted (e.g.
 * post-merge-verify.yml runs without unlocking the key). The encrypted file
 * begins with the literal magic `\x00GITCRYPT\x00`. Callers `it.skipIf` on this
 * so the parity invariant is enforced in unlocked contexts (PR matrix, local
 * Docker) where every diff lands.
 */
export function isGitCryptEncrypted(filePath: string): boolean {
  try {
    const head = readFileSync(filePath).subarray(0, 10)
    return head[0] === 0 && head.toString('utf-8', 1, 9) === 'GITCRYPT\x00'.slice(0, 8)
  } catch {
    return false
  }
}

/**
 * audit-host-volume-fs-guard-helpers — SMI-6457.
 *
 * Static guard flagging host-side filesystem operations (rm -rf, test -f,
 * existsSync, etc.) against a path docker-compose.yml has migrated onto a
 * Docker named volume — the exact bug class behind SMI-6453 (a container-run
 * server's dependency probe read stale host-side bytes) and SMI-6454 (a
 * host-run launcher's remediation text told the user to run a container-side
 * fix that could never reach the host bytes it needed to repair).
 *
 * This is a heuristic CANDIDATE GENERATOR, not a definitive classifier: it
 * cannot know whether a given script's own server process runs host-side
 * (where a host-side check is correct) or container-side (where it is the
 * SMI-6453 bug). scripts/mcp-skillsmith-launcher.sh is a confirmed, expected
 * false-positive source for exactly this reason (SMI-6454's own Out-of-Scope
 * note) — every match is a candidate for human review, not a verdict.
 *
 * See docs/internal/implementation/smi-6457-host-vs-named-volume-fs-op-guard.md
 * for the full design and its plan-review record.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// js-yaml via createRequire, same pattern already used in
// scripts/audit-standards.mjs's retro-frontmatter check.
const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

const ROOT_ENV_VAR_RE = /^process\.env\.[A-Z0-9_]*REPO_ROOT[A-Z0-9_]*$/

/**
 * Parses docker-compose.yml text and returns the repo-relative paths backed
 * by a Docker named volume (not a host bind mount). A `volumes:` list entry
 * `<name>:<container-path>[:mode]` is a named-volume mount iff `<name>` is
 * also a key under the top-level `volumes:` block. A literal host path
 * (starts with '.', '/', or `~`) is a bind mount. A source containing `${`
 * (shell/Compose interpolation) is UNKNOWN and skipped -- it could resolve
 * to either shape, and assuming either direction risks a wrong verdict
 * (plan-review finding, SMI-6457).
 */
export function parseNamedVolumeRepoRelativePaths(composeYamlText) {
  const doc = yaml.load(composeYamlText)
  if (!doc || typeof doc !== 'object') return []

  const namedVolumeKeys = new Set(Object.keys(doc.volumes ?? {}))
  const paths = new Set()

  for (const service of Object.values(doc.services ?? {})) {
    for (const entry of service?.volumes ?? []) {
      if (typeof entry !== 'string') continue // long syntax (type/source/target) -- out of scope, see plan
      const parts = entry.split(':')
      if (parts.length < 2) continue
      const [source, containerPath] = parts
      if (source.includes('${')) continue // interpolated -- unknown, skip (never assume bind or volume)
      if (!namedVolumeKeys.has(source)) continue // literal host path -- bind mount, not a named volume
      if (containerPath === '/app') continue // mount root itself, no repo-relative sub-path
      if (!containerPath.startsWith('/app/')) continue // named volume outside /app -- no repo-relative equivalent
      paths.add(containerPath.slice('/app/'.length).replace(/\/+$/, ''))
    }
  }
  return [...paths]
}

// ---- Pass 1: single-hop variable resolution -------------------------------

const BASH_LITERAL_ASSIGN_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(["'])(.*?)\2\s*$/
const JS_LITERAL_ASSIGN_RE =
  /^\s*(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(["'`])(.*?)\2\s*;?\s*$/
const JS_JOIN_ASSIGN_RE =
  /^\s*(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*join\((.*)\)\s*;?\s*$/

/** Strips a `$REPO_ROOT/` or `${REPO_ROOT}/` prefix, returning the literal suffix (or the input unchanged if no such prefix is present). */
function stripRootVarPrefix(text) {
  const m = text.match(/^\$\{?(REPO_ROOT)\}?\/(.*)$/)
  return m ? m[2] : text
}

/** Resolves a comma-separated `join(...)` argument list to a literal-prefix path, stopping at the first unresolvable (dynamic) argument. Root-env-var args (`process.env.*REPO_ROOT*`) contribute nothing. */
function resolveJoinArgsToPrefix(argsText, varMap) {
  const args = splitTopLevelArgs(argsText)
  const segments = []
  for (const rawArg of args) {
    const arg = rawArg.trim()
    const strLit = arg.match(/^(["'`])(.*)\1$/)
    if (strLit) {
      segments.push(strLit[2])
      continue
    }
    if (ROOT_ENV_VAR_RE.test(arg)) continue // root placeholder, contributes nothing
    if (varMap.has(arg) && varMap.get(arg) != null) {
      segments.push(varMap.get(arg))
      continue
    }
    // First unresolvable argument -- stop here; segments so far are the
    // static prefix (SMI-6457 plan-review fix: a dynamic tail does not
    // disqualify the prefix already established).
    break
  }
  return segments.join('/')
}

function splitTopLevelArgs(argsText) {
  const args = []
  let depth = 0
  let current = ''
  let quote = null
  for (const ch of argsText) {
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      current += ch
      continue
    }
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      args.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) args.push(current)
  return args
}

/** Builds a `Map<varName, resolvedRelativePathOrNull>` for one file's text, per Pass 1's three recognized grammars (plan §1). */
function buildVariableMap(lines) {
  const varMap = new Map()
  for (const line of lines) {
    const bashMatch = line.match(BASH_LITERAL_ASSIGN_RE)
    if (bashMatch) {
      varMap.set(bashMatch[1], stripRootVarPrefix(bashMatch[3]))
      continue
    }
    const jsLitMatch = line.match(JS_LITERAL_ASSIGN_RE)
    if (jsLitMatch && !jsLitMatch[3].includes('${')) {
      varMap.set(jsLitMatch[1], jsLitMatch[3])
      continue
    }
    const joinMatch = line.match(JS_JOIN_ASSIGN_RE)
    if (joinMatch) {
      varMap.set(joinMatch[1], resolveJoinArgsToPrefix(joinMatch[2], varMap))
      continue
    }
  }
  return varMap
}

// ---- Pass 2: operation scan ------------------------------------------------

// `[ -f`/`[ -d`/`[ ! -f`/`[ ! -d` use a negative lookbehind so they don't
// double-fire inside a `[[ -f`/`[[ -d` token (the second `[` of `[[` would
// otherwise itself match `\[\s+-f\s+`, producing a duplicate finding).
const OPERATORS = [
  { name: 'rm -rf', re: /rm\s+-rf\s+/g },
  { name: 'test -f', re: /\btest\s+-f\s+/g },
  { name: 'test -d', re: /\btest\s+-d\s+/g },
  { name: '[[ -f', re: /\[\[\s+-f\s+/g },
  { name: '[[ -d', re: /\[\[\s+-d\s+/g },
  { name: '[ -f', re: /(?<!\[)\[\s+-f\s+/g },
  { name: '[ ! -f', re: /(?<!\[)\[\s+!\s+-f\s+/g },
  { name: '[ -d', re: /(?<!\[)\[\s+-d\s+/g },
  { name: '[ ! -d', re: /(?<!\[)\[\s+!\s+-d\s+/g },
  { name: 'existsSync', re: /existsSync\(\s*/g },
  { name: 'fs.access', re: /fs\.access\(\s*/g },
]

/** Extracts the static (fully-literal-or-resolved) prefix of a bash target token, stopping at the first `$` interpolation -- a dynamic trailing segment (e.g. `$dep_name`) does not disqualify the literal prefix before it. */
function resolveBashTarget(token, varMap) {
  const unquoted = token.replace(/^["']|["']$/g, '')
  const bareVarMatch = unquoted.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)
  if (bareVarMatch) {
    return varMap.get(bareVarMatch[1]) ?? null
  }
  const varPrefixMatch = unquoted.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?\/(.*)$/)
  if (varPrefixMatch) {
    const resolved = varMap.get(varPrefixMatch[1])
    return resolved != null ? `${resolved}/${varPrefixMatch[2].split('$')[0]}` : null
  }
  const dollarIdx = unquoted.indexOf('$')
  if (dollarIdx === -1) return unquoted // fully literal
  if (dollarIdx === 0) return null // starts with an unresolvable variable, no literal prefix at all
  return unquoted.slice(0, dollarIdx) // literal prefix before the interpolation
}

/** Extracts the static prefix of a JS target expression: a string literal, a resolved bare variable, or a `join(...)` call's literal-prefix (per resolveJoinArgsToPrefix). */
function resolveJsTarget(exprText, varMap) {
  const trimmed = exprText.trim()
  const strLit = trimmed.match(/^(["'`])(.*)\1$/)
  if (strLit) return strLit[2]
  const joinCall = trimmed.match(/^join\((.*)\)$/)
  if (joinCall) {
    const prefix = resolveJoinArgsToPrefix(joinCall[1], varMap)
    return prefix || null
  }
  if (varMap.has(trimmed)) return varMap.get(trimmed)
  return null
}

/** True iff `target` (a resolved static prefix) falls at or beneath one of `namedVolumePaths` -- a full path-segment match, never a partial-segment string match (e.g. `node_modules-foo` must NOT match `node_modules`). */
function matchesNamedVolumePath(target, namedVolumePaths) {
  if (!target) return null
  const norm = target.replace(/^\.\//, '').replace(/\/+$/, '')
  for (const p of namedVolumePaths) {
    if (norm === p || norm.startsWith(`${p}/`)) return p
  }
  return null
}

function extractTargetToken(line, matchEndIndex, operatorName) {
  const rest = line.slice(matchEndIndex)
  if (operatorName === 'existsSync' || operatorName === 'fs.access') {
    // Balance parens from the already-consumed opening '(' to find the
    // first top-level argument (or the whole call if it has none).
    let depth = 1
    let end = 0
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '(') depth++
      if (rest[i] === ')') depth--
      if (depth === 0) {
        end = i
        break
      }
    }
    return { isJs: true, text: rest.slice(0, end || rest.length) }
  }
  const tokenMatch = rest.match(/^\S+/)
  return { isJs: false, text: tokenMatch ? tokenMatch[0] : '' }
}

/**
 * Scans `files` (repo-relative paths) for host-side operations against a
 * `namedVolumePaths` path, using the two-pass design in the SMI-6457 plan.
 * Returns `{file, line: lineNumber (1-indexed), operation, matchedPath, lineText}[]`.
 */
export function findHostSideNamedVolumeOps(files, namedVolumePaths) {
  const findings = []
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    const varMap = buildVariableMap(lines)

    lines.forEach((line, idx) => {
      for (const op of OPERATORS) {
        op.re.lastIndex = 0
        let m
        while ((m = op.re.exec(line))) {
          const beforeText = line.slice(0, m.index)
          if (/docker\s+exec/i.test(beforeText)) continue // same-line docker-exec wrap -- correctly scoped

          const { isJs, text: targetText } = extractTargetToken(line, op.re.lastIndex, op.name)
          if (!targetText) continue

          const target = isJs
            ? resolveJsTarget(targetText, varMap)
            : resolveBashTarget(targetText, varMap)
          const matchedPath = matchesNamedVolumePath(target, namedVolumePaths)
          if (!matchedPath) continue

          findings.push({
            file,
            line: idx + 1,
            operation: op.name,
            matchedPath,
            lineText: line.trim(),
          })
        }
      }
    })
  }
  return findings
}

/** Builds the `${file}:${trimmedLineText}` allowlist key for one finding (content-fingerprint, not line-number-keyed -- SMI-6457 plan review). */
export function allowlistKeyFor(finding) {
  return `${finding.file}:${finding.lineText}`
}

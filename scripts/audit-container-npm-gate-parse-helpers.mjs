#!/usr/bin/env node
/**
 * Pure text-analysis layer for audit-container-npm-gate-helpers.mjs, split out
 * to keep both files under the repo's 500-line standard (SMI-6654). Holds
 * classifyUnit, logicalUnits, probeMounts, scanText, and every private
 * helper/regex/constant only they use. node: builtins only -- no filesystem
 * or process access lives here, that stays in the sibling file.
 *
 * Nothing here may reuse a `/g` RegExp object across calls. `.test()`,
 * `.exec()` and `.matchAll()` all read `lastIndex`, and the prototype carried
 * state between them (49 corpus mismatches until found). Every global regex is
 * built fresh per call by `globalRe()`.
 *
 * This file is scanned by Check 72 like any other tracked file (no
 * self-exemption), so its comments and strings are worded so that no launcher
 * precedes an npm verb on one line.
 */

const globalRe = (source, flags = 'g') => new RegExp(source, flags)

// M-8 (npm 10.9.7 command docs) plus `prune` and `audit fix`. Longest first so
// alternation never stops at a shorter alias that prefixes a longer one.
const VERBS = [
  'install',
  'add',
  'i',
  'in',
  'ins',
  'inst',
  'insta',
  'instal',
  'isnt',
  'isnta',
  'isntal',
  'isntall',
  'ci',
  'clean-install',
  'ic',
  'install-clean',
  'isntall-clean',
  'install-test',
  'it',
  'install-ci-test',
  'cit',
  'clean-install-test',
  'sit',
  'update',
  'up',
  'upgrade',
  'udpate',
  'uninstall',
  'unlink',
  'remove',
  'rm',
  'r',
  'un',
  'rebuild',
  'rb',
  'dedupe',
  'ddp',
  'link',
  'ln',
  'prune',
  String.raw`audit\s+fix`,
].sort((a, b) => b.length - a.length)

const FLAGS = String.raw`(?:\s+--?[A-Za-z][\w-]*(?:(?:=|\s+)[^\s'"\\-][^\s'"\\]*)?)*?`
const VERB_SRC = String.raw`(?<![\w.-])npm${FLAGS}\s+(?:${VERBS.join('|')})(?![\w-])`
const LOCK_FAMILY_RE = new RegExp(
  String.raw`^npm${FLAGS}\s+(?:install|add|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|update|up|upgrade|udpate)(?![\w-])`
)
const LOCK_ONLY_FLAG_RE = /(?:^|\s)--package-lock-only(?:=true)?(?=\s|$)/

// R3. Compose global options that take a value may sit between the tool and its subcommand.
const GLOBAL_FLAGS = String.raw`(?:\s+(?:-f|--file|-p|--project-name|--profile|--env-file|--project-directory)(?:\s+|=)\S+)*`
const LAUNCH_SRC =
  String.raw`\bdocker(?:\s+compose|-compose)?${GLOBAL_FLAGS}\s+(?:container\s+)?exec\b` +
  String.raw`|\bdocker(?:\s+compose|-compose)${GLOBAL_FLAGS}\s+run\b` +
  String.raw`|worktree-docker\.sh\s+exec\b`
const SHELL_C_SRC = String.raw`(?:^|\s)(?:sh|bash)\s+-c\s+`
// Tried longest first, so `'\''` is never mistaken for a bare `'`.
const OPENERS = ["'\\''", '\\"', "\\'", '"', "'"]
const VALUE_OPTIONS = new Set(['-w', '--workdir', '-e', '--env', '-u', '--user', '--env-file'])
const VERB_AT_COMMAND_RE = new RegExp(
  String.raw`^(?:exec\s+)?npm${FLAGS}\s+(?:${VERBS.join('|')})(?![\w-])`
)
const GATE_CMD_RE = /^(?:sh|bash)\s+(?:\/app\/)?scripts\/lib\/node-modules-mount-gate\.sh$/
// Shape (b): scripts/regen-lockfile.sh's saved-rc form, whole script, exact.
const RC_FORM_RE =
  /^sh scripts\/lib\/node-modules-mount-gate\.sh; rc=\$\?; \[ "\$rc" -eq 0 \] \|\| \{ echo "MOUNT_GATE \$rc" >&2; exit 97; \}; exec npm (?:install|rebuild "\$@")$/
const HEREDOC_RE = /(?<!<)<<-?\s*(['"]?)([A-Za-z_]\w*)\1/
// Markdown fences (CommonMark): an opener is a run of 3+ backticks or tildes; a
// closer is a run of the SAME character, at least as long, with nothing after
// it. A shorter or other-character fence line inside a block is content, not a
// transition (PR #2857 gate finding SMI-6654-1: a four-backtick block holding a
// triple-backtick line used to flip the scanner into prose mode).
const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})/
const FENCE_CLOSE_RE = /^\s*(`{3,}|~{3,})\s*$/
function fenceOpener(line) {
  const m = FENCE_OPEN_RE.exec(line)
  return m ? { ch: m[1][0], len: m[1].length } : null
}
function closesFence(line, fence) {
  const m = FENCE_CLOSE_RE.exec(line)
  return Boolean(m) && m[1][0] === fence.ch && m[1].length >= fence.len
}

/** R5(a): only container options and exactly one container name before `sh -c`. */
function isContainerPrefix(stretch, launcherText) {
  const tokens = stretch.trim() ? stretch.trim().split(/\s+/) : []
  let names = 0
  for (let t = 0; t < tokens.length; t++) {
    if (/[;&|()`]/.test(tokens[t])) return false
    if (tokens[t] === '--') continue
    if (tokens[t].startsWith('-')) {
      if (VALUE_OPTIONS.has(tokens[t])) t++
      continue
    }
    names++
  }
  return names === (/worktree-docker/.test(launcherText) ? 0 : 1)
}

/** Split a shell script at top-level `&& || ; | &` and newline, skipping quotes, `$(…)` and `${…}`. */
function splitScript(s) {
  const cmds = []
  const ops = []
  let start = 0
  let quote = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '\\') {
      i++
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      continue
    }
    if (c === '$' && (s[i + 1] === '(' || s[i + 1] === '{')) {
      const open = s[i + 1]
      const close = open === '(' ? ')' : '}'
      let depth = 0
      for (i = i + 1; i < s.length; i++) {
        if (s[i] === open) depth++
        else if (s[i] === close && --depth === 0) break
      }
      continue
    }
    const two = s.slice(i, i + 2)
    const op = two === '&&' || two === '||' ? two : ';|&\n'.includes(c) ? c : null
    if (op) {
      cmds.push({ text: s.slice(start, i), start, end: i })
      ops.push(op)
      i += op.length - 1
      start = i + 1
    }
  }
  cmds.push({ text: s.slice(start), start, end: s.length })
  return { cmds, ops }
}

/** R5 applied to one container script; `off` is the verb's offset inside it. */
function classifyContainerScript(script, off) {
  if (RC_FORM_RE.test(script)) return 'safe-rc'
  const { cmds, ops } = splitScript(script)
  const k = cmds.findIndex((c) => off >= c.start && off < c.end)
  if (k < 0) return 'not-command-position'
  if (!VERB_AT_COMMAND_RE.test(cmds[k].text.trim())) return 'not-command-position'
  let gate = -1
  for (let x = k - 1; x >= 0; x--) {
    if (ops[x] !== '&&') break
    if (GATE_CMD_RE.test(cmds[x].text.trim())) {
      gate = x
      break
    }
  }
  if (gate < 0) return 'no-gate-in-and-chain'
  for (let x = gate - 1; x >= 0; x--) {
    if (ops[x] === ';' || ops[x] === '\n' || ops[x] === '&') break
    if (ops[x] !== '&&') return 'or-before-gate'
  }
  return 'safe'
}

/**
 * R3-R6 over one logical unit. Returns one entry per npm mutation verb that is
 * attributed to a preceding launcher: `safe`, `safe-rc`, `lock-only-unverified`,
 * or a finding verdict.
 */
export function classifyUnit(seg) {
  const launches = [...seg.matchAll(globalRe(LAUNCH_SRC))].map((m) => ({
    s: m.index,
    e: m.index + m[0].length,
  }))
  if (launches.length === 0) return []
  const out = []
  for (const v of seg.matchAll(globalRe(VERB_SRC))) {
    const launcher = launches.filter((l) => l.e <= v.index).pop()
    if (!launcher) continue
    let verdict = 'outside-container-shell'
    const shellC = globalRe(SHELL_C_SRC)
    shellC.lastIndex = launcher.e
    const m = shellC.exec(seg)
    const launcherText = seg.slice(launcher.s, launcher.e)
    if (m && m.index < v.index && isContainerPrefix(seg.slice(launcher.e, m.index), launcherText)) {
      const after = m.index + m[0].length
      const opener = OPENERS.find((o) => seg.startsWith(o, after))
      if (!opener) verdict = 'no-quoted-script'
      else {
        const bodyStart = after + opener.length
        const close = seg.indexOf(opener, bodyStart)
        if (close < 0) verdict = 'unclosed-script'
        else if (v.index >= close) verdict = 'outside-container-shell'
        else verdict = classifyContainerScript(seg.slice(bodyStart, close), v.index - bodyStart)
      }
    }
    if (verdict !== 'safe' && verdict !== 'safe-rc') {
      const ownCommand = seg.slice(v.index).split(/&&|\|\||;|\||'|"|\n/)[0]
      if (LOCK_FAMILY_RE.test(v[0]) && LOCK_ONLY_FLAG_RE.test(ownCommand)) {
        verdict = 'lock-only-unverified'
      }
    }
    out.push({ verdict, index: v.index, text: v[0].replace(/\s+/g, ' ') })
  }
  return out
}

/** What a launcher unit still needs joined, or null when it is complete. */
function pendingJoin(seg, heredocDone) {
  if (/\\$/.test(seg.trimEnd())) return { kind: 'continuation' }
  const last = [...seg.matchAll(globalRe(SHELL_C_SRC))].pop()
  if (last) {
    const after = last.index + last[0].length
    const opener = OPENERS.find((o) => seg.startsWith(o, after))
    if (opener && seg.indexOf(opener, after + opener.length) < 0) return { kind: 'quote' }
  }
  if (!heredocDone) {
    const h = HEREDOC_RE.exec(seg)
    if (h) return { kind: 'heredoc', delim: h[2] }
  }
  return null
}

/**
 * R2. Markdown prose outside fences: one unit per backtick span per line. Code,
 * and fenced markdown: a launcher line becomes a logical command by joining
 * trailing `\` continuations, an unclosed `sh -c` quote, and a heredoc body,
 * until complete or EOF (a markdown join never crosses a fence line). A unit
 * still incomplete at that point is `splitUnresolved`.
 */
export function logicalUnits(text, isMd) {
  const lines = text.split('\n')
  const out = []
  let fence = null
  // A join inside a fenced block stops only at that block's own closing fence.
  const blocked = (idx) =>
    idx >= lines.length || (isMd && fence !== null && closesFence(lines[idx], fence))
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const base = { line: i + 1, lineText: line.trim(), joined: 0, splitUnresolved: false }
    if (isMd && fence === null) {
      const opener = fenceOpener(line)
      if (opener) {
        fence = opener
        continue
      }
    } else if (isMd && closesFence(line, fence)) {
      fence = null
      continue
    }
    if (isMd && fence === null) {
      for (const span of line.split('`')) out.push({ ...base, seg: span })
      continue
    }
    if (!globalRe(LAUNCH_SRC).test(line)) {
      out.push({ ...base, seg: line })
      continue
    }
    let seg = line
    let j = i
    let heredocDone = false
    let unresolved = false
    for (let p = pendingJoin(seg, heredocDone); p; p = pendingJoin(seg, heredocDone)) {
      if (blocked(j + 1)) {
        unresolved = true
        break
      }
      if (p.kind === 'continuation') seg = seg.trimEnd().slice(0, -1) + ' ' + lines[++j]
      else if (p.kind === 'quote') seg = seg + '\n' + lines[++j]
      else {
        let k = j + 1
        while (!blocked(k) && lines[k].trim() !== p.delim) k++
        seg = seg + '\n' + lines.slice(j + 1, Math.min(k + 1, lines.length)).join('\n')
        heredocDone = true
        if (blocked(k)) {
          j = Math.min(k, lines.length) - 1
          unresolved = true
          break
        }
        j = k
      }
    }
    out.push({ ...base, seg, joined: j - i, splitUnresolved: unresolved })
    i = j
  }
  return out
}

/** R7. Arm B: `mountpoint` / `findmnt` with a path argument. */
export function probeMounts(text) {
  const nodeModulesVars = new Set()
  const assign = /^\s*(?:export\s+|local\s+|readonly\s+)?(\w+)=\S*node_modules/gm
  for (const m of text.matchAll(assign)) nodeModulesVars.add(m[1])
  const probeSrc = String.raw`(?:^|[\s;&|(\x60'"{])(mountpoint|findmnt)((?:\s+--?[A-Za-z][\w-]*)*)\s+(["']?)(\$\{?(\w+)\}?|[/.~][^\s'";|&)]*)`
  const out = []
  text.split('\n').forEach((lineText, idx) => {
    for (const m of lineText.matchAll(globalRe(probeSrc))) {
      const block = m[4].includes('node_modules') || Boolean(m[5] && nodeModulesVars.has(m[5]))
      out.push({
        line: idx + 1,
        lineText: lineText.trim(),
        severity: block ? 'block' : 'warn',
        text: m[0].trim(),
      })
    }
  })
  return out
}

/** One file's text through R2-R7, exactly as the repo scan runs it. */
export function scanText(text, isMd) {
  const verbs = []
  const unresolved = []
  let joinedUnits = 0
  for (const u of logicalUnits(text, isMd)) {
    if (u.joined) joinedUnits++
    if (u.splitUnresolved) unresolved.push({ line: u.line, lineText: u.lineText })
    for (const r of classifyUnit(u.seg)) verbs.push({ line: u.line, lineText: u.lineText, ...r })
  }
  return { verbs, unresolved, probes: probeMounts(text), joinedUnits }
}

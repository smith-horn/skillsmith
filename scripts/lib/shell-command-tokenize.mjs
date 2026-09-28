/**
 * Shell-command tokenizer (quote-aware, records command substitutions),
 * shared by `scripts/env-read-guard.mjs` and `scripts/ruflo-host-guard.mjs`
 * via `scripts/lib/shell-command-normalize.mjs`.
 *
 * Split out of `shell-command-normalize.mjs` itself (SMI-6744 Wave 4 delta
 * governance round) purely to stay under the 500-line file-length gate
 * (`scripts/check-file-length.mjs`) once the H-6 ANSI-C-quoting fix and its
 * own docblock corrections pushed that file past the limit —
 * `shell-command-normalize.mjs` imports `tokenize`/`basenameOf` back from
 * here and RE-EXPORTS them, so no consumer's own import path changes.
 */

/** @param {string} p */
export function basenameOf(p) {
  return p.split('/').pop()
}

// --- Tokenizer (quote-aware, records command substitutions) ---

/** Index just past the closing `"` starting at s[i] === '"'. */
function skipDouble(s, i) {
  let j = i + 1
  while (j < s.length) {
    if (s[j] === '\\') {
      j += 2
      continue
    }
    if (s[j] === '"') return j + 1
    j++
  }
  return s.length
}

/** Balanced-paren read; s[start] === '('. */
function readParen(s, start) {
  let depth = 0
  let i = start
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === "'") {
      const e = s.indexOf("'", i + 1)
      i = e === -1 ? s.length : e + 1
      continue
    }
    if (c === '"') {
      i = skipDouble(s, i)
      continue
    }
    if (c === '(') {
      depth++
      i++
      continue
    }
    if (c === ')') {
      depth--
      i++
      if (depth === 0) return { inner: s.slice(start + 1, i - 1), next: i }
      continue
    }
    i++
  }
  return { inner: s.slice(start + 1), next: s.length }
}

/**
 * Split a command string into word/operator tokens. Word tokens carry
 * their unquoted `value` plus any `$(...)` / backtick bodies in `subs`.
 * @param {string} command
 */
export function tokenize(command) {
  const tokens = []
  let cur = null
  const flush = () => {
    if (cur !== null) tokens.push(cur)
    cur = null
  }
  const word = () => {
    if (cur === null) cur = { type: 'word', value: '', subs: [] }
    return cur
  }
  const pushOp = (value, width, i) => {
    flush()
    tokens.push({ type: 'op', value })
    return i + width
  }

  let i = 0
  while (i < command.length) {
    const c = command[i]
    if (c === '\\') {
      if (i + 1 < command.length) word().value += command[i + 1]
      i += 2
      continue
    }
    if (c === "'") {
      const e = command.indexOf("'", i + 1)
      word().value += e === -1 ? command.slice(i + 1) : command.slice(i + 1, e)
      i = e === -1 ? command.length : e + 1
      continue
    }
    if (c === '"') {
      const w = word()
      let j = i + 1
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\') {
          if (j + 1 < command.length) w.value += command[j + 1]
          j += 2
        } else if (command[j] === '$' && command[j + 1] === '(') {
          const r = readParen(command, j + 1)
          w.subs.push(r.inner)
          w.value += command.slice(j, r.next)
          j = r.next
        } else if (command[j] === '`') {
          const e = command.indexOf('`', j + 1)
          const inner = e === -1 ? command.slice(j + 1) : command.slice(j + 1, e)
          w.subs.push(inner)
          w.value += inner
          j = e === -1 ? command.length : e + 1
        } else {
          w.value += command[j]
          j++
        }
      }
      i = j < command.length ? j + 1 : command.length
      continue
    }
    if (c === '`') {
      const w = word()
      const e = command.indexOf('`', i + 1)
      const inner = e === -1 ? command.slice(i + 1) : command.slice(i + 1, e)
      w.subs.push(inner)
      w.value += inner
      i = e === -1 ? command.length : e + 1
      continue
    }
    if (c === '$' && command[i + 1] === "'") {
      // ANSI-C quoting (H-6 fix, SMI-6744 Wave 4 governance round):
      // `$'...'` is a distinct Bash quoting form from a plain `'...'` —
      // unlike single quotes, its body's own backslash escapes ARE
      // processed, so `bash -c $'npx ruflo memory store'` reached
      // `extractShellDashC` with the LITERAL text `$'npx ruflo memory
      // store'` still attached to the `$`, which never equalled the
      // decoded command text `H1`/`H4`/`H5` test for. Decodes minimally —
      // `\n`, `\t`, `\\`, `\'`, and `\xHH` — matching this file's own
      // "unrecognized escape passes the character through" convention
      // elsewhere for anything else. Dropping the `$` and reusing the
      // current word (`word()`, not a fresh one) lets `$'text'` glued
      // directly onto other characters compose the same way a plain
      // quoted segment already does.
      const w = word()
      let j = i + 2
      while (j < command.length && command[j] !== "'") {
        if (command[j] === '\\') {
          const esc = command[j + 1]
          if (esc === 'n') {
            w.value += '\n'
            j += 2
          } else if (esc === 't') {
            w.value += '\t'
            j += 2
          } else if (esc === '\\' || esc === "'") {
            w.value += esc
            j += 2
          } else if (esc === 'x') {
            const hex = command.slice(j + 2, j + 4)
            const m = /^[0-9a-fA-F]{1,2}/.exec(hex)
            if (m) {
              w.value += String.fromCharCode(parseInt(m[0], 16))
              j += 2 + m[0].length
            } else {
              w.value += 'x'
              j += 2
            }
          } else {
            w.value += esc ?? ''
            j += 2
          }
          continue
        }
        w.value += command[j]
        j++
      }
      i = j < command.length ? j + 1 : command.length
      continue
    }
    if ((c === '$' || c === '<' || c === '>') && command[i + 1] === '(') {
      const w = word()
      const r = readParen(command, i + 1)
      w.subs.push(r.inner)
      w.value += command.slice(i, r.next)
      i = r.next
      continue
    }
    if (c === '\n') {
      i = pushOp('\n', 1, i)
      continue
    }
    if (/\s/.test(c)) {
      flush()
      i++
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      i = pushOp(two, 2, i)
      continue
    }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '{' || c === '}') {
      i = pushOp(c, 1, i)
      continue
    }
    word().value += c
    i++
  }
  flush()
  return tokens
}

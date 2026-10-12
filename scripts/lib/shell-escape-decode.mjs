/**
 * Shared backslash-escape decoder (SMI-6744 C1 fix, delta round).
 *
 * Before this fix, two call sites each implemented their OWN partial
 * escape table and could silently diverge from one another:
 *   - `scripts/lib/shell-command-tokenize.mjs`'s `$'...'` (ANSI-C quoting)
 *     branch decoded `\n`, `\t`, `\\`, `\'`, and `\xHH` only, falling
 *     through unchanged for everything else — including `\NNN` (octal),
 *     `\uHHHH`, and `\UHHHHHHHH`, all of which zsh (and, for `\NNN`/`\xHH`/
 *     `\uHHHH`, bash) genuinely decodes. `$'\162uflo' memory store` (octal
 *     162 = 'r') reached `decide()` in `scripts/ruflo-host-guard.mjs` as
 *     the LITERAL text `\162uflo`, which never equalled the decoded
 *     `ruflo` the H-predicates test for — a live bypass, not a cosmetic
 *     gap (measured: `zsh -c "printf '\162uflo\n'"` prints `ruflo`).
 *   - `scripts/lib/ruflo-host-guard-shell-fed.mjs`'s `decodePrintfEscapes`
 *     already handled `\xHH`/`\NNN`/`\uHHHH`/`\UHHHHHHHH` (deliberately
 *     minimal, no `\n`/`\t`/etc — see that file's own history) for
 *     printf(1)/bash's `printf` builtin's format-string escapes.
 * Both now call `decodeEscapeAt` below, so the two tables cannot diverge
 * again. Measured against both bash 3.2 (macOS's stock `/bin/bash`) and
 * zsh 5.9: zsh decodes the full table below (including `\UHHHHHHHH`);
 * bash 3.2 decodes everything except `\UHHHHHHHH` (added in bash 4.2).
 * Decoding the FULL table regardless of which shell might reject a given
 * form is the conservative, fail-closed choice for a security guard — it
 * can only make this guard MORE willing to recognize a disguised `ruflo`
 * invocation, never less.
 *
 * Unknown-escape behavior is a genuine bash/zsh divergence (MEASURED):
 * bash's `$'\z'` keeps the backslash (`\z`), zsh's drops it (`z`). This
 * repo's tokenizer already pinned the zsh-shaped behavior before this fix
 * (`scripts/tests/shell-command-normalize.test.ts`'s own
 * "passes an unrecognized escape character through unchanged" case,
 * `$'a\zb'` -> `azb`) — kept here rather than switched, both because
 * changing a passing pinned test is out of this fix's own scope and
 * because dropping the backslash is the MORE conservative reading for a
 * security guard (it can only ever reveal MORE of a disguised name to the
 * predicates below, never hide one bash's own behavior would have shown).
 */

/** `\cX` control-character escape: `uppercase(X) XOR 0x40`. */
function controlChar(ch) {
  return String.fromCharCode((ch.toUpperCase().charCodeAt(0) ^ 0x40) & 0xff)
}

/**
 * Decodes ONE backslash escape sequence starting at `text[pos]`, which
 * MUST be `\\`. Shared by the ANSI-C `$'...'` tokenizer branch (which
 * needs per-character, position-aware decoding so it can also detect the
 * unescaped closing `'`) and `decodeShellEscapes` below (a whole-string
 * convenience wrapper for callers, like printf's own format-string
 * decoding, that already hold an isolated literal argument with no
 * quote-termination concern).
 * @param {string} text
 * @param {number} pos index of the `\\` character
 * @returns {{ value: string, next: number }} the decoded character(s), and
 *   the index just past the whole escape sequence (backslash included) —
 *   always `> pos`, so a caller looping on this can never stall.
 */
export function decodeEscapeAt(text, pos) {
  const body = text.slice(pos + 1)
  if (body.length === 0) return { value: '', next: pos + 1 }
  const c = body[0]

  // `\NNN` -- one to three octal digits (bash/zsh accept a leading `0`
  // exactly the same way: `\0NNN` is not a distinct escape, it is just
  // this same rule with '0' as the first of up to three octal digits --
  // MEASURED: `printf '\0143at\n'` decodes only `\014` (three digits,
  // greedy) and leaves `3at` literal, matching this same {1,3} rule with
  // no special-casing).
  if (c >= '0' && c <= '7') {
    const m = /^[0-7]{1,3}/.exec(body)
    return { value: String.fromCharCode(parseInt(m[0], 8) & 0xff), next: pos + 1 + m[0].length }
  }

  switch (c) {
    case '\\':
      return { value: '\\', next: pos + 2 }
    case "'":
      return { value: "'", next: pos + 2 }
    case '"':
      return { value: '"', next: pos + 2 }
    case 'n':
      return { value: '\n', next: pos + 2 }
    case 't':
      return { value: '\t', next: pos + 2 }
    case 'r':
      return { value: '\r', next: pos + 2 }
    case 'a':
      return { value: '\x07', next: pos + 2 }
    case 'b':
      return { value: '\x08', next: pos + 2 }
    case 'f':
      return { value: '\x0c', next: pos + 2 }
    case 'v':
      return { value: '\x0b', next: pos + 2 }
    case 'e':
    case 'E':
      return { value: '\x1b', next: pos + 2 }
    case 'x': {
      const m = /^[0-9a-fA-F]{1,2}/.exec(body.slice(1))
      if (m) return { value: String.fromCharCode(parseInt(m[0], 16)), next: pos + 2 + m[0].length }
      return { value: 'x', next: pos + 2 }
    }
    case 'u': {
      const m = /^[0-9a-fA-F]{1,4}/.exec(body.slice(1))
      if (m) return { value: String.fromCodePoint(parseInt(m[0], 16)), next: pos + 2 + m[0].length }
      return { value: 'u', next: pos + 2 }
    }
    case 'U': {
      const m = /^[0-9a-fA-F]{1,8}/.exec(body.slice(1))
      if (m) return { value: String.fromCodePoint(parseInt(m[0], 16)), next: pos + 2 + m[0].length }
      return { value: 'U', next: pos + 2 }
    }
    case 'c': {
      const ctrl = body[1]
      if (ctrl) return { value: controlChar(ctrl), next: pos + 3 }
      return { value: 'c', next: pos + 2 }
    }
    default:
      // Unrecognized escape -- drop the backslash, keep the character
      // (zsh-shaped; see docblock above).
      return { value: c, next: pos + 2 }
  }
}

/**
 * Decodes every backslash escape in an already-isolated literal string
 * (no quote-termination scanning needed — unlike the ANSI-C `$'...'`
 * tokenizer branch, which calls `decodeEscapeAt` directly instead of this
 * whole-string convenience wrapper).
 * @param {string} text
 * @returns {string}
 */
export function decodeShellEscapes(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) {
      const r = decodeEscapeAt(text, i)
      out += r.value
      i = r.next
    } else {
      out += text[i]
      i++
    }
  }
  return out
}

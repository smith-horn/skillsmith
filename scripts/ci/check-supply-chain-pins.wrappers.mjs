/**
 * Command-word resolution for Check 4 of `check-supply-chain-pins.mjs`
 * (SMI-6944, SMI-6978): given one command's tokens, find the word the shell
 * actually runs. Split out of check-supply-chain-pins.commands.mjs to keep every
 * file under the 500-line ceiling.
 *
 * Skipped before the command word:
 *   - leading `VAR=value` assignments and the keywords in KEYWORDS;
 *   - `function NAME` (the `function f { vercel deploy; }` form; `f() { ...; }`
 *     already splits at the parentheses);
 *   - redirections anywhere in the command (`>/dev/null vercel deploy`,
 *     `2>&1`, `> out`, `<<<word`), with a detached target (`> out`) taken too;
 *   - wrapper words that run their operand as a command, with their own flags.
 *     A flag that takes a SEPARATE value consumes the next token
 *     (`sudo -u runner vercel`, `timeout -s KILL 60 vercel`, `exec -a x vercel`,
 *     `env -u FOO vercel`); an attached value (`-uroot`, `--user=root`, `-oL`)
 *     is one token. `timeout` also consumes its DURATION operand, and
 *     `env -S 'vercel deploy'` re-splits its string into the command.
 *
 * Pure functions. ASCII only.
 *
 * @see scripts/ci/check-supply-chain-pins.commands.mjs (consumer)
 * @see docs/internal/implementation/smi-6944-vercel-cli-from-lockfile.md
 */

export const KEYWORDS = new Set([
  'then',
  'do',
  'else',
  'elif',
  'if',
  'while',
  'until',
  '!',
  '{',
  '}',
])
export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/

/**
 * Wrapper words that run their operand. `value`: flags taking a separate value
 * token. `operands`: positional operands before the command (timeout's DURATION).
 * `split`: flags whose value is a command string (env -S). `lookup`: a flag that
 * makes the wrapper look a name up instead of running it (`command -v vercel`).
 */
const WRAPPERS = {
  env: {
    value: ['-u', '--unset', '-C', '--chdir', '-P'],
    split: ['-S', '--split-string'],
  },
  sudo: {
    value: [
      '-u',
      '--user',
      '-g',
      '--group',
      '-h',
      '--host',
      '-p',
      '--prompt',
      '-C',
      '--close-from',
      '-D',
      '--chdir',
      '-r',
      '--role',
      '-t',
      '--type',
      '-U',
      '--other-user',
      '-T',
      '--command-timeout',
      '-R',
      '--chroot',
    ],
  },
  doas: { value: ['-u', '-C'] },
  nohup: {},
  setsid: {},
  time: { value: ['-f', '--format', '-o', '--output'] },
  timeout: { value: ['-s', '--signal', '-k', '--kill-after'], operands: 1 },
  nice: { value: ['-n', '--adjustment'] },
  stdbuf: { value: ['-i', '-o', '-e', '--input', '--output', '--error'] },
  xargs: {
    value: [
      '-I',
      '-n',
      '-P',
      '-L',
      '-s',
      '-d',
      '-E',
      '-a',
      '--arg-file',
      '--delimiter',
      '--max-args',
      '--max-procs',
      '--max-lines',
      '--max-chars',
      '--eof',
      '--process-slot-var',
    ],
  },
  corepack: {},
  command: { lookup: /^-[a-zA-Z]*[vV]/ },
  builtin: {},
  exec: { value: ['-a'] },
}
const SPECS = Object.fromEntries(
  Object.entries(WRAPPERS).map(([k, s]) => [
    k,
    {
      value: new Set(s.value || []),
      split: new Set(s.split || []),
      operands: s.operands || 0,
      lookup: s.lookup || null,
    },
  ])
)

const REDIRECT = /^(?:\d+|&)?(?:<<<|<<-|<<|>>|>\||>&|<>|<&|>|<)([\s\S]*)$/

/** Strip surrounding quote characters. */
export function bare(token) {
  return String(token).replace(/^["']+|["']+$/g, '')
}

function unquote(token) {
  const m = token.match(/^(["'])([\s\S]*)\1$/)
  return m ? m[2] : token
}

/** Tokens with every redirection (and a detached redirection target) removed. */
export function withoutRedirects(tokens) {
  const out = []
  for (let i = 0; i < tokens.length; i++) {
    const m = tokens[i].match(REDIRECT)
    if (!m) out.push(tokens[i])
    else if (m[1] === '') i++ // `> file`: the target is the next token
  }
  return out
}

/** Index just past wrapper `name`'s own flags and operands, starting at `i`. */
function skipWrapperArgs(spec, toks, i) {
  for (;;) {
    const t = toks[i]
    if (t === undefined) return { i }
    if (t === '--') return { i: i + 1 }
    if (spec.split.has(t)) return { i: i + 2, split: toks[i + 1] }
    const eq = t.indexOf('=')
    if (t.startsWith('--') && eq > 0 && spec.split.has(t.slice(0, eq))) {
      return { i: i + 1, split: t.slice(eq + 1) }
    }
    if (/^-S./.test(t) && spec.split.has('-S')) return { i: i + 1, split: t.slice(2) }
    if (spec.value.has(t)) i += 2
    else if (t.startsWith('-') || ASSIGNMENT.test(t)) i++
    else return { i }
  }
}

/** Tokens from the real command word onward, or null when there is none. */
export function commandWords(tokens) {
  let toks = withoutRedirects(tokens)
  let i = 0
  while (i < toks.length) {
    const b = bare(toks[i])
    const spec = Object.prototype.hasOwnProperty.call(SPECS, b) ? SPECS[b] : null
    if (ASSIGNMENT.test(toks[i]) || KEYWORDS.has(b)) {
      i++
    } else if (b === 'function') {
      i += 2
    } else if (spec) {
      if (spec.lookup && spec.lookup.test(toks[i + 1] || '')) return null
      const r = skipWrapperArgs(spec, toks, i + 1)
      i = r.i
      if (r.split !== undefined) {
        const inner = unquote(r.split).trim().split(/\s+/).filter(Boolean)
        toks = [...inner, ...toks.slice(i)]
        i = 0
        continue
      }
      for (let k = 0; k < spec.operands && i < toks.length; k++) i++
    } else {
      break
    }
  }
  return i < toks.length ? toks.slice(i) : null
}

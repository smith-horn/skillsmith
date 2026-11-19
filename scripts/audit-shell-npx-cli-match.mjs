/**
 * The npx call pattern for Check 59's shell sub-check (SMI-7223, SMI-7241),
 * and which of its matches count.
 *
 * A scan carries one matcher from matcher() through every function it calls,
 * as an argument; nothing at module level changes during a scan, so a scan
 * restricted to some tools cannot leak into a later one.
 */

export const TOOLS = ['supabase', 'wrangler']

// npx flags whose value is a separate word. `-p`/`--package` is checked by
// pinnedByPackageFlag(): its value is what npx installs.
const NPX_VALUE_FLAGS = '--prefix|--cache|--registry|--userconfig|--workspace|-w|--package|-p'
// `npx` as a bare word or a quoted command word ("npx" / 'npx'), then
// optional flags, then a watched tool, bare or quoted, with an optional
// @version (group 3 is the tool, group 4 the version). Bash's blanks are
// space and tab only, so `echo\rnpx` is one word: CR, FF and VT count as word
// characters before `npx`.
const hitFor = (tools) =>
  new RegExp(
    String.raw`(?:(?<![\w.$\r\f\v-])npx|(["'])npx\1)\s+(?:(?:${NPX_VALUE_FLAGS})(?:=|\s+)\S+\s+|--?[A-Za-z-]+(?:=\S+)?\s+)*(["']?)(${tools.join('|')})(@[^\s"';&|()<>]+)?\2(?![A-Za-z0-9@_-])`,
    'g'
  )
// An exact pin: npx runs that version, not registry-latest. A prerelease or
// build suffix still names one version.
const EXACT_VERSION = /^@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
// `-p <value>` / `--package=<value>` among npx's flags.
const PACKAGE_FLAG = /(?:^|\s)(?:-p|--package)(?:=|\s+)(["']?)([^\s"']+)\1/g

/**
 * What one scan looks for. `tools`: a non-empty subset of TOOLS (checked by
 * the caller). `versioned`: count only calls that name a version that is not
 * exact, as `tool@spec` or `-p tool@spec` (a bare `npx tool` does not count).
 * `quotedArgs`: also scan every quoted argument as a script of its own.
 */
export function matcher(tools, { versioned = false, quotedArgs = false } = {}) {
  return { re: hitFor(tools), versioned, quotedArgs }
}

/** Does this match of `pat.re` count: unpinned, and versioned if asked. */
export function counts(pat, m) {
  if (isPinned(m)) return false
  return !pat.versioned || m[4] !== undefined || packageValueFor(m[0], m[3], () => true)
}

/** True when an npx match pins its tool: an exact @version, or else -p/--package. */
function isPinned(m) {
  if (m[4]) return EXACT_VERSION.test(m[4])
  return packageValueFor(m[0], m[3], (version) => EXACT_VERSION.test(version))
}

/** Does a -p/--package value in the call name this tool with a version passing `test`? */
function packageValueFor(call, tool, test) {
  for (const m of call.matchAll(PACKAGE_FLAG)) {
    const at = m[2].lastIndexOf('@')
    if (at > 0 && m[2].slice(0, at) === tool && test(m[2].slice(at))) return true
  }
  return false
}

/** The tool of the first counted call in `text`, context ignored. */
export function anyCall(text, pat) {
  for (const m of text.matchAll(pat.re)) if (counts(pat, m)) return m[3]
  return null
}

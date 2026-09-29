#!/usr/bin/env node
/**
 * Heredoc-consumer table and body normalization for
 * `ruflo-host-guard-shell-fed.mjs` -- split into its own file (round-3
 * governance fix) purely to stay under the 500-line file-length gate once the
 * per-consumer body normalizer grew that file past the limit, same precedent
 * as `ruflo-host-guard-unresolved.mjs`.
 */

/**
 * SMI-6869 consumer-string round, group 10 — commands whose stdin (fed via
 * a heredoc redirect on this same line) is itself a script/config body a
 * LATER process will run as real shell text: `make -f -` reads a Makefile
 * from stdin (a tab-indented recipe line runs via `/bin/sh -c`), `crontab -`
 * installs a crontab from stdin (each line's trailing command field runs
 * via shell), and `at`/`batch` read a job script from stdin (run via shell
 * when the job fires). The body text is handed to `evaluateGuardCommand`
 * NON-embedded, same as a bash heredoc — it is real shell text, not program
 * source — and the guard's own `\n`-as-statement-separator segmentation
 * naturally isolates a Makefile recipe line or an `at` job line as its own
 * segment; a crontab line's 5 leading schedule fields land in front of the
 * command, closed there by M-6's bare-name inversion rather than H4.
 * (SMI-6869 round 2) ALSO extended to a pipe-fed producer (`printf '* * *
 * * * ruflo memory store\n' | crontab -`) — but unlike the shell/
 * interpreter branches below, an UNREADABLE producer here is NOT a deny
 * signal, only a "nothing extracted" one: `resolveShellFedProducer` only
 * ever yields text from a LITERAL producer (`echo`/`printf`, or a `cat`
 * relaying a heredoc), so a non-literal producer (`crontab -l | crontab -`
 * round-tripping) correctly yields nothing and stays allow, never a false
 * deny on ordinary crontab/make pipeline usage.
 */
export const HEREDOC_CONSUMER_BASENAMES = new Set(['make', 'gmake', 'crontab', 'at', 'batch'])

/**
 * Round-3 governance fix. A make/crontab body is NOT a plain shell script,
 * and handing it to `evaluateGuardCommand` raw produced BOTH false positives
 * and holes, all measured through `decide()`:
 *   - `crontab - <<'EOF'\n0 3 * * * /usr/local/bin/backup.sh\nEOF` DENIED on
 *     `0` — a crontab line's five leading SCHEDULE fields are not argv, so
 *     the first one reached `checkUnresolvedCommand`'s all-digit arm. (The
 *     shell-fed docblock anticipated those fields landing "in front of the
 *     command, closed there by M-6's bare-name inversion" — but an earlier
 *     arm fires first.) Strip the schedule; the command part is what runs.
 *   - `make -f - <<'EOF'\nall:\n\t@ruflo memory store\nEOF` and the `-`
 *     variant reached ALLOW: `@`/`-`/`+` are make's own per-recipe-line
 *     prefix characters (silence / ignore-errors / always-run), stripped by
 *     make before the line reaches `/bin/sh`, so the guard must strip them
 *     too or `@ruflo` never spells `ruflo` at argv[0].
 *   - `make -f - <<'EOF'\napp: main.o\n\t$(CC) -o $@ $<\nEOF` DENIED on the
 *     `$`-in-head arm. A make-level `$(VAR)` at the head is expanded by MAKE,
 *     not the shell, to a program name this guard cannot see either way —
 *     the same "out of reach by design" posture file-sourced text already
 *     has, so such a line is skipped rather than denied. The rest of the
 *     recipe still recurses, so `$(NPX) ruflo memory store`'s own bare
 *     `ruflo` is still closed by the bare-name inversion.
 * Only `\n`-joined output is returned, so the caller's own segmentation is
 * unchanged.
 * @param {string} head basename of this segment's argv[0]
 * @param {string} body the heredoc / literal-producer text
 */
export function normalizeHeredocConsumerBody(head, body) {
  if (head === 'crontab') {
    return body
      .split('\n')
      .map((line) => {
        const t = line.trim()
        if (t === '' || t.startsWith('#')) return ''
        // a crontab VAR=value prologue line is not a schedule line
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) return t
        const nickname = /^@[A-Za-z]+\s+(.*)$/.exec(t)
        if (nickname) return nickname[1]
        const fields = t.split(/\s+/)
        return fields.length > 5 ? fields.slice(5).join(' ') : ''
      })
      .join('\n')
  }
  if (head === 'make' || head === 'gmake') {
    return body
      .split('\n')
      .map((line) => {
        // Strip make's own per-recipe-line prefix characters on EVERY line
        // rather than only TAB-indented ones: GNU make's `.RECIPEPREFIX`
        // lets a Makefile pick a different prefix character, so "TAB means
        // recipe" is not an invariant, and this guard is fail-closed —
        // over-scanning a non-recipe line costs at worst an over-deny on a
        // Makefile make itself would reject.
        const cmd = line.replace(/^[\s@+-]+/, '')
        // a make-level variable reference at the head expands to a name this
        // guard cannot resolve -- out of reach, same posture as `sh <file>`
        return /^\$[({]/.test(cmd) ? '' : cmd
      })
      .join('\n')
  }
  return body
}

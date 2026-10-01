/**
 * The process-launcher table BOTH guards read (SMI-6903 round 22 F1). Moved
 * here from `ruflo-host-guard-wrappers.mjs`, where SMI-6744 Wave 4 built it
 * for the ruflo guard alone (H-A launcher prefixes; the delta round's H-1
 * arity fixes and H-2 exec/command/noglob/builtin per-wrapper value-flags).
 *
 * A launcher prefixes a command without BEING it, and takes its OWN options
 * and operands first, so a one-word peel of the head cannot reach the command
 * (`timeout 5 cat .env` peels to `5 cat .env`, whose argv[0] is `5`). The
 * ruflo guard has peeled these through `normalizeWrappersWithExec` since
 * Wave 4; the env guard never did, and had pinned `timeout`/`nice` as an
 * allowed limit that ADR-172 sec 1 did not name (its class 1 covers an argv
 * path behind a modifier head, and names only `xargs` out of contract). The
 * cross-family gate called that a leak, not a limit. Every launcher below was
 * run with a decoy file in bash 3.2 and zsh 5.9 on the host and bash 5.2 in
 * the dev container, on whichever of those has it; PRINTED means the decoy's
 * contents came out:
 *
 *   timeout 5; --foreground -k 2 5; -s TERM 5     PRINTED, bash 5.2 (absent on the host)
 *   nice; -n 5; -n5; -5                           PRINTED, all three
 *   nice --adjustment=5                           PRINTED, bash 5.2 (BSD nice has no long form)
 *   nohup                                         PRINTED, all three
 *   setsid; -w                                    PRINTED, bash 5.2
 *   stdbuf -oL; -o L                              PRINTED, all three; --output=L bash 5.2
 *   ionice -c 3; -c3 -n7                          PRINTED, bash 5.2
 *   caffeinate -i; -t 5                           PRINTED, bash 3.2 and zsh (macOS only)
 *   taskset 1; -c 0                               PRINTED, bash 5.2
 *   flock /tmp/l; -n /tmp/l                       PRINTED, bash 5.2
 *   chroot /                                      PRINTED, bash 5.2 (root inside the container)
 *   script -q /dev/null                           PRINTED, bash 3.2 and zsh (BSD script; util-linux
 *                                                 script takes -c instead, see the nested note)
 *   timeout 5 nice; nice timeout 5; nohup nice -n 5; env X=1 timeout 5
 *                                                 PRINTED, bash 5.2 (the nohup chain on all three)
 *
 * `chrt` needs a privilege the container lacks (measured, not printed) and
 * `doas`, `unbuffer` and `watch` are installed nowhere here, so their rows are
 * documented semantics rather than measurements. Each stays in the table
 * because a wrong row costs an over-block while a missing row is a silent
 * allow.
 *
 * ONE table with an arity column, so the next launcher is a row and not a new
 * branch: `positionals` is the number of bare (non-flag) arguments the
 * launcher itself consumes before the wrapped command starts; `valueFlags`
 * are its own flags that consume a FOLLOWING value, so flag-skipping does not
 * mistake that value for the wrapped command. A combined short-flag+value
 * token (`-oL`, `-n5`, `-5`) is self-contained and the generic single-token
 * skip handles it. A launcher whose own flag takes a NESTED COMMAND STRING
 * (`script -c`, `su -c`, `dtrace -c`, `flock FILE -c`) is `DASH_C_LAUNCHERS`
 * below, read as shell text by both guards (round 23); `watch` without `-x`
 * joins its words into `sh -c` text, which reads as the same argv here.
 *
 * `exec`/`command`/`noglob`/`builtin` are table rows with their OWN value
 * flags rather than routed through the shared `WRAPPER_VALUE_FLAGS` in
 * `shell-command-normalize.mjs` (H-2 fix): that shared set's `-p` (sudo's
 * password prompt, a value flag) collided with `command -p`'s value-LESS POSIX
 * "default PATH" flag, so `command -p ruflo memory store` once parsed `-p` as
 * consuming `ruflo`. `noglob`/`builtin` take no flags of their own in real
 * Bash; `exec -a <name>` is the one `exec` flag that takes a value.
 *
 * `stopFlags` are a launcher's own flags under which it does NOT run the
 * command that follows: `command -v NAME` and `-V` DESCRIBE the name, and
 * `--help`/`--version` print and exit. With `flock` in the table, peeling
 * through `command -v flock` left an empty command behind, and the ruflo
 * guard's fail-closed arity fallback denied a real repository line
 * (`if … && command -v flock >/dev/null 2>&1; then`, measured, round 22).
 */

import { basenameOf } from './shell-command-tokenize.mjs'

/** Flags under which NO launcher runs its command. */
const UNIVERSAL_STOP_FLAGS = new Set(['--help', '--version'])

export const LAUNCHER_TABLE = new Map(
  [
    { name: 'nohup', positionals: 0, valueFlags: [] },
    { name: 'setsid', positionals: 0, valueFlags: [] },
    { name: 'time', positionals: 0, valueFlags: [] },
    { name: 'unbuffer', positionals: 0, valueFlags: [] },
    // OpenBSD doas(1): `-a style`, `-C config`, `-u user` take values (round
    // 24; documented, the binary is installed nowhere here).
    { name: 'doas', positionals: 0, valueFlags: ['-a', '-u', '-C'] },
    // `caffeinate -t 5 cat …` (measured printing on macOS): `-t`/`-w` take a
    // value, so an empty value-flag set left `5` sitting as argv[0].
    { name: 'caffeinate', positionals: 0, valueFlags: ['-t', '-w'] },
    // H-1 fix: `timeout -k <duration> 5 …` / `-s KILL 5 …` both left
    // timeout's own flag VALUE where the duration positional was expected.
    { name: 'timeout', positionals: 1, valueFlags: ['-k', '--kill-after', '-s', '--signal'] },
    { name: 'nice', positionals: 0, valueFlags: ['-n', '--adjustment'] },
    // Round 23: every row's value flags are the launcher's FULL synopsis,
    // separated long forms included (`stdbuf --output L` printed a decoy in
    // bash 5.2 while only `-o` was modelled). A long form with `=` is one
    // token and needs no row; an OPTIONAL-argument flag (`xargs --replace`,
    // util-linux `script -t[FILE]`) is never a value flag, since the shell
    // does not hand it the next word.
    {
      name: 'stdbuf',
      positionals: 0,
      valueFlags: ['-o', '-e', '-i', '--output', '--error', '--input'],
    },
    // BSD `script [-adkpqr] [-F pipe] [-t time] [file [command …]]` (macOS;
    // `script -q -t 1 /dev/null cat D` printed, round 23) and util-linux
    // `script [options] [file]` whose own `-c`/`--command` is a nested
    // command string (`launcherDashCCommand`, read before this row peels).
    {
      name: 'script',
      positionals: 1,
      valueFlags: [
        '-F',
        '-t',
        '-E',
        '--echo',
        '-o',
        '--output-limit',
        '-T',
        '--log-timing',
        '-I',
        '--log-in',
        '-O',
        '--log-out',
        '-B',
        '--log-io',
        '-m',
        '--logging-format',
      ],
    },
    // H-1 fix: `chrt -f 1 …`'s priority is a REQUIRED bare positional between
    // chrt's own flags and the wrapped command; the deadline options take
    // nanosecond values.
    {
      name: 'chrt',
      positionals: 1,
      valueFlags: [
        '-p',
        '--pid',
        '-T',
        '--sched-runtime',
        '-P',
        '--sched-period',
        '-D',
        '--sched-deadline',
      ],
    },
    {
      name: 'ionice',
      positionals: 0,
      valueFlags: [
        '-c',
        '--class',
        '-n',
        '--classdata',
        '-p',
        '--pid',
        '-P',
        '--pgid',
        '-u',
        '--uid',
      ],
    },
    { name: 'taskset', positionals: 1, valueFlags: [] },
    // `flock [options] FILE COMMAND`, or `flock [options] FILE -c COMMAND`
    // (`launcherDashCCommand`; measured running the body only with FILE first).
    {
      name: 'flock',
      positionals: 1,
      valueFlags: ['-w', '--wait', '--timeout', '-E', '--conflict-exit-code'],
    },
    { name: 'chroot', positionals: 1, valueFlags: ['--userspec', '--groups'] },
    { name: 'watch', positionals: 0, valueFlags: ['-n', '--interval'] },
    // H-1 fix: `-I`/`-i` are xargs's own value flags -- correct only once the
    // ruflo guard's `restoreXargsReplacementWordTokens` has restored the `{}`
    // token its tokenizer loses; see that function. `--replace`, `--eof` and
    // `--max-lines` take an OPTIONAL value and are deliberately absent.
    {
      name: 'xargs',
      positionals: 0,
      valueFlags: [
        '-I',
        '-i',
        '-n',
        '-P',
        '-d',
        '-L',
        '-s',
        '-a',
        '-E',
        '--arg-file',
        '--delimiter',
        '--max-args',
        '--max-procs',
        '--max-chars',
        '--process-slot-var',
      ],
    },
    { name: 'exec', positionals: 0, valueFlags: ['-a'] },
    { name: 'command', positionals: 0, valueFlags: [], stopFlags: ['-v', '-V'] },
    { name: 'noglob', positionals: 0, valueFlags: [] },
    { name: 'builtin', positionals: 0, valueFlags: [] },
  ].map((entry) => [
    entry.name,
    {
      positionals: entry.positionals,
      valueFlags: new Set(entry.valueFlags),
      stopFlags: new Set(entry.stopFlags ?? []),
    },
  ])
)

/**
 * True when one of the launcher's own leading flags means it will not run
 * the command after them (`command -v flock`, `timeout --version`). A
 * short-flag CLUSTER carrying a stop flag stops too (`command -pv cat`
 * prints cat's path and runs nothing, measured; round 23).
 * @param {string[]} argv the words AFTER the launcher's own name
 * @param {{valueFlags: Set<string>, stopFlags: Set<string>}} entry
 */
export function launcherStops(argv, entry) {
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--' || !a.startsWith('-') || a === '-') return false
    if (UNIVERSAL_STOP_FLAGS.has(a) || entry.stopFlags.has(a)) return true
    if (/^-[A-Za-z]{2,}$/.test(a) && [...a.slice(1)].some((ch) => entry.stopFlags.has('-' + ch))) {
      return true
    }
    i += entry.valueFlags.has(a) ? 2 : 1
  }
  return false
}

/**
 * Launchers whose own `-c`/`--command` value is a NESTED COMMAND STRING the
 * launcher runs through a shell: util-linux `script -c`, `su -c`, `dtrace -c`,
 * `flock FILE -c` (each measured printing a decoy file in bash 5.2 where the
 * binary exists; `flock -c CMD FILE` with the file last runs nothing, so the
 * extraction over-approximates and can only add a denial). The ruflo guard
 * has recursed the first three since SMI-6744; the env guard reads them one
 * level deep since SMI-6903 round 23, through `transparentHeadReadings`.
 */
export const DASH_C_LAUNCHERS = new Set(['script', 'su', 'dtrace', 'flock'])

/**
 * The nested command string of a `DASH_C_LAUNCHERS` invocation, or null.
 * `-c CMD`, `-cCMD`, `--command CMD` and `--command=CMD`, anywhere after the
 * launcher's name (util-linux permutes options past the file operand), and a
 * short-flag CLUSTER with getopt's own rule (round 24): the first `c` in the
 * cluster takes the REST of the token as its value, or the next word when
 * nothing follows it. `script -qc 'cat D'` and `script -qc'cat D'` print a
 * decoy in bash 5.2; `script -cq 'cat D'` runs `q`, not cat (measured).
 * @param {string[]} argv the whole argv, launcher name first
 * @returns {string|null}
 */
export function launcherDashCCommand(argv) {
  if (argv.length === 0 || !DASH_C_LAUNCHERS.has(basenameOf(argv[0]))) return null
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') return null
    if (a === '--command') return argv[i + 1] ?? null
    if (a.startsWith('--command=')) return a.slice('--command='.length)
    if (a.startsWith('--') || !a.startsWith('-') || a.length < 2) continue
    const k = a.indexOf('c', 1)
    if (k === -1) continue
    return k === a.length - 1 ? (argv[i + 1] ?? null) : a.slice(k + 1)
  }
  return null
}

/**
 * Strips one launcher's own flags (value-flags aware), then its `positionals`
 * bare arguments. `argv` is the word list AFTER the launcher's own name.
 * @param {string[]} argv
 * @param {{positionals: number, valueFlags: Set<string>}} entry
 * @returns {string[]}
 */
export function stripLauncher(argv, entry) {
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--') {
      i++
      break
    }
    if (!a.startsWith('-') || a === '-') break
    i += entry.valueFlags.has(a) ? 2 : 1
  }
  return argv.slice(i + entry.positionals)
}

/**
 * Peels ONE leading launcher-table entry; null if argv[0] matches none, or
 * if the launcher's own flags say it runs nothing (`launcherStops`). The head
 * is matched by basename, so `/usr/bin/timeout 5 …` peels as `timeout`.
 * @param {string[]} argv
 * @returns {string[]|null}
 */
export function peelOneLauncher(argv) {
  if (argv.length === 0) return null
  const entry = LAUNCHER_TABLE.get(basenameOf(argv[0]))
  if (entry === undefined || launcherStops(argv.slice(1), entry)) return null
  return stripLauncher(argv.slice(1), entry)
}

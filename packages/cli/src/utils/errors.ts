/**
 * SMI-4314: Typed CLI error classes.
 *
 * Library-style command implementations (e.g. `initSkill`) must not call
 * `process.exit` directly. Instead, they throw a typed error carrying the
 * user-facing message and intended exit code. The command-action wrapper
 * catches the typed error, prints the message exactly once, and exits with
 * the requested code. Any other thrown `Error` is treated as an unexpected
 * bug and routed through `sanitizeError` with exit code 1.
 *
 * Keeping the process.exit layer inside the wrapper — rather than inside the
 * library function — prevents the "double-error-print" hazard that
 * `init.helpers.ts` previously had to work around, and lets tests assert on
 * `rejects.toBeInstanceOf(InitSkillError)` instead of monkey-patching
 * `process.exit`.
 */

/**
 * Error thrown by `initSkill` (and related author-init helpers) when an
 * expected user-facing failure occurs — e.g. invalid skill name, invalid
 * category, or filesystem setup failure.
 *
 * The `message` is intended to be user-facing: it is printed to stderr by
 * the command-action wrapper and already carries any ANSI styling from the
 * call site (e.g. `chalk.red(...)`). Callers should therefore not re-wrap
 * the message with another `chalk.red`/"Error:" prefix.
 *
 * @example
 *   throw new InitSkillError(chalk.red(`Invalid skill name: ${name}`))
 *
 * @example
 *   try {
 *     await initSkill(name, targetPath, opts)
 *   } catch (err) {
 *     if (err instanceof InitSkillError) {
 *       console.error(err.message)
 *       process.exit(err.exitCode)
 *     }
 *     // fall through to generic handling
 *   }
 */
export class InitSkillError extends Error {
  /**
   * Process exit code to use when this error reaches the command wrapper.
   * Defaults to 1 (generic failure). Use other codes only when the caller
   * needs to distinguish failure modes in scripted contexts.
   */
  public readonly exitCode: number

  constructor(message: string, exitCode: number = 1, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'InitSkillError'
    this.exitCode = exitCode

    // Preserve `instanceof` across the transpiled class boundary. Without
    // this, `err instanceof InitSkillError` can be false in some CJS/ESM
    // interop scenarios.
    Object.setPrototypeOf(this, InitSkillError.prototype)
  }
}

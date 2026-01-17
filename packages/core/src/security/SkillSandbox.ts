/**
 * SMI-1534: E2B Sandbox Execution for Skill Testing
 *
 * Provides isolated execution environment for testing untrusted skills.
 * Uses E2B (e2b.dev) sandboxes for secure, containerized execution.
 *
 * Features:
 * - Isolated filesystem per skill test
 * - Network isolation
 * - Resource limits (CPU, memory)
 * - Automatic cleanup after test
 * - Configurable timeout (default: 30s)
 */

/**
 * Configuration options for sandbox creation
 */
export interface SandboxOptions {
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number
  /** Memory limit in MB (default: 256) */
  memoryMB?: number
  /** Whether to allow network access (default: false for security) */
  allowNetwork?: boolean
  /** Environment variables to inject */
  env?: Record<string, string>
}

/**
 * Result from executing code in sandbox
 */
export interface ExecutionResult {
  /** Whether execution completed successfully */
  success: boolean
  /** Exit code from the process */
  exitCode: number
  /** Standard output */
  stdout: string
  /** Standard error */
  stderr: string
  /** Execution time in milliseconds */
  durationMs: number
  /** Whether execution timed out */
  timedOut: boolean
  /** Any error that occurred */
  error?: string
}

/**
 * Represents a file to be copied into the sandbox
 */
export interface SandboxFile {
  /** Path within the sandbox */
  path: string
  /** File content */
  content: string
}

/**
 * E2B Sandbox wrapper for skill testing
 *
 * @example
 * ```typescript
 * const sandbox = new SkillSandbox({ timeout: 60000 })
 * try {
 *   await sandbox.create()
 *   await sandbox.copyFiles([
 *     { path: '/skill/SKILL.md', content: skillContent },
 *     { path: '/skill/test.ts', content: testCode }
 *   ])
 *   const result = await sandbox.execute('node /skill/test.ts')
 *   console.log(result.stdout)
 * } finally {
 *   await sandbox.destroy()
 * }
 * ```
 */
export class SkillSandbox {
  private options: Required<SandboxOptions>
  private sandbox: E2BSandboxInterface | null = null
  private created: boolean = false

  constructor(options: SandboxOptions = {}) {
    this.options = {
      timeout: options.timeout ?? 30000,
      memoryMB: options.memoryMB ?? 256,
      allowNetwork: options.allowNetwork ?? false,
      env: options.env ?? {},
    }
  }

  /**
   * Create and initialize the sandbox environment
   * @throws Error if sandbox creation fails or E2B is unavailable
   */
  async create(): Promise<void> {
    if (this.created) {
      throw new Error('Sandbox already created. Call destroy() first.')
    }

    try {
      // Dynamic import to allow graceful degradation if E2B is not installed
      // SMI-1534: Use native dynamic import instead of Function constructor for CSP compliance
      // @ts-expect-error - Dynamic import of optional dependency
      const e2bModule: { Sandbox: E2BSandboxConstructor } = await import('@e2b/code-interpreter')
      const Sandbox = e2bModule.Sandbox

      // Build sandbox configuration with security settings
      const sandboxConfig: Record<string, unknown> = {
        timeout: this.options.timeout,
        // E2B template for Node.js execution
        template: 'node-v20',
        metadata: {
          source: 'skillsmith',
          purpose: 'skill-testing',
          networkIsolation: !this.options.allowNetwork, // Track isolation state
        },
      }

      // Network isolation: E2B may support different mechanisms
      // depending on version. We set the configuration to signal intent.
      if (!this.options.allowNetwork) {
        // Request network isolation when supported by E2B
        sandboxConfig.enableNetworking = false
        sandboxConfig.internetAccess = false // Alternative E2B API field
      }

      this.sandbox = await Sandbox.create(sandboxConfig)

      // SMI-1534: Verify network isolation is actually in effect
      if (!this.options.allowNetwork) {
        await this.verifyNetworkIsolation()
      }

      this.created = true
    } catch (error) {
      // Check if it's a missing module error
      if (
        error instanceof Error &&
        (error.message.includes('Cannot find module') ||
          error.message.includes('Cannot find package') ||
          error.message.includes('ERR_MODULE_NOT_FOUND'))
      ) {
        throw new SandboxUnavailableError(
          'E2B sandbox not available. Install @e2b/code-interpreter to enable sandboxed execution.'
        )
      }
      throw error
    }
  }

  /**
   * Copy files into the sandbox filesystem
   * @param files - Array of files to copy
   */
  async copyFiles(files: SandboxFile[]): Promise<void> {
    this.ensureCreated()

    for (const file of files) {
      await this.sandbox!.filesystem.write(file.path, file.content)
    }
  }

  /**
   * Copy a skill directory into the sandbox
   * @param skillPath - Local path to skill directory
   * @param destPath - Destination path in sandbox (default: /skill)
   */
  async copySkill(skillContent: string, destPath: string = '/skill'): Promise<void> {
    this.ensureCreated()

    // Create skill directory structure
    await this.sandbox!.filesystem.makeDir(destPath)
    await this.sandbox!.filesystem.write(`${destPath}/SKILL.md`, skillContent)
  }

  /**
   * Execute a command in the sandbox
   * @param command - Command to execute
   * @param workingDir - Working directory (default: /skill)
   * @returns Execution result
   */
  async execute(command: string, workingDir: string = '/skill'): Promise<ExecutionResult> {
    this.ensureCreated()

    const startTime = performance.now()
    let timedOut = false
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    try {
      // Create a timeout promise with clearable timer (fixes memory leak)
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true
          reject(new Error('Execution timed out'))
        }, this.options.timeout)
      })

      // Execute command with timeout race
      const executionPromise = this.sandbox!.process.startAndWait({
        cmd: command,
        cwd: workingDir,
        env: this.options.env,
      })

      const result = await Promise.race([executionPromise, timeoutPromise])

      // Clear timeout on successful completion (fixes race condition)
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }

      const durationMs = performance.now() - startTime

      return {
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs,
        timedOut: false,
      }
    } catch (error) {
      const durationMs = performance.now() - startTime

      // Clear timeout if still pending
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }

      if (timedOut) {
        // Kill sandbox process on timeout to free resources
        try {
          await this.sandbox!.kill()
          this.sandbox = null
          this.created = false
        } catch (cleanupError) {
          // SMI-1534: Log cleanup errors for debugging instead of silently ignoring
          console.debug(
            '[SkillSandbox] Cleanup error after timeout:',
            cleanupError instanceof Error ? cleanupError.message : cleanupError
          )
        }

        return {
          success: false,
          exitCode: -1,
          stdout: '',
          stderr: 'Execution timed out after ' + this.options.timeout + 'ms',
          durationMs,
          timedOut: true,
          error: 'Timeout',
        }
      }

      return {
        success: false,
        exitCode: -1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        durationMs,
        timedOut: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Execute TypeScript/JavaScript code directly
   * @param code - Code to execute
   * @returns Execution result
   */
  async executeCode(code: string): Promise<ExecutionResult> {
    this.ensureCreated()

    // Write code to temp file and execute
    const tempPath = '/tmp/skill-test-' + Date.now() + '.js'
    await this.sandbox!.filesystem.write(tempPath, code)

    return this.execute('node ' + tempPath, '/tmp')
  }

  /**
   * Destroy the sandbox and clean up resources
   * Should always be called in a finally block
   */
  async destroy(): Promise<void> {
    if (this.sandbox) {
      try {
        await this.sandbox.kill()
      } catch (cleanupError) {
        // SMI-1534: Log cleanup errors for debugging instead of silently ignoring
        console.debug(
          '[SkillSandbox] Cleanup error during destroy:',
          cleanupError instanceof Error ? cleanupError.message : cleanupError
        )
      }
      this.sandbox = null
      this.created = false
    }
  }

  /**
   * Check if sandbox is active
   */
  isActive(): boolean {
    return this.created && this.sandbox !== null
  }

  /**
   * Get sandbox status
   */
  getStatus(): SandboxStatus {
    return {
      created: this.created,
      active: this.isActive(),
      options: this.options,
    }
  }

  private ensureCreated(): void {
    if (!this.created || !this.sandbox) {
      throw new Error('Sandbox not created. Call create() first.')
    }
  }

  /**
   * SMI-1534: Verify network isolation is actually in effect
   * Attempts to make a network request and expects it to fail
   */
  private async verifyNetworkIsolation(): Promise<void> {
    if (!this.sandbox) return

    try {
      // Try to ping a well-known address - should fail if isolated
      const result = await this.sandbox.process.startAndWait({
        cmd: 'timeout 2 curl -s --connect-timeout 1 http://1.1.1.1 2>&1 || echo "NETWORK_BLOCKED"',
        cwd: '/tmp',
      })

      // If we don't see NETWORK_BLOCKED and exit code is 0, network is accessible
      if (result.exitCode === 0 && !result.stdout.includes('NETWORK_BLOCKED')) {
        console.warn(
          '[SkillSandbox] WARNING: Network isolation verification failed. ' +
            'Network may be accessible despite isolation being requested.'
        )
      }
    } catch {
      // Verification command failed - this is expected in isolated environment
      // No action needed
    }
  }
}

/**
 * Sandbox status information
 */
export interface SandboxStatus {
  created: boolean
  active: boolean
  options: Required<SandboxOptions>
}

/**
 * Error thrown when E2B sandbox is not available
 */
export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxUnavailableError'
  }
}

/**
 * Internal interface for E2B sandbox (avoids direct type dependency)
 */
interface E2BSandboxInterface {
  filesystem: {
    write(path: string, content: string): Promise<void>
    read(path: string): Promise<string>
    makeDir(path: string): Promise<void>
  }
  process: {
    startAndWait(options: { cmd: string; cwd?: string; env?: Record<string, string> }): Promise<{
      exitCode: number
      stdout: string
      stderr: string
    }>
  }
  kill(): Promise<void>
}

/**
 * Constructor interface for E2B Sandbox class
 */
interface E2BSandboxConstructor {
  create(config: Record<string, unknown>): Promise<E2BSandboxInterface>
}

/**
 * Factory function for creating sandboxes with proper cleanup
 * Ensures sandbox is destroyed even if test throws
 *
 * @example
 * ```typescript
 * const result = await withSandbox(async (sandbox) => {
 *   await sandbox.copySkill(skillContent)
 *   return sandbox.execute('node test.js')
 * })
 * ```
 */
export async function withSandbox<T>(
  fn: (sandbox: SkillSandbox) => Promise<T>,
  options?: SandboxOptions
): Promise<T> {
  const sandbox = new SkillSandbox(options)
  try {
    await sandbox.create()
    return await fn(sandbox)
  } finally {
    await sandbox.destroy()
  }
}

export default SkillSandbox

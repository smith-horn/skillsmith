/**
 * SMI-739: OpenTelemetry Tracer Setup
 * SMI-755: Graceful fallback when OpenTelemetry unavailable
 *
 * Provides distributed tracing for Skillsmith operations:
 * - MCP tool calls
 * - Database queries
 * - Cache operations
 * - External API calls
 *
 * Configuration:
 * - OTEL_EXPORTER_OTLP_ENDPOINT: OTLP endpoint for trace export
 * - OTEL_SERVICE_NAME: Service name (default: skillsmith)
 * - SKILLSMITH_TELEMETRY_ENABLED: Master switch for all telemetry (default: auto)
 * - SKILLSMITH_TRACING_ENABLED: Enable/disable tracing (default: true if endpoint set)
 *
 * Graceful Fallback:
 * - If OpenTelemetry packages are not installed, uses NoOp implementations
 * - Logs warning on fallback (unless SKILLSMITH_TELEMETRY_ENABLED=false)
 * - All tracing APIs remain functional (just don't record)
 */

/**
 * Local type definitions matching OpenTelemetry interfaces
 * SMI-755: Allows compilation without @opentelemetry/api installed
 */
interface OTelSpan {
  setAttributes(attributes: Record<string, unknown>): void
  setStatus(status: { code: number; message?: string }): void
  recordException(error: Error): void
  addEvent(name: string, attributes?: Record<string, unknown>): void
  end(): void
}

interface OTelTracer {
  startSpan(name: string, options?: unknown): OTelSpan
}

interface OTelSpanOptions {
  attributes?: Record<string, unknown>
  links?: unknown[]
  startTime?: number
  root?: boolean
  kind?: number
}

// Type aliases for API compatibility
type Span = OTelSpan
type Tracer = OTelTracer
type SpanOptions = OTelSpanOptions
type SpanStatusCode = number

// Lazy import to avoid loading OTEL if not needed
// SMI-755: Use 'unknown' types to avoid compile-time dependency on OTEL packages
let api: unknown = null
let sdk: unknown = null
let resources: unknown = null
let semanticConventions: unknown = null

/**
 * Type-safe accessors for OTEL modules (SMI-755)
 * These provide typed access while avoiding compile-time dependency
 */
interface OTelApi {
  trace: {
    getTracer(name: string, version?: string): OTelTracer
    getActiveSpan(): OTelSpan | undefined
  }
}

interface OTelNodeSDK {
  new (config: unknown): { start(): Promise<void>; shutdown(): Promise<void> }
}

interface OTelResource {
  new (attributes: Record<string, string>): unknown
}

function getApi(): OTelApi | null {
  return api as OTelApi | null
}

function getSdk(): { NodeSDK: OTelNodeSDK } | null {
  return sdk as { NodeSDK: OTelNodeSDK } | null
}

function getResources(): { Resource: OTelResource } | null {
  return resources as { Resource: OTelResource } | null
}

function getSemanticConventions(): Record<string, string> | null {
  return semanticConventions as Record<string, string> | null
}

/** Whether OpenTelemetry packages are available */
let otelAvailable: boolean | null = null

/**
 * Dynamic import helper that bypasses TypeScript type checking (SMI-755)
 * This allows the code to compile even when @opentelemetry packages aren't installed
 */
async function dynamicImport(moduleName: string): Promise<unknown> {
  try {
    // Use Function constructor to bypass TypeScript's static analysis
    const importFn = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>
    return await importFn(moduleName)
  } catch {
    return null
  }
}

/**
 * Check if OpenTelemetry is available (SMI-755)
 */
async function checkOTelAvailability(): Promise<boolean> {
  if (otelAvailable !== null) return otelAvailable

  const result = await dynamicImport('@opentelemetry/api')
  otelAvailable = result !== null
  return otelAvailable
}

/**
 * Tracer configuration
 */
export interface TracerConfig {
  /** Service name for spans (default: skillsmith) */
  serviceName?: string
  /** OTLP endpoint URL */
  endpoint?: string
  /** Enable auto-instrumentation (default: true) */
  autoInstrument?: boolean
  /** Enable console exporter for debugging (default: false) */
  consoleExport?: boolean
  /** Sample rate 0-1 (default: 1.0 = 100%) */
  sampleRate?: number
}

/**
 * Span attribute types
 */
export interface SpanAttributes {
  [key: string]: string | number | boolean | string[] | number[] | boolean[] | undefined
}

/**
 * Span wrapper for easier usage
 */
export interface SpanWrapper {
  /** Add attributes to span */
  setAttributes(attributes: SpanAttributes): void
  /** Set span status */
  setStatus(code: 'ok' | 'error', message?: string): void
  /** Record an exception */
  recordException(error: Error): void
  /** Add an event to the span */
  addEvent(name: string, attributes?: SpanAttributes): void
  /** End the span */
  end(): void
  /** Get the underlying OTEL span (if available) */
  getSpan(): Span | null
}

/**
 * No-op span wrapper for when tracing is disabled
 */
class NoOpSpanWrapper implements SpanWrapper {
  setAttributes(_attributes: SpanAttributes): void {}
  setStatus(_code: 'ok' | 'error', _message?: string): void {}
  recordException(_error: Error): void {}
  addEvent(_name: string, _attributes?: SpanAttributes): void {}
  end(): void {}
  getSpan(): Span | null {
    return null
  }
}

/**
 * Active span wrapper with real OTEL span
 */
class ActiveSpanWrapper implements SpanWrapper {
  constructor(private span: Span) {}

  setAttributes(attributes: SpanAttributes): void {
    // Filter out undefined values
    const filtered: Record<string, string | number | boolean | string[] | number[] | boolean[]> = {}
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) {
        filtered[key] = value
      }
    }
    this.span.setAttributes(filtered)
  }

  setStatus(code: 'ok' | 'error', message?: string): void {
    const statusCode: SpanStatusCode = code === 'ok' ? 1 : 2 // SpanStatusCode.OK = 1, ERROR = 2
    this.span.setStatus({ code: statusCode, message })
  }

  recordException(error: Error): void {
    this.span.recordException(error)
  }

  addEvent(name: string, attributes?: SpanAttributes): void {
    // Filter out undefined values
    const filtered: Record<string, string | number | boolean | string[] | number[] | boolean[]> = {}
    if (attributes) {
      for (const [key, value] of Object.entries(attributes)) {
        if (value !== undefined) {
          filtered[key] = value
        }
      }
    }
    this.span.addEvent(name, filtered)
  }

  end(): void {
    this.span.end()
  }

  getSpan(): Span {
    return this.span
  }
}

/**
 * Skillsmith Tracer - Wrapper for OpenTelemetry tracing
 */
export class SkillsmithTracer {
  private tracer: Tracer | null = null
  private initialized = false
  private enabled = false
  private config: Required<TracerConfig>
  private sdkInstance: { start(): Promise<void>; shutdown(): Promise<void> } | null = null

  constructor(config: TracerConfig = {}) {
    this.config = {
      serviceName: config.serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'skillsmith',
      endpoint: config.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '',
      autoInstrument: config.autoInstrument ?? true,
      consoleExport: config.consoleExport ?? false,
      sampleRate: config.sampleRate ?? 1.0,
    }

    // SMI-755: Check master telemetry switch first
    const telemetryDisabled = process.env.SKILLSMITH_TELEMETRY_ENABLED === 'false'
    if (telemetryDisabled) {
      this.enabled = false
      return
    }

    // Check if tracing should be enabled
    const explicitlyEnabled = process.env.SKILLSMITH_TRACING_ENABLED === 'true'
    const explicitlyDisabled = process.env.SKILLSMITH_TRACING_ENABLED === 'false'

    if (explicitlyDisabled) {
      this.enabled = false
    } else if (explicitlyEnabled || this.config.endpoint || this.config.consoleExport) {
      this.enabled = true
    }
  }

  /**
   * Initialize the tracer
   * Must be called before creating spans
   */
  async initialize(): Promise<void> {
    if (this.initialized) return
    if (!this.enabled) {
      this.initialized = true
      return
    }

    // SMI-755: Check if OpenTelemetry is available before attempting to load
    const isAvailable = await checkOTelAvailability()
    if (!isAvailable) {
      console.warn(
        '[Skillsmith Telemetry] OpenTelemetry packages not installed. ' +
          'Tracing disabled. Install @opentelemetry/api and related packages to enable.'
      )
      this.enabled = false
      this.initialized = true
      return
    }

    try {
      // SMI-755: Lazy load OTEL modules with error handling
      // Use dynamicImport to bypass TypeScript type checking
      api = await dynamicImport('@opentelemetry/api')
      sdk = await dynamicImport('@opentelemetry/sdk-node')
      resources = await dynamicImport('@opentelemetry/resources')
      semanticConventions = await dynamicImport('@opentelemetry/semantic-conventions')

      // If any core module failed to load, disable tracing
      if (!api || !sdk || !resources || !semanticConventions) {
        console.warn(
          '[Skillsmith Telemetry] Some OpenTelemetry packages missing. Tracing disabled.'
        )
        this.enabled = false
        this.initialized = true
        return
      }

      // Get typed accessors
      const otelApi = getApi()
      const otelSdk = getSdk()
      const otelResources = getResources()
      const otelSemConv = getSemanticConventions()

      if (!otelApi || !otelSdk || !otelResources || !otelSemConv) {
        this.enabled = false
        this.initialized = true
        return
      }

      // Build SDK configuration
      const sdkConfig: Record<string, unknown> = {}

      // Create resource with service info
      const Resource = otelResources.Resource
      sdkConfig.resource = new Resource({
        [otelSemConv['ATTR_SERVICE_NAME'] ?? 'service.name']: this.config.serviceName,
        [otelSemConv['ATTR_SERVICE_VERSION'] ?? 'service.version']: '0.1.0',
      })

      // Add auto-instrumentation if enabled
      if (this.config.autoInstrument) {
        try {
          const autoInst = (await dynamicImport('@opentelemetry/auto-instrumentations-node')) as {
            getNodeAutoInstrumentations?: (config: unknown) => unknown[]
          } | null
          if (autoInst?.getNodeAutoInstrumentations) {
            sdkConfig.instrumentations = [
              autoInst.getNodeAutoInstrumentations({
                // Customize instrumentations
                '@opentelemetry/instrumentation-fs': { enabled: false },
                '@opentelemetry/instrumentation-dns': { enabled: false },
                '@opentelemetry/instrumentation-net': { enabled: false },
              }),
            ]
          }
        } catch {
          // Auto-instrumentation optional, continue without it
        }
      }

      // Initialize SDK
      const NodeSDK = otelSdk.NodeSDK
      this.sdkInstance = new NodeSDK(sdkConfig)
      await this.sdkInstance.start()

      // Get tracer
      this.tracer = otelApi.trace.getTracer(this.config.serviceName, '0.1.0')
      this.initialized = true
    } catch (error) {
      // SMI-755: Graceful fallback - disable tracing on error
      console.warn('[Skillsmith Telemetry] Failed to initialize OpenTelemetry tracing:', error)
      this.enabled = false
      this.initialized = true
    }
  }

  /**
   * Check if tracing is enabled
   */
  isEnabled(): boolean {
    return this.enabled && this.initialized
  }

  /**
   * Start a new span
   *
   * @param name - Span name (e.g., 'mcp.tool.search', 'db.query')
   * @param options - Span options
   * @returns SpanWrapper for manipulating the span
   */
  startSpan(name: string, options?: SpanOptions): SpanWrapper {
    if (!this.isEnabled() || !this.tracer) {
      return new NoOpSpanWrapper()
    }

    const span = this.tracer.startSpan(name, options)
    return new ActiveSpanWrapper(span)
  }

  /**
   * Execute a function within a span context
   *
   * @param name - Span name
   * @param fn - Function to execute
   * @param options - Span options
   * @returns Result of the function
   */
  async withSpan<T>(
    name: string,
    fn: (span: SpanWrapper) => Promise<T>,
    options?: SpanOptions
  ): Promise<T> {
    const spanWrapper = this.startSpan(name, options)

    try {
      const result = await fn(spanWrapper)
      spanWrapper.setStatus('ok')
      return result
    } catch (error) {
      if (error instanceof Error) {
        spanWrapper.recordException(error)
      }
      spanWrapper.setStatus('error', error instanceof Error ? error.message : 'Unknown error')
      throw error
    } finally {
      spanWrapper.end()
    }
  }

  /**
   * Execute a synchronous function within a span context
   */
  withSpanSync<T>(name: string, fn: (span: SpanWrapper) => T, options?: SpanOptions): T {
    const spanWrapper = this.startSpan(name, options)

    try {
      const result = fn(spanWrapper)
      spanWrapper.setStatus('ok')
      return result
    } catch (error) {
      if (error instanceof Error) {
        spanWrapper.recordException(error)
      }
      spanWrapper.setStatus('error', error instanceof Error ? error.message : 'Unknown error')
      throw error
    } finally {
      spanWrapper.end()
    }
  }

  /**
   * Get the current active span (if any)
   */
  getCurrentSpan(): SpanWrapper {
    const otelApi = getApi()
    if (!otelApi) {
      return new NoOpSpanWrapper()
    }
    const span = otelApi.trace.getActiveSpan()
    if (!span) {
      return new NoOpSpanWrapper()
    }
    return new ActiveSpanWrapper(span)
  }

  /**
   * Shutdown the tracer and flush pending spans
   */
  async shutdown(): Promise<void> {
    if (this.sdkInstance) {
      await this.sdkInstance.shutdown()
      this.sdkInstance = null
    }
    this.tracer = null
    this.initialized = false
  }
}

// Default tracer instance
let defaultTracer: SkillsmithTracer | null = null

/**
 * Get the default tracer instance
 */
export function getTracer(): SkillsmithTracer {
  if (!defaultTracer) {
    defaultTracer = new SkillsmithTracer()
  }
  return defaultTracer
}

/**
 * Initialize the default tracer
 * Should be called at application startup
 */
export async function initializeTracing(config?: TracerConfig): Promise<SkillsmithTracer> {
  if (defaultTracer) {
    await defaultTracer.shutdown()
  }
  defaultTracer = new SkillsmithTracer(config)
  await defaultTracer.initialize()
  return defaultTracer
}

/**
 * Shutdown the default tracer
 * Should be called at application shutdown
 */
export async function shutdownTracing(): Promise<void> {
  if (defaultTracer) {
    await defaultTracer.shutdown()
    defaultTracer = null
  }
}

/**
 * Decorator for tracing async methods
 */
export function traced(spanName?: string) {
  return function <T extends (...args: unknown[]) => Promise<unknown>>(
    target: unknown,
    propertyKey: string,
    descriptor: TypedPropertyDescriptor<T>
  ): TypedPropertyDescriptor<T> {
    const originalMethod = descriptor.value
    if (!originalMethod) return descriptor

    descriptor.value = async function (this: unknown, ...args: unknown[]) {
      const tracer = getTracer()
      const name = spanName ?? `${(target as object).constructor.name}.${propertyKey}`
      const boundMethod = originalMethod.bind(this)

      return tracer.withSpan(name, async (span) => {
        span.setAttributes({
          'code.function': propertyKey,
          'code.namespace': (target as object).constructor.name,
        })
        return boundMethod(...args)
      })
    } as T

    return descriptor
  }
}

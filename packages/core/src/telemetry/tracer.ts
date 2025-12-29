/**
 * SMI-739: OpenTelemetry Tracer Setup
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
 * - SKILLSMITH_TRACING_ENABLED: Enable/disable tracing (default: true if endpoint set)
 */

import type { Span, Tracer, SpanStatusCode, SpanOptions, Context } from '@opentelemetry/api'

// Lazy import to avoid loading OTEL if not needed
let api: typeof import('@opentelemetry/api') | null = null
let sdk: typeof import('@opentelemetry/sdk-node') | null = null
let resources: typeof import('@opentelemetry/resources') | null = null
let semanticConventions: typeof import('@opentelemetry/semantic-conventions') | null = null

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
  constructor(
    private span: Span,
    private otelApi: typeof import('@opentelemetry/api')
  ) {}

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
  private sdkInstance: InstanceType<typeof import('@opentelemetry/sdk-node').NodeSDK> | null = null

  constructor(config: TracerConfig = {}) {
    this.config = {
      serviceName: config.serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'skillsmith',
      endpoint: config.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '',
      autoInstrument: config.autoInstrument ?? true,
      consoleExport: config.consoleExport ?? false,
      sampleRate: config.sampleRate ?? 1.0,
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

    try {
      // Lazy load OTEL modules
      api = await import('@opentelemetry/api')
      sdk = await import('@opentelemetry/sdk-node')
      resources = await import('@opentelemetry/resources')
      semanticConventions = await import('@opentelemetry/semantic-conventions')

      // Build exporters array
      const exporters: unknown[] = []

      // Add OTLP exporter if endpoint is configured
      if (this.config.endpoint) {
        const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http')
        exporters.push(
          new OTLPTraceExporter({
            url: this.config.endpoint,
          })
        )
      }

      // Add console exporter for debugging
      if (this.config.consoleExport) {
        const { ConsoleSpanExporter } = await import('@opentelemetry/sdk-trace-base')
        exporters.push(new ConsoleSpanExporter())
      }

      // Create resource with service info
      const resource = new resources.Resource({
        [semanticConventions.ATTR_SERVICE_NAME]: this.config.serviceName,
        [semanticConventions.ATTR_SERVICE_VERSION]: '0.1.0',
      })

      // Create SDK configuration
      const sdkConfig: ConstructorParameters<typeof sdk.NodeSDK>[0] = {
        resource,
      }

      // Add auto-instrumentation if enabled
      if (this.config.autoInstrument) {
        const { getNodeAutoInstrumentations } =
          await import('@opentelemetry/auto-instrumentations-node')
        sdkConfig.instrumentations = [
          getNodeAutoInstrumentations({
            // Customize instrumentations
            '@opentelemetry/instrumentation-fs': { enabled: false },
            '@opentelemetry/instrumentation-dns': { enabled: false },
            '@opentelemetry/instrumentation-net': { enabled: false },
          }),
        ]
      }

      // Initialize SDK
      this.sdkInstance = new sdk.NodeSDK(sdkConfig)
      await this.sdkInstance.start()

      // Get tracer
      this.tracer = api.trace.getTracer(this.config.serviceName, '0.1.0')
      this.initialized = true
    } catch (error) {
      // Graceful fallback - disable tracing on error
      console.warn('Failed to initialize OpenTelemetry tracing:', error)
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
    if (!this.isEnabled() || !this.tracer || !api) {
      return new NoOpSpanWrapper()
    }

    const span = this.tracer.startSpan(name, options)
    return new ActiveSpanWrapper(span, api)
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
    if (!api) {
      return new NoOpSpanWrapper()
    }
    const span = api.trace.getActiveSpan()
    if (!span) {
      return new NoOpSpanWrapper()
    }
    return new ActiveSpanWrapper(span, api)
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

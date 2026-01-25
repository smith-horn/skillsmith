/**
 * SMI-739: OpenTelemetry Tracer Setup
 * SMI-755: Graceful fallback when OpenTelemetry unavailable
 *
 * Provides distributed tracing for Skillsmith operations.
 *
 * @see tracer-types.ts for type definitions
 * @see span-utils.ts for span wrapper classes
 */

// Re-export types
export type {
  TracerConfig,
  SpanAttributes,
  SpanWrapper,
  Span,
  Tracer,
  SpanOptions,
  OTelApi,
  OTelNodeSDK,
  OTelResourceFromAttributes,
} from './tracer-types.js'

// Import types and utilities
import type {
  TracerConfig,
  SpanOptions,
  SpanWrapper,
  Tracer,
  OTelApi,
  OTelNodeSDK,
  OTelResourceFromAttributes,
} from './tracer-types.js'

import { NoOpSpanWrapper, ActiveSpanWrapper } from './span-utils.js'

// Lazy import to avoid loading OTEL if not needed
let api: unknown = null
let sdk: unknown = null
let resources: unknown = null
let semanticConventions: unknown = null
let otelAvailable: boolean | null = null

async function dynamicImport(moduleName: string): Promise<unknown> {
  try {
    const importFn = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>
    return await importFn(moduleName)
  } catch {
    return null
  }
}

async function checkOTelAvailability(): Promise<boolean> {
  if (otelAvailable !== null) return otelAvailable
  const result = await dynamicImport('@opentelemetry/api')
  otelAvailable = result !== null
  return otelAvailable
}

function getApi(): OTelApi | null {
  return api as OTelApi | null
}
function getSdk(): { NodeSDK: OTelNodeSDK } | null {
  return sdk as { NodeSDK: OTelNodeSDK } | null
}
function getResources(): { resourceFromAttributes: OTelResourceFromAttributes } | null {
  return resources as { resourceFromAttributes: OTelResourceFromAttributes } | null
}
function getSemanticConventions(): Record<string, string> | null {
  return semanticConventions as Record<string, string> | null
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

    const telemetryDisabled = process.env.SKILLSMITH_TELEMETRY_ENABLED === 'false'
    if (telemetryDisabled) {
      this.enabled = false
      return
    }

    const explicitlyEnabled = process.env.SKILLSMITH_TRACING_ENABLED === 'true'
    const explicitlyDisabled = process.env.SKILLSMITH_TRACING_ENABLED === 'false'
    if (explicitlyDisabled) {
      this.enabled = false
    } else if (explicitlyEnabled || this.config.endpoint || this.config.consoleExport) {
      this.enabled = true
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (!this.enabled) {
      this.initialized = true
      return
    }

    const isAvailable = await checkOTelAvailability()
    if (!isAvailable) {
      console.warn('[Skillsmith Telemetry] OpenTelemetry packages not installed. Tracing disabled.')
      this.enabled = false
      this.initialized = true
      return
    }

    try {
      api = await dynamicImport('@opentelemetry/api')
      sdk = await dynamicImport('@opentelemetry/sdk-node')
      resources = await dynamicImport('@opentelemetry/resources')
      semanticConventions = await dynamicImport('@opentelemetry/semantic-conventions')

      if (!api || !sdk || !resources || !semanticConventions) {
        console.warn(
          '[Skillsmith Telemetry] Some OpenTelemetry packages missing. Tracing disabled.'
        )
        this.enabled = false
        this.initialized = true
        return
      }

      const otelApi = getApi()
      const otelSdk = getSdk()
      const otelResources = getResources()
      const otelSemConv = getSemanticConventions()

      if (!otelApi || !otelSdk || !otelResources || !otelSemConv) {
        this.enabled = false
        this.initialized = true
        return
      }

      const sdkConfig: Record<string, unknown> = {}
      sdkConfig.resource = otelResources.resourceFromAttributes({
        [otelSemConv['ATTR_SERVICE_NAME'] ?? 'service.name']: this.config.serviceName,
        [otelSemConv['ATTR_SERVICE_VERSION'] ?? 'service.version']: '0.1.0',
      })

      if (this.config.autoInstrument) {
        try {
          const autoInst = (await dynamicImport('@opentelemetry/auto-instrumentations-node')) as {
            getNodeAutoInstrumentations?: (config: unknown) => unknown[]
          } | null
          if (autoInst?.getNodeAutoInstrumentations) {
            sdkConfig.instrumentations = [
              autoInst.getNodeAutoInstrumentations({
                '@opentelemetry/instrumentation-fs': { enabled: false },
                '@opentelemetry/instrumentation-dns': { enabled: false },
                '@opentelemetry/instrumentation-net': { enabled: false },
              }),
            ]
          }
        } catch {
          // Auto-instrumentation optional
        }
      }

      const NodeSDK = otelSdk.NodeSDK
      this.sdkInstance = new NodeSDK(sdkConfig)
      await this.sdkInstance.start()
      this.tracer = otelApi.trace.getTracer(this.config.serviceName, '0.1.0')
      this.initialized = true
    } catch (error) {
      console.warn('[Skillsmith Telemetry] Failed to initialize OpenTelemetry tracing:', error)
      this.enabled = false
      this.initialized = true
    }
  }

  isEnabled(): boolean {
    return this.enabled && this.initialized
  }

  startSpan(name: string, options?: SpanOptions): SpanWrapper {
    if (!this.isEnabled() || !this.tracer) return new NoOpSpanWrapper()
    const span = this.tracer.startSpan(name, options)
    return new ActiveSpanWrapper(span)
  }

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
      if (error instanceof Error) spanWrapper.recordException(error)
      spanWrapper.setStatus('error', error instanceof Error ? error.message : 'Unknown error')
      throw error
    } finally {
      spanWrapper.end()
    }
  }

  withSpanSync<T>(name: string, fn: (span: SpanWrapper) => T, options?: SpanOptions): T {
    const spanWrapper = this.startSpan(name, options)
    try {
      const result = fn(spanWrapper)
      spanWrapper.setStatus('ok')
      return result
    } catch (error) {
      if (error instanceof Error) spanWrapper.recordException(error)
      spanWrapper.setStatus('error', error instanceof Error ? error.message : 'Unknown error')
      throw error
    } finally {
      spanWrapper.end()
    }
  }

  getCurrentSpan(): SpanWrapper {
    const otelApi = getApi()
    if (!otelApi) return new NoOpSpanWrapper()
    const span = otelApi.trace.getActiveSpan()
    if (!span) return new NoOpSpanWrapper()
    return new ActiveSpanWrapper(span)
  }

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

export function getTracer(): SkillsmithTracer {
  if (!defaultTracer) defaultTracer = new SkillsmithTracer()
  return defaultTracer
}

export async function initializeTracing(config?: TracerConfig): Promise<SkillsmithTracer> {
  if (defaultTracer) await defaultTracer.shutdown()
  defaultTracer = new SkillsmithTracer(config)
  await defaultTracer.initialize()
  return defaultTracer
}

export async function shutdownTracing(): Promise<void> {
  if (defaultTracer) {
    await defaultTracer.shutdown()
    defaultTracer = null
  }
}

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

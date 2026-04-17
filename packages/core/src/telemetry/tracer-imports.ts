/**
 * SMI-4250: Extracted dynamic import + instrumentation registry for tracer.
 *
 * Lives in its own module so tests can `vi.mock` the import surface without
 * having to mock all of tracer.ts. The class registry encodes which OTel
 * instrumentation packages tracer.ts attempts to load on init; each entry
 * is optional at runtime and silently skipped if the package isn't installed
 * (e.g. `instrumentation-aws-sdk` only loads when `@skillsmith/enterprise`
 * is present in the consuming install).
 */

export async function dynamicImport(moduleName: string): Promise<unknown> {
  try {
    const importFn = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>
    return await importFn(moduleName)
  } catch {
    return null
  }
}

export const INSTRUMENTATION_PACKAGES: ReadonlyArray<readonly [string, string]> = [
  ['@opentelemetry/instrumentation-http', 'HttpInstrumentation'],
  ['@opentelemetry/instrumentation-undici', 'UndiciInstrumentation'],
  ['@opentelemetry/instrumentation-runtime-node', 'RuntimeNodeInstrumentation'],
  ['@opentelemetry/instrumentation-aws-sdk', 'AwsInstrumentation'],
] as const

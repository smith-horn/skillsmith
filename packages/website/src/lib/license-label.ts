/**
 * SMI-5327: License label helper for consistent rendering across surfaces.
 *
 * A null / undefined / empty SPDX identifier means "unknown / not detected".
 * Consumers MUST NOT infer "no restrictions", "freely usable", or
 * "public domain" from a null license — the database simply has no data.
 *
 * Real SPDX identifiers ("MIT", "Apache-2.0", "GPL-3.0", etc.) are rendered
 * verbatim. The label is also used for the `aria-label` on the badge element.
 */

/**
 * Return the display label for a SPDX license value.
 *
 * @param license - SPDX identifier from the API, or null/undefined when unknown
 * @returns "MIT" | "Apache-2.0" | … verbatim, or "Unknown" for null/undefined/empty
 *
 * @example
 * licenseLabel('MIT')       // => 'MIT'
 * licenseLabel('Apache-2.0') // => 'Apache-2.0'
 * licenseLabel(null)        // => 'Unknown'
 * licenseLabel(undefined)   // => 'Unknown'
 * licenseLabel('')          // => 'Unknown'
 */
export function licenseLabel(license: string | null | undefined): string {
  const trimmed = license?.trim()
  return trimmed ? trimmed : 'Unknown'
}

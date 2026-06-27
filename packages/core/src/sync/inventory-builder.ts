/**
 * Inventory payload assembler (SMI-5392, umbrella SMI-5382).
 *
 * Combines the device descriptor ({@link buildInventoryDevice}) with the scanned
 * skill set ({@link collectDeviceSkills}) into the full
 * {@link InventoryUploadPayload} that {@link uploadInventory} POSTs to the
 * `inventory-upload` edge function.
 *
 * @module @skillsmith/core/sync/inventory-builder
 */

import { collectDeviceSkills } from './inventory-collector.js'
import { buildInventoryDevice, type BuildInventoryDeviceOptions } from './inventory-device.js'
import type { InventoryUploadPayload } from './inventory-types.js'

/**
 * Build the complete inventory snapshot for this device.
 *
 * @param opts - Optional CLI version to stamp on the device descriptor.
 * @returns `{ device, skills }` ready to upload.
 * @see SMI-5392
 */
export async function buildInventoryPayload(
  opts?: BuildInventoryDeviceOptions
): Promise<InventoryUploadPayload> {
  return {
    device: buildInventoryDevice(opts),
    skills: await collectDeviceSkills(),
  }
}

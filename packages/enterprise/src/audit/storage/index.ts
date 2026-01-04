/**
 * Cloud storage backends for audit logs
 *
 * Provides storage integrations:
 * - AWS S3
 * - Google Cloud Storage
 * - Azure Blob Storage
 * - Local filesystem (for development)
 */

// Placeholder exports - implementations to be added
export interface AuditStorage {
  readonly provider: string
  store(key: string, data: Buffer): Promise<void>
  retrieve(key: string): Promise<Buffer>
  list(prefix: string): Promise<string[]>
  delete(key: string): Promise<void>
}

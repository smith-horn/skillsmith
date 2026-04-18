import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GDPRComplianceService } from './GDPRComplianceService.js'
import type { Database, Statement, RunResult } from '../db/database-interface.js'
import type {
  SubscriptionExportData,
  InvoiceExportData,
  LicenseKeyExportData,
  WebhookEventExportData,
} from './gdpr-types.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type MockStatement = {
  all: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
  iterate: ReturnType<typeof vi.fn>
  finalize: ReturnType<typeof vi.fn>
  bind: ReturnType<typeof vi.fn>
}

function makeStmt(opts: {
  allResult?: unknown[]
  getResult?: unknown
  runResult?: RunResult
}): MockStatement {
  return {
    all: vi.fn().mockReturnValue(opts.allResult ?? []),
    get: vi.fn().mockReturnValue(opts.getResult),
    run: vi.fn().mockReturnValue(opts.runResult ?? { changes: 0, lastInsertRowid: 0 }),
    iterate: vi.fn(),
    finalize: vi.fn(),
    bind: vi.fn(),
  }
}

function makeMockDb(): Database & {
  prepare: ReturnType<typeof vi.fn>
  exec: ReturnType<typeof vi.fn>
} {
  return {
    prepare: vi.fn(),
    exec: vi.fn(),
    transaction: vi.fn(),
    pragma: vi.fn(),
    close: vi.fn(),
    open: true,
    name: ':memory:',
    memory: true,
    readonly: false,
  } as unknown as Database & {
    prepare: ReturnType<typeof vi.fn>
    exec: ReturnType<typeof vi.fn>
  }
}

function makeMockStripe(deletesFn = vi.fn().mockResolvedValue({})) {
  return {
    getStripeInstance: vi.fn().mockReturnValue({
      customers: { del: deletesFn },
    }),
  }
}

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const CUSTOMER_ID = 'user-abc-123'
const STRIPE_CUSTOMER_ID = 'cus_stripe123'
const SUB_ID = 'sub-001'

const SUB_ROW: SubscriptionExportData = {
  id: SUB_ID,
  stripeSubscriptionId: 'stripe-sub-001',
  tier: 'individual',
  status: 'active',
  seatCount: 1,
  currentPeriodStart: '2026-01-01T00:00:00Z',
  currentPeriodEnd: '2026-02-01T00:00:00Z',
  canceledAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const INVOICE_ROW: InvoiceExportData = {
  id: 'inv-001',
  stripeInvoiceId: 'in_stripe001',
  amountCents: 999,
  currency: 'cad',
  status: 'paid',
  invoiceNumber: 'INV-001',
  paidAt: '2026-01-05T00:00:00Z',
  periodStart: '2026-01-01T00:00:00Z',
  periodEnd: '2026-02-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
}

const LICENSE_DB_ROW = {
  id: 'key-001',
  keyExpiry: '2027-01-01T00:00:00Z',
  isActive: 1,
  generatedAt: '2026-01-01T00:00:00Z',
  revokedAt: null,
  revocationReason: null,
}

const WEBHOOK_DB_ROW = {
  id: 'wh-001',
  stripeEventId: 'evt_001',
  eventType: 'customer.subscription.created',
  processedAt: '2026-01-01T00:00:00Z',
  success: 1,
}

// ---------------------------------------------------------------------------
// exportCustomerData
// ---------------------------------------------------------------------------

describe('GDPRComplianceService.exportCustomerData', () => {
  let db: ReturnType<typeof makeMockDb>

  beforeEach(() => {
    db = makeMockDb()
  })

  function setupFullExport() {
    db.prepare
      // exportSubscriptions
      .mockReturnValueOnce(makeStmt({ allResult: [SUB_ROW] }))
      // exportInvoices
      .mockReturnValueOnce(makeStmt({ allResult: [INVOICE_ROW] }))
      // exportLicenseKeys: fetch subscription IDs
      .mockReturnValueOnce(makeStmt({ allResult: [{ id: SUB_ID }] }))
      // exportLicenseKeys: fetch keys
      .mockReturnValueOnce(makeStmt({ allResult: [LICENSE_DB_ROW] }))
      // exportWebhookEvents: fetch stripe customer ID
      .mockReturnValueOnce(makeStmt({ getResult: { stripe_customer_id: STRIPE_CUSTOMER_ID } }))
      // exportWebhookEvents: fetch events
      .mockReturnValueOnce(makeStmt({ allResult: [WEBHOOK_DB_ROW] }))
  }

  it('returns metadata with the correct customer ID, format, and version', () => {
    setupFullExport()
    const service = new GDPRComplianceService({ db })
    const result = service.exportCustomerData(CUSTOMER_ID)
    expect(result.metadata.customerId).toBe(CUSTOMER_ID)
    expect(result.metadata.format).toBe('json')
    expect(result.metadata.version).toBe('1.0')
    expect(result.metadata.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('returns subscriptions with all fields mapped', () => {
    setupFullExport()
    const service = new GDPRComplianceService({ db })
    const result = service.exportCustomerData(CUSTOMER_ID)
    expect(result.subscriptions).toHaveLength(1)
    expect(result.subscriptions[0]).toMatchObject({
      id: SUB_ID,
      tier: 'individual',
      status: 'active',
    })
  })

  it('defaults seatCount to 1 when the database row returns null', () => {
    db.prepare
      .mockReturnValueOnce(makeStmt({ allResult: [{ ...SUB_ROW, seatCount: null }] }))
      .mockReturnValueOnce(makeStmt({ allResult: [] }))
      .mockReturnValueOnce(makeStmt({ allResult: [] }))
      .mockReturnValueOnce(makeStmt({ getResult: undefined }))
    const service = new GDPRComplianceService({ db })
    const result = service.exportCustomerData(CUSTOMER_ID)
    expect(result.subscriptions[0]?.seatCount).toBe(1)
  })

  it('returns invoices with all fields mapped', () => {
    setupFullExport()
    const service = new GDPRComplianceService({ db })
    const result = service.exportCustomerData(CUSTOMER_ID)
    expect(result.invoices).toHaveLength(1)
    expect(result.invoices[0]).toMatchObject({ id: 'inv-001', amountCents: 999, currency: 'cad' })
  })

  it('converts isActive integer to boolean in license key export', () => {
    setupFullExport()
    const service = new GDPRComplianceService({ db })
    const result = service.exportCustomerData(CUSTOMER_ID)
    const key = result.licenseKeys[0] as LicenseKeyExportData
    expect(typeof key.isActive).toBe('boolean')
    expect(key.isActive).toBe(true)
  })

  it('converts success integer to boolean in webhook event export', () => {
    setupFullExport()
    const service = new GDPRComplianceService({ db })
    const result = service.exportCustomerData(CUSTOMER_ID)
    const event = result.webhookEvents[0] as WebhookEventExportData
    expect(typeof event.success).toBe('boolean')
    expect(event.success).toBe(true)
  })

  it('returns empty licenseKeys when the customer has no subscriptions', () => {
    db.prepare
      .mockReturnValueOnce(makeStmt({ allResult: [] })) // exportSubscriptions
      .mockReturnValueOnce(makeStmt({ allResult: [] })) // exportInvoices
      .mockReturnValueOnce(makeStmt({ allResult: [] })) // exportLicenseKeys: sub IDs → empty
      .mockReturnValueOnce(makeStmt({ getResult: undefined })) // exportWebhookEvents: no stripe ID
    const service = new GDPRComplianceService({ db })
    const result = service.exportCustomerData(CUSTOMER_ID)
    expect(result.licenseKeys).toEqual([])
  })

  it('returns empty webhookEvents when there is no Stripe customer ID', () => {
    db.prepare
      .mockReturnValueOnce(makeStmt({ allResult: [SUB_ROW] }))
      .mockReturnValueOnce(makeStmt({ allResult: [INVOICE_ROW] }))
      .mockReturnValueOnce(makeStmt({ allResult: [{ id: SUB_ID }] }))
      .mockReturnValueOnce(makeStmt({ allResult: [LICENSE_DB_ROW] }))
      .mockReturnValueOnce(makeStmt({ getResult: undefined })) // no Stripe customer
    const service = new GDPRComplianceService({ db })
    const result = service.exportCustomerData(CUSTOMER_ID)
    expect(result.webhookEvents).toEqual([])
  })

  it('returns all four empty arrays for a customer with no data', () => {
    db.prepare
      .mockReturnValueOnce(makeStmt({ allResult: [] })) // subscriptions
      .mockReturnValueOnce(makeStmt({ allResult: [] })) // invoices
      .mockReturnValueOnce(makeStmt({ allResult: [] })) // sub IDs → empty
      .mockReturnValueOnce(makeStmt({ getResult: undefined })) // no Stripe customer
    const service = new GDPRComplianceService({ db })
    const result = service.exportCustomerData(CUSTOMER_ID)
    expect(result.subscriptions).toEqual([])
    expect(result.invoices).toEqual([])
    expect(result.licenseKeys).toEqual([])
    expect(result.webhookEvents).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// deleteCustomerData
// ---------------------------------------------------------------------------

describe('GDPRComplianceService.deleteCustomerData', () => {
  let db: ReturnType<typeof makeMockDb>

  beforeEach(() => {
    db = makeMockDb()
  })

  function setupLiveDeletion(stripeId = STRIPE_CUSTOMER_ID) {
    db.prepare
      // Stripe customer ID lookup (before transaction)
      .mockReturnValueOnce(makeStmt({ getResult: { stripe_customer_id: stripeId } }))
      // Sub IDs for license key deletion
      .mockReturnValueOnce(makeStmt({ allResult: [{ id: SUB_ID }] }))
      // DELETE license_keys
      .mockReturnValueOnce(makeStmt({ runResult: { changes: 2, lastInsertRowid: 0 } }))
      // DELETE invoices
      .mockReturnValueOnce(makeStmt({ runResult: { changes: 3, lastInsertRowid: 0 } }))
      // DELETE stripe_webhook_events
      .mockReturnValueOnce(makeStmt({ runResult: { changes: 1, lastInsertRowid: 0 } }))
      // DELETE user_subscriptions
      .mockReturnValueOnce(makeStmt({ runResult: { changes: 1, lastInsertRowid: 0 } }))
  }

  it('returns success=true with correct deletion counts', async () => {
    setupLiveDeletion()
    const service = new GDPRComplianceService({ db })
    const result = await service.deleteCustomerData(CUSTOMER_ID)
    expect(result.success).toBe(true)
    expect(result.customerId).toBe(CUSTOMER_ID)
    expect(result.counts.licenseKeys).toBe(2)
    expect(result.counts.invoices).toBe(3)
    expect(result.counts.webhookEvents).toBe(1)
    expect(result.counts.subscriptions).toBe(1)
    expect(result.errors).toEqual([])
  })

  it('wraps deletion in a transaction (BEGIN and COMMIT are called)', async () => {
    setupLiveDeletion()
    const service = new GDPRComplianceService({ db })
    await service.deleteCustomerData(CUSTOMER_ID)
    expect(db.exec).toHaveBeenCalledWith('BEGIN TRANSACTION')
    expect(db.exec).toHaveBeenCalledWith('COMMIT')
  })

  it('rolls back and reports an error when a database operation throws', async () => {
    db.prepare
      .mockReturnValueOnce(makeStmt({ getResult: { stripe_customer_id: STRIPE_CUSTOMER_ID } }))
      .mockReturnValueOnce(makeStmt({ allResult: [{ id: SUB_ID }] }))
      .mockReturnValueOnce({
        ...makeStmt({}),
        run: vi.fn().mockImplementation(() => {
          throw new Error('disk I/O error')
        }),
      } as unknown as Statement)
    const service = new GDPRComplianceService({ db })
    const result = await service.deleteCustomerData(CUSTOMER_ID)
    expect(result.success).toBe(false)
    expect(result.errors[0]).toContain('disk I/O error')
    expect(db.exec).toHaveBeenCalledWith('ROLLBACK')
  })

  it('skips license key deletion when the customer has no subscriptions', async () => {
    db.prepare
      .mockReturnValueOnce(makeStmt({ getResult: { stripe_customer_id: STRIPE_CUSTOMER_ID } }))
      .mockReturnValueOnce(makeStmt({ allResult: [] })) // no sub IDs
      .mockReturnValueOnce(makeStmt({ runResult: { changes: 0, lastInsertRowid: 0 } })) // invoices
      .mockReturnValueOnce(makeStmt({ runResult: { changes: 1, lastInsertRowid: 0 } })) // webhook events
      .mockReturnValueOnce(makeStmt({ runResult: { changes: 0, lastInsertRowid: 0 } })) // subscriptions
    const service = new GDPRComplianceService({ db })
    const result = await service.deleteCustomerData(CUSTOMER_ID)
    expect(result.success).toBe(true)
    expect(result.counts.licenseKeys).toBe(0)
  })

  it('skips webhook event deletion when there is no Stripe customer ID', async () => {
    db.prepare
      .mockReturnValueOnce(makeStmt({ getResult: undefined })) // no stripe ID
      .mockReturnValueOnce(makeStmt({ allResult: [] })) // sub IDs
      .mockReturnValueOnce(makeStmt({ runResult: { changes: 0, lastInsertRowid: 0 } })) // invoices
      .mockReturnValueOnce(makeStmt({ runResult: { changes: 0, lastInsertRowid: 0 } })) // subscriptions
    const service = new GDPRComplianceService({ db })
    const result = await service.deleteCustomerData(CUSTOMER_ID)
    expect(result.counts.webhookEvents).toBe(0)
  })

  it('calls Stripe customer deletion when deleteFromStripe is true (default)', async () => {
    setupLiveDeletion()
    const stripeDel = vi.fn().mockResolvedValue({})
    const service = new GDPRComplianceService({
      db,
      stripeClient: makeMockStripe(stripeDel) as never,
    })
    await service.deleteCustomerData(CUSTOMER_ID)
    expect(stripeDel).toHaveBeenCalledWith(STRIPE_CUSTOMER_ID)
  })

  it('sets stripeDeleted=true after a successful Stripe deletion', async () => {
    setupLiveDeletion()
    const service = new GDPRComplianceService({
      db,
      stripeClient: makeMockStripe() as never,
    })
    const result = await service.deleteCustomerData(CUSTOMER_ID)
    expect(result.stripeDeleted).toBe(true)
  })

  it('does not call Stripe deletion when deleteFromStripe is false', async () => {
    setupLiveDeletion()
    const stripeDel = vi.fn()
    const service = new GDPRComplianceService({
      db,
      stripeClient: makeMockStripe(stripeDel) as never,
    })
    await service.deleteCustomerData(CUSTOMER_ID, { deleteFromStripe: false })
    expect(stripeDel).not.toHaveBeenCalled()
  })

  it('adds a Stripe error to errors without failing the db deletion', async () => {
    setupLiveDeletion()
    const service = new GDPRComplianceService({
      db,
      stripeClient: makeMockStripe(
        vi.fn().mockRejectedValue(new Error('Stripe unavailable'))
      ) as never,
    })
    const result = await service.deleteCustomerData(CUSTOMER_ID)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('Stripe unavailable')
    expect(result.stripeDeleted).toBe(false)
  })

  describe('dryRun mode', () => {
    function setupDryRun(stripeId = STRIPE_CUSTOMER_ID) {
      db.prepare
        .mockReturnValueOnce(makeStmt({ getResult: { stripe_customer_id: stripeId } }))
        // sub IDs
        .mockReturnValueOnce(makeStmt({ allResult: [{ id: SUB_ID }] }))
        // COUNT license_keys
        .mockReturnValueOnce(makeStmt({ getResult: { count: 2 } }))
        // COUNT invoices
        .mockReturnValueOnce(makeStmt({ getResult: { count: 3 } }))
        // COUNT stripe_webhook_events
        .mockReturnValueOnce(makeStmt({ getResult: { count: 1 } }))
        // COUNT user_subscriptions
        .mockReturnValueOnce(makeStmt({ getResult: { count: 1 } }))
    }

    it('returns counts without executing any DELETE statements', async () => {
      setupDryRun()
      const service = new GDPRComplianceService({ db })
      const result = await service.deleteCustomerData(CUSTOMER_ID, { dryRun: true })
      expect(result.counts.licenseKeys).toBe(2)
      expect(result.counts.invoices).toBe(3)
      expect(result.counts.webhookEvents).toBe(1)
      expect(result.counts.subscriptions).toBe(1)
    })

    it('does not call BEGIN TRANSACTION or COMMIT in dry run', async () => {
      setupDryRun()
      const service = new GDPRComplianceService({ db })
      await service.deleteCustomerData(CUSTOMER_ID, { dryRun: true })
      expect(db.exec).not.toHaveBeenCalled()
    })

    it('does not call Stripe deletion in dry run', async () => {
      setupDryRun()
      const stripeDel = vi.fn()
      const service = new GDPRComplianceService({
        db,
        stripeClient: makeMockStripe(stripeDel) as never,
      })
      await service.deleteCustomerData(CUSTOMER_ID, { dryRun: true })
      expect(stripeDel).not.toHaveBeenCalled()
    })

    it('returns success=true with no errors in dry run', async () => {
      setupDryRun()
      const service = new GDPRComplianceService({ db })
      const result = await service.deleteCustomerData(CUSTOMER_ID, { dryRun: true })
      expect(result.success).toBe(true)
      expect(result.errors).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// hasCustomerData
// ---------------------------------------------------------------------------

describe('GDPRComplianceService.hasCustomerData', () => {
  it('returns true when a subscription row exists', () => {
    const db = makeMockDb()
    db.prepare.mockReturnValueOnce(makeStmt({ getResult: { id: SUB_ID } }))
    const service = new GDPRComplianceService({ db })
    expect(service.hasCustomerData(CUSTOMER_ID)).toBe(true)
  })

  it('returns false when no subscription row exists', () => {
    const db = makeMockDb()
    db.prepare.mockReturnValueOnce(makeStmt({ getResult: undefined }))
    const service = new GDPRComplianceService({ db })
    expect(service.hasCustomerData(CUSTOMER_ID)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getDataSummary
// ---------------------------------------------------------------------------

describe('GDPRComplianceService.getDataSummary', () => {
  it('returns zeroed summary for a customer with no subscription', () => {
    const db = makeMockDb()
    db.prepare.mockReturnValueOnce(makeStmt({ getResult: undefined }))
    const service = new GDPRComplianceService({ db })
    const summary = service.getDataSummary(CUSTOMER_ID)
    expect(summary).toEqual({
      hasSubscription: false,
      invoiceCount: 0,
      licenseKeyCount: 0,
      stripeCustomerId: null,
    })
  })

  it('returns correct counts and Stripe customer ID for an existing customer', () => {
    const db = makeMockDb()
    db.prepare
      .mockReturnValueOnce(
        makeStmt({ getResult: { id: SUB_ID, stripe_customer_id: STRIPE_CUSTOMER_ID } })
      )
      .mockReturnValueOnce(makeStmt({ getResult: { count: 4 } })) // invoice count
      .mockReturnValueOnce(makeStmt({ getResult: { count: 2 } })) // license key count
    const service = new GDPRComplianceService({ db })
    const summary = service.getDataSummary(CUSTOMER_ID)
    expect(summary.hasSubscription).toBe(true)
    expect(summary.invoiceCount).toBe(4)
    expect(summary.licenseKeyCount).toBe(2)
    expect(summary.stripeCustomerId).toBe(STRIPE_CUSTOMER_ID)
  })
})

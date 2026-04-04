import { Prisma } from '@prisma/client'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../types/auth.js'
import { prisma } from '../db/prisma.js'
import { requireJwt } from '../middlewares/jwt.js'
import { jsonError, jsonOk } from '../utils/response.js'
import { getCompanyForUser } from '../utils/company.js'
import { createLedgerEntry } from '../services/ledger.service.js'
import {
  calculateInvestorLedgerTotals,
  deriveInvestorTransactionPaymentStatus,
  getInvestorLedgerSummary,
  getInvestorTransactionPaidTotal,
  getInvestorTransactionRemaining,
  mapInvestorTransactionResponse,
  syncInvestorClosedState,
} from '../services/investor-ledger.service.js'
import { invalidateInvestorCaches, invalidateInvestorDetailCaches } from '../services/cache-invalidation.js'
import { cacheService } from '../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../config/cache-keys.js'

export const investorRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()
const LEDGER_TX_OPTIONS = { maxWait: 15000, timeout: 20000 } as const

investorRoutes.use('*', requireJwt)

// ── Schemas ──────────────────────────────────────────

const investorTypeEnum = z.enum(['EQUITY', 'FIXED_RATE'])
const investorTransactionKindEnum = z.enum(['PRINCIPAL_IN', 'PRINCIPAL_OUT', 'INTEREST'])
const paymentStatusEnum = z.enum(['PENDING', 'PARTIAL', 'COMPLETED'])

const createInvestorSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  type: investorTypeEnum,
  siteId: z.string().optional(),          // required for EQUITY
  equityPercentage: z.number().min(0).max(100).optional(), // for EQUITY
  fixedRate: z.number().min(0).optional(), // annual % for FIXED_RATE
})

const updateInvestorSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().optional(),
  equityPercentage: z.number().min(0).max(100).optional(),
  fixedRate: z.number().min(0).optional(),
})

const addTransactionSchema = z.object({
  amount: z.number().positive(),
  note: z.string().optional(),
  amountPaid: z.number().min(0).optional().default(0),
  paymentDate: z.string().datetime().optional(),
  idempotencyKey: z.string().optional(),
})

const investorResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  type: z.string(),
  siteId: z.string().nullable(),
  siteName: z.string().nullable(),
  equityPercentage: z.number().nullable(),
  fixedRate: z.number().nullable(),
  totalInvested: z.number(),
  totalReturned: z.number(),
  interestPaid: z.number(),
  outstandingPrincipal: z.number(),
  isClosed: z.boolean(),
  createdAt: z.string().datetime(),
})

const transactionResponseSchema = z.object({
  id: z.string(),
  kind: investorTransactionKindEnum,
  amount: z.number(),
  note: z.string().nullable(),
  amountPaid: z.number(),
  remaining: z.number(),
  paymentDate: z.string().datetime().nullable(),
  paymentStatus: paymentStatusEnum,
  createdAt: z.string().datetime(),
})

const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})

// ── Helper: get investor scoped to company ────────────

async function getInvestorForUser(investorId: string, userId: string) {
  const company = await getCompanyForUser(userId)
  if (!company) return { company: null, investor: null }
  const investor = await prisma.investor.findFirst({
    where: { id: investorId, companyId: company.id, isDeleted: false },
  })
  return { company, investor }
}

const investorTransactionInclude = Prisma.validator<Prisma.InvestorTransactionInclude>()({
  ledgerEntries: {
    select: { amount: true, postedAt: true },
    orderBy: { postedAt: 'desc' },
  },
})

const investorWithLedgerInclude = Prisma.validator<Prisma.InvestorInclude>()({
  site: { select: { id: true, name: true } },
  transactions: {
    where: { isDeleted: false },
    include: investorTransactionInclude,
    orderBy: { createdAt: 'desc' },
  },
})

type InvestorTransactionWithLedger = Prisma.InvestorTransactionGetPayload<{
  include: typeof investorTransactionInclude
}>

type InvestorWithLedger = Prisma.InvestorGetPayload<{
  include: typeof investorWithLedgerInclude
}>

function mapInvestorResponse(investor: InvestorWithLedger) {
  const totals = calculateInvestorLedgerTotals(investor.transactions)

  return {
    id: investor.id,
    name: investor.name,
    phone: investor.phone,
    type: investor.type,
    siteId: investor.siteId,
    siteName: investor.site?.name ?? null,
    equityPercentage: investor.equityPercentage,
    fixedRate: investor.fixedRate,
    totalInvested: totals.principalInTotal,
    totalReturned: totals.totalReturned,
    interestPaid: totals.interestTotal,
    outstandingPrincipal: totals.outstandingPrincipal,
    isClosed: investor.isClosed,
    createdAt: investor.createdAt.toISOString(),
  }
}

async function getInvestorView(
  investorId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const investor = await tx.investor.findUnique({
    where: { id: investorId },
    include: investorWithLedgerInclude,
  })

  if (!investor) return null

  return {
    investor: mapInvestorResponse(investor),
    transactions: investor.transactions.map((transaction: InvestorTransactionWithLedger) =>
      mapInvestorTransactionResponse(transaction),
    ),
  }
}

async function getTransactionView(
  transactionId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const transaction = await tx.investorTransaction.findUnique({
    where: { id: transactionId },
    include: investorTransactionInclude,
  })

  if (!transaction) return null

  return mapInvestorTransactionResponse(transaction)
}

function resolveLedgerConfig(
  investor: { siteId: string | null },
  kind: 'PRINCIPAL_IN' | 'PRINCIPAL_OUT' | 'INTEREST',
) {
  const walletType = investor.siteId ? 'SITE' as const : 'COMPANY' as const

  if (kind === 'PRINCIPAL_IN') {
    return {
      siteId: investor.siteId,
      walletType,
      direction: 'IN' as const,
      movementType: 'INVESTOR_PRINCIPAL_IN' as const,
    }
  }

  if (kind === 'PRINCIPAL_OUT') {
    return {
      siteId: investor.siteId,
      walletType,
      direction: 'OUT' as const,
      movementType: 'INVESTOR_PRINCIPAL_OUT' as const,
    }
  }

  return {
    siteId: investor.siteId,
    walletType,
    direction: 'OUT' as const,
    movementType: 'INVESTOR_INTEREST' as const,
  }
}

function getDefaultLedgerNote(kind: 'PRINCIPAL_IN' | 'PRINCIPAL_OUT' | 'INTEREST') {
  if (kind === 'PRINCIPAL_IN') return 'Investor principal received'
  if (kind === 'PRINCIPAL_OUT') return 'Investor principal payout'
  return 'Investor interest payout'
}

async function createInvestorTransactionDocumentWithLedger(
  tx: Prisma.TransactionClient,
  input: {
    companyId: string
    investor: { id: string; siteId: string | null }
    kind: 'PRINCIPAL_IN' | 'PRINCIPAL_OUT' | 'INTEREST'
    amount: number
    amountPaid: number
    note?: string
    paymentDate?: string
    idempotencyKey?: string
  },
) {
  const transaction = await tx.investorTransaction.create({
    data: {
      investorId: input.investor.id,
      kind: input.kind,
      amount: input.amount,
      note: input.note ?? null,
    },
  })

  if (input.amountPaid > 0) {
    const ledgerConfig = resolveLedgerConfig(input.investor, input.kind)

    await createLedgerEntry({
      companyId: input.companyId,
      siteId: ledgerConfig.siteId,
      walletType: ledgerConfig.walletType,
      direction: ledgerConfig.direction,
      movementType: ledgerConfig.movementType,
      amount: new Prisma.Decimal(input.amountPaid),
      idempotencyKey: input.idempotencyKey ?? `investor-${input.kind.toLowerCase()}:${transaction.id}:${Date.now()}`,
      postedAt: input.paymentDate ? new Date(input.paymentDate) : undefined,
      note: input.note ?? getDefaultLedgerNote(input.kind),
      investorTransactionId: transaction.id,
    }, tx)
  }

  await syncInvestorClosedState(input.investor.id, tx)

  return transaction.id
}

// ══════════════════════════════════════════════════════
// INVESTORS CRUD
// ══════════════════════════════════════════════════════

// ── GET /investors ────────────────────────────────────

const getInvestorsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Investors'],
  summary: 'List all investors',
  description: 'Returns all investors for the company. Filter by type: ?type=EQUITY (site investors) or ?type=FIXED_RATE (company investors).',
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({ type: investorTypeEnum.optional() }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ investors: z.array(investorResponseSchema) }),
          }),
        },
      },
      description: 'List of investors',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

investorRoutes.openapi(getInvestorsRoute, async (c) => {
  const auth = c.get('auth')
  const company = await getCompanyForUser(auth.userId)
  if (!company) return jsonError(c, 'No company found. Create one first.', 404) as any

  const { type } = c.req.valid('query')

  const cacheKey = `${CacheKeys.investorList(company.id)}:${type ?? 'all'}`
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  const investors = await prisma.investor.findMany({
    where: {
      companyId: company.id,
      isDeleted: false,
      ...(type ? { type } : {}),
    },
    include: investorWithLedgerInclude,
    orderBy: { createdAt: 'desc' },
  })

  const responseData = {
    investors: investors.map((investor) => mapInvestorResponse(investor)),
  }
  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return jsonOk(c, responseData) as any
})

// ── POST /investors ───────────────────────────────────

const createInvestorRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Investors'],
  summary: 'Create an investor',
  description: 'Create an equity investor (linked to a site) or a fixed-rate investor (linked to the company). Equity investors add funds directly to the site when they invest. Fixed-rate investors add to company available fund.',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: createInvestorSchema } } },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ investor: investorResponseSchema }),
          }),
        },
      },
      description: 'Investor created',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Invalid input',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Company or site not found',
    },
  },
})

investorRoutes.openapi(createInvestorRoute, async (c) => {
  const auth = c.get('auth')
  const body = await c.req.json().catch(() => null)
  const parsed = createInvestorSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const company = await getCompanyForUser(auth.userId)
  if (!company) return jsonError(c, 'No company found. Create one first.', 404) as any

  const { name, phone, type, siteId, equityPercentage, fixedRate } = parsed.data

  if (type === 'EQUITY') {
    if (!siteId) return jsonError(c, 'siteId is required for equity investors', 400) as any
    const site = await prisma.site.findFirst({ where: { id: siteId, companyId: company.id } })
    if (!site) return jsonError(c, 'Site not found', 404) as any
  }

  if (type === 'FIXED_RATE' && siteId) {
    return jsonError(c, 'Fixed-rate investors are linked to the company, not a site. Remove siteId.', 400) as any
  }

  const investor = await prisma.investor.create({
    data: {
      companyId: company.id,
      siteId: type === 'EQUITY' ? siteId : null,
      name,
      phone,
      type,
      equityPercentage: type === 'EQUITY' ? equityPercentage : null,
      fixedRate: type === 'FIXED_RATE' ? fixedRate : null,
    },
  })

  await invalidateInvestorCaches(company.id, investor.siteId)
  await invalidateInvestorDetailCaches(investor.id)

  const view = await getInvestorView(investor.id)

  return jsonOk(c, {
    investor: view!.investor,
  }, 201) as any
})

// ── GET /investors/:id ────────────────────────────────

const getInvestorRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Investors'],
  summary: 'Get investor profile',
  description: 'Returns investor details and full transaction history.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              investor: investorResponseSchema,
              transactions: z.array(transactionResponseSchema),
            }),
          }),
        },
      },
      description: 'Investor profile with transaction history',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Investor not found',
    },
  },
})

investorRoutes.openapi(getInvestorRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const { investor } = await getInvestorForUser(id, auth.userId)
  if (!investor) return jsonError(c, 'Investor not found', 404) as any

  const cacheKey = CacheKeys.investorDetail(id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  const view = await getInvestorView(id)
  if (!view) return jsonError(c, 'Investor not found', 404) as any

  const responseData = {
    investor: view.investor,
    transactions: view.transactions,
  }
  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_DETAIL)
  return jsonOk(c, responseData) as any
})

// ── PUT /investors/:id ────────────────────────────────

const updateInvestorRoute = createRoute({
  method: 'put',
  path: '/{id}',
  tags: ['Investors'],
  summary: 'Update investor details',
  description: 'Update investor name, phone, equity percentage, or fixed rate.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: updateInvestorSchema } } },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ investor: investorResponseSchema }),
          }),
        },
      },
      description: 'Investor updated',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Invalid input',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Investor not found',
    },
  },
})

investorRoutes.openapi(updateInvestorRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const body = await c.req.json().catch(() => null)
  const parsed = updateInvestorSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const { company, investor } = await getInvestorForUser(id, auth.userId)
  if (!investor || !company) return jsonError(c, 'Investor not found', 404) as any

  const updated = await prisma.investor.update({
    where: { id },
    data: parsed.data,
  })

  await invalidateInvestorCaches(company.id, updated.siteId)
  await invalidateInvestorDetailCaches(updated.id)

  const view = await getInvestorView(updated.id)

  return jsonOk(c, {
    investor: view!.investor,
  }) as any
})

// ── DELETE /investors/:id ─────────────────────────────

const deleteInvestorRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Investors'],
  summary: 'Delete an investor',
  description: 'Remove an investor and all their transaction records. Fund values are recomputed automatically.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ message: z.string() }),
          }),
        },
      },
      description: 'Investor deleted',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Investor not found',
    },
  },
})

investorRoutes.openapi(deleteInvestorRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')

  const { company, investor } = await getInvestorForUser(id, auth.userId)
  if (!company || !investor) return jsonError(c, 'Investor not found', 404) as any

  await prisma.investor.update({ where: { id }, data: { isDeleted: true } })

  await invalidateInvestorCaches(company.id, investor.siteId)
  await invalidateInvestorDetailCaches(investor.id)

  return jsonOk(c, { message: `Investor "${investor.name}" removed` }) as any
})

// ══════════════════════════════════════════════════════
// INVESTOR TRANSACTIONS
// ══════════════════════════════════════════════════════

// ── POST /investors/:id/transactions ─────────────────

const addTransactionRoute = createRoute({
  method: 'post',
  path: '/{id}/transactions',
  tags: ['Investors'],
  summary: 'Add investment amount',
  description: 'Create a principal-in transaction for an investor. If an initial paid amount is provided, a ledger entry is posted immediately.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: addTransactionSchema } } },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              transaction: transactionResponseSchema,
              investor: investorResponseSchema,
            }),
          }),
        },
      },
      description: 'Transaction recorded and funds updated',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Invalid input',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Investor not found',
    },
  },
})

investorRoutes.openapi(addTransactionRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const body = await c.req.json().catch(() => null)
  const parsed = addTransactionSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const { company, investor } = await getInvestorForUser(id, auth.userId)
  if (!company || !investor) return jsonError(c, 'Investor not found', 404) as any

  const { amount, note, amountPaid = 0, paymentDate, idempotencyKey } = parsed.data

  if (amountPaid > amount) {
    return jsonError(c, 'AMOUNT_EXCEEDS_LIMIT', 400) as any
  }

  const transactionId = await prisma.$transaction(async (tx) => {
    return createInvestorTransactionDocumentWithLedger(tx, {
      companyId: company.id,
      investor,
      kind: 'PRINCIPAL_IN',
      amount,
      amountPaid,
      note,
      paymentDate,
      idempotencyKey,
    })
  }, LEDGER_TX_OPTIONS)

  await invalidateInvestorCaches(company.id, investor.siteId)
  await invalidateInvestorDetailCaches(investor.id)

  const [view, transaction] = await Promise.all([
    getInvestorView(investor.id),
    getTransactionView(transactionId),
  ])

  return jsonOk(c, {
    transaction: transaction!,
    investor: view!.investor,
  }, 201) as any
})

// ── POST /investors/:id/return ───────────────────────

const returnInvestmentRoute = createRoute({
  method: 'post',
  path: '/{id}/return',
  tags: ['Investors'],
  summary: 'Return investment to investor',
  description: `Record a return of funds to an investor (partial or full).
- **EQUITY investor**: reduces the site's equity-allocated fund automatically (via totalInvested). Validated: return amount ≤ totalInvested.
- **FIXED_RATE investor**: reduces the company available fund automatically (via negative transaction). Validated: return amount ≤ company available fund (cannot return money already deployed to sites).
A negative transaction record is created for audit history.`,
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: addTransactionSchema } } },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              transaction: transactionResponseSchema,
              investor: investorResponseSchema,
            }),
          }),
        },
      },
      description: 'Return recorded and funds updated',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Return exceeds invested amount or available fund',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Investor not found',
    },
  },
})

investorRoutes.openapi(returnInvestmentRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const body = await c.req.json().catch(() => null)
  const parsed = addTransactionSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const { company, investor } = await getInvestorForUser(id, auth.userId)
  if (!investor || !company) return jsonError(c, 'Investor not found', 404) as any

  const { amount, note, amountPaid = 0, paymentDate, idempotencyKey } = parsed.data

  if (amountPaid > amount) {
    return jsonError(c, 'AMOUNT_EXCEEDS_LIMIT', 400) as any
  }

  const summary = await getInvestorLedgerSummary(investor.id)
  if (amount > summary.outstandingPrincipal) {
    return jsonError(c, `Return amount (${amount}) exceeds outstanding principal (${summary.outstandingPrincipal})`, 400) as any
  }

  const transactionId = await prisma.$transaction(async (tx) => {
    return createInvestorTransactionDocumentWithLedger(tx, {
      companyId: company.id,
      investor,
      kind: 'PRINCIPAL_OUT',
      amount,
      amountPaid,
      note: note ?? 'Principal return',
      paymentDate,
      idempotencyKey,
    })
  }, LEDGER_TX_OPTIONS)

  await invalidateInvestorCaches(company.id, investor.siteId)
  await invalidateInvestorDetailCaches(investor.id)

  const [view, transaction] = await Promise.all([
    getInvestorView(investor.id),
    getTransactionView(transactionId),
  ])

  return jsonOk(c, {
    transaction: transaction!,
    investor: view!.investor,
  }) as any
})

// ── POST /investors/:id/interest ─────────────────────

const payInterestRoute = createRoute({
  method: 'post',
  path: '/{id}/interest',
  tags: ['Investors'],
  summary: 'Pay interest to fixed-rate investor',
  description: `Pay interest to a FIXED_RATE investor. This reduces company available fund but does NOT touch the investor's principal (totalInvested). Only available for FIXED_RATE investors. A negative transaction is created for audit history.`,
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: addTransactionSchema } } },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              transaction: transactionResponseSchema,
              investor: investorResponseSchema,
            }),
          }),
        },
      },
      description: 'Interest paid',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Not a fixed-rate investor or insufficient funds',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Investor not found',
    },
  },
})

investorRoutes.openapi(payInterestRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const body = await c.req.json().catch(() => null)
  const parsed = addTransactionSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const { company, investor } = await getInvestorForUser(id, auth.userId)
  if (!investor || !company) return jsonError(c, 'Investor not found', 404) as any

  if (investor.type !== 'FIXED_RATE') {
    return jsonError(c, 'Interest payments are only for fixed-rate investors', 400) as any
  }

  const { amount, note, amountPaid = 0, paymentDate, idempotencyKey } = parsed.data

  if (amountPaid > amount) {
    return jsonError(c, 'AMOUNT_EXCEEDS_LIMIT', 400) as any
  }

  const transactionId = await prisma.$transaction(async (tx) => {
    return createInvestorTransactionDocumentWithLedger(tx, {
      companyId: company.id,
      investor,
      kind: 'INTEREST',
      amount,
      amountPaid,
      note: note ?? 'Interest payment',
      paymentDate,
      idempotencyKey,
    })
  }, LEDGER_TX_OPTIONS)

  await invalidateInvestorCaches(company.id, investor.siteId)
  await invalidateInvestorDetailCaches(investor.id)

  const [view, transaction] = await Promise.all([
    getInvestorView(investor.id),
    getTransactionView(transactionId),
  ])

  return jsonOk(c, {
    transaction: transaction!,
    investor: view!.investor,
  }) as any
})

// ── GET /investors/:id/transactions ──────────────────

const getTransactionsRoute = createRoute({
  method: 'get',
  path: '/{id}/transactions',
  tags: ['Investors'],
  summary: 'List investor transactions',
  description: 'Returns all investment transactions for an investor in descending order.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              transactions: z.array(transactionResponseSchema),
              totalInvested: z.number(),
              totalReturned: z.number(),
              interestPaid: z.number(),
              outstandingPrincipal: z.number(),
            }),
          }),
        },
      },
      description: 'Transaction history',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Investor not found',
    },
  },
})

investorRoutes.openapi(getTransactionsRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')

  const { investor } = await getInvestorForUser(id, auth.userId)
  if (!investor) return jsonError(c, 'Investor not found', 404) as any

  const cacheKey = CacheKeys.investorTransactions(id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  const view = await getInvestorView(id)
  if (!view) return jsonError(c, 'Investor not found', 404) as any

  const responseData = {
    transactions: view.transactions,
    totalInvested: view.investor.totalInvested,
    totalReturned: view.investor.totalReturned,
    interestPaid: view.investor.interestPaid,
    outstandingPrincipal: view.investor.outstandingPrincipal,
  }
  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return jsonOk(c, responseData) as any
})

// ── PATCH /investors/:id/transactions/:transactionId/payment ────────

const updateTransactionPaymentRoute = createRoute({
  method: 'patch',
  path: '/{id}/transactions/{transactionId}/payment',
  tags: ['Investors'],
  summary: 'Record a payment against an investor transaction (additive)',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string(), transactionId: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            amount: z.number().positive(),
            note: z.string().optional(),
            idempotencyKey: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              transaction: z.object({
                id: z.string(),
                kind: investorTransactionKindEnum,
                amountPaid: z.number(),
                remaining: z.number(),
                paymentStatus: paymentStatusEnum,
              }),
              payment: z.object({ id: z.string(), amount: z.number(), createdAt: z.string().datetime() }),
            }),
          }),
        },
      },
      description: 'Payment recorded',
    },
    400: { content: { 'application/json': { schema: errorResponseSchema } }, description: 'Invalid payload' },
    404: { content: { 'application/json': { schema: errorResponseSchema } }, description: 'Transaction not found' },
  },
})

investorRoutes.openapi(updateTransactionPaymentRoute, async (c) => {
  const auth = c.get('auth')
  const { id, transactionId } = c.req.valid('param')
  const { amount, note, idempotencyKey } = c.req.valid('json')

  const { investor, company } = await getInvestorForUser(id, auth.userId)
  if (!investor || !company) return jsonError(c, 'Investor not found', 404) as any

  const transaction = await prisma.investorTransaction.findFirst({
    where: { id: transactionId, investorId: investor.id, isDeleted: false },
  })
  if (!transaction) return jsonError(c, 'Transaction not found', 404) as any

  const currentPaid = await getInvestorTransactionPaidTotal(transactionId)
  const newTotal = currentPaid + amount

  if (newTotal > transaction.amount) {
    return jsonError(c, 'AMOUNT_EXCEEDS_LIMIT', 400) as any
  }

  const ledgerConfig = resolveLedgerConfig(investor, transaction.kind)

  const result = await prisma.$transaction(async (tx) => {
    const payment = await createLedgerEntry({
      companyId: company.id,
      siteId: ledgerConfig.siteId,
      walletType: ledgerConfig.walletType,
      direction: ledgerConfig.direction,
      movementType: ledgerConfig.movementType,
      amount: new Prisma.Decimal(amount),
      idempotencyKey: idempotencyKey ?? `investor-payment:${transactionId}:${Date.now()}`,
      note: note ?? getDefaultLedgerNote(transaction.kind),
      investorTransactionId: transactionId,
    }, tx)

    await syncInvestorClosedState(investor.id, tx)

    const amountPaid = await getInvestorTransactionPaidTotal(transactionId, tx)
    const remaining = await getInvestorTransactionRemaining(transactionId, tx)
    const paymentStatus = deriveInvestorTransactionPaymentStatus(transaction.amount, amountPaid)

    return { payment, amountPaid, remaining, paymentStatus }
  }, LEDGER_TX_OPTIONS)

  await invalidateInvestorCaches(company.id, investor.siteId)
  await invalidateInvestorDetailCaches(investor.id)

  return jsonOk(c, {
    transaction: {
      id: transaction.id,
      kind: transaction.kind,
      amountPaid: result.amountPaid,
      remaining: result.remaining,
      paymentStatus: result.paymentStatus,
    },
    payment: {
      id: result.payment.id,
      amount: Number(result.payment.amount),
      createdAt: result.payment.postedAt,
    },
  }) as any
})

// ── GET /investors/:id/transactions/:transactionId/payments ─────────

const getTransactionPaymentsRoute = createRoute({
  method: 'get',
  path: '/{id}/transactions/{transactionId}/payments',
  tags: ['Payments'],
  summary: 'Get payment history for an investor transaction',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string(), transactionId: z.string() }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              payments: z.array(z.object({
                id: z.string(),
                amount: z.number(),
                note: z.string().nullable(),
                createdAt: z.string().datetime(),
              })),
            }),
          }),
        },
      },
      description: 'Payment history',
    },
    404: { content: { 'application/json': { schema: errorResponseSchema } }, description: 'Not found' },
  },
})

investorRoutes.openapi(getTransactionPaymentsRoute, async (c) => {
  const auth = c.get('auth')
  const { id, transactionId } = c.req.valid('param')
  const { investor, company } = await getInvestorForUser(id, auth.userId)
  if (!investor || !company) return jsonError(c, 'Investor not found', 404) as any

  const transaction = await prisma.investorTransaction.findFirst({
    where: { id: transactionId, investorId: investor.id, isDeleted: false },
  })
  if (!transaction) return jsonError(c, 'Transaction not found', 404) as any

  const payments = await prisma.payment.findMany({
    where: {
      companyId: company.id,
      investorTransactionId: transactionId,
    },
    orderBy: { postedAt: 'desc' },
  })

  return jsonOk(c, {
    payments: payments.map((payment) => ({
      id: payment.id,
      amount: Number(payment.amount),
      note: payment.note,
      createdAt: payment.postedAt,
    })),
  }) as any
})




import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../types/auth.js'
import { prisma } from '../db/prisma.js'
import { requireJwt } from '../middlewares/jwt.js'
import { jsonError, jsonOk } from '../utils/response.js'
import { getCompanyForUser } from '../utils/company.js'
import { invalidateInvestorCaches, invalidateInvestorDetailCaches } from '../services/cache-invalidation.js'
import { cacheService } from '../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../config/cache-keys.js'

export const investorRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()

investorRoutes.use('*', requireJwt)

// ── Schemas ──────────────────────────────────────────

const investorTypeEnum = z.enum(['EQUITY', 'FIXED_RATE'])

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
  isClosed: z.boolean(),
  createdAt: z.string().datetime(),
})

const transactionResponseSchema = z.object({
  id: z.string(),
  amount: z.number(),
  note: z.string().nullable(),
  amountPaid: z.number(),
  paymentDate: z.string().datetime().nullable(),
  paymentStatus: z.enum(['PENDING', 'PARTIAL', 'COMPLETED']),
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
    include: { site: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  })

  const responseData = {
    investors: investors.map((inv) => ({
      id: inv.id,
      name: inv.name,
      phone: inv.phone,
      type: inv.type,
      siteId: inv.siteId,
      siteName: inv.site?.name ?? null,
      equityPercentage: inv.equityPercentage,
      fixedRate: inv.fixedRate,
      totalInvested: inv.totalInvested,
      totalReturned: inv.totalReturned,
      isClosed: inv.isClosed,
      createdAt: inv.createdAt,
    })),
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
    include: { site: { select: { id: true, name: true } } },
  })

  await invalidateInvestorCaches(company.id, investor.siteId)
  await invalidateInvestorDetailCaches(investor.id)

  return jsonOk(c, {
    investor: {
      id: investor.id,
      name: investor.name,
      phone: investor.phone,
      type: investor.type,
      siteId: investor.siteId,
      siteName: investor.site?.name ?? null,
      equityPercentage: investor.equityPercentage,
      fixedRate: investor.fixedRate,
      totalInvested: investor.totalInvested,
      totalReturned: investor.totalReturned,
      isClosed: investor.isClosed,
      createdAt: investor.createdAt,
    },
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

  const [fullInvestor, transactions] = await Promise.all([
    prisma.investor.findUnique({
      where: { id },
      include: { site: { select: { id: true, name: true } } },
    }),
    prisma.investorTransaction.findMany({
      where: { investorId: id, isDeleted: false },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  const responseData = {
    investor: {
      id: fullInvestor!.id,
      name: fullInvestor!.name,
      phone: fullInvestor!.phone,
      type: fullInvestor!.type,
      siteId: fullInvestor!.siteId,
      siteName: fullInvestor!.site?.name ?? null,
      equityPercentage: fullInvestor!.equityPercentage,
      fixedRate: fullInvestor!.fixedRate,
      totalInvested: fullInvestor!.totalInvested,
      totalReturned: fullInvestor!.totalReturned,
      isClosed: fullInvestor!.isClosed,
      createdAt: fullInvestor!.createdAt,
    },
    transactions: transactions.map((t) => ({
      id: t.id,
      amount: t.amount,
      note: t.note,
      amountPaid: t.amountPaid,
      paymentDate: t.paymentDate ? t.paymentDate.toISOString() : null,
      paymentStatus: t.paymentStatus,
      createdAt: t.createdAt.toISOString(),
    })),
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
    include: { site: { select: { id: true, name: true } } },
  })

  await invalidateInvestorCaches(company.id, updated.siteId)
  await invalidateInvestorDetailCaches(updated.id)

  return jsonOk(c, {
    investor: {
      id: updated.id,
      name: updated.name,
      phone: updated.phone,
      type: updated.type,
      siteId: updated.siteId,
      siteName: updated.site?.name ?? null,
      equityPercentage: updated.equityPercentage,
      fixedRate: updated.fixedRate,
      totalInvested: updated.totalInvested,
      totalReturned: updated.totalReturned,
      isClosed: updated.isClosed,
      createdAt: updated.createdAt,
    },
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
  description: `Record a new investment transaction for an investor.
- **EQUITY investor**: amount is added to the site's allocated fund and remaining fund.
- **FIXED_RATE investor**: amount is added to the company's available fund.
Investor total_invested is updated atomically.`,
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
              investor: z.object({
                id: z.string(),
                name: z.string(),
                type: z.string(),
                totalInvested: z.number(),
              }),
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

  const { amount, note, amountPaid = 0, paymentDate } = parsed.data

  // Transaction: create investment record + update total_invested atomically
  const result = await prisma.$transaction(async (tx) => {
    const transaction = await tx.investorTransaction.create({
      data: { investorId: investor.id, amount, note, amountPaid, paymentDate: paymentDate ? new Date(paymentDate) : null, paymentStatus: amountPaid >= amount ? 'COMPLETED' : amountPaid > 0 ? 'PARTIAL' : 'PENDING' },
    })

    const updatedInvestor = await tx.investor.update({
      where: { id: investor.id },
      data: { totalInvested: { increment: amount } },
    })

    return { transaction, updatedInvestor }
  })

  await invalidateInvestorCaches(company.id, investor.siteId)
  await invalidateInvestorDetailCaches(investor.id)

  return jsonOk(c, {
    transaction: {
      id: result.transaction.id,
      amount: result.transaction.amount,
      note: result.transaction.note,
      amountPaid: result.transaction.amountPaid,
      paymentDate: result.transaction.paymentDate ? result.transaction.paymentDate.toISOString() : null,
      paymentStatus: result.transaction.paymentStatus,
      createdAt: result.transaction.createdAt.toISOString(),
    },
    investor: {
      id: result.updatedInvestor.id,
      name: result.updatedInvestor.name,
      type: result.updatedInvestor.type,
      totalInvested: result.updatedInvestor.totalInvested,
      totalReturned: result.updatedInvestor.totalReturned,
      isClosed: result.updatedInvestor.isClosed,
    },
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
              investor: z.object({
                id: z.string(),
                name: z.string(),
                type: z.string(),
                totalInvested: z.number(),
              }),
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

  if (investor.isClosed) {
    return jsonError(c, 'This investor account is already closed. No further returns allowed.', 400) as any
  }

  const { amount, note, amountPaid = 0, paymentDate } = parsed.data

  if (investor.type === 'EQUITY') {
    // For equity investors: max return = equityPercentage% of (Revenue - Expenses)
    if (!investor.siteId) return jsonError(c, 'Equity investor has no linked site', 400) as any

    const { getSiteTotalExpensesBilled } = await import('../utils/fund.js')
    const [totalRevenueResult, totalExpensesBilled] = await Promise.all([
      prisma.customer.aggregate({
        where: { siteId: investor.siteId, isDeleted: false },
        _sum: { sellingPrice: true },
      }),
      getSiteTotalExpensesBilled(investor.siteId)
    ])
    
    const totalRevenue = totalRevenueResult._sum.sellingPrice ?? 0
    const totalProfit = Math.max(0, totalRevenue - totalExpensesBilled)
    const equityReturn = Math.round((investor.equityPercentage ?? 0) / 100 * totalProfit)

    if (amount > equityReturn) {
      return jsonError(c, `Return amount (${amount}) exceeds equity return (${equityReturn}). ${investor.equityPercentage}% of total profit ${totalProfit} (Rev: ${totalRevenue}, Exp: ${totalExpensesBilled}).`, 400) as any
    }
  }

  if (investor.type === 'FIXED_RATE') {
    // Return = giving back principal. Amount must not exceed remaining principal.
    if (amount > investor.totalInvested) {
      return jsonError(c, `Return amount (${amount}) exceeds remaining principal (${investor.totalInvested})`, 400) as any
    }
    // Check company available fund
    const { getCompanyAvailableFund } = await import('../utils/fund.js')
    const availableFund = await getCompanyAvailableFund(company.id)
    if (amount > availableFund) {
      return jsonError(c, `Return amount (${amount}) exceeds company available fund (${availableFund}). Funds may already be deployed to sites.`, 400) as any
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    const transaction = await tx.investorTransaction.create({
      data: { investorId: investor.id, amount: -amount, note: note ?? 'Principal return', amountPaid, paymentDate: paymentDate ? new Date(paymentDate) : null, paymentStatus: amountPaid >= amount ? 'COMPLETED' : amountPaid > 0 ? 'PARTIAL' : 'PENDING' },
    })
    // For FIXED_RATE: decrement totalInvested (principal going back) + increment totalReturned
    // For EQUITY: only increment totalReturned (profit payout, principal stays)
    const shouldClose = investor.type === 'FIXED_RATE'
      ? (investor.totalInvested - amount) <= 0
      : true // equity always closes on return

    const updateData = investor.type === 'FIXED_RATE'
      ? { totalInvested: { decrement: amount }, totalReturned: { increment: amount }, ...(shouldClose ? { isClosed: true } : {}) }
      : { totalReturned: { increment: amount }, isClosed: true }

    const updatedInvestor = await tx.investor.update({
      where: { id: investor.id },
      data: updateData,
    })
    return { transaction, updatedInvestor }
  })

  await invalidateInvestorCaches(company.id, investor.siteId)
  await invalidateInvestorDetailCaches(investor.id)

  return jsonOk(c, {
    transaction: {
      id: result.transaction.id,
      amount: result.transaction.amount,
      note: result.transaction.note,
      amountPaid: result.transaction.amountPaid,
      paymentDate: result.transaction.paymentDate ? result.transaction.paymentDate.toISOString() : null,
      paymentStatus: result.transaction.paymentStatus,
      createdAt: result.transaction.createdAt.toISOString(),
    },
    investor: {
      id: result.updatedInvestor.id,
      name: result.updatedInvestor.name,
      type: result.updatedInvestor.type,
      totalInvested: result.updatedInvestor.totalInvested,
      totalReturned: result.updatedInvestor.totalReturned,
      isClosed: result.updatedInvestor.isClosed,
    },
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
              investor: z.object({
                id: z.string(),
                name: z.string(),
                type: z.string(),
                totalInvested: z.number(),
                totalReturned: z.number(),
              }),
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

  const { amount, note, amountPaid = 0, paymentDate } = parsed.data

  // Check company available fund
  const { getCompanyAvailableFund } = await import('../utils/fund.js')
  const availableFund = await getCompanyAvailableFund(company.id)
  if (amount > availableFund) {
    return jsonError(c, `Interest amount (${amount}) exceeds company available fund (${availableFund})`, 400) as any
  }

  const result = await prisma.$transaction(async (tx) => {
    const transaction = await tx.investorTransaction.create({
      data: { investorId: investor.id, amount: -amount, note: note ?? 'Interest payment', amountPaid, paymentDate: paymentDate ? new Date(paymentDate) : null, paymentStatus: amountPaid >= amount ? 'COMPLETED' : amountPaid > 0 ? 'PARTIAL' : 'PENDING' },
    })
    // Interest: only increment totalReturned, principal (totalInvested) stays the same
    const updatedInvestor = await tx.investor.update({
      where: { id: investor.id },
      data: { totalReturned: { increment: amount } },
    })
    return { transaction, updatedInvestor }
  })

  await invalidateInvestorCaches(company.id, investor.siteId)
  await invalidateInvestorDetailCaches(investor.id)

  return jsonOk(c, {
    transaction: {
      id: result.transaction.id,
      amount: result.transaction.amount,
      note: result.transaction.note,
      amountPaid: result.transaction.amountPaid,
      paymentDate: result.transaction.paymentDate ? result.transaction.paymentDate.toISOString() : null,
      paymentStatus: result.transaction.paymentStatus,
      createdAt: result.transaction.createdAt.toISOString(),
    },
    investor: {
      id: result.updatedInvestor.id,
      name: result.updatedInvestor.name,
      type: result.updatedInvestor.type,
      totalInvested: result.updatedInvestor.totalInvested,
      totalReturned: result.updatedInvestor.totalReturned,
      isClosed: result.updatedInvestor.isClosed,
    },
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

  const transactions = await prisma.investorTransaction.findMany({
    where: { investorId: id },
    orderBy: { createdAt: 'desc' },
  })

  const responseData = {
    transactions: transactions.map((t) => ({
      id: t.id,
      amount: t.amount,
      note: t.note,
      amountPaid: t.amountPaid,
      paymentDate: t.paymentDate ? t.paymentDate.toISOString() : null,
      paymentStatus: t.paymentStatus,
      createdAt: t.createdAt.toISOString(),
    })),
    totalInvested: investor.totalInvested,
    totalReturned: investor.totalReturned,
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
              transaction: z.object({ id: z.string(), amountPaid: z.number(), paymentStatus: z.string() }),
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
  const parsed = c.req.valid('json')
  
  const { investor, company } = await getInvestorForUser(id, auth.userId)
  if (!investor || !company) return jsonError(c, 'Investor not found', 404) as any

  const transaction = await prisma.investorTransaction.findFirst({
    where: { id: transactionId, investorId: investor.id, isDeleted: false },
  })
  if (!transaction) return jsonError(c, 'Transaction not found', 404) as any

  const { amount, note } = parsed
  const absAmount = Math.abs(transaction.amount)
  const newTotal = transaction.amountPaid + amount

  if (newTotal > absAmount) {
    return jsonError(c, `Payment of ${amount} would exceed the transaction total (${absAmount}). Remaining: ${absAmount - transaction.amountPaid}`, 400) as any
  }

  const paymentStatus = newTotal >= absAmount ? 'COMPLETED' : newTotal > 0 ? 'PARTIAL' : 'PENDING'

  const result = await prisma.$transaction(async (tx: any) => {
    const payment = await tx.payment.create({
      data: {
        companyId: company.id,
        siteId: investor.siteId,
        entityType: 'INVESTOR_TRANSACTION',
        entityId: transactionId,
        amount,
        note: note || 'Payment for investor transaction',
      },
    })

    const updated = await tx.investorTransaction.update({
      where: { id: transactionId },
      data: { amountPaid: newTotal, paymentDate: new Date(), paymentStatus },
    })

    return { payment, updated }
  })

  cacheService.del(CacheKeys.investorTransactions(investor.id))
  await invalidateInvestorCaches(company.id, investor.siteId)

  return jsonOk(c, {
    transaction: { id: result.updated.id, amountPaid: result.updated.amountPaid, paymentStatus: result.updated.paymentStatus },
    payment: { id: result.payment.id, amount: result.payment.amount, createdAt: result.payment.createdAt },
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
  const { investor } = await getInvestorForUser(id, auth.userId)
  if (!investor) return jsonError(c, 'Investor not found', 404) as any

  const payments = await prisma.payment.findMany({
    where: { entityType: 'INVESTOR_TRANSACTION', entityId: transactionId },
    orderBy: { createdAt: 'desc' },
  })

  return jsonOk(c, { payments }) as any
})


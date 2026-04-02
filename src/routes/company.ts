import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../types/auth.js'
import { prisma } from '../db/prisma.js'
import { requireJwt } from '../middlewares/jwt.js'
import { jsonError, jsonOk } from '../utils/response.js'
import { getCompanyPartnerFund, getCompanyFixedRateInvestorFund, getCompanyFixedRateReturned, getTotalAllocatedFund, getCompanyAvailableFund, getCompanyTotalWithdrawals } from '../utils/fund.js'
import { invalidatePartnerCaches, invalidateWithdrawalCaches, invalidateCompanyCaches } from '../services/cache-invalidation.js'
import { getCompanyForUser } from '../utils/company.js'
import { cacheService } from '../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../config/cache-keys.js'

export const companyRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()

// Apply JWT middleware to all company routes
companyRoutes.use('*', requireJwt)

// ── Schemas ──────────────────────────────────────────

const createCompanySchema = z.object({
  name: z.string().min(1),
  address: z.string().optional(),
})

const updateCompanySchema = z.object({
  name: z.string().min(1).optional(),
  address: z.string().optional(),
})

const createPartnerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  investmentAmount: z.number().min(0).default(0),
  stakePercentage: z.number().min(0).max(100).default(0),
})

const updatePartnerSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  investmentAmount: z.number().min(0).optional(),
  stakePercentage: z.number().min(0).max(100).optional(),
})

const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})

// ── POST /company ────────────────────────────────────

const createCompanyRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Company'],
  summary: 'Create a company',
  description: 'Create a new company for the authenticated user. Each user can have only one company.',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': { schema: createCompanySchema },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              company: z.object({
                id: z.string(),
                name: z.string(),
                address: z.string().nullable(),
                createdAt: z.string().datetime(),
              }),
            }),
          }),
        },
      },
      description: 'Company created successfully',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Invalid input or company already exists',
    },
  },
})

companyRoutes.openapi(createCompanyRoute, async (c) => {
  const auth = c.get('auth')
  const body = await c.req.json().catch(() => null)
  const parsed = createCompanySchema.safeParse(body)

  if (!parsed.success) {
    return jsonError(c, 'Invalid request body', 400) as any
  }

  // One user → one company
  const existing = await prisma.company.findUnique({
    where: { createdBy: auth.userId },
  })
  if (existing) {
    return jsonError(c, 'You already have a company', 400) as any
  }

  const company = await prisma.company.create({
    data: {
      name: parsed.data.name,
      address: parsed.data.address,
      createdBy: auth.userId,
    },
  })

  return jsonOk(c, {
    company: {
      id: company.id,
      name: company.name,
      address: company.address,
      createdAt: company.createdAt,
    },
  }, 201) as any
})

// ── GET /company ─────────────────────────────────────

const getCompanyRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Company'],
  summary: 'Get company details',
  description: 'Returns the company profile with all partners and a full fund breakdown: `partner_fund` (sum of partner investments), `investor_fund` (sum of fixed-rate investor transactions), `total_fund` (partner + investor), and `available_fund` (total minus funds allocated to sites).',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              company: z.object({
                id: z.string(),
                name: z.string(),
                address: z.string().nullable(),
                createdAt: z.string().datetime(),
              }),
              partner_fund: z.number(),
              investor_fund: z.number(),
              total_fund: z.number(),
              available_fund: z.number(),
              partners: z.array(z.object({
                id: z.string(),
                name: z.string(),
                email: z.string().nullable(),
                phone: z.string().nullable(),
                investmentAmount: z.number(),
                stakePercentage: z.number(),
              })),
            }),
          }),
        },
      },
      description: 'Company details with partners and fund summary',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found for this user',
    },
  },
})

companyRoutes.openapi(getCompanyRoute, async (c) => {
  const auth = c.get('auth')

  const company = await getCompanyForUser(auth.userId)
  if (!company) {
    return jsonError(c, 'No company found. Create one first.', 404) as any
  }

  const cacheKey = CacheKeys.companyDetails(company.id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  // Cache miss — do full query with partners
  const companyWithPartners = await prisma.company.findUnique({
    where: { id: company.id },
    include: { partners: true },
  })
  if (!companyWithPartners) return jsonError(c, 'No company found', 404) as any

  const [partnerFund, investorFund, availableFund] = await Promise.all([
    getCompanyPartnerFund(company.id),
    getCompanyFixedRateInvestorFund(company.id),
    getCompanyAvailableFund(company.id),
  ])
  const totalFund = partnerFund + investorFund

  const responseData = {
    company: {
      id: companyWithPartners.id,
      name: companyWithPartners.name,
      address: companyWithPartners.address,
      createdAt: companyWithPartners.createdAt,
    },
    partner_fund: partnerFund,
    investor_fund: investorFund,
    total_fund: totalFund,
    available_fund: availableFund,
    partners: companyWithPartners.partners.map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      phone: p.phone,
      investmentAmount: p.investmentAmount,
      stakePercentage: p.stakePercentage,
    })),
  }
  await cacheService.set(cacheKey, responseData, CacheTTL.COMPANY_PROFILE)
  return jsonOk(c, responseData) as any
})

// ── PUT /company ─────────────────────────────────────

const updateCompanyRoute = createRoute({
  method: 'put',
  path: '/',
  tags: ['Company'],
  summary: 'Update company details',
  description: 'Update the company name and/or address.',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': { schema: updateCompanySchema },
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
              company: z.object({
                id: z.string(),
                name: z.string(),
                address: z.string().nullable(),
                createdAt: z.string().datetime(),
              }),
            }),
          }),
        },
      },
      description: 'Company updated',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Invalid input',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

companyRoutes.openapi(updateCompanyRoute, async (c) => {
  const auth = c.get('auth')
  const body = await c.req.json().catch(() => null)
  const parsed = updateCompanySchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const existing = await getCompanyForUser(auth.userId)
  if (!existing) return jsonError(c, 'No company found. Create one first.', 404) as any

  const company = await prisma.company.update({
    where: { id: existing.id },
    data: parsed.data,
  })

  await invalidateCompanyCaches(company.id, auth.userId)

  return jsonOk(c, {
    company: {
      id: company.id,
      name: company.name,
      address: company.address,
      createdAt: company.createdAt,
    },
  }) as any
})

// ── DELETE /company ──────────────────────────────────

const deleteCompanyRoute = createRoute({
  method: 'delete',
  path: '/',
  tags: ['Company'],
  summary: 'Delete company',
  description: 'Permanently delete the company and all associated data (sites, vendors, partners, customers, investors).',
  security: [{ bearerAuth: [] }],
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
      description: 'Company deleted',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

companyRoutes.openapi(deleteCompanyRoute, async (c) => {
  const auth = c.get('auth')

  const company = await getCompanyForUser(auth.userId)
  if (!company) return jsonError(c, 'No company found', 404) as any

  await prisma.company.delete({ where: { id: company.id } })

  await invalidateCompanyCaches(company.id, auth.userId)

  return jsonOk(c, { message: `Company "${company.name}" deleted` }) as any
})

// ── POST /company/withdraw ───────────────────────────

const withdrawSchema = z.object({
  amount: z.number().positive(),
  note: z.string().optional(),
  amountPaid: z.number().min(0).optional().default(0),
  paymentDate: z.string().datetime().optional(),
})

const companyWithdrawRoute = createRoute({
  method: 'post',
  path: '/withdraw',
  tags: ['Company'],
  summary: 'Withdraw from company available fund',
  description: 'Pull money out of the company available fund (e.g., owner payout, operational expenses). Validated: amount must not exceed available fund. Creates a record in company withdrawals.',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: withdrawSchema } } },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              withdrawal: z.object({
                id: z.string(),
                amount: z.number(),
                note: z.string().nullable(),
                amountPaid: z.number(),
                paymentDate: z.string().datetime().nullable(),
                paymentStatus: z.enum(['PENDING', 'PARTIAL', 'COMPLETED']),
                createdAt: z.string().datetime(),
              }),
              availableFund: z.number(),
            }),
          }),
        },
      },
      description: 'Funds withdrawn from company',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Insufficient funds or bad request',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

companyRoutes.openapi(companyWithdrawRoute, async (c) => {
  const auth = c.get('auth')
  const body = await c.req.json().catch(() => null)
  const parsed = withdrawSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const company = await getCompanyForUser(auth.userId)
  if (!company) return jsonError(c, 'No company found', 404) as any

  const availableFund = await getCompanyAvailableFund(company.id)
  if (parsed.data.amount > availableFund) {
    return jsonError(c, `Withdrawal amount (${parsed.data.amount}) exceeds available fund (${availableFund})`, 400) as any
  }

  const { amount, note, amountPaid = 0, paymentDate } = parsed.data

  const result = await prisma.$transaction(async (tx: any) => {
    const withdrawal = await tx.companyWithdrawal.create({
      data: {
        companyId: company.id,
        amount,
        note,
        amountPaid,
        paymentDate: paymentDate ? new Date(paymentDate) : null,
        paymentStatus: amountPaid >= amount ? 'COMPLETED' : amountPaid > 0 ? 'PARTIAL' : 'PENDING',
      },
    })

    if (amountPaid > 0) {
      await tx.payment.create({
        data: {
          companyId: company.id,
          entityType: 'COMPANY_WITHDRAWAL',
          entityId: withdrawal.id,
          amount: amountPaid,
          note: note || 'Initial withdrawal payment',
        },
      })
    }
    return withdrawal
  })

  const withdrawal = result

  await invalidateWithdrawalCaches(company.id)

  const newAvailableFund = await getCompanyAvailableFund(company.id)

  return jsonOk(c, {
    withdrawal: {
      id: withdrawal.id,
      amount: withdrawal.amount,
      note: withdrawal.note,
      amountPaid: withdrawal.amountPaid,
      paymentDate: withdrawal.paymentDate ? withdrawal.paymentDate.toISOString() : null,
      paymentStatus: withdrawal.paymentStatus,
      createdAt: withdrawal.createdAt.toISOString(),
    },
    availableFund: newAvailableFund,
  }) as any
})

// ── GET /company/activity ────────────────────────────

const getActivityRoute = createRoute({
  method: 'get',
  path: '/activity',
  tags: ['Company'],
  summary: 'Get recent company activity',
  description: 'Returns a paginated unified feed of recent events. Use ?cursor=ISO_DATE for next page.',
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      cursor: z.string().optional(),
      limit: z.coerce.number().min(1).max(50).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              activities: z.array(z.object({
                id: z.string(),
                type: z.enum(['withdrawal', 'site_fund', 'investor_tx', 'expense']),
                amount: z.number(),
                description: z.string(),
                date: z.string().datetime(),
              })),
              nextCursor: z.string().nullable(),
            }),
          }),
        },
      },
      description: 'Recent activity',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

companyRoutes.openapi(getActivityRoute, async (c) => {
  const auth = c.get('auth')
  const { cursor, limit: rawLimit } = c.req.valid('query')
  const limit = rawLimit ?? 10
  const company = await getCompanyForUser(auth.userId)
  if (!company) return jsonError(c, 'No company found', 404) as any

  const cacheKey = `${CacheKeys.activityFeed(company.id)}:${cursor ?? 'first'}:${limit}`
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  // Fetch more than needed per source so we have enough after merging
  const fetchLimit = limit + 5
  const dateFilter = cursor ? { lt: new Date(cursor) } : undefined
  const dateWhere = dateFilter ? { createdAt: dateFilter } : {}

  const [withdrawals, siteFunds, investorTxs, expenses] = await Promise.all([
    prisma.companyWithdrawal.findMany({
      where: { companyId: company.id, isDeleted: false, ...dateWhere },
      orderBy: { createdAt: 'desc' },
      take: fetchLimit,
    }),
    prisma.siteFund.findMany({
      where: { site: { companyId: company.id }, ...dateWhere },
      orderBy: { createdAt: 'desc' },
      take: fetchLimit,
      include: { site: { select: { name: true } } },
    }),
    prisma.investorTransaction.findMany({
      where: { investor: { companyId: company.id, isDeleted: false }, ...dateWhere },
      orderBy: { createdAt: 'desc' },
      take: fetchLimit,
      include: { investor: { select: { name: true, type: true } } },
    }),
    prisma.expense.findMany({
      where: { site: { companyId: company.id }, ...dateWhere },
      orderBy: { createdAt: 'desc' },
      take: fetchLimit,
      include: { site: { select: { name: true } } },
    }),
  ])

  const activities = [
    ...withdrawals.map((w) => ({
      id: w.id,
      type: 'withdrawal' as const,
      amount: -w.amount,
      description: w.note || 'Company withdrawal',
      date: w.createdAt,
    })),
    ...siteFunds.map((sf) => ({
      id: sf.id,
      type: 'site_fund' as const,
      amount: sf.amount,
      description: sf.amount > 0
        ? `Fund allocated to ${sf.site.name}`
        : `Fund pulled from ${sf.site.name}`,
      date: sf.createdAt,
    })),
    ...investorTxs.map((tx) => ({
      id: tx.id,
      type: 'investor_tx' as const,
      amount: tx.amount,
      description: tx.amount > 0
        ? `${tx.investor.name} invested`
        : tx.note?.toLowerCase().includes('interest')
          ? `Interest paid to ${tx.investor.name}`
          : `Returned to ${tx.investor.name}`,
      date: tx.createdAt,
    })),
    ...expenses.map((e) => ({
      id: e.id,
      type: 'expense' as const,
      amount: -e.amount,
      description: `${e.description} — ${e.site.name}`,
      date: e.createdAt,
    })),
  ]

  activities.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

  const page = activities.slice(0, limit)
  const hasMore = activities.length > limit
  const nextCursor = hasMore && page.length > 0
    ? (page[page.length - 1].date instanceof Date ? (page[page.length - 1].date as unknown as Date).toISOString() : page[page.length - 1].date as unknown as string)
    : null

  const responseData = {
    activities: page.map((a) => ({
      ...a,
      date: a.date instanceof Date ? a.date.toISOString() : a.date,
    })),
    nextCursor,
  }
  await cacheService.set(cacheKey, responseData, CacheTTL.ACTIVITY_FEED)
  return jsonOk(c, responseData) as any
})

// ── GET /company/expenses ───────────────────────────

const getCompanyExpensesRoute = createRoute({
  method: 'get',
  path: '/expenses',
  tags: ['Company'],
  summary: 'Get all company expenses across sites',
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      page: z.coerce.number().min(1).optional(),
      limit: z.coerce.number().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              expenses: z.array(z.object({
                id: z.string(),
                type: z.string(),
                reason: z.string().nullable(),
                description: z.string().nullable(),
                amount: z.number(),
                siteName: z.string(),
                vendorName: z.string().nullable(),
                createdAt: z.string().datetime(),
              })),
              total: z.number(),
              page: z.number(),
              totalPages: z.number(),
            }),
          }),
        },
      },
      description: 'Company expenses',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

companyRoutes.openapi(getCompanyExpensesRoute, async (c) => {
  const auth = c.get('auth')
  const { page: rawPage, limit: rawLimit } = c.req.valid('query')
  const page = rawPage ?? 1
  const limit = rawLimit ?? 20
  const skip = (page - 1) * limit

  const company = await getCompanyForUser(auth.userId)
  if (!company) return jsonError(c, 'No company found', 404) as any

  const cacheKey = `${CacheKeys.companyExpenses(company.id)}:${page}:${limit}`
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  const [expenses, total] = await Promise.all([
    prisma.expense.findMany({
      where: { site: { companyId: company.id } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        site: { select: { name: true } },
        vendor: { select: { name: true } },
      },
    }),
    prisma.expense.count({ where: { site: { companyId: company.id } } }),
  ])

  const responseData = {
    expenses: expenses.map((e) => ({
      id: e.id,
      type: e.type,
      reason: e.reason,
      description: e.description,
      amount: e.amount,
      siteName: e.site.name,
      vendorName: e.vendor?.name ?? null,
      createdAt: e.createdAt,
    })),
    total,
    page,
    totalPages: Math.ceil(total / limit),
  }
  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return jsonOk(c, responseData) as any
})

// ── POST /company/partners ───────────────────────────

const addPartnerRoute = createRoute({
  method: 'post',
  path: '/partners',
  tags: ['Partners'],
  summary: 'Add a partner',
  description: 'Add a new partner to the company with their name, contact info, investment amount, and stake percentage.',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': { schema: createPartnerSchema },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              partner: z.object({
                id: z.string(),
                name: z.string(),
                email: z.string().nullable(),
                phone: z.string().nullable(),
                investmentAmount: z.number(),
                stakePercentage: z.number(),
              }),
            }),
          }),
        },
      },
      description: 'Partner added',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Bad request',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

companyRoutes.openapi(addPartnerRoute, async (c) => {
  const auth = c.get('auth')
  const body = await c.req.json().catch(() => null)
  const parsed = createPartnerSchema.safeParse(body)

  if (!parsed.success) {
    return jsonError(c, 'Invalid request body', 400) as any
  }

  const company = await getCompanyForUser(auth.userId)
  if (!company) {
    return jsonError(c, 'No company found. Create one first.', 404) as any
  }

  const partner = await prisma.partner.create({
    data: {
      companyId: company.id,
      name: parsed.data.name,
      email: parsed.data.email,
      phone: parsed.data.phone,
      investmentAmount: parsed.data.investmentAmount,
      stakePercentage: parsed.data.stakePercentage,
    },
  })

  await invalidatePartnerCaches(company.id)

  return jsonOk(c, {
    partner: {
      id: partner.id,
      name: partner.name,
      email: partner.email,
      phone: partner.phone,
      investmentAmount: partner.investmentAmount,
      stakePercentage: partner.stakePercentage,
    },
  }, 201) as any
})

// ── GET /company/partners ────────────────────────────

const getPartnersRoute = createRoute({
  method: 'get',
  path: '/partners',
  tags: ['Partners'],
  summary: 'List all partners',
  description: 'Returns all partners of the company with the total fund calculated from partner investments.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              company: z.object({
                id: z.string(),
                name: z.string(),
              }),
              total_fund: z.number(),
              partners: z.array(z.object({
                id: z.string(),
                name: z.string(),
                email: z.string().nullable(),
                phone: z.string().nullable(),
                investmentAmount: z.number(),
                stakePercentage: z.number(),
              })),
            }),
          }),
        },
      },
      description: 'All partners with total fund',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

companyRoutes.openapi(getPartnersRoute, async (c) => {
  const auth = c.get('auth')

  const company = await getCompanyForUser(auth.userId)
  if (!company) {
    return jsonError(c, 'No company found. Create one first.', 404) as any
  }

  const cacheKey = CacheKeys.partnerList(company.id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  // Cache miss — fetch partners
  const companyWithPartners = await prisma.company.findUnique({
    where: { id: company.id },
    include: { partners: true },
  })
  if (!companyWithPartners) return jsonError(c, 'No company found', 404) as any

  const totalFund = companyWithPartners.partners.reduce((sum, p) => sum + p.investmentAmount, 0)

  const responseData = {
    company: {
      id: companyWithPartners.id,
      name: companyWithPartners.name,
    },
    total_fund: totalFund,
    partners: companyWithPartners.partners.map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      phone: p.phone,
      investmentAmount: p.investmentAmount,
      stakePercentage: p.stakePercentage,
    })),
  }
  await cacheService.set(cacheKey, responseData, CacheTTL.PARTNER_LIST)
  return jsonOk(c, responseData) as any
})

// ── PUT /company/partners/:id ────────────────────────

const updatePartnerRoute = createRoute({
  method: 'put',
  path: '/partners/{id}',
  tags: ['Partners'],
  summary: 'Update a partner',
  description: 'Update partner details such as name, contact info, investment amount, or stake percentage.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        'application/json': { schema: updatePartnerSchema },
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
              partner: z.object({
                id: z.string(),
                name: z.string(),
                email: z.string().nullable(),
                phone: z.string().nullable(),
                investmentAmount: z.number(),
                stakePercentage: z.number(),
              }),
            }),
          }),
        },
      },
      description: 'Partner updated',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Bad request',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Partner not found',
    },
  },
})

companyRoutes.openapi(updatePartnerRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const body = await c.req.json().catch(() => null)
  const parsed = updatePartnerSchema.safeParse(body)

  if (!parsed.success) {
    return jsonError(c, 'Invalid request body', 400) as any
  }

  // Verify partner belongs to user's company
  const company = await getCompanyForUser(auth.userId)
  if (!company) {
    return jsonError(c, 'No company found', 404) as any
  }

  const existing = await prisma.partner.findFirst({
    where: { id, companyId: company.id },
  })
  if (!existing) {
    return jsonError(c, 'Partner not found', 404) as any
  }

  const partner = await prisma.partner.update({
    where: { id },
    data: parsed.data,
  })

  await invalidatePartnerCaches(company.id)

  return jsonOk(c, {
    partner: {
      id: partner.id,
      name: partner.name,
      email: partner.email,
      phone: partner.phone,
      investmentAmount: partner.investmentAmount,
      stakePercentage: partner.stakePercentage,
    },
  }) as any
})

// ── DELETE /company/partners/:id ─────────────────────

const deletePartnerRoute = createRoute({
  method: 'delete',
  path: '/partners/{id}',
  tags: ['Partners'],
  summary: 'Remove a partner',
  description: 'Remove a partner from the company. This reduces the company total fund by their investment amount.',
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
              message: z.string(),
            }),
          }),
        },
      },
      description: 'Partner deleted',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Partner not found',
    },
  },
})

companyRoutes.openapi(deletePartnerRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')

  const company = await getCompanyForUser(auth.userId)
  if (!company) {
    return jsonError(c, 'No company found', 404) as any
  }

  const existing = await prisma.partner.findFirst({
    where: { id, companyId: company.id },
  })
  if (!existing) {
    return jsonError(c, 'Partner not found', 404) as any
  }

  await prisma.partner.delete({
    where: { id },
  })

  await invalidatePartnerCaches(company.id)

  return jsonOk(c, { message: `Partner ${existing.name} removed` }) as any
})

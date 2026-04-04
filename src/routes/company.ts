import { Prisma } from '@prisma/client'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../types/auth.js'
import { prisma } from '../db/prisma.js'
import { requireJwt } from '../middlewares/jwt.js'
import { jsonError, jsonOk } from '../utils/response.js'
import { createLedgerEntry } from '../services/ledger.service.js'
import {
  deriveCompanyWithdrawalPaymentStatus,
  getCompanyWithdrawalPaidTotal,
  getCompanyWithdrawalRemaining,
  mapCompanyWithdrawalLedgerFields,
} from '../services/company-withdrawal-ledger.service.js'
import { getPartnerPaidTotal, sumDirectionalLedgerAmounts } from '../services/ledger-read.service.js'
import { getCompanyPartnerFund, getCompanyFixedRateInvestorFund, getCompanyAvailableFund } from '../utils/ledger-fund.js'
import { invalidatePartnerCaches, invalidateWithdrawalCaches, invalidateCompanyCaches } from '../services/cache-invalidation.js'
import { getCompanyForUser } from '../utils/company.js'
import { cacheService } from '../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../config/cache-keys.js'

export const companyRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()
const LEDGER_TX_OPTIONS = { maxWait: 15000, timeout: 20000 } as const

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

const withdrawalResponseSchema = z.object({
  id: z.string(),
  amount: z.number(),
  note: z.string().nullable(),
  amountPaid: z.number(),
  remaining: z.number(),
  paymentDate: z.string().datetime().nullable(),
  paymentStatus: z.enum(['PENDING', 'PARTIAL', 'COMPLETED']),
  createdAt: z.string().datetime(),
})

async function getCompanyWithdrawalForUser(withdrawalId: string, userId: string) {
  const company = await getCompanyForUser(userId)
  if (!company) return { company: null, withdrawal: null }

  const withdrawal = await prisma.companyWithdrawal.findFirst({
    where: { id: withdrawalId, companyId: company.id, isDeleted: false },
    include: {
      ledgerEntries: {
        select: { amount: true, postedAt: true },
        orderBy: { postedAt: 'desc' },
      },
    },
  })

  return { company, withdrawal }
}

function mapPartnerResponse(
  partner: {
    id: string
    name: string
    email: string | null
    phone: string | null
    stakePercentage: number
    ledgerEntries: Array<{ amount: Prisma.Decimal | number | string; direction: 'IN' | 'OUT' }>
  },
) {
  return {
    id: partner.id,
    name: partner.name,
    email: partner.email,
    phone: partner.phone,
    investmentAmount: sumDirectionalLedgerAmounts(partner.ledgerEntries),
    stakePercentage: partner.stakePercentage,
  }
}

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
      createdAt: company.createdAt.toISOString(),
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
    include: {
      partners: {
        include: {
          ledgerEntries: {
            select: { amount: true, direction: true },
          },
        },
      },
    },
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
      createdAt: companyWithPartners.createdAt.toISOString(),
    },
    partner_fund: partnerFund,
    investor_fund: investorFund,
    total_fund: totalFund,
    available_fund: availableFund,
    partners: companyWithPartners.partners.map(mapPartnerResponse),
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
      createdAt: company.createdAt.toISOString(),
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
  idempotencyKey: z.string().optional(),
})

const withdrawalPaymentSchema = z.object({
  amount: z.number().positive(),
  note: z.string().optional(),
  idempotencyKey: z.string().optional(),
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
              withdrawal: withdrawalResponseSchema,
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
  const { amount, note, amountPaid = 0, paymentDate, idempotencyKey } = parsed.data

  if (amountPaid > amount) {
    return jsonError(c, 'AMOUNT_EXCEEDS_LIMIT', 400) as any
  }

  if (amountPaid > availableFund) {
    return jsonError(c, 'INSUFFICIENT_FUNDS', 400) as any
  }

  const result = await prisma.$transaction(async (tx: any) => {
    const withdrawal = await tx.companyWithdrawal.create({
      data: {
        companyId: company.id,
        amount,
        note,
      },
    })

    let initialPaymentDate: string | null = null
    if (amountPaid > 0) {
      const payment = await createLedgerEntry({
        companyId: company.id,
        walletType: 'COMPANY',
        direction: 'OUT',
        movementType: 'COMPANY_WITHDRAWAL',
        amount: new Prisma.Decimal(amountPaid),
        idempotencyKey: idempotencyKey ?? `company-withdrawal:${withdrawal.id}:${Date.now()}`,
        postedAt: paymentDate ? new Date(paymentDate) : undefined,
        note: note || 'Initial withdrawal payment',
        companyWithdrawalId: withdrawal.id,
      }, tx)
      initialPaymentDate = payment.postedAt.toISOString()
    }

    const paidTotal = await getCompanyWithdrawalPaidTotal(withdrawal.id, tx)
    const remaining = await getCompanyWithdrawalRemaining(withdrawal.id, tx)

    return { withdrawal, paidTotal, remaining, initialPaymentDate }
  }, LEDGER_TX_OPTIONS)

  await invalidateWithdrawalCaches(company.id)

  const newAvailableFund = await getCompanyAvailableFund(company.id)
  const paymentStatus = deriveCompanyWithdrawalPaymentStatus(result.withdrawal.amount, result.paidTotal)

  return jsonOk(c, {
    withdrawal: {
      id: result.withdrawal.id,
      amount: result.withdrawal.amount,
      note: result.withdrawal.note,
      amountPaid: result.paidTotal,
      remaining: result.remaining,
      paymentDate: result.initialPaymentDate,
      paymentStatus,
      createdAt: result.withdrawal.createdAt.toISOString(),
    },
    availableFund: newAvailableFund,
  }) as any
})

const getWithdrawalsRoute = createRoute({
  method: 'get',
  path: '/withdrawals',
  tags: ['Company'],
  summary: 'List company withdrawals',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              withdrawals: z.array(withdrawalResponseSchema),
            }),
          }),
        },
      },
      description: 'Company withdrawals',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

companyRoutes.openapi(getWithdrawalsRoute, async (c) => {
  const auth = c.get('auth')
  const company = await getCompanyForUser(auth.userId)
  if (!company) return jsonError(c, 'No company found', 404) as any

  const cacheKey = CacheKeys.companyWithdrawalList(company.id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  const withdrawals = await prisma.companyWithdrawal.findMany({
    where: { companyId: company.id, isDeleted: false },
    include: {
      ledgerEntries: {
        select: { amount: true, postedAt: true },
        orderBy: { postedAt: 'desc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  const responseData = {
    withdrawals: withdrawals.map((withdrawal) => {
      const derived = mapCompanyWithdrawalLedgerFields(withdrawal.amount, withdrawal.ledgerEntries)
      return {
        id: withdrawal.id,
        amount: withdrawal.amount,
        note: withdrawal.note,
        amountPaid: derived.amountPaid,
        remaining: derived.remaining,
        paymentDate: derived.paymentDate,
        paymentStatus: derived.paymentStatus,
        createdAt: withdrawal.createdAt.toISOString(),
      }
    }),
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return jsonOk(c, responseData) as any
})

const getWithdrawalDetailRoute = createRoute({
  method: 'get',
  path: '/withdrawals/{id}',
  tags: ['Company'],
  summary: 'Get company withdrawal detail',
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
              withdrawal: withdrawalResponseSchema,
            }),
          }),
        },
      },
      description: 'Withdrawal detail',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Withdrawal not found',
    },
  },
})

companyRoutes.openapi(getWithdrawalDetailRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const { withdrawal } = await getCompanyWithdrawalForUser(id, auth.userId)
  if (!withdrawal) return jsonError(c, 'Withdrawal not found', 404) as any

  const derived = mapCompanyWithdrawalLedgerFields(withdrawal.amount, withdrawal.ledgerEntries)

  return jsonOk(c, {
    withdrawal: {
      id: withdrawal.id,
      amount: withdrawal.amount,
      note: withdrawal.note,
      amountPaid: derived.amountPaid,
      remaining: derived.remaining,
      paymentDate: derived.paymentDate,
      paymentStatus: derived.paymentStatus,
      createdAt: withdrawal.createdAt.toISOString(),
    },
  }) as any
})

const addWithdrawalPaymentRoute = createRoute({
  method: 'patch',
  path: '/withdrawals/{id}/payment',
  tags: ['Company'],
  summary: 'Record a company withdrawal payment',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: withdrawalPaymentSchema,
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
              withdrawal: z.object({
                id: z.string(),
                amountPaid: z.number(),
                remaining: z.number(),
                paymentStatus: z.enum(['PENDING', 'PARTIAL', 'COMPLETED']),
              }),
              payment: z.object({
                id: z.string(),
                amount: z.number(),
                createdAt: z.string().datetime(),
              }),
              availableFund: z.number(),
            }),
          }),
        },
      },
      description: 'Withdrawal payment recorded',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Invalid payload',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Withdrawal not found',
    },
  },
})

companyRoutes.openapi(addWithdrawalPaymentRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const { amount, note, idempotencyKey } = c.req.valid('json')

  const { company, withdrawal } = await getCompanyWithdrawalForUser(id, auth.userId)
  if (!company || !withdrawal) return jsonError(c, 'Withdrawal not found', 404) as any

  const availableFund = await getCompanyAvailableFund(company.id)
  if (amount > availableFund) {
    return jsonError(c, 'INSUFFICIENT_FUNDS', 400) as any
  }

  const currentPaid = await getCompanyWithdrawalPaidTotal(withdrawal.id)
  const newTotal = currentPaid + amount
  if (newTotal > withdrawal.amount) {
    return jsonError(c, 'AMOUNT_EXCEEDS_LIMIT', 400) as any
  }

  const result = await prisma.$transaction(async (tx) => {
    const payment = await createLedgerEntry({
      companyId: company.id,
      walletType: 'COMPANY',
      direction: 'OUT',
      movementType: 'COMPANY_WITHDRAWAL',
      amount: new Prisma.Decimal(amount),
      idempotencyKey: idempotencyKey ?? `company-withdrawal-payment:${withdrawal.id}:${Date.now()}`,
      note: note || 'Withdrawal payment',
      companyWithdrawalId: withdrawal.id,
    }, tx)

    const amountPaid = await getCompanyWithdrawalPaidTotal(withdrawal.id, tx)
    const remaining = await getCompanyWithdrawalRemaining(withdrawal.id, tx)
    const paymentStatus = deriveCompanyWithdrawalPaymentStatus(withdrawal.amount, amountPaid)

    return { payment, amountPaid, remaining, paymentStatus }
  }, LEDGER_TX_OPTIONS)

  await invalidateWithdrawalCaches(company.id)

  return jsonOk(c, {
    withdrawal: {
      id: withdrawal.id,
      amountPaid: result.amountPaid,
      remaining: result.remaining,
      paymentStatus: result.paymentStatus,
    },
    payment: {
      id: result.payment.id,
      amount: Number(result.payment.amount),
      createdAt: result.payment.postedAt.toISOString(),
    },
    availableFund: await getCompanyAvailableFund(company.id),
  }) as any
})

const getWithdrawalPaymentsRoute = createRoute({
  method: 'get',
  path: '/withdrawals/{id}/payments',
  tags: ['Payments'],
  summary: 'Get company withdrawal payment history',
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
      description: 'Withdrawal payment history',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Withdrawal not found',
    },
  },
})

companyRoutes.openapi(getWithdrawalPaymentsRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const { company, withdrawal } = await getCompanyWithdrawalForUser(id, auth.userId)
  if (!company || !withdrawal) return jsonError(c, 'Withdrawal not found', 404) as any

  const payments = await prisma.payment.findMany({
    where: {
      companyId: company.id,
      companyWithdrawalId: withdrawal.id,
    },
    orderBy: { postedAt: 'desc' },
  })

  return jsonOk(c, {
    payments: payments.map((payment) => ({
      id: payment.id,
      amount: Number(payment.amount),
      note: payment.note,
      createdAt: payment.postedAt.toISOString(),
    })),
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

  const fetchLimit = limit + 5
  const payments = await prisma.payment.findMany({
    where: {
      companyId: company.id,
      ...(cursor ? { postedAt: { lt: new Date(cursor) } } : {}),
      OR: [
        { companyWithdrawalId: { not: null } },
        {
          walletType: 'COMPANY',
          movementType: { in: ['COMPANY_TO_SITE_TRANSFER', 'SITE_TO_COMPANY_TRANSFER'] },
        },
        { investorTransactionId: { not: null } },
        { expenseId: { not: null } },
        { partnerId: { not: null } },
      ],
    },
    orderBy: { postedAt: 'desc' },
    take: fetchLimit,
    include: {
      site: { select: { name: true } },
      companyWithdrawal: { select: { note: true } },
      partner: { select: { name: true } },
      investorTransaction: {
        select: {
          note: true,
          kind: true,
          investor: { select: { name: true } },
        },
      },
      expense: {
        select: {
          description: true,
          site: { select: { name: true } },
        },
      },
    },
  })

  const page = payments.slice(0, limit)
  const hasMore = payments.length > limit
  const nextCursor = hasMore && page.length > 0
    ? page[page.length - 1].postedAt.toISOString()
    : null

  const responseData = {
    activities: page.map((payment) => {
      if (payment.companyWithdrawalId) {
        return {
          id: payment.id,
          type: 'withdrawal' as const,
          amount: -Number(payment.amount),
          description: payment.note || payment.companyWithdrawal?.note || 'Company withdrawal',
          date: payment.postedAt.toISOString(),
        }
      }

      if (payment.walletType === 'COMPANY' && payment.movementType === 'COMPANY_TO_SITE_TRANSFER') {
        return {
          id: payment.id,
          type: 'site_fund' as const,
          amount: Number(payment.amount),
          description: `Fund allocated to ${payment.site?.name ?? 'site'}`,
          date: payment.postedAt.toISOString(),
        }
      }

      if (payment.walletType === 'COMPANY' && payment.movementType === 'SITE_TO_COMPANY_TRANSFER') {
        return {
          id: payment.id,
          type: 'site_fund' as const,
          amount: -Number(payment.amount),
          description: `Fund pulled from ${payment.site?.name ?? 'site'}`,
          date: payment.postedAt.toISOString(),
        }
      }

      if (payment.investorTransactionId) {
        const investorName = payment.investorTransaction?.investor?.name ?? 'Investor'

        return {
          id: payment.id,
          type: 'investor_tx' as const,
          amount: payment.movementType === 'INVESTOR_PRINCIPAL_IN'
            ? Number(payment.amount)
            : -Number(payment.amount),
          description: payment.movementType === 'INVESTOR_PRINCIPAL_IN'
            ? `${investorName} invested`
            : payment.movementType === 'INVESTOR_INTEREST'
              ? `Interest paid to ${investorName}`
              : `Returned to ${investorName}`,
          date: payment.postedAt.toISOString(),
        }
      }

      if (payment.partnerId) {
        return {
          id: payment.id,
          type: 'investor_tx' as const, // Using investor_tx or could use a new type
          amount: Number(payment.amount),
          description: `Capital from ${payment.partner?.name ?? 'Partner'}`,
          date: payment.postedAt.toISOString(),
        }
      }

      return {
        id: payment.id,
        type: 'expense' as const,
        amount: -Number(payment.amount),
        description: `${payment.expense?.description ?? 'Expense'} - ${payment.expense?.site?.name ?? 'site'}`,
        date: payment.postedAt.toISOString(),
      }
    }),
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
      where: { site: { companyId: company.id }, isDeleted: false },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        site: { select: { name: true } },
        vendor: { select: { name: true } },
      },
    }),
    prisma.expense.count({ where: { site: { companyId: company.id }, isDeleted: false } }),
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
      createdAt: e.createdAt.toISOString(),
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

  const partner = await prisma.$transaction(async (tx) => {
    const createdPartner = await tx.partner.create({
      data: {
        companyId: company.id,
        name: parsed.data.name,
        email: parsed.data.email,
        phone: parsed.data.phone,
        stakePercentage: parsed.data.stakePercentage,
      },
    })

    if (parsed.data.investmentAmount > 0) {
      await createLedgerEntry({
        companyId: company.id,
        walletType: 'COMPANY',
        direction: 'IN',
        movementType: 'PARTNER_CAPITAL_IN',
        amount: new Prisma.Decimal(parsed.data.investmentAmount),
        idempotencyKey: `partner-create:${createdPartner.id}:capital`,
        note: 'Initial partner capital',
        partnerId: createdPartner.id,
      }, tx)
    }

    return tx.partner.findUnique({
      where: { id: createdPartner.id },
      include: {
        ledgerEntries: {
          select: { amount: true, direction: true },
        },
      },
    })
  }, LEDGER_TX_OPTIONS)

  if (!partner) {
    return jsonError(c, 'Partner could not be created', 400) as any
  }

  await invalidatePartnerCaches(company.id)

  return jsonOk(c, {
    partner: {
      id: partner.id,
      name: partner.name,
      email: partner.email,
      phone: partner.phone,
      investmentAmount: sumDirectionalLedgerAmounts(partner.ledgerEntries),
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
    include: {
      partners: {
        include: {
          ledgerEntries: {
            select: { amount: true, direction: true },
          },
        },
      },
    },
  })
  if (!companyWithPartners) return jsonError(c, 'No company found', 404) as any

  const totalFund = await getCompanyPartnerFund(company.id)

  const responseData = {
    company: {
      id: companyWithPartners.id,
      name: companyWithPartners.name,
    },
    total_fund: totalFund,
    partners: companyWithPartners.partners.map(mapPartnerResponse),
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

  const partner = await prisma.$transaction(async (tx) => {
    const updatedPartner = await tx.partner.update({
      where: { id },
      data: {
        name: parsed.data.name,
        email: parsed.data.email,
        phone: parsed.data.phone,
        stakePercentage: parsed.data.stakePercentage,
      },
    })

    if (parsed.data.investmentAmount !== undefined) {
      const currentInvestment = await getPartnerPaidTotal(id, tx)
      const delta = parsed.data.investmentAmount - currentInvestment

      if (delta !== 0) {
        await createLedgerEntry({
          companyId: company.id,
          walletType: 'COMPANY',
          direction: delta > 0 ? 'IN' : 'OUT',
          movementType: delta > 0 ? 'PARTNER_CAPITAL_IN' : 'ADJUSTMENT',
          amount: new Prisma.Decimal(Math.abs(delta)),
          idempotencyKey: `partner-update:${id}:${Date.now()}`,
          note: delta > 0 ? 'Partner capital increased' : 'Partner capital adjusted down',
          partnerId: id,
        }, tx)
      }
    }

    return tx.partner.findUnique({
      where: { id: updatedPartner.id },
      include: {
        ledgerEntries: {
          select: { amount: true, direction: true },
        },
      },
    })
  }, LEDGER_TX_OPTIONS)

  if (!partner) {
    return jsonError(c, 'Partner not found', 404) as any
  }

  await invalidatePartnerCaches(company.id)

  return jsonOk(c, {
    partner: {
      id: partner.id,
      name: partner.name,
      email: partner.email,
      phone: partner.phone,
      investmentAmount: sumDirectionalLedgerAmounts(partner.ledgerEntries),
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

  const ledgerEntryCount = await prisma.payment.count({
    where: { partnerId: id },
  })
  if (ledgerEntryCount > 0) {
    return jsonError(c, 'Partner has financial history and cannot be deleted', 400) as any
  }

  await prisma.partner.delete({
    where: { id },
  })

  await invalidatePartnerCaches(company.id)

  return jsonOk(c, { message: `Partner ${existing.name} removed` }) as any
})


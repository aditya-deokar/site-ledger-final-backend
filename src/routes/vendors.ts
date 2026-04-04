import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../types/auth.js'
import { prisma } from '../db/prisma.js'
import { requireJwt } from '../middlewares/jwt.js'
import { jsonError, jsonOk } from '../utils/response.js'
import { getCompanyForUser } from '../utils/company.js'
import { invalidateVendorCaches } from '../services/cache-invalidation.js'
import { cacheService } from '../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../config/cache-keys.js'
import {
  buildVendorStatement,
  getVendorExpenseRecords,
  mapVendorBills,
  mapVendorPayments,
  summarizeVendorRecords,
} from '../services/vendor-accounting.service.js'

export const vendorRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()

vendorRoutes.use('*', requireJwt)

// ── Schemas ──────────────────────────────────────────

const vendorTypeSchema = z.string().trim().min(1)
const paymentStatusSchema = z.enum(['PENDING', 'PARTIAL', 'COMPLETED'])

const createVendorSchema = z.object({
  name: z.string().min(1),
  type: vendorTypeSchema,
  phone: z.string().optional(),
  email: z.string().email().optional(),
})

const updateVendorSchema = z.object({
  name: z.string().min(1).optional(),
  type: vendorTypeSchema.optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
})

const vendorResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  createdAt: z.string().datetime(),
})

const vendorSummarySchema = vendorResponseSchema.extend({
  totalExpenses: z.number(),
  totalBilled: z.number(),
  totalPaid: z.number(),
  totalOutstanding: z.number(),
  remainingBalance: z.number(),
  expenseCount: z.number(),
  billCount: z.number(),
})

const vendorBillSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  amount: z.number(),
  amountPaid: z.number(),
  remaining: z.number(),
  paymentDate: z.string().datetime().nullable(),
  paymentStatus: paymentStatusSchema,
  description: z.string().nullable(),
  reason: z.string().nullable(),
  siteName: z.string(),
  createdAt: z.string().datetime(),
  billDate: z.string().datetime(),
})

const vendorPaymentSchema = z.object({
  id: z.string(),
  expenseId: z.string(),
  expenseAmount: z.number(),
  amount: z.number(),
  note: z.string().nullable(),
  siteId: z.string(),
  siteName: z.string(),
  description: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string().datetime(),
  paymentDate: z.string().datetime(),
})

const vendorStatementEntrySchema = z.object({
  id: z.string(),
  entryType: z.enum(['BILL', 'PAYMENT']),
  referenceId: z.string(),
  expenseId: z.string(),
  date: z.string().datetime(),
  billAmount: z.number(),
  paymentAmount: z.number(),
  balance: z.number(),
  description: z.string().nullable(),
  reason: z.string().nullable(),
  note: z.string().nullable(),
  siteId: z.string(),
  siteName: z.string(),
})

const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})

async function getVendorForUser(vendorId: string, userId: string) {
  const company = await getCompanyForUser(userId)
  if (!company) return { company: null, vendor: null }

  const vendor = await prisma.vendor.findFirst({
    where: { id: vendorId, companyId: company.id, isDeleted: false },
  })

  return { company, vendor }
}

function mapVendorBase(vendor: {
  id: string
  name: string
  type: string
  phone: string | null
  email: string | null
  createdAt: Date
}) {
  return {
    id: vendor.id,
    name: vendor.name,
    type: vendor.type,
    phone: vendor.phone,
    email: vendor.email,
    createdAt: vendor.createdAt.toISOString(),
  }
}

// ── GET /vendors ─────────────────────────────────────

const getVendorsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Vendors'],
  summary: 'List vendors',
  description: 'Returns all vendors for the company. Optionally filter by vendor type using the ?type= query parameter (for expense form dropdowns).',
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      type: vendorTypeSchema.optional(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              vendors: z.array(vendorResponseSchema),
            }),
          }),
        },
      },
      description: 'List of vendors',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

vendorRoutes.openapi(getVendorsRoute, async (c) => {
  const auth = c.get('auth')
  const company = await getCompanyForUser(auth.userId)
  if (!company) return jsonError(c, 'No company found. Create one first.', 404) as any

  const { type } = c.req.valid('query')

  const cacheKey = `${CacheKeys.vendorList(company.id)}:${type ?? 'all'}`
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  const vendors = await prisma.vendor.findMany({
    where: {
      companyId: company.id,
      isDeleted: false,
      ...(type ? { type } : {}),
    },
    orderBy: { createdAt: 'desc' },
  })

  const responseData = {
    vendors: vendors.map(mapVendorBase),
  }
  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return jsonOk(c, responseData) as any
})

// ── POST /vendors ────────────────────────────────────

const createVendorRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Vendors'],
  summary: 'Create a vendor',
  description: 'Add a new vendor with name and any non-empty vendor type.',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: createVendorSchema } },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ vendor: vendorResponseSchema }),
          }),
        },
      },
      description: 'Vendor created',
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

vendorRoutes.openapi(createVendorRoute, async (c) => {
  const auth = c.get('auth')
  const body = await c.req.json().catch(() => null)
  const parsed = createVendorSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const company = await getCompanyForUser(auth.userId)
  if (!company) return jsonError(c, 'No company found. Create one first.', 404) as any

  const vendor = await prisma.vendor.create({
    data: {
      companyId: company.id,
      name: parsed.data.name,
      type: parsed.data.type,
      phone: parsed.data.phone,
      email: parsed.data.email,
    },
  })

  await invalidateVendorCaches(company.id)

  return jsonOk(c, {
    vendor: mapVendorBase(vendor),
  }, 201) as any
})

// ── PUT /vendors/:id ─────────────────────────────────

const updateVendorRoute = createRoute({
  method: 'put',
  path: '/{id}',
  tags: ['Vendors'],
  summary: 'Update a vendor',
  description: 'Update vendor details such as name, type, phone, or email.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { 'application/json': { schema: updateVendorSchema } },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ vendor: vendorResponseSchema }),
          }),
        },
      },
      description: 'Vendor updated',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Bad request',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Vendor not found',
    },
  },
})

vendorRoutes.openapi(updateVendorRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const body = await c.req.json().catch(() => null)
  const parsed = updateVendorSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const company = await getCompanyForUser(auth.userId)
  if (!company) return jsonError(c, 'No company found', 404) as any

  const existing = await prisma.vendor.findFirst({
    where: { id, companyId: company.id, isDeleted: false },
  })
  if (!existing) return jsonError(c, 'Vendor not found', 404) as any

  const vendor = await prisma.vendor.update({
    where: { id },
    data: parsed.data,
  })

  await invalidateVendorCaches(company.id, id)

  return jsonOk(c, {
    vendor: mapVendorBase(vendor),
  }) as any
})

// ── DELETE /vendors/:id ──────────────────────────────

const deleteVendorRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Vendors'],
  summary: 'Delete a vendor',
  description: 'Soft-delete a vendor. Existing expense records and ledger history remain available for reporting.',
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
      description: 'Vendor deleted',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Vendor not found',
    },
  },
})

vendorRoutes.openapi(deleteVendorRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')

  const company = await getCompanyForUser(auth.userId)
  if (!company) return jsonError(c, 'No company found', 404) as any

  const existing = await prisma.vendor.findFirst({
    where: { id, companyId: company.id, isDeleted: false },
  })
  if (!existing) return jsonError(c, 'Vendor not found', 404) as any

  await prisma.vendor.update({ 
    where: { id },
    data: { isDeleted: true }
  })

  await invalidateVendorCaches(company.id, id)

  return jsonOk(c, { message: `Vendor "${existing.name}" removed` }) as any
})

// ── GET /vendors/:id ────────────────────────────────

const getVendorRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Vendors'],
  summary: 'Get vendor summary',
  description: 'Returns ledger-based vendor accounting totals using expenses as bills and expense payments as vendor payments.',
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
              vendor: vendorSummarySchema,
            }),
          }),
        },
      },
      description: 'Vendor summary',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Vendor not found',
    },
  },
})

vendorRoutes.openapi(getVendorRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const { company, vendor } = await getVendorForUser(id, auth.userId)
  if (!company) return jsonError(c, 'No company found', 404) as any
  if (!vendor) return jsonError(c, 'Vendor not found', 404) as any

  const cacheKey = CacheKeys.vendorDetail(id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  const expenses = await getVendorExpenseRecords(vendor.id)
  const summary = summarizeVendorRecords(expenses)

  const responseData = {
    vendor: {
      ...mapVendorBase(vendor),
      totalExpenses: summary.totalBilled,
      totalBilled: summary.totalBilled,
      totalPaid: summary.totalPaid,
      totalOutstanding: summary.totalOutstanding,
      remainingBalance: summary.totalOutstanding,
      expenseCount: summary.billCount,
      billCount: summary.billCount,
    },
  }
  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_DETAIL)
  return jsonOk(c, responseData) as any
})

// ── GET /vendors/:id/transactions ───────────────────

const getVendorTransactionsRoute = createRoute({
  method: 'get',
  path: '/{id}/transactions',
  tags: ['Vendors'],
  summary: 'List vendor bills',
  description: 'Returns vendor bill documents backed by expenses, with paid totals and outstanding amounts derived from the ledger.',
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
              transactions: z.array(vendorBillSchema),
              totalBilled: z.number(),
              totalPaid: z.number(),
              totalOutstanding: z.number(),
              billCount: z.number(),
            }),
          }),
        },
      },
      description: 'Vendor bills list',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Vendor not found',
    },
  },
})

vendorRoutes.openapi(getVendorTransactionsRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const { company, vendor } = await getVendorForUser(id, auth.userId)
  if (!company) return jsonError(c, 'No company found', 404) as any
  if (!vendor) return jsonError(c, 'Vendor not found', 404) as any

  const cacheKey = CacheKeys.vendorTransactions(id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  const expenses = await getVendorExpenseRecords(vendor.id)
  const summary = summarizeVendorRecords(expenses)

  const responseData = {
    transactions: mapVendorBills(expenses),
    totalBilled: summary.totalBilled,
    totalPaid: summary.totalPaid,
    totalOutstanding: summary.totalOutstanding,
    billCount: summary.billCount,
  }
  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return jsonOk(c, responseData) as any
})

const getVendorPaymentsRoute = createRoute({
  method: 'get',
  path: '/{id}/payments',
  tags: ['Vendors'],
  summary: 'List vendor payments',
  description: 'Returns all payment ledger rows posted against this vendor\'s expenses.',
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
              payments: z.array(vendorPaymentSchema),
              totalPaid: z.number(),
              paymentCount: z.number(),
            }),
          }),
        },
      },
      description: 'Vendor payments list',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Vendor not found',
    },
  },
})

vendorRoutes.openapi(getVendorPaymentsRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const { company, vendor } = await getVendorForUser(id, auth.userId)
  if (!company) return jsonError(c, 'No company found', 404) as any
  if (!vendor) return jsonError(c, 'Vendor not found', 404) as any

  const cacheKey = CacheKeys.vendorPayments(id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  const expenses = await getVendorExpenseRecords(vendor.id)
  const payments = mapVendorPayments(expenses)

  const responseData = {
    payments,
    totalPaid: payments.reduce((sum, payment) => sum + payment.amount, 0),
    paymentCount: payments.length,
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return jsonOk(c, responseData) as any
})

const getVendorStatementRoute = createRoute({
  method: 'get',
  path: '/{id}/statement',
  tags: ['Vendors'],
  summary: 'Get vendor statement',
  description: 'Returns a chronological vendor ledger combining bill documents and expense payment rows with a running outstanding balance.',
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
              statement: z.array(vendorStatementEntrySchema),
              totalBilled: z.number(),
              totalPaid: z.number(),
              closingBalance: z.number(),
            }),
          }),
        },
      },
      description: 'Vendor statement',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Vendor not found',
    },
  },
})

vendorRoutes.openapi(getVendorStatementRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const { company, vendor } = await getVendorForUser(id, auth.userId)
  if (!company) return jsonError(c, 'No company found', 404) as any
  if (!vendor) return jsonError(c, 'Vendor not found', 404) as any

  const cacheKey = CacheKeys.vendorStatement(id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  const expenses = await getVendorExpenseRecords(vendor.id)
  const responseData = buildVendorStatement(expenses)

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return jsonOk(c, responseData) as any
})

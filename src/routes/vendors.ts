import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../types/auth.js'
import { prisma } from '../db/prisma.js'
import { requireJwt } from '../middlewares/jwt.js'
import { jsonError, jsonOk } from '../utils/response.js'
import { getCompanyForUser } from '../utils/company.js'
import { invalidateVendorCaches } from '../services/cache-invalidation.js'
import { cacheService } from '../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../config/cache-keys.js'

export const vendorRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()

vendorRoutes.use('*', requireJwt)

// ── Schemas ──────────────────────────────────────────

const vendorTypeEnum = z.enum(['ELECTRICIAN', 'PLUMBER', 'SUPPLIER', 'PAINTER', 'ARCHITECT'])

const createVendorSchema = z.object({
  name: z.string().min(1),
  type: vendorTypeEnum,
  phone: z.string().optional(),
  email: z.string().email().optional(),
})

const updateVendorSchema = z.object({
  name: z.string().min(1).optional(),
  type: vendorTypeEnum.optional(),
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

const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})

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
      type: vendorTypeEnum.optional(),
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
    vendors: vendors.map((v) => ({
      id: v.id,
      name: v.name,
      type: v.type,
      phone: v.phone,
      email: v.email,
      createdAt: v.createdAt,
    })),
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
  description: 'Add a new vendor with name and type (ELECTRICIAN, PLUMBER, SUPPLIER, PAINTER, ARCHITECT).',
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
    vendor: {
      id: vendor.id,
      name: vendor.name,
      type: vendor.type,
      phone: vendor.phone,
      email: vendor.email,
      createdAt: vendor.createdAt,
    },
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
    vendor: {
      id: vendor.id,
      name: vendor.name,
      type: vendor.type,
      phone: vendor.phone,
      email: vendor.email,
      createdAt: vendor.createdAt,
    },
  }) as any
})

// ── DELETE /vendors/:id ──────────────────────────────

const deleteVendorRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Vendors'],
  summary: 'Delete a vendor',
  description: 'Remove a vendor. Existing expense records linked to this vendor will retain their data but the vendor reference is set to null.',
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
  summary: 'Get vendor profile',
  description: 'Returns vendor details with total expenses paid and expense count across all sites.',
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
              vendor: vendorResponseSchema.extend({
                totalExpenses: z.number(),
                expenseCount: z.number(),
                totalPaid: z.number(),
                remainingBalance: z.number(),
              }),
            }),
          }),
        },
      },
      description: 'Vendor profile',
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

  const company = await getCompanyForUser(auth.userId)
  if (!company) return jsonError(c, 'No company found', 404) as any

  const vendor = await prisma.vendor.findFirst({
    where: { id, companyId: company.id, isDeleted: false },
  })
  if (!vendor) return jsonError(c, 'Vendor not found', 404) as any

  const cacheKey = CacheKeys.vendorDetail(id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  const expenseAgg = await prisma.expense.aggregate({
    where: { vendorId: vendor.id, isDeleted: false },
    _sum: { amount: true, amountPaid: true },
    _count: true,
  })

  const totalBilled = expenseAgg._sum.amount ?? 0
  const totalPaid = expenseAgg._sum.amountPaid ?? 0

  const responseData = {
    vendor: {
      id: vendor.id,
      name: vendor.name,
      type: vendor.type,
      phone: vendor.phone,
      email: vendor.email,
      createdAt: vendor.createdAt,
      totalExpenses: totalBilled,
      totalPaid: totalPaid,
      remainingBalance: totalBilled - totalPaid,
      expenseCount: expenseAgg._count,
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
  summary: 'List vendor transactions',
  description: 'Returns all expense records linked to this vendor across all sites, ordered by most recent first.',
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
              transactions: z.array(z.object({
                id: z.string(),
                amount: z.number(),
                amountPaid: z.number(),
                paymentDate: z.string().datetime().nullable(),
                paymentStatus: z.enum(['PENDING', 'PARTIAL', 'COMPLETED']),
                description: z.string().nullable(),
                reason: z.string().nullable(),
                siteName: z.string().nullable(),
                createdAt: z.string().datetime(),
              })),
              totalBilled: z.number(),
              totalPaid: z.number(),
            }),
          }),
        },
      },
      description: 'Vendor transaction history',
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

  const company = await getCompanyForUser(auth.userId)
  if (!company) return jsonError(c, 'No company found', 404) as any

  const vendor = await prisma.vendor.findFirst({
    where: { id, companyId: company.id, isDeleted: false },
  })
  if (!vendor) return jsonError(c, 'Vendor not found', 404) as any

  const cacheKey = CacheKeys.vendorTransactions(id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  const expenses = await prisma.expense.findMany({
    where: { vendorId: vendor.id, isDeleted: false },
    include: { site: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  })

  const totalBilled = expenses.reduce((sum, e) => sum + e.amount, 0)
  const totalPaid = expenses.reduce((sum, e) => sum + e.amountPaid, 0)

  const responseData = {
    transactions: expenses.map((e) => ({
      id: e.id,
      siteId: e.siteId,
      amount: e.amount,
      amountPaid: e.amountPaid,
      paymentDate: e.paymentDate?.toISOString() ?? null,
      paymentStatus: e.paymentStatus,
      description: e.description,
      reason: e.reason,
      siteName: e.site.name,
      createdAt: e.createdAt.toISOString(),
    })),
    totalBilled,
    totalPaid,
  }
  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return jsonOk(c, responseData) as any
})

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../types/auth.js'
import { prisma } from '../db/prisma.js'
import { requireJwt } from '../middlewares/jwt.js'
import { jsonError, jsonOk } from '../utils/response.js'
import { getCompanyForUser } from '../utils/company.js'
import { invalidateCustomerCaches } from '../services/cache-invalidation.js'
import { cacheService } from '../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../config/cache-keys.js'

export const customerRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()

customerRoutes.use('*', requireJwt)

// ── Schemas ──────────────────────────────────────────

const createCustomerSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  sellingPrice: z.number().positive(),
  bookingAmount: z.number().min(0),
  customerType: z.enum(['CUSTOMER', 'EXISTING_OWNER']).optional(),
})

const updateCustomerSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  amountPaid: z.number().min(0).optional(),
})

const customerResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  sellingPrice: z.number(),
  bookingAmount: z.number(),
  amountPaid: z.number(),
  remaining: z.number(),
  customerType: z.enum(['CUSTOMER', 'EXISTING_OWNER']).nullable(),
  flatId: z.string(),
  flatNumber: z.number(),
  floorNumber: z.number(),
  flatStatus: z.string(),
  customFlatId: z.string().nullable().optional(),
  floorName: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
})

const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})

// ── Helper: verify site belongs to user ──────────────

async function verifySiteOwnership(siteId: string, userId: string) {
  const company = await getCompanyForUser(userId)
  if (!company) return { company: null, site: null }
  const site = await prisma.site.findFirst({
    where: { id: siteId, companyId: company.id },
  })
  return { company, site }
}

// ── GET /customers (all company customers) ──────────

const getAllCustomersRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Customers'],
  summary: 'List all company customers',
  description: 'Returns all customers across all sites for the company, with their flat, floor, and site details.',
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      status: z.enum(['BOOKED', 'SOLD']).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              customers: z.array(z.object({
                id: z.string(),
                name: z.string(),
                phone: z.string().nullable(),
                email: z.string().nullable(),
                sellingPrice: z.number(),
                bookingAmount: z.number(),
                amountPaid: z.number(),
                remaining: z.number(),
                flatId: z.string().nullable(),
                flatNumber: z.number().nullable(),
                floorNumber: z.number().nullable(),
                flatStatus: z.string().nullable(),
                siteId: z.string().nullable(),
                siteName: z.string().nullable(),
                createdAt: z.string().datetime(),
              })),
            }),
          }),
        },
      },
      description: 'All company customers',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

customerRoutes.openapi(getAllCustomersRoute, async (c) => {
  const auth = c.get('auth')
  const company = await getCompanyForUser(auth.userId)
  if (!company) return jsonError(c, 'No company found. Create one first.', 404) as any

  const { status } = c.req.valid('query')

  const cacheKey = `${CacheKeys.customerList(company.id)}:${status ?? 'all'}`
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  const customers = await prisma.customer.findMany({
    where: {
      companyId: company.id,
      ...(status ? { flat: { status } } : {}),
    },
    include: {
      flat: { include: { floor: true } },
      site: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  const responseData = {
    customers: customers.map((cu) => ({
      id: cu.id,
      name: cu.name,
      phone: cu.phone,
      email: cu.email,
      sellingPrice: cu.sellingPrice,
      bookingAmount: cu.bookingAmount,
      amountPaid: cu.amountPaid,
      remaining: cu.sellingPrice - cu.amountPaid,
      flatId: cu.flatId,
      flatNumber: cu.flat?.flatNumber ?? null,
      floorNumber: cu.flat?.floor?.floorNumber ?? null,
      flatStatus: cu.flat?.status ?? null,
      siteId: cu.siteId,
      siteName: cu.site?.name ?? null,
      createdAt: cu.createdAt,
    })),
  }
  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return jsonOk(c, responseData) as any
})

// ── POST /sites/:siteId/flats/:flatId/customer ──────

const bookFlatRoute = createRoute({
  method: 'post',
  path: '/{siteId}/flats/{flatId}/customer',
  tags: ['Customers'],
  summary: 'Book a flat',
  description: 'Book an available flat for a customer. Creates a customer record, sets flat status to BOOKED (or SOLD if fully paid). Flat must be AVAILABLE.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ siteId: z.string(), flatId: z.string() }),
    body: {
      content: { 'application/json': { schema: createCustomerSchema } },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ customer: customerResponseSchema }),
          }),
        },
      },
      description: 'Flat booked',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Flat not available or bad request',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Site or flat not found',
    },
  },
})

customerRoutes.openapi(bookFlatRoute, async (c) => {
  const auth = c.get('auth')
  const { siteId, flatId } = c.req.valid('param')
  const body = await c.req.json().catch(() => null)
  const parsed = createCustomerSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const { company, site } = await verifySiteOwnership(siteId, auth.userId)
  if (!company || !site) return jsonError(c, 'Site not found', 404) as any

  const { name, phone, email, sellingPrice, bookingAmount } = parsed.data

  if (bookingAmount > sellingPrice) {
    return jsonError(c, 'Booking amount cannot exceed selling price', 400) as any
  }

  // Transaction: check flat is AVAILABLE, create customer, update flat status, create payment
  const result = await prisma.$transaction(async (tx: any) => {
    const flat = await tx.flat.findFirst({
      where: { id: flatId, siteId: site.id },
      include: { floor: true },
    })
    if (!flat) throw new Error('FLAT_NOT_FOUND')
    if (flat.status !== 'AVAILABLE') throw new Error('FLAT_NOT_AVAILABLE')

    const forcedCustomerType = flat.flatType === 'EXISTING_OWNER' ? 'EXISTING_OWNER' : 'CUSTOMER'

    const customer = await tx.customer.create({
      data: {
        flatId: flat.id,
        siteId: site.id,
        companyId: company.id,
        name,
        phone,
        email,
        sellingPrice,
        bookingAmount,
        amountPaid: bookingAmount,
        customerType: forcedCustomerType,
      },
    })

    if (bookingAmount > 0) {
      await tx.payment.create({
        data: {
          companyId: company.id,
          siteId: site.id,
          entityType: 'CUSTOMER',
          entityId: customer.id,
          amount: bookingAmount,
          note: 'Initial booking amount',
        },
      })
    }

    const newStatus = bookingAmount >= sellingPrice ? 'SOLD' as const : 'BOOKED' as const
    await tx.flat.update({
      where: { id: flat.id },
      data: { status: newStatus },
    })

    return {
      customer,
      flatNumber: flat.flatNumber,
      floorNumber: flat.floor.floorNumber,
      flatStatus: newStatus,
    }
  }).catch((err: any) => {
    if (err.message === 'FLAT_NOT_FOUND') return { error: 'Flat not found', status: 404 }
    if (err.message === 'FLAT_NOT_AVAILABLE') return { error: 'Flat is not available for booking', status: 400 }
    throw err
  })

  if ('error' in result) {
    return jsonError(c, result.error, result.status) as any
  }

  await invalidateCustomerCaches(company.id, siteId)
  await cacheService.del(CacheKeys.flatCustomer(flatId))

  return jsonOk(c, {
    customer: {
      id: result.customer.id,
      name: result.customer.name,
      phone: result.customer.phone,
      email: result.customer.email,
      sellingPrice: result.customer.sellingPrice,
      bookingAmount: result.customer.bookingAmount,
      amountPaid: result.customer.amountPaid,
      remaining: result.customer.sellingPrice - result.customer.amountPaid,
      customerType: result.customer.customerType,
      flatId: result.customer.flatId,
      flatNumber: result.flatNumber,
      floorNumber: result.floorNumber,
      flatStatus: result.flatStatus,
      createdAt: result.customer.createdAt,
    },
  }, 201) as any
})

// ── GET /sites/:siteId/customers ─────────────────────

const getSiteCustomersRoute = createRoute({
  method: 'get',
  path: '/{siteId}/customers',
  tags: ['Customers'],
  summary: 'List site customers',
  description: 'Returns all customers for a site with their flat details, payment status, and remaining balance.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ siteId: z.string() }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              customers: z.array(customerResponseSchema),
            }),
          }),
        },
      },
      description: 'List of customers',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Site not found',
    },
  },
})

customerRoutes.openapi(getSiteCustomersRoute, async (c) => {
  const auth = c.get('auth')
  const { siteId } = c.req.valid('param')
  const { site } = await verifySiteOwnership(siteId, auth.userId)
  if (!site) return jsonError(c, 'Site not found', 404) as any

  const cacheKey = CacheKeys.siteCustomers(site.id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  const customers = await prisma.customer.findMany({
    where: { siteId: site.id, isDeleted: false },
    include: {
      flat: { include: { floor: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  const responseData = {
    customers: customers.map((cu) => ({
      id: cu.id,
      name: cu.name,
      phone: cu.phone,
      email: cu.email,
      sellingPrice: cu.sellingPrice,
      bookingAmount: cu.bookingAmount,
      amountPaid: cu.amountPaid,
      remaining: cu.sellingPrice - cu.amountPaid,
      customerType: cu.customerType,
      flatId: cu.flatId,
      flatNumber: cu.flat!.flatNumber,
      floorNumber: cu.flat!.floor.floorNumber,
      customFlatId: cu.flat!.customFlatId ?? null,
      floorName: cu.flat!.floor.floorName ?? null,
      flatStatus: cu.flat!.status,
      createdAt: cu.createdAt,
    })),
  }
  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return jsonOk(c, responseData) as any
})

// ── GET /sites/:siteId/flats/:flatId/customer ────────

const getFlatCustomerRoute = createRoute({
  method: 'get',
  path: '/{siteId}/flats/{flatId}/customer',
  tags: ['Customers'],
  summary: 'Get customer for a flat',
  description: 'Returns the customer who has booked or purchased a specific flat.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ siteId: z.string(), flatId: z.string() }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ customer: customerResponseSchema }),
          }),
        },
      },
      description: 'Customer for flat',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Not found',
    },
  },
})

customerRoutes.openapi(getFlatCustomerRoute, async (c) => {
  const auth = c.get('auth')
  const { siteId, flatId } = c.req.valid('param')
  const { site } = await verifySiteOwnership(siteId, auth.userId)
  if (!site) return jsonError(c, 'Site not found', 404) as any

  const cacheKey = CacheKeys.flatCustomer(flatId)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  const customer = await prisma.customer.findFirst({
    where: { flatId, siteId: site.id, isDeleted: false },
    include: { flat: { include: { floor: true } } },
  })
  if (!customer) return jsonError(c, 'No customer found for this flat', 404) as any

  const responseData = {
    customer: {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      email: customer.email,
      sellingPrice: customer.sellingPrice,
      bookingAmount: customer.bookingAmount,
      amountPaid: customer.amountPaid,
      remaining: customer.sellingPrice - customer.amountPaid,
      customerType: customer.customerType,
      flatId: customer.flatId,
      flatNumber: customer.flat!.flatNumber,
      floorNumber: customer.flat!.floor.floorNumber,
      flatStatus: customer.flat!.status,
      createdAt: customer.createdAt,
    },
  }
  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_DETAIL)
  return jsonOk(c, responseData) as any
})

// ── PUT /sites/:siteId/flats/:flatId/customer/:id ───

const updateCustomerRoute = createRoute({
  method: 'put',
  path: '/{siteId}/flats/{flatId}/customer/{id}',
  tags: ['Customers'],
  summary: 'Update customer details',
  description: 'Update customer info or payment. If amountPaid reaches sellingPrice, flat status is automatically set to SOLD.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ siteId: z.string(), flatId: z.string(), id: z.string() }),
    body: {
      content: { 'application/json': { schema: updateCustomerSchema } },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ customer: customerResponseSchema }),
          }),
        },
      },
      description: 'Customer updated',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Bad request',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Customer not found',
    },
  },
})

customerRoutes.openapi(updateCustomerRoute, async (c) => {
  const auth = c.get('auth')
  const { siteId, flatId, id } = c.req.valid('param')
  const body = await c.req.json().catch(() => null)
  const parsed = updateCustomerSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const { site } = await verifySiteOwnership(siteId, auth.userId)
  if (!site) return jsonError(c, 'Site not found', 404) as any

  const existing = await prisma.customer.findFirst({
    where: { id, flatId, siteId: site.id },
  })
  if (!existing) return jsonError(c, 'Customer not found', 404) as any

  if (parsed.data.amountPaid !== undefined && parsed.data.amountPaid > existing.sellingPrice) {
    return jsonError(c, 'Amount paid cannot exceed selling price', 400) as any
  }

  // Transaction: update customer + auto-update flat status
  const result = await prisma.$transaction(async (tx) => {
    const customer = await tx.customer.update({
      where: { id },
      data: parsed.data,
      include: { flat: { include: { floor: true } } },
    })

    // Auto-update flat status based on payment
    let flatStatus = customer.flat!.status
    if (customer.amountPaid >= customer.sellingPrice && flatStatus !== 'SOLD') {
      await tx.flat.update({ where: { id: flatId }, data: { status: 'SOLD' } })
      flatStatus = 'SOLD'
    }

    return { customer, flatStatus }
  })

  const { company: updateCompany } = await verifySiteOwnership(siteId, auth.userId)
  if (updateCompany) await invalidateCustomerCaches(updateCompany.id, siteId)
  await cacheService.del(CacheKeys.flatCustomer(flatId))

  return jsonOk(c, {
    customer: {
      id: result.customer.id,
      name: result.customer.name,
      phone: result.customer.phone,
      email: result.customer.email,
      sellingPrice: result.customer.sellingPrice,
      bookingAmount: result.customer.bookingAmount,
      amountPaid: result.customer.amountPaid,
      remaining: result.customer.sellingPrice - result.customer.amountPaid,
      customerType: result.customer.customerType,
      flatId: result.customer.flatId,
      flatNumber: result.customer.flat!.flatNumber,
      floorNumber: result.customer.flat!.floor.floorNumber,
      flatStatus: result.flatStatus,
      createdAt: result.customer.createdAt,
    },
  }) as any
})

// ── DELETE /sites/:siteId/flats/:flatId/customer/:id ─

const cancelBookingRoute = createRoute({
  method: 'delete',
  path: '/{siteId}/flats/{flatId}/customer/{id}',
  tags: ['Customers'],
  summary: 'Cancel booking',
  description: 'Cancel a flat booking by removing the customer record. The flat status is reset to AVAILABLE.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ siteId: z.string(), flatId: z.string(), id: z.string() }),
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
      description: 'Booking cancelled',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Customer not found',
    },
  },
})

customerRoutes.openapi(cancelBookingRoute, async (c) => {
  const auth = c.get('auth')
  const { siteId, flatId, id } = c.req.valid('param')
  const { site } = await verifySiteOwnership(siteId, auth.userId)
  if (!site) return jsonError(c, 'Site not found', 404) as any

  const existing = await prisma.customer.findFirst({
    where: { id, flatId, siteId: site.id, isDeleted: false },
  })
  if (!existing) return jsonError(c, 'Customer not found', 404) as any

  // Transaction: soft delete customer + set flat back to AVAILABLE
  await prisma.$transaction(async (tx: any) => {
    await tx.customer.update({ 
      where: { id },
      data: { isDeleted: true, flatId: null } 
    })
    await tx.flat.update({
      where: { id: flatId },
      data: { status: 'AVAILABLE' },
    })
  })

  const { company: cancelCompany } = await verifySiteOwnership(siteId, auth.userId)
  if (cancelCompany) await invalidateCustomerCaches(cancelCompany.id, siteId)
  await cacheService.del(CacheKeys.flatCustomer(flatId))

  return jsonOk(c, { message: `Booking for "${existing.name}" cancelled. Flat is now available.` }) as any
})

// ── PATCH /customers/:id/payment ─────────────────────

const recordCustomerPaymentRoute = createRoute({
  method: 'patch',
  path: '/{id}/payment',
  tags: ['Customers'],
  summary: 'Record customer payment (additive)',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
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
              customer: z.object({ id: z.string(), amountPaid: z.number(), remaining: z.number() }),
              payment: z.object({ id: z.string(), amount: z.number(), createdAt: z.string().datetime() }),
            }),
          }),
        },
      },
      description: 'Payment recorded',
    },
    400: { content: { 'application/json': { schema: errorResponseSchema } }, description: 'Invalid payload' },
    404: { content: { 'application/json': { schema: errorResponseSchema } }, description: 'Customer not found' },
  },
})

customerRoutes.openapi(recordCustomerPaymentRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const { amount, note } = c.req.valid('json')

  const company = await getCompanyForUser(auth.userId)
  if (!company) return jsonError(c, 'Company not found', 404) as any

  const customer = await prisma.customer.findFirst({
    where: { id, companyId: company.id, isDeleted: false },
  })
  if (!customer) return jsonError(c, 'Customer not found', 404) as any

  const newTotal = customer.amountPaid + amount
  if (newTotal > customer.sellingPrice) {
    return jsonError(c, `Payment exceeds selling price. Remaining: ${customer.sellingPrice - customer.amountPaid}`, 400) as any
  }

  const result = await prisma.$transaction(async (tx: any) => {
    const payment = await tx.payment.create({
      data: {
        companyId: company.id,
        siteId: customer.siteId,
        entityType: 'CUSTOMER',
        entityId: id,
        amount,
        note: note || 'Installment payment',
      },
    })

    const updatedCustomer = await tx.customer.update({
      where: { id },
      data: { amountPaid: newTotal },
    })

    // If fully paid, ensure flat is SOLD
    if (newTotal >= customer.sellingPrice && customer.flatId) {
      await tx.flat.update({
        where: { id: customer.flatId },
        data: { status: 'SOLD' },
      })
    }

    return { payment, updatedCustomer }
  })

  await invalidateCustomerCaches(company.id, customer.siteId!)
  if (customer.flatId) await cacheService.del(CacheKeys.flatCustomer(customer.flatId))

  return jsonOk(c, {
    customer: {
      id: result.updatedCustomer.id,
      amountPaid: result.updatedCustomer.amountPaid,
      remaining: result.updatedCustomer.sellingPrice - result.updatedCustomer.amountPaid,
    },
    payment: {
      id: result.payment.id,
      amount: result.payment.amount,
      createdAt: result.payment.createdAt,
    },
  }) as any
})

// ── GET /customers/:id/payments ──────────────────────

const getCustomerPaymentsRoute = createRoute({
  method: 'get',
  path: '/{id}/payments',
  tags: ['Customers'],
  summary: 'Get customer payment history',
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
      description: 'Payment history',
    },
    404: { content: { 'application/json': { schema: errorResponseSchema } }, description: 'Customer not found' },
  },
})

customerRoutes.openapi(getCustomerPaymentsRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const company = await getCompanyForUser(auth.userId)
  if (!company) return jsonError(c, 'Company not found', 404) as any

  const customer = await prisma.customer.findFirst({
    where: { id, companyId: company.id, isDeleted: false },
  })
  if (!customer) return jsonError(c, 'Customer not found', 404) as any

  const payments = await prisma.payment.findMany({
    where: { entityType: 'CUSTOMER', entityId: id },
    orderBy: { createdAt: 'desc' },
  })

  return jsonOk(c, { payments }) as any
})


import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { requireJwt } from '../../middlewares/jwt.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import {
  cancelDealSchema,
  createCustomerSchema,
  customerResponseSchema,
  errorResponseSchema,
  insufficientFundsErrorResponseSchema,
  updateCustomerSchema,
} from './customers.schema.js'
import {
  bookFlatForUser,
  cancelDealForUser,
  cancelBookingForUser,
  getAllCustomersForUser,
  getFlatCustomerForUser,
  getSiteCustomersForUser,
  isCustomerServiceError,
  updateCustomerForUser,
} from './customers.service.js'
import { registerCustomerPaymentRoutes } from './customer-payments.routes.js'
import { registerCustomerAgreementRoutes } from './customer-agreement.routes.js'

export const customerRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()

customerRoutes.use('*', requireJwt)

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
              customers: z.array(
                z.object({
                  id: z.string(),
                  name: z.string(),
                  phone: z.string().nullable(),
                  email: z.string().nullable(),
                  sellingPrice: z.number(),
                  bookingAmount: z.number(),
                  amountPaid: z.number(),
                  remaining: z.number(),
                  dealStatus: z.enum(['ACTIVE', 'CANCELLED']),
                  flatId: z.string().nullable(),
                  flatNumber: z.number().nullable(),
                  floorNumber: z.number().nullable(),
                  flatStatus: z.string().nullable(),
                  customFlatId: z.string().nullable().optional(),
                  floorName: z.string().nullable().optional(),
                  wingId: z.string().nullable().optional(),
                  wingName: z.string().nullable().optional(),
                  unitType: z.string().nullable().optional(),
                  flatType: z.string().nullable().optional(),
                  cancelledAt: z.string().datetime().nullable(),
                  cancellationReason: z.string().nullable(),
                  cancelledByUserId: z.string().nullable(),
                  cancelledFromFlatStatus: z.enum(['AVAILABLE', 'BOOKED', 'SOLD']).nullable(),
                  cancelledFlatId: z.string().nullable(),
                  cancelledFlatDisplay: z.string().nullable(),
                  cancelledFloorNumber: z.number().nullable(),
                  cancelledFloorName: z.string().nullable(),
                  siteId: z.string().nullable(),
                  siteName: z.string().nullable(),
                  createdAt: z.string().datetime(),
                }),
              ),
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
  const { status } = c.req.valid('query')

  const result = await getAllCustomersForUser(auth.userId, status)
  if (isCustomerServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

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

  const result = await bookFlatForUser(siteId, flatId, auth.userId, parsed.data)
  if (isCustomerServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result, 201) as any
})

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

  const result = await getSiteCustomersForUser(siteId, auth.userId)
  if (isCustomerServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

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

  const result = await getFlatCustomerForUser(siteId, flatId, auth.userId)
  if (isCustomerServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

const updateCustomerRoute = createRoute({
  method: 'put',
  path: '/{siteId}/flats/{flatId}/customer/{id}',
  tags: ['Customers'],
  summary: 'Update customer details',
  description: 'Update customer info only. Paid amount and remaining are derived from the ledger, and flat status is recalculated from ledger-backed payments.',
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

  const result = await updateCustomerForUser(siteId, flatId, id, auth.userId, parsed.data)
  if (isCustomerServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

const cancelDealRoute = createRoute({
  method: 'patch',
  path: '/{siteId}/flats/{flatId}/customer/{id}/cancel',
  tags: ['Customers'],
  summary: 'Cancel deal and free the flat',
  description: 'Cancels an active flat deal, optionally records a partial or full refund, snapshots flat metadata for audit, and resets the flat to AVAILABLE.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ siteId: z.string(), flatId: z.string(), id: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: cancelDealSchema,
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
              customer: customerResponseSchema,
              refund: z.object({
                id: z.string(),
                amount: z.number(),
                direction: z.literal('OUT'),
                movementType: z.literal('CUSTOMER_REFUND'),
              }).nullable(),
              flat: z.object({
                id: z.string(),
                status: z.literal('AVAILABLE'),
              }),
            }),
          }),
        },
      },
      description: 'Deal cancelled and flat released',
    },
    400: {
      content: { 'application/json': { schema: insufficientFundsErrorResponseSchema } },
      description: 'Invalid cancel request or insufficient site funds',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Customer, flat, or site not found',
    },
  },
})

customerRoutes.openapi(cancelDealRoute, async (c) => {
  const auth = c.get('auth')
  const { siteId, flatId, id } = c.req.valid('param')
  const parsed = c.req.valid('json')

  const result = await cancelDealForUser(siteId, flatId, id, auth.userId, parsed)
  if (isCustomerServiceError(result)) {
    if (result.error === 'INSUFFICIENT_FUNDS') {
      return c.json(
        {
          ok: false,
          error: result.error,
          availableFund: result.availableFund,
          refundAmount: result.refundAmount,
          shortfall: result.shortfall,
        },
        result.status as any,
      )
    }

    return jsonError(c, result.error, result.status) as any
  }

  return jsonOk(c, result) as any
})

const cancelBookingRoute = createRoute({
  method: 'delete',
  path: '/{siteId}/flats/{flatId}/customer/{id}',
  tags: ['Customers'],
  summary: 'Cancel booking (legacy compatibility)',
  description: 'Legacy compatibility endpoint. Cancels an active flat deal with a full refund and resets the flat to AVAILABLE.',
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
    400: {
      content: { 'application/json': { schema: insufficientFundsErrorResponseSchema } },
      description: 'Insufficient site funds to refund the customer',
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

  const result = await cancelBookingForUser(siteId, flatId, id, auth.userId)
  if (isCustomerServiceError(result)) {
    if (result.error === 'INSUFFICIENT_FUNDS') {
      return c.json(
        {
          ok: false,
          error: result.error,
          availableFund: result.availableFund,
          refundAmount: result.refundAmount,
          shortfall: result.shortfall,
        },
        result.status as any,
      )
    }

    return jsonError(c, result.error, result.status) as any
  }

  return jsonOk(c, result) as any
})

registerCustomerPaymentRoutes(customerRoutes)
registerCustomerAgreementRoutes(customerRoutes)

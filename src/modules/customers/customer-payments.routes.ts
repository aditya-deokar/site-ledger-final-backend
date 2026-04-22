import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import {
  customerPaymentHistoryItemSchema,
  customerPaymentSchema,
  errorResponseSchema,
  paymentModeSchema,
} from './customers.schema.js'
import { getCustomerPaymentsForUser, recordCustomerPaymentForUser } from './customer-payments.service.js'
import { isCustomerServiceError } from './customers.service.js'

type CustomerRouteApp = OpenAPIHono<{ Variables: AuthContext['Variables'] }>

export function registerCustomerPaymentRoutes(customerRoutes: CustomerRouteApp) {
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
            schema: customerPaymentSchema,
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
                payment: z.object({
                  id: z.string(),
                  amount: z.number(),
                  paymentMode: paymentModeSchema.nullable(),
                  referenceNumber: z.string().nullable(),
                  note: z.string().nullable(),
                  createdAt: z.string().datetime(),
                }),
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
    const parsed = c.req.valid('json')

    const result = await recordCustomerPaymentForUser(id, auth.userId, parsed)
    if (isCustomerServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
  })

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
                payments: z.array(customerPaymentHistoryItemSchema),
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

    const result = await getCustomerPaymentsForUser(id, auth.userId)
    if (isCustomerServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
  })
}

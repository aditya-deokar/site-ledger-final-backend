import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { requireJwt } from '../../middlewares/jwt.js'
import type { AuthContext } from '../../types/auth.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import {
  errorResponseSchema,
  paymentReceiptSchema,
  reversePaymentResponseSchema,
  reversePaymentSchema,
} from './payments.schema.js'
import {
  getPaymentReceiptForUser,
  isPaymentServiceError,
  reversePaymentForUser,
} from './payments.service.js'

export const paymentRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()

paymentRoutes.use('*', requireJwt)

const getPaymentReceiptRoute = createRoute({
  method: 'get',
  path: '/{id}/receipt',
  tags: ['Payments'],
  summary: 'Get immutable payment receipt snapshot',
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
              receipt: paymentReceiptSchema,
            }),
          }),
        },
      },
      description: 'Receipt snapshot',
    },
    404: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Payment or receipt not found',
    },
  },
})

paymentRoutes.openapi(getPaymentReceiptRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')

  const result = await getPaymentReceiptForUser(id, auth.userId)
  if (isPaymentServiceError(result)) {
    return jsonError(c, result.error, result.status) as any
  }

  return jsonOk(c, result) as any
})

const reversePaymentRoute = createRoute({
  method: 'post',
  path: '/{id}/reverse',
  tags: ['Payments'],
  summary: 'Reverse a ledger payment entry',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: reversePaymentSchema,
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
            data: reversePaymentResponseSchema,
          }),
        },
      },
      description: 'Payment reversed',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid reversal request',
    },
    404: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Payment not found',
    },
  },
})

paymentRoutes.openapi(reversePaymentRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const parsed = c.req.valid('json')

  const result = await reversePaymentForUser(id, auth.userId, parsed)
  if (isPaymentServiceError(result)) {
    return jsonError(c, result.error, result.status) as any
  }

  return jsonOk(c, result) as any
})

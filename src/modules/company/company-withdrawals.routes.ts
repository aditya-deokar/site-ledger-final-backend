import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import {
  errorResponseSchema,
  withdrawalPaymentSchema,
  withdrawalResponseSchema,
  withdrawSchema,
} from './company.schema.js'
import {
  addCompanyWithdrawalPaymentForUser,
  createCompanyWithdrawalForUser,
  getCompanyWithdrawalDetailForUser,
  getCompanyWithdrawalPaymentsForUser,
  getCompanyWithdrawalsForUser,
} from './company-withdrawals.service.js'
import { isCompanyServiceError } from './company.service.js'

type CompanyRouteApp = OpenAPIHono<{ Variables: AuthContext['Variables'] }>

export function registerCompanyWithdrawalRoutes(companyRoutes: CompanyRouteApp) {
  const companyWithdrawRoute = createRoute({
    method: 'post',
    path: '/withdraw',
    tags: ['Company'],
    summary: 'Withdraw from company available fund',
    description:
      'Pull money out of the company available fund (e.g., owner payout, operational expenses). Validated: amount must not exceed available fund. Creates a record in company withdrawals.',
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

    const result = await createCompanyWithdrawalForUser(auth.userId, parsed.data)
    if (isCompanyServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
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
    const result = await getCompanyWithdrawalsForUser(auth.userId)
    if (isCompanyServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
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

    const result = await getCompanyWithdrawalDetailForUser(id, auth.userId)
    if (isCompanyServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
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
    const parsed = c.req.valid('json')

    const result = await addCompanyWithdrawalPaymentForUser(id, auth.userId, parsed)
    if (isCompanyServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
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
                payments: z.array(
                  z.object({
                    id: z.string(),
                    amount: z.number(),
                    note: z.string().nullable(),
                    createdAt: z.string().datetime(),
                  }),
                ),
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

    const result = await getCompanyWithdrawalPaymentsForUser(id, auth.userId)
    if (isCompanyServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
  })
}

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import { createExpenseSchema, errorResponseSchema } from './sites.schema.js'
import {
  createExpenseForUser,
  deleteExpenseForUser,
  getExpensePaymentsForUser,
  getExpensesForUser,
  getExpensesSummaryForUser,
  updateExpensePaymentForUser,
} from './site-expenses.service.js'

type SiteRouteApp = OpenAPIHono<{ Variables: AuthContext['Variables'] }>

const updateExpensePaymentSchema = z.object({
  amount: z.number().positive(),
  note: z.string().optional(),
  idempotencyKey: z.string().optional(),
})

function isExpenseRouteErrorResult(result: unknown): result is { error: string; status: number } {
  return (
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    typeof result.error === 'string' &&
    'status' in result &&
    typeof result.status === 'number'
  )
}

export function registerSiteExpenseRoutes(siteRoutes: SiteRouteApp) {
  const getExpensesRoute = createRoute({
    method: 'get',
    path: '/{id}/expenses',
    tags: ['Expenses'],
    summary: 'List site expenses',
    description: 'Returns all expenses for a site, including vendor name and type for vendor-linked expenses.',
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
                expenses: z.array(
                  z.object({
                    id: z.string(),
                    type: z.string(),
                    reason: z.string().nullable(),
                    vendorId: z.string().nullable(),
                    vendorName: z.string().nullable(),
                    vendorType: z.string().nullable(),
                    description: z.string().nullable(),
                    amount: z.number(),
                    amountPaid: z.number(),
                    remaining: z.number(),
                    paymentDate: z.string().datetime().nullable(),
                    paymentStatus: z.enum(['PENDING', 'PARTIAL', 'COMPLETED']),
                    createdAt: z.string().datetime(),
                  }),
                ),
              }),
            }),
          },
        },
        description: 'List of expenses',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Site not found',
      },
    },
  })

  siteRoutes.openapi(getExpensesRoute, async (c) => {
    const auth = c.get('auth')
    const { id } = c.req.valid('param')

    const responseData = await getExpensesForUser(id, auth.userId)
    if (!responseData) return jsonError(c, 'Site not found', 404) as any

    return jsonOk(c, responseData) as any
  })

  const getExpensesSummaryRoute = createRoute({
    method: 'get',
    path: '/{id}/expenses/summary',
    tags: ['Expenses'],
    summary: 'Get expense summary',
    description: 'Returns aggregated expense data: total expenses and breakdown by type (GENERAL vs VENDOR).',
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
                totalExpenses: z.number(),
                breakdown: z.array(
                  z.object({
                    type: z.string(),
                    total: z.number(),
                  }),
                ),
              }),
            }),
          },
        },
        description: 'Expense summary',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Site not found',
      },
    },
  })

  siteRoutes.openapi(getExpensesSummaryRoute, async (c) => {
    const auth = c.get('auth')
    const { id } = c.req.valid('param')

    const responseData = await getExpensesSummaryForUser(id, auth.userId)
    if (!responseData) return jsonError(c, 'Site not found', 404) as any

    return jsonOk(c, responseData) as any
  })

  const createExpenseRoute = createRoute({
    method: 'post',
    path: '/{id}/expenses',
    tags: ['Expenses'],
    summary: 'Add an expense',
    description: 'Record a general or vendor expense against a site. For VENDOR type, vendorId is required.',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: { 'application/json': { schema: createExpenseSchema } },
      },
    },
    responses: {
      201: {
        content: {
          'application/json': {
            schema: z.object({
              ok: z.literal(true),
              data: z.object({
                expense: z.object({
                  id: z.string(),
                  type: z.string(),
                  reason: z.string().nullable(),
                  vendorId: z.string().nullable(),
                  description: z.string().nullable(),
                  amount: z.number(),
                  amountPaid: z.number(),
                  remaining: z.number(),
                  paymentDate: z.string().datetime().nullable(),
                  paymentStatus: z.enum(['PENDING', 'PARTIAL', 'COMPLETED']),
                  createdAt: z.string().datetime(),
                }),
                siteRemainingFund: z.number(),
              }),
            }),
          },
        },
        description: 'Expense added',
      },
      400: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Bad request',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Site not found',
      },
    },
  })

  siteRoutes.openapi(createExpenseRoute, async (c) => {
    const auth = c.get('auth')
    const { id } = c.req.valid('param')
    const body = await c.req.json().catch(() => null)
    const parsed = createExpenseSchema.safeParse(body)
    if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

    const result = await createExpenseForUser(id, auth.userId, parsed.data)
    if (!result) return jsonError(c, 'Site not found', 404) as any
    if (isExpenseRouteErrorResult(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result, 201) as any
  })

  const updateExpensePaymentRoute = createRoute({
    method: 'patch',
    path: '/{id}/expenses/{expenseId}/payment',
    tags: ['Expenses'],
    summary: 'Record a payment against an expense (additive)',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string(), expenseId: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: updateExpensePaymentSchema,
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
                expense: z.object({
                  id: z.string(),
                  amountPaid: z.number(),
                  remaining: z.number(),
                  paymentStatus: z.string(),
                }),
                payment: z.object({
                  id: z.string(),
                  amount: z.number(),
                  createdAt: z.string().datetime(),
                }),
              }),
            }),
          },
        },
        description: 'Payment recorded',
      },
      400: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Invalid payload',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Expense not found',
      },
    },
  })

  siteRoutes.openapi(updateExpensePaymentRoute, async (c) => {
    const auth = c.get('auth')
    const { id, expenseId } = c.req.valid('param')
    const parsed = c.req.valid('json')

    const result = await updateExpensePaymentForUser(id, expenseId, auth.userId, parsed)
    if (!result) return jsonError(c, 'Site not found', 404) as any
    if (isExpenseRouteErrorResult(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
  })

  const getExpensePaymentsRoute = createRoute({
    method: 'get',
    path: '/{id}/expenses/{expenseId}/payments',
    tags: ['Payments'],
    summary: 'Get payment history for an expense',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string(), expenseId: z.string() }),
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
                    direction: z.enum(['IN', 'OUT']),
                    movementType: z.string(),
                    reversalOfPaymentId: z.string().nullable(),
                    note: z.string().nullable(),
                    createdAt: z.string().datetime(),
                  }),
                ),
              }),
            }),
          },
        },
        description: 'Payment history',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Not found',
      },
    },
  })

  siteRoutes.openapi(getExpensePaymentsRoute, async (c) => {
    const auth = c.get('auth')
    const { id, expenseId } = c.req.valid('param')

    const responseData = await getExpensePaymentsForUser(id, expenseId, auth.userId)
    if (!responseData) return jsonError(c, 'Site not found', 404) as any

    return jsonOk(c, responseData) as any
  })

  const deleteExpenseRoute = createRoute({
    method: 'delete',
    path: '/{id}/expenses/{expenseId}',
    tags: ['Expenses'],
    summary: 'Soft-delete an expense',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string(), expenseId: z.string() }),
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
        description: 'Expense soft-deleted',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Expense not found',
      },
    },
  })

  siteRoutes.openapi(deleteExpenseRoute, async (c) => {
    const auth = c.get('auth')
    const { id, expenseId } = c.req.valid('param')

    const result = await deleteExpenseForUser(id, expenseId, auth.userId)
    if (!result) return jsonError(c, 'Site not found', 404) as any
    if (isExpenseRouteErrorResult(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
  })
}

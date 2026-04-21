import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import {
  addTransactionSchema,
  errorResponseSchema,
  investorResponseSchema,
  investorTransactionKindEnum,
  paymentHistoryItemSchema,
  paymentStatusEnum,
  transactionResponseSchema,
  updateTransactionPaymentSchema,
} from './investors.schema.js'
import {
  addPrincipalForUser,
  getTransactionPaymentsForUser,
  getTransactionsForUser,
  payInterestForUser,
  returnInvestmentForUser,
  updateTransactionPaymentForUser,
} from './investor-transactions.service.js'

type InvestorRouteApp = OpenAPIHono<{ Variables: AuthContext['Variables'] }>

function isInvestorServiceError(result: unknown): result is { error: string; status: number } {
  return (
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    typeof result.error === 'string' &&
    'status' in result &&
    typeof result.status === 'number'
  )
}

export function registerInvestorTransactionRoutes(investorRoutes: InvestorRouteApp) {
  const addTransactionRoute = createRoute({
    method: 'post',
    path: '/{id}/transactions',
    tags: ['Investors'],
    summary: 'Add investment amount',
    description:
      'Create a principal-in transaction for an investor. If an initial paid amount is provided, a ledger entry is posted immediately.',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: addTransactionSchema } } },
    },
    responses: {
      201: {
        content: {
          'application/json': {
            schema: z.object({
              ok: z.literal(true),
              data: z.object({
                transaction: transactionResponseSchema,
                investor: investorResponseSchema,
              }),
            }),
          },
        },
        description: 'Transaction recorded and funds updated',
      },
      400: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Invalid input',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Investor not found',
      },
    },
  })

  investorRoutes.openapi(addTransactionRoute, async (c) => {
    const auth = c.get('auth')
    const { id } = c.req.valid('param')
    const body = await c.req.json().catch(() => null)
    const parsed = addTransactionSchema.safeParse(body)
    if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

    const result = await addPrincipalForUser(id, auth.userId, parsed.data)
    if (!result) return jsonError(c, 'Investor not found', 404) as any
    if (isInvestorServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result, 201) as any
  })

  const returnInvestmentRoute = createRoute({
    method: 'post',
    path: '/{id}/return',
    tags: ['Investors'],
    summary: 'Return principal to fixed-rate investor',
    description:
      'Record a principal return to a FIXED_RATE investor (partial or full). Equity investors should use the profit payout route instead of principal return.',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: addTransactionSchema } } },
    },
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.object({
              ok: z.literal(true),
              data: z.object({
                transaction: transactionResponseSchema,
                investor: investorResponseSchema,
              }),
            }),
          },
        },
        description: 'Return recorded and funds updated',
      },
      400: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Return exceeds invested amount or available fund',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Investor not found',
      },
    },
  })

  investorRoutes.openapi(returnInvestmentRoute, async (c) => {
    const auth = c.get('auth')
    const { id } = c.req.valid('param')
    const body = await c.req.json().catch(() => null)
    const parsed = addTransactionSchema.safeParse(body)
    if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

    const result = await returnInvestmentForUser(id, auth.userId, parsed.data)
    if (!result) return jsonError(c, 'Investor not found', 404) as any
    if (isInvestorServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
  })

  const payInterestRoute = createRoute({
    method: 'post',
    path: '/{id}/interest',
    tags: ['Investors'],
    summary: 'Record investor payout',
    description:
      "Record a payout for an investor. FIXED_RATE investors receive interest; EQUITY investors receive profit share. The payout reduces the relevant wallet balance without reducing principal.",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: addTransactionSchema } } },
    },
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.object({
              ok: z.literal(true),
              data: z.object({
                transaction: transactionResponseSchema,
                investor: investorResponseSchema,
              }),
            }),
          },
        },
        description: 'Interest paid',
      },
      400: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Invalid payout or insufficient funds',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Investor not found',
      },
    },
  })

  investorRoutes.openapi(payInterestRoute, async (c) => {
    const auth = c.get('auth')
    const { id } = c.req.valid('param')
    const body = await c.req.json().catch(() => null)
    const parsed = addTransactionSchema.safeParse(body)
    if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

    const result = await payInterestForUser(id, auth.userId, parsed.data)
    if (!result) return jsonError(c, 'Investor not found', 404) as any
    if (isInvestorServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
  })

  const getTransactionsRoute = createRoute({
    method: 'get',
    path: '/{id}/transactions',
    tags: ['Investors'],
    summary: 'List investor transactions',
    description: 'Returns all investment transactions for an investor in descending order.',
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
                transactions: z.array(transactionResponseSchema),
                totalInvested: z.number(),
                totalReturned: z.number(),
                interestPaid: z.number(),
                outstandingPrincipal: z.number(),
              }),
            }),
          },
        },
        description: 'Transaction history',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Investor not found',
      },
    },
  })

  investorRoutes.openapi(getTransactionsRoute, async (c) => {
    const auth = c.get('auth')
    const { id } = c.req.valid('param')

    const responseData = await getTransactionsForUser(id, auth.userId)
    if (!responseData) return jsonError(c, 'Investor not found', 404) as any

    return jsonOk(c, responseData) as any
  })

  const updateTransactionPaymentRoute = createRoute({
    method: 'patch',
    path: '/{id}/transactions/{transactionId}/payment',
    tags: ['Investors'],
    summary: 'Record a payment against an investor transaction (additive)',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string(), transactionId: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: updateTransactionPaymentSchema,
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
                transaction: z.object({
                  id: z.string(),
                  kind: investorTransactionKindEnum,
                  amountPaid: z.number(),
                  remaining: z.number(),
                  paymentStatus: paymentStatusEnum,
                }),
                payment: z.object({ id: z.string(), amount: z.number(), createdAt: z.string().datetime() }),
              }),
            }),
          },
        },
        description: 'Payment recorded',
      },
      400: { content: { 'application/json': { schema: errorResponseSchema } }, description: 'Invalid payload' },
      404: { content: { 'application/json': { schema: errorResponseSchema } }, description: 'Transaction not found' },
    },
  })

  investorRoutes.openapi(updateTransactionPaymentRoute, async (c) => {
    const auth = c.get('auth')
    const { id, transactionId } = c.req.valid('param')
    const parsed = c.req.valid('json')

    const result = await updateTransactionPaymentForUser(id, transactionId, auth.userId, parsed)
    if (!result) return jsonError(c, 'Investor not found', 404) as any
    if (isInvestorServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
  })

  const getTransactionPaymentsRoute = createRoute({
    method: 'get',
    path: '/{id}/transactions/{transactionId}/payments',
    tags: ['Payments'],
    summary: 'Get payment history for an investor transaction',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string(), transactionId: z.string() }),
    },
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.object({
              ok: z.literal(true),
              data: z.object({
                payments: z.array(paymentHistoryItemSchema),
              }),
            }),
          },
        },
        description: 'Payment history',
      },
      404: { content: { 'application/json': { schema: errorResponseSchema } }, description: 'Not found' },
    },
  })

  investorRoutes.openapi(getTransactionPaymentsRoute, async (c) => {
    const auth = c.get('auth')
    const { id, transactionId } = c.req.valid('param')

    const result = await getTransactionPaymentsForUser(id, transactionId, auth.userId)
    if (!result) return jsonError(c, 'Investor not found', 404) as any
    if (isInvestorServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
  })
}

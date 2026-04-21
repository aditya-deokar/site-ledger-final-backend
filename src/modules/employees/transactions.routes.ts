import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { requireJwt } from '../../middlewares/jwt.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import {
  createEmployeeTransactionSchema,
  employeeTransactionQuerySchema,
  employeeTransactionResponseSchema,
  errorResponseSchema,
  updateEmployeeTransactionStatusSchema,
} from './employees.schema.js'
import {
  createEmployeeTransactionForUser,
  getEmployeeTransactionsForUser,
  updateEmployeeTransactionStatusForUser,
} from './transactions.service.js'
import { isEmployeeServiceError } from './employees.service.js'

export const employeeTransactionRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()

employeeTransactionRoutes.use('*', requireJwt)

const createTransactionRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Employee Transactions'],
  summary: 'Create employee transaction',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: createEmployeeTransactionSchema } } },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ transaction: employeeTransactionResponseSchema }),
          }),
        },
      },
      description: 'Transaction created',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Employee not found',
    },
  },
})

employeeTransactionRoutes.openapi(createTransactionRoute, async (c) => {
  const auth = c.get('auth')
  const payload = c.req.valid('json')

  const result = await createEmployeeTransactionForUser(auth.userId, payload)
  if (isEmployeeServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result, 201) as any
})

const listTransactionsRoute = createRoute({
  method: 'get',
  path: '/{employeeId}',
  tags: ['Employee Transactions'],
  summary: 'Get employee transaction history',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ employeeId: z.string() }),
    query: employeeTransactionQuerySchema,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              transactions: z.array(employeeTransactionResponseSchema),
              summary: z.object({
                totalPaid: z.number(),
                totalDeducted: z.number(),
                netAmount: z.number(),
                pendingAmount: z.number(),
              }),
              period: z.object({
                startDate: z.string().datetime().nullable(),
                endDate: z.string().datetime().nullable(),
              }),
            }),
          }),
        },
      },
      description: 'Transaction history and summary',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Employee not found',
    },
  },
})

employeeTransactionRoutes.openapi(listTransactionsRoute, async (c) => {
  const auth = c.get('auth')
  const { employeeId } = c.req.valid('param')
  const filters = c.req.valid('query')

  const result = await getEmployeeTransactionsForUser(employeeId, auth.userId, filters)
  if (!result) return jsonError(c, 'Employee not found', 404) as any

  return jsonOk(c, result) as any
})

const updateTransactionStatusRoute = createRoute({
  method: 'put',
  path: '/{id}/status',
  tags: ['Employee Transactions'],
  summary: 'Update employee transaction status',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: updateEmployeeTransactionStatusSchema } } },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              transaction: employeeTransactionResponseSchema,
              statusTransition: z.object({
                previous: z.string(),
                current: z.string(),
              }),
            }),
          }),
        },
      },
      description: 'Transaction status updated',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Transaction not found',
    },
  },
})

employeeTransactionRoutes.openapi(updateTransactionStatusRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const payload = c.req.valid('json')

  const result = await updateEmployeeTransactionStatusForUser(id, auth.userId, payload)
  if (!result) return jsonError(c, 'Transaction not found', 404) as any

  return jsonOk(c, result) as any
})

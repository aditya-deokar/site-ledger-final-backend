import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { requireJwt } from '../../middlewares/jwt.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import {
  employeeTransactionResponseSchema,
  errorResponseSchema,
  paySalarySchema,
} from './employees.schema.js'
import { isEmployeeServiceError } from './employees.service.js'
import { paySalaryForEmployee } from './salary-payment.service.js'

export const salaryPaymentRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()

salaryPaymentRoutes.use('*', requireJwt)

const paySalaryRoute = createRoute({
  method: 'post',
  path: '/{id}/pay-salary',
  tags: ['Employees'],
  summary: 'Pay employee salary (deducts from company fund)',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: paySalarySchema } } },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              transaction: employeeTransactionResponseSchema,
              availableFund: z.number(),
            }),
          }),
        },
      },
      description: 'Salary paid successfully',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Insufficient funds or invalid input',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Employee or company not found',
    },
  },
})

salaryPaymentRoutes.openapi(paySalaryRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const payload = c.req.valid('json')

  const result = await paySalaryForEmployee(id, auth.userId, payload)
  if (isEmployeeServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { requireJwt } from '../../middlewares/jwt.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import {
  errorResponseSchema,
  generateSalaryRemindersSchema,
  markReminderPaidSchema,
  salaryReminderQuerySchema,
  salaryReminderResponseSchema,
} from './employees.schema.js'
import {
  generateSalaryRemindersForUser,
  getSalaryRemindersForUser,
  markSalaryReminderPaidForUser,
} from './reminders.service.js'
import { isEmployeeServiceError } from './employees.service.js'

export const salaryReminderRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()

salaryReminderRoutes.use('*', requireJwt)

const listRemindersRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Salary Reminders'],
  summary: 'Get salary reminders',
  security: [{ bearerAuth: [] }],
  request: {
    query: salaryReminderQuerySchema,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              reminders: z.array(salaryReminderResponseSchema),
              summary: z.object({
                totalPending: z.number(),
                totalAmount: z.number(),
                overdueCount: z.number(),
              }),
            }),
          }),
        },
      },
      description: 'Salary reminders list',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

salaryReminderRoutes.openapi(listRemindersRoute, async (c) => {
  const auth = c.get('auth')
  const filters = c.req.valid('query')

  const result = await getSalaryRemindersForUser(auth.userId, filters)
  if (isEmployeeServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

const generateRemindersRoute = createRoute({
  method: 'post',
  path: '/generate',
  tags: ['Salary Reminders'],
  summary: 'Generate monthly salary reminders',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: generateSalaryRemindersSchema } } },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              reminders: z.array(salaryReminderResponseSchema),
              created: z.number(),
            }),
          }),
        },
      },
      description: 'Reminders generated',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

salaryReminderRoutes.openapi(generateRemindersRoute, async (c) => {
  const auth = c.get('auth')
  const payload = c.req.valid('json')

  const result = await generateSalaryRemindersForUser(auth.userId, payload)
  if (isEmployeeServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

const markReminderPaidRoute = createRoute({
  method: 'put',
  path: '/{id}/paid',
  tags: ['Salary Reminders'],
  summary: 'Mark salary reminder as paid',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: markReminderPaidSchema } } },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              reminder: salaryReminderResponseSchema,
            }),
          }),
        },
      },
      description: 'Reminder marked as paid',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Reminder not found',
    },
  },
})

salaryReminderRoutes.openapi(markReminderPaidRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const payload = c.req.valid('json')

  const result = await markSalaryReminderPaidForUser(id, auth.userId, payload)
  if (!result) return jsonError(c, 'Reminder not found', 404) as any
  if (isEmployeeServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { requireJwt } from '../../middlewares/jwt.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import {
  attendanceHistoryQuerySchema,
  attendanceResponseSchema,
  errorResponseSchema,
  markAttendanceSchema,
  monthlyAttendanceSummarySchema,
} from './employees.schema.js'
import {
  getAttendanceForEmployeeForUser,
  getTodayAttendanceForUser,
  markAttendanceForUser,
} from './attendance.service.js'
import { isEmployeeServiceError } from './employees.service.js'

export const attendanceRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()

attendanceRoutes.use('*', requireJwt)

const markAttendanceRoute = createRoute({
  method: 'post',
  path: '/mark',
  tags: ['Attendance'],
  summary: 'Mark attendance',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: markAttendanceSchema } } },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ attendance: attendanceResponseSchema }),
          }),
        },
      },
      description: 'Attendance marked',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Employee not found',
    },
  },
})

attendanceRoutes.openapi(markAttendanceRoute, async (c) => {
  const auth = c.get('auth')
  const payload = c.req.valid('json')

  const result = await markAttendanceForUser(auth.userId, payload)
  if (isEmployeeServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

const getAttendanceHistoryRoute = createRoute({
  method: 'get',
  path: '/{employeeId}',
  tags: ['Attendance'],
  summary: 'Get employee attendance history',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ employeeId: z.string() }),
    query: attendanceHistoryQuerySchema,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              attendance: z.array(attendanceResponseSchema),
              summary: monthlyAttendanceSummarySchema,
            }),
          }),
        },
      },
      description: 'Attendance history and monthly summary',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Employee not found',
    },
  },
})

attendanceRoutes.openapi(getAttendanceHistoryRoute, async (c) => {
  const auth = c.get('auth')
  const { employeeId } = c.req.valid('param')
  const query = c.req.valid('query')

  const result = await getAttendanceForEmployeeForUser(employeeId, auth.userId, query)
  if (!result) return jsonError(c, 'Employee not found', 404) as any

  return jsonOk(c, result) as any
})

const getTodayAttendanceRoute = createRoute({
  method: 'get',
  path: '/today',
  tags: ['Attendance'],
  summary: "Get today's attendance for all employees",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              date: z.string().datetime(),
              attendance: z.array(
                z.object({
                  employee: z.object({
                    id: z.string(),
                    employeeId: z.string(),
                    name: z.string(),
                  }),
                  attendance: attendanceResponseSchema.nullable(),
                }),
              ),
              summary: z.object({
                totalEmployees: z.number(),
                markedCount: z.number(),
                present: z.number(),
                absent: z.number(),
                halfDay: z.number(),
              }),
            }),
          }),
        },
      },
      description: "Today's attendance",
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

attendanceRoutes.openapi(getTodayAttendanceRoute, async (c) => {
  const auth = c.get('auth')

  const result = await getTodayAttendanceForUser(auth.userId)
  if (isEmployeeServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

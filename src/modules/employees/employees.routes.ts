import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { requireJwt } from '../../middlewares/jwt.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import {
  createEmployeeSchema,
  employeeDocumentResponseSchema,
  employeeListQuerySchema,
  employeeResponseSchema,
  errorResponseSchema,
  updateEmployeeSchema,
  uploadDocumentSchema,
} from './employees.schema.js'
import {
  createEmployeeForUser,
  deleteEmployeeDocumentForUser,
  deleteEmployeeForUser,
  getEmployeeDetailForUser,
  getEmployeeDocumentsForUser,
  getEmployeesForUser,
  isEmployeeServiceError,
  updateEmployeeForUser,
  uploadEmployeeDocumentForUser,
} from './employees.service.js'

export const employeeRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()

employeeRoutes.use('*', requireJwt)

const listEmployeesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Employees'],
  summary: 'List employees',
  description: 'Returns employees for the company with optional search/filter by department and status.',
  security: [{ bearerAuth: [] }],
  request: {
    query: employeeListQuerySchema,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              employees: z.array(employeeResponseSchema),
              total: z.number(),
              summary: z.object({
                active: z.number(),
                inactive: z.number(),
                terminated: z.number(),
              }),
            }),
          }),
        },
      },
      description: 'Employee list',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

employeeRoutes.openapi(listEmployeesRoute, async (c) => {
  const auth = c.get('auth')
  const filters = c.req.valid('query')

  const result = await getEmployeesForUser(auth.userId, filters)
  if (isEmployeeServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

const createEmployeeRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Employees'],
  summary: 'Create employee',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: createEmployeeSchema } } },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ employee: employeeResponseSchema }),
          }),
        },
      },
      description: 'Employee created',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Invalid request',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
    409: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Employee ID conflict',
    },
  },
})

employeeRoutes.openapi(createEmployeeRoute, async (c) => {
  const auth = c.get('auth')
  const payload = c.req.valid('json')

  const result = await createEmployeeForUser(auth.userId, payload)
  if (isEmployeeServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result, 201) as any
})

const getEmployeeRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Employees'],
  summary: 'Get employee details',
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
              employee: employeeResponseSchema,
              stats: z.object({
                documentsCount: z.number(),
                attendanceCount: z.number(),
                transactionCount: z.number(),
              }),
            }),
          }),
        },
      },
      description: 'Employee details',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Employee not found',
    },
  },
})

employeeRoutes.openapi(getEmployeeRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')

  const result = await getEmployeeDetailForUser(id, auth.userId)
  if (!result) return jsonError(c, 'Employee not found', 404) as any

  return jsonOk(c, result) as any
})

const updateEmployeeRoute = createRoute({
  method: 'put',
  path: '/{id}',
  tags: ['Employees'],
  summary: 'Update employee',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: updateEmployeeSchema } } },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ employee: employeeResponseSchema }),
          }),
        },
      },
      description: 'Employee updated',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Employee not found',
    },
    409: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Employee ID conflict',
    },
  },
})

employeeRoutes.openapi(updateEmployeeRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const payload = c.req.valid('json')

  const result = await updateEmployeeForUser(id, auth.userId, payload)
  if (!result) return jsonError(c, 'Employee not found', 404) as any
  if (isEmployeeServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

const deleteEmployeeRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Employees'],
  summary: 'Delete employee',
  description: 'Soft-deletes employee while keeping historical attendance and transaction records.',
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
            data: z.object({ message: z.string() }),
          }),
        },
      },
      description: 'Employee deleted',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Employee not found',
    },
  },
})

employeeRoutes.openapi(deleteEmployeeRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')

  const result = await deleteEmployeeForUser(id, auth.userId)
  if (!result) return jsonError(c, 'Employee not found', 404) as any

  return jsonOk(c, result) as any
})

const getEmployeeDocumentsRoute = createRoute({
  method: 'get',
  path: '/{id}/documents',
  tags: ['Employee Documents'],
  summary: 'Get employee documents',
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
            data: z.object({ documents: z.array(employeeDocumentResponseSchema) }),
          }),
        },
      },
      description: 'Document list',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Employee not found',
    },
  },
})

employeeRoutes.openapi(getEmployeeDocumentsRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')

  const result = await getEmployeeDocumentsForUser(id, auth.userId)
  if (!result) return jsonError(c, 'Employee not found', 404) as any

  return jsonOk(c, result) as any
})

const uploadEmployeeDocumentRoute = createRoute({
  method: 'post',
  path: '/{id}/documents',
  tags: ['Employee Documents'],
  summary: 'Upload employee document metadata',
  description: 'Stores document file URL or structured key-value data.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: uploadDocumentSchema } } },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ document: employeeDocumentResponseSchema }),
          }),
        },
      },
      description: 'Document uploaded',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Invalid request',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Employee not found',
    },
  },
})

employeeRoutes.openapi(uploadEmployeeDocumentRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const payload = c.req.valid('json')

  const result = await uploadEmployeeDocumentForUser(id, auth.userId, payload)
  if (!result) return jsonError(c, 'Employee not found', 404) as any

  return jsonOk(c, result, 201) as any
})

const deleteEmployeeDocumentRoute = createRoute({
  method: 'delete',
  path: '/{id}/documents/{documentId}',
  tags: ['Employee Documents'],
  summary: 'Delete employee document',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string(), documentId: z.string() }),
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
      description: 'Document deleted',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Employee or document not found',
    },
  },
})

employeeRoutes.openapi(deleteEmployeeDocumentRoute, async (c) => {
  const auth = c.get('auth')
  const { id, documentId } = c.req.valid('param')

  const result = await deleteEmployeeDocumentForUser(id, documentId, auth.userId)
  if (isEmployeeServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

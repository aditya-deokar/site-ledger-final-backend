import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { requireJwt } from '../../middlewares/jwt.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import { employeeDocumentResponseSchema, errorResponseSchema } from './employees.schema.js'
import { getDocumentDownloadForUser, isEmployeeServiceError } from './employees.service.js'

export const employeeDocumentRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()

employeeDocumentRoutes.use('*', requireJwt)

const getDocumentDownloadRoute = createRoute({
  method: 'get',
  path: '/{id}/download',
  tags: ['Employee Documents'],
  summary: 'Get employee document download URL',
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
              document: employeeDocumentResponseSchema,
              downloadUrl: z.string().url(),
            }),
          }),
        },
      },
      description: 'Document URL',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Document has no file URL',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Document not found',
    },
  },
})

employeeDocumentRoutes.openapi(getDocumentDownloadRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')

  const result = await getDocumentDownloadForUser(id, auth.userId)
  if (isEmployeeServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

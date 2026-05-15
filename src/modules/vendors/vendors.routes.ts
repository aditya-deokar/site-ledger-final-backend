import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { requireJwt } from '../../middlewares/jwt.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import {
  createVendorSchema,
  errorResponseSchema,
  paginationSchema,
  patchVendorStatusSchema,
  updateVendorSchema,
  uploadVendorDocumentSchema,
  vendorAssignmentSchema,
  vendorBaseResponseSchema,
  vendorDocumentSchema,
  vendorListItemSchema,
  vendorListQuerySchema,
  vendorResponseSchema,
  vendorSiteAssignmentUpsertSchema,
} from './vendors.schema.js'
import {
  createVendorDocumentForUser,
  createVendorForUser,
  deleteVendorDocumentForUser,
  deleteVendorForUser,
  getVendorsForUser,
  isVendorServiceError,
  listVendorDocumentsForUser,
  listVendorSiteAssignmentsForUser,
  patchVendorStatusForUser,
  updateVendorForUser,
  upsertVendorSiteAssignmentForUser,
} from './vendors.service.js'
import { registerVendorAccountingRoutes } from './vendor-accounting.routes.js'

export const vendorRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()

vendorRoutes.use('*', requireJwt)

const getVendorsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Vendors'],
  summary: 'List vendors',
  description: 'Returns vendors for the company with filters, KPIs, and pagination.',
  security: [{ bearerAuth: [] }],
  request: {
    query: vendorListQuerySchema,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              vendors: z.array(vendorListItemSchema),
              pagination: paginationSchema,
            }),
          }),
        },
      },
      description: 'List of vendors',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

vendorRoutes.openapi(getVendorsRoute, async (c) => {
  const auth = c.get('auth')
  const query = c.req.valid('query')

  const result = await getVendorsForUser(auth.userId, query)
  if (isVendorServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

const createVendorRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Vendors'],
  summary: 'Create a vendor',
  description: 'Creates a company-wide vendor profile with free-text category and rich master details.',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: createVendorSchema } },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ vendor: vendorResponseSchema }),
          }),
        },
      },
      description: 'Vendor created',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Bad request',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

vendorRoutes.openapi(createVendorRoute, async (c) => {
  const auth = c.get('auth')
  const body = await c.req.json().catch(() => null)
  const parsed = createVendorSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const result = await createVendorForUser(auth.userId, parsed.data)
  if (isVendorServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result, 201) as any
})

const updateVendorRoute = createRoute({
  method: 'put',
  path: '/{id}',
  tags: ['Vendors'],
  summary: 'Update a vendor',
  description: 'Updates the vendor master profile.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { 'application/json': { schema: updateVendorSchema } },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ vendor: vendorResponseSchema }),
          }),
        },
      },
      description: 'Vendor updated',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Bad request',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Vendor not found',
    },
  },
})

vendorRoutes.openapi(updateVendorRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const body = await c.req.json().catch(() => null)
  const parsed = updateVendorSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const result = await updateVendorForUser(id, auth.userId, parsed.data)
  if (isVendorServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

const patchVendorStatusRoute = createRoute({
  method: 'patch',
  path: '/{id}/status',
  tags: ['Vendors'],
  summary: 'Change vendor status',
  description: 'Archive, activate, block, or inactivate a vendor without deleting history.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { 'application/json': { schema: patchVendorStatusSchema } },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ vendor: vendorBaseResponseSchema }),
          }),
        },
      },
      description: 'Vendor status updated',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Bad request',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Vendor not found',
    },
  },
})

vendorRoutes.openapi(patchVendorStatusRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const body = await c.req.json().catch(() => null)
  const parsed = patchVendorStatusSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const result = await patchVendorStatusForUser(id, auth.userId, parsed.data.status)
  if (isVendorServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

const getVendorAssignmentsRoute = createRoute({
  method: 'get',
  path: '/{id}/site-assignments',
  tags: ['Vendors'],
  summary: 'List vendor site assignments',
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
              assignments: z.array(vendorAssignmentSchema),
            }),
          }),
        },
      },
      description: 'Vendor site assignments',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Vendor not found',
    },
  },
})

vendorRoutes.openapi(getVendorAssignmentsRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')

  const result = await listVendorSiteAssignmentsForUser(id, auth.userId)
  if (isVendorServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

const upsertVendorAssignmentRoute = createRoute({
  method: 'put',
  path: '/{id}/site-assignments/{siteId}',
  tags: ['Vendors'],
  summary: 'Create or update a vendor site assignment',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string(), siteId: z.string() }),
    body: {
      content: { 'application/json': { schema: vendorSiteAssignmentUpsertSchema } },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              assignment: vendorAssignmentSchema,
            }),
          }),
        },
      },
      description: 'Vendor site assignment updated',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Bad request',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Vendor or site not found',
    },
  },
})

vendorRoutes.openapi(upsertVendorAssignmentRoute, async (c) => {
  const auth = c.get('auth')
  const { id, siteId } = c.req.valid('param')
  const body = await c.req.json().catch(() => null)
  const parsed = vendorSiteAssignmentUpsertSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const result = await upsertVendorSiteAssignmentForUser(id, siteId, auth.userId, parsed.data)
  if (isVendorServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

const getVendorDocumentsRoute = createRoute({
  method: 'get',
  path: '/{id}/documents',
  tags: ['Vendors'],
  summary: 'List vendor documents',
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
              documents: z.array(vendorDocumentSchema),
            }),
          }),
        },
      },
      description: 'Vendor documents',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Vendor not found',
    },
  },
})

vendorRoutes.openapi(getVendorDocumentsRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')

  const result = await listVendorDocumentsForUser(id, auth.userId)
  if (isVendorServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

const createVendorDocumentRoute = createRoute({
  method: 'post',
  path: '/{id}/documents',
  tags: ['Vendors'],
  summary: 'Create a vendor document record',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { 'application/json': { schema: uploadVendorDocumentSchema } },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              document: vendorDocumentSchema,
            }),
          }),
        },
      },
      description: 'Vendor document created',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Bad request',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Vendor not found',
    },
  },
})

vendorRoutes.openapi(createVendorDocumentRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const body = await c.req.json().catch(() => null)
  const parsed = uploadVendorDocumentSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const result = await createVendorDocumentForUser(id, auth.userId, parsed.data)
  if (isVendorServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result, 201) as any
})

const deleteVendorDocumentRoute = createRoute({
  method: 'delete',
  path: '/{id}/documents/{documentId}',
  tags: ['Vendors'],
  summary: 'Delete a vendor document',
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
      description: 'Vendor document deleted',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Vendor document not found',
    },
  },
})

vendorRoutes.openapi(deleteVendorDocumentRoute, async (c) => {
  const auth = c.get('auth')
  const { id, documentId } = c.req.valid('param')

  const result = await deleteVendorDocumentForUser(id, documentId, auth.userId)
  if (isVendorServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

const deleteVendorRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Vendors'],
  summary: 'Delete a vendor',
  description: 'Soft-deletes a vendor for backward compatibility. Prefer status archiving in the redesigned flow.',
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
      description: 'Vendor deleted',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Vendor not found',
    },
  },
})

vendorRoutes.openapi(deleteVendorRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')

  const result = await deleteVendorForUser(id, auth.userId)
  if (isVendorServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

registerVendorAccountingRoutes(vendorRoutes)

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { requireJwt } from '../../middlewares/jwt.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import {
  createVendorSchema,
  errorResponseSchema,
  updateVendorSchema,
  vendorResponseSchema,
  vendorTypeSchema,
} from './vendors.schema.js'
import {
  createVendorForUser,
  deleteVendorForUser,
  getVendorsForUser,
  isVendorServiceError,
  updateVendorForUser,
} from './vendors.service.js'
import { registerVendorAccountingRoutes } from './vendor-accounting.routes.js'

export const vendorRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()

vendorRoutes.use('*', requireJwt)

const getVendorsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Vendors'],
  summary: 'List vendors',
  description: 'Returns all vendors for the company. Optionally filter by vendor type using the ?type= query parameter (for expense form dropdowns).',
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      type: vendorTypeSchema.optional(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              vendors: z.array(vendorResponseSchema),
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
  const { type } = c.req.valid('query')

  const result = await getVendorsForUser(auth.userId, type)
  if (isVendorServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

const createVendorRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Vendors'],
  summary: 'Create a vendor',
  description: 'Add a new vendor with name and any non-empty vendor type.',
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
  description: 'Update vendor details such as name, type, phone, or email.',
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

const deleteVendorRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Vendors'],
  summary: 'Delete a vendor',
  description: 'Soft-delete a vendor. Existing expense records and ledger history remain available for reporting.',
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
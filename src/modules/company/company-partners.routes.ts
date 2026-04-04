import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import { createPartnerSchema, errorResponseSchema, updatePartnerSchema } from './company.schema.js'
import {
  addPartnerForUser,
  deletePartnerForUser,
  getPartnersForUser,
  updatePartnerForUser,
} from './company-partners.service.js'
import { isCompanyServiceError } from './company.service.js'

type CompanyRouteApp = OpenAPIHono<{ Variables: AuthContext['Variables'] }>

export function registerCompanyPartnerRoutes(companyRoutes: CompanyRouteApp) {
  const addPartnerRoute = createRoute({
    method: 'post',
    path: '/partners',
    tags: ['Partners'],
    summary: 'Add a partner',
    description: 'Add a new partner to the company with their name, contact info, investment amount, and stake percentage.',
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: {
          'application/json': { schema: createPartnerSchema },
        },
      },
    },
    responses: {
      201: {
        content: {
          'application/json': {
            schema: z.object({
              ok: z.literal(true),
              data: z.object({
                partner: z.object({
                  id: z.string(),
                  name: z.string(),
                  email: z.string().nullable(),
                  phone: z.string().nullable(),
                  investmentAmount: z.number(),
                  stakePercentage: z.number(),
                }),
              }),
            }),
          },
        },
        description: 'Partner added',
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

  companyRoutes.openapi(addPartnerRoute, async (c) => {
    const auth = c.get('auth')
    const body = await c.req.json().catch(() => null)
    const parsed = createPartnerSchema.safeParse(body)

    if (!parsed.success) {
      return jsonError(c, 'Invalid request body', 400) as any
    }

    const result = await addPartnerForUser(auth.userId, parsed.data)
    if (isCompanyServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result, 201) as any
  })

  const getPartnersRoute = createRoute({
    method: 'get',
    path: '/partners',
    tags: ['Partners'],
    summary: 'List all partners',
    description: 'Returns all partners of the company with the total fund calculated from partner investments.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.object({
              ok: z.literal(true),
              data: z.object({
                company: z.object({
                  id: z.string(),
                  name: z.string(),
                }),
                total_fund: z.number(),
                partners: z.array(
                  z.object({
                    id: z.string(),
                    name: z.string(),
                    email: z.string().nullable(),
                    phone: z.string().nullable(),
                    investmentAmount: z.number(),
                    stakePercentage: z.number(),
                  }),
                ),
              }),
            }),
          },
        },
        description: 'All partners with total fund',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'No company found',
      },
    },
  })

  companyRoutes.openapi(getPartnersRoute, async (c) => {
    const auth = c.get('auth')
    const result = await getPartnersForUser(auth.userId)
    if (isCompanyServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
  })

  const updatePartnerRoute = createRoute({
    method: 'put',
    path: '/partners/{id}',
    tags: ['Partners'],
    summary: 'Update a partner',
    description: 'Update partner details such as name, contact info, investment amount, or stake percentage.',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': { schema: updatePartnerSchema },
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
                partner: z.object({
                  id: z.string(),
                  name: z.string(),
                  email: z.string().nullable(),
                  phone: z.string().nullable(),
                  investmentAmount: z.number(),
                  stakePercentage: z.number(),
                }),
              }),
            }),
          },
        },
        description: 'Partner updated',
      },
      400: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Bad request',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Partner not found',
      },
    },
  })

  companyRoutes.openapi(updatePartnerRoute, async (c) => {
    const auth = c.get('auth')
    const { id } = c.req.valid('param')
    const body = await c.req.json().catch(() => null)
    const parsed = updatePartnerSchema.safeParse(body)

    if (!parsed.success) {
      return jsonError(c, 'Invalid request body', 400) as any
    }

    const result = await updatePartnerForUser(id, auth.userId, parsed.data)
    if (isCompanyServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
  })

  const deletePartnerRoute = createRoute({
    method: 'delete',
    path: '/partners/{id}',
    tags: ['Partners'],
    summary: 'Remove a partner',
    description: 'Remove a partner from the company. This reduces the company total fund by their investment amount.',
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
                message: z.string(),
              }),
            }),
          },
        },
        description: 'Partner deleted',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Partner not found',
      },
    },
  })

  companyRoutes.openapi(deletePartnerRoute, async (c) => {
    const auth = c.get('auth')
    const { id } = c.req.valid('param')

    const result = await deletePartnerForUser(id, auth.userId)
    if (isCompanyServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
  })
}

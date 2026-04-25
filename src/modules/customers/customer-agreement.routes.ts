import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import {
  addAgreementLineForUser,
  deleteAgreementLineForUser,
  getAgreementForUser,
  updateAgreementLineForUser,
} from './customer-agreement.service.js'

type CustomerRouteApp = OpenAPIHono<{ Variables: AuthContext['Variables'] }>

const agreementLineTypeSchema = z.enum(['BASE_PRICE', 'CHARGE', 'TAX', 'DISCOUNT', 'CREDIT'])

const agreementLineInputSchema = z.object({
  type: agreementLineTypeSchema,
  label: z.string().trim().min(1),
  amount: z.number().min(0),
  ratePercent: z.number().min(0).optional(),
  calculationBase: z.number().min(0).optional(),
  affectsProfit: z.boolean().optional(),
  note: z.string().optional(),
})

const agreementTotalsSchema = z.object({
  basePrice: z.number(),
  charges: z.number(),
  tax: z.number(),
  discounts: z.number(),
  credits: z.number(),
  payableTotal: z.number(),
  profitRevenue: z.number(),
})

const agreementLineResponseSchema = z.object({
  id: z.string(),
  type: agreementLineTypeSchema,
  label: z.string(),
  amount: z.number(),
  signedAmount: z.number(),
  ratePercent: z.number().nullable(),
  calculationBase: z.number().nullable(),
  affectsProfit: z.boolean(),
  note: z.string().nullable(),
  createdAt: z.string().datetime(),
})

const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})

function isAgreementError(result: unknown): result is { error: string; status: number } {
  return (
    typeof result === 'object'
    && result !== null
    && 'error' in result
    && typeof result.error === 'string'
    && 'status' in result
    && typeof result.status === 'number'
  )
}

export function registerCustomerAgreementRoutes(customerRoutes: CustomerRouteApp) {
  const getAgreementRoute = createRoute({
    method: 'get',
    path: '/{id}/agreement',
    tags: ['Customers'],
    summary: 'Get customer agreement lines',
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
                agreement: z.object({
                  customerId: z.string(),
                  lines: z.array(agreementLineResponseSchema),
                  totals: agreementTotalsSchema,
                  amountPaid: z.number(),
                  remaining: z.number(),
                }),
              }),
            }),
          },
        },
        description: 'Agreement lines and totals',
      },
      404: { content: { 'application/json': { schema: errorResponseSchema } }, description: 'Customer not found' },
    },
  })

  customerRoutes.openapi(getAgreementRoute, async (c) => {
    const auth = c.get('auth')
    const { id } = c.req.valid('param')
    const result = await getAgreementForUser(id, auth.userId)
    if (isAgreementError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
  })

  const addAgreementLineRoute = createRoute({
    method: 'post',
    path: '/{id}/agreement-lines',
    tags: ['Customers'],
    summary: 'Add an agreement charge, tax, discount, or credit',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: agreementLineInputSchema } } },
    },
    responses: {
      201: {
        content: {
          'application/json': {
            schema: z.object({
              ok: z.literal(true),
              data: z.object({
                line: agreementLineResponseSchema,
                totals: agreementTotalsSchema,
              }),
            }),
          },
        },
        description: 'Agreement line added',
      },
      400: { content: { 'application/json': { schema: errorResponseSchema } }, description: 'Invalid agreement line' },
      404: { content: { 'application/json': { schema: errorResponseSchema } }, description: 'Customer not found' },
    },
  })

  customerRoutes.openapi(addAgreementLineRoute, async (c) => {
    const auth = c.get('auth')
    const { id } = c.req.valid('param')
    const body = await c.req.json().catch(() => null)
    const parsed = agreementLineInputSchema.safeParse(body)
    if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

    const result = await addAgreementLineForUser(id, auth.userId, parsed.data)
    if (isAgreementError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result, 201) as any
  })

  const updateAgreementLineRoute = createRoute({
    method: 'put',
    path: '/{id}/agreement-lines/{lineId}',
    tags: ['Customers'],
    summary: 'Update an agreement line',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string(), lineId: z.string() }),
      body: { content: { 'application/json': { schema: agreementLineInputSchema } } },
    },
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.object({
              ok: z.literal(true),
              data: z.object({
                line: agreementLineResponseSchema,
                totals: agreementTotalsSchema,
              }),
            }),
          },
        },
        description: 'Agreement line updated',
      },
      400: { content: { 'application/json': { schema: errorResponseSchema } }, description: 'Invalid agreement line' },
      404: { content: { 'application/json': { schema: errorResponseSchema } }, description: 'Line not found' },
    },
  })

  customerRoutes.openapi(updateAgreementLineRoute, async (c) => {
    const auth = c.get('auth')
    const { id, lineId } = c.req.valid('param')
    const body = await c.req.json().catch(() => null)
    const parsed = agreementLineInputSchema.safeParse(body)
    if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

    const result = await updateAgreementLineForUser(id, lineId, auth.userId, parsed.data)
    if (isAgreementError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
  })

  const deleteAgreementLineRoute = createRoute({
    method: 'delete',
    path: '/{id}/agreement-lines/{lineId}',
    tags: ['Customers'],
    summary: 'Remove an agreement line',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string(), lineId: z.string() }),
    },
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.object({
              ok: z.literal(true),
              data: z.object({
                message: z.string(),
                totals: agreementTotalsSchema,
              }),
            }),
          },
        },
        description: 'Agreement line removed',
      },
      400: { content: { 'application/json': { schema: errorResponseSchema } }, description: 'Cannot remove line' },
      404: { content: { 'application/json': { schema: errorResponseSchema } }, description: 'Line not found' },
    },
  })

  customerRoutes.openapi(deleteAgreementLineRoute, async (c) => {
    const auth = c.get('auth')
    const { id, lineId } = c.req.valid('param')
    const result = await deleteAgreementLineForUser(id, lineId, auth.userId)
    if (isAgreementError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
  })
}

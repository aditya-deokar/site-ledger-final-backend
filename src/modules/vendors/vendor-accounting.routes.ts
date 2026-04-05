import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import {
  errorResponseSchema,
  vendorBillSchema,
  vendorPaymentSchema,
  vendorStatementEntrySchema,
  vendorSummarySchema,
} from './vendors.schema.js'
import {
  getVendorPaymentsForUser,
  getVendorStatementForUser,
  getVendorSummaryForUser,
  getVendorTransactionsForUser,
} from './vendor-accounting.service.js'
import { isVendorServiceError } from './vendors.service.js'

type VendorRouteApp = OpenAPIHono<{ Variables: AuthContext['Variables'] }>

export function registerVendorAccountingRoutes(vendorRoutes: VendorRouteApp) {
  const getVendorRoute = createRoute({
    method: 'get',
    path: '/{id}',
    tags: ['Vendors'],
    summary: 'Get vendor summary',
    description: 'Returns ledger-based vendor accounting totals using expenses as bills and expense payments as vendor payments.',
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
                vendor: vendorSummarySchema,
              }),
            }),
          },
        },
        description: 'Vendor summary',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Vendor not found',
      },
    },
  })

  vendorRoutes.openapi(getVendorRoute, async (c) => {
    const auth = c.get('auth')
    const { id } = c.req.valid('param')

    const result = await getVendorSummaryForUser(id, auth.userId)
    if (isVendorServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
  })

  const getVendorTransactionsRoute = createRoute({
    method: 'get',
    path: '/{id}/transactions',
    tags: ['Vendors'],
    summary: 'List vendor bills',
    description: 'Returns vendor bill documents backed by expenses, with paid totals and outstanding amounts derived from the ledger.',
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
                transactions: z.array(vendorBillSchema),
                totalBilled: z.number(),
                totalPaid: z.number(),
                totalOutstanding: z.number(),
                billCount: z.number(),
              }),
            }),
          },
        },
        description: 'Vendor bills list',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Vendor not found',
      },
    },
  })

  vendorRoutes.openapi(getVendorTransactionsRoute, async (c) => {
    const auth = c.get('auth')
    const { id } = c.req.valid('param')

    const result = await getVendorTransactionsForUser(id, auth.userId)
    if (isVendorServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
  })

  const getVendorPaymentsRoute = createRoute({
    method: 'get',
    path: '/{id}/payments',
    tags: ['Vendors'],
    summary: 'List vendor payments',
    description: 'Returns all payment ledger rows posted against this vendor\'s expenses.',
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
                payments: z.array(vendorPaymentSchema),
                totalPaid: z.number(),
                paymentCount: z.number(),
              }),
            }),
          },
        },
        description: 'Vendor payments list',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Vendor not found',
      },
    },
  })

  vendorRoutes.openapi(getVendorPaymentsRoute, async (c) => {
    const auth = c.get('auth')
    const { id } = c.req.valid('param')

    const result = await getVendorPaymentsForUser(id, auth.userId)
    if (isVendorServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
  })

  const getVendorStatementRoute = createRoute({
    method: 'get',
    path: '/{id}/statement',
    tags: ['Vendors'],
    summary: 'Get vendor statement',
    description: 'Returns a chronological vendor ledger combining bill documents and expense payment rows with a running outstanding balance.',
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
                statement: z.array(vendorStatementEntrySchema),
                totalBilled: z.number(),
                totalPaid: z.number(),
                closingBalance: z.number(),
              }),
            }),
          },
        },
        description: 'Vendor statement',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Vendor not found',
      },
    },
  })

  vendorRoutes.openapi(getVendorStatementRoute, async (c) => {
    const auth = c.get('auth')
    const { id } = c.req.valid('param')

    const result = await getVendorStatementForUser(id, auth.userId)
    if (isVendorServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
  })
}
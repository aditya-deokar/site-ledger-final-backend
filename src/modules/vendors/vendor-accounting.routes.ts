import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import {
  errorResponseSchema,
  paginationSchema,
  vendorBillSchema,
  vendorPaymentSchema,
  vendorReceiptSchema,
  vendorStatementEntrySchema,
  vendorSummarySchema,
} from './vendors.schema.js'
import {
  getVendorPaymentsForUser,
  getVendorReceiptsForUser,
  getVendorStatementForUser,
  getVendorSummaryForUser,
  getVendorTransactionsForUser,
} from './vendor-accounting.service.js'
import { isVendorServiceError } from './vendors.service.js'

type VendorRouteApp = OpenAPIHono<{ Variables: AuthContext['Variables'] }>

const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).max(1000).optional(),
})

function registerBillRoute(vendorRoutes: VendorRouteApp, path: '/{id}/bills' | '/{id}/transactions') {
  const route = createRoute({
    method: 'get',
    path,
    tags: ['Vendors'],
    summary: path.endsWith('/bills') ? 'List vendor bills' : 'List vendor transactions',
    description: 'Returns vendor bill documents backed by expenses, with paid totals and outstanding amounts derived from the ledger.',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string() }),
      query: paginationQuerySchema,
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
                overdueBillCount: z.number(),
                pagination: paginationSchema,
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

  vendorRoutes.openapi(route, async (c) => {
    const auth = c.get('auth')
    const { id } = c.req.valid('param')
    const { page, size } = c.req.valid('query')

    const result = await getVendorTransactionsForUser(id, auth.userId, page, size)
    if (isVendorServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
  })
}

export function registerVendorAccountingRoutes(vendorRoutes: VendorRouteApp) {
  const getVendorRoute = createRoute({
    method: 'get',
    path: '/{id}',
    tags: ['Vendors'],
    summary: 'Get vendor summary',
    description: 'Returns vendor accounting totals, profile metrics, and assignments.',
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

  registerBillRoute(vendorRoutes, '/{id}/bills')
  registerBillRoute(vendorRoutes, '/{id}/transactions')

  const getVendorPaymentsRoute = createRoute({
    method: 'get',
    path: '/{id}/payments',
    tags: ['Vendors'],
    summary: 'List vendor payments',
    description: 'Returns payment ledger rows posted against this vendor bills, including receipt summary.',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string() }),
      query: paginationQuerySchema,
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
                pagination: paginationSchema,
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
    const { page, size } = c.req.valid('query')

    const result = await getVendorPaymentsForUser(id, auth.userId, page, size)
    if (isVendorServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
  })

  const getVendorReceiptsRoute = createRoute({
    method: 'get',
    path: '/{id}/receipts',
    tags: ['Vendors'],
    summary: 'List vendor receipts',
    description: 'Returns persisted receipts for vendor payments.',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string() }),
      query: paginationQuerySchema,
    },
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.object({
              ok: z.literal(true),
              data: z.object({
                receipts: z.array(vendorReceiptSchema),
                pagination: paginationSchema,
              }),
            }),
          },
        },
        description: 'Vendor receipts list',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Vendor not found',
      },
    },
  })

  vendorRoutes.openapi(getVendorReceiptsRoute, async (c) => {
    const auth = c.get('auth')
    const { id } = c.req.valid('param')
    const { page, size } = c.req.valid('query')

    const result = await getVendorReceiptsForUser(id, auth.userId, page, size)
    if (isVendorServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
  })

  const getVendorStatementRoute = createRoute({
    method: 'get',
    path: '/{id}/statement',
    tags: ['Vendors'],
    summary: 'Get vendor statement',
    description: 'Returns a chronological vendor ledger combining opening balance, bills, and payments with a running outstanding balance.',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string() }),
      query: paginationQuerySchema,
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
                pagination: paginationSchema,
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
    const { page, size } = c.req.valid('query')

    const result = await getVendorStatementForUser(id, auth.userId, page, size)
    if (isVendorServiceError(result)) return jsonError(c, result.error, result.status) as any

    return jsonOk(c, result) as any
  })
}

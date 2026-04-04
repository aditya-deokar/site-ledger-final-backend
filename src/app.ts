import { OpenAPIHono } from '@hono/zod-openapi'
import { swaggerUI } from '@hono/swagger-ui'
import { cors } from 'hono/cors'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { healthRoutes } from './routes/health.js'
import { authRoutes } from './routes/auth.js'
import { companyRoutes } from './routes/company.js'
import { siteRoutes } from './routes/sites.js'
import { vendorRoutes } from './routes/vendors.js'
import { customerRoutes } from './routes/customers.js'
import { investorRoutes } from './routes/investors.js'
import { LedgerError } from './services/ledger.service.js'
import { jsonError } from './utils/response.js'
import { requestId } from './middlewares/request-id.js'
import { createLogger } from './config/logger.js'

const httpLog = createLogger('http')

const pinoLogger = createMiddleware(async (c, next) => {
  const start = Date.now()
  await next()
  const duration = Date.now() - start
  const status = c.res.status
  const method = c.req.method
  const path = c.req.path

  // Color-code by status for dev readability
  const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'

  httpLog[level]({
    method,
    path,
    status,
    duration_ms: duration,
  }, `← ${method} ${path} ${status} ${duration}ms`)
})

export const app = new OpenAPIHono()

app.use('*', requestId)
app.use('*', pinoLogger)
app.use('*', cors({
  origin: ['http://localhost:3000', 'http://localhost:5173', 'https://www.sitesledger.app', 'https://www.siteledger.app'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}))

app.doc('/openapi.json', {
  openapi: '3.0.0',
  info: {
    title: 'GAA Builders - Real Estate Management API',
    description: 'Backend API for managing real estate companies, construction sites, fund allocation, expenses, vendors, and customer flat bookings.',
    version: '1.0.0',
    contact: {
      name: 'GAA Builders',
    },
  },
  tags: [
    { name: 'Health', description: 'Server health check' },
    { name: 'Auth', description: 'User registration and authentication' },
    { name: 'Company', description: 'Company profile management' },
    { name: 'Partners', description: 'Manage company partners and investments' },
    { name: 'Sites', description: 'Construction site management' },
    { name: 'Site Fund', description: 'Allocate and track funds per site' },
    { name: 'Expenses', description: 'Record and manage site expenses (general & vendor)' },
    { name: 'Floors & Flats', description: 'View floors and manage flat statuses' },
    { name: 'Vendors', description: 'Manage vendors (electrician, plumber, supplier, etc.)' },
    { name: 'Customers', description: 'Customer flat booking and payment tracking' },
    { name: 'Investors', description: 'Manage equity and fixed-rate investors with transaction history' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
  },
} as any)

app.get('/docs', swaggerUI({ url: '/openapi.json' }))

app.route('/api/health', healthRoutes)
app.route('/api/auth', authRoutes)
app.route('/api/company', companyRoutes)
app.route('/api/sites', siteRoutes)
app.route('/api/vendors', vendorRoutes)
app.route('/api/sites', customerRoutes)
app.route('/api/customers', customerRoutes)
app.route('/api/investors', investorRoutes)

app.notFound((c: Context) => jsonError(c, 'Not Found', 404))

app.onError((err: Error, c: Context) => {
  if (err instanceof LedgerError) {
    const status = err.code === 'IDEMPOTENCY_CONFLICT'
      ? 409
      : err.code === 'INSUFFICIENT_FUNDS' || err.code === 'AMOUNT_EXCEEDS_LIMIT' || err.code === 'INVALID_LEDGER_INPUT'
        ? 400
        : 500

    return jsonError(c, err.code, status)
  }

  return jsonError(c, err.message || 'Internal Server Error', 500)
})

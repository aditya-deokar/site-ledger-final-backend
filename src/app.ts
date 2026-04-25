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
import { paymentRoutes } from './routes/payments.js'
import { employeeRoutes } from './routes/employees.js'
import { attendanceRoutes } from './routes/attendance.js'
import { employeeTransactionRoutes } from './routes/transactions.js'
import { salaryReminderRoutes } from './routes/reminders.js'
import { employeeDocumentRoutes } from './routes/documents.js'
import { salaryPaymentRoutes } from './modules/employees/salary-payment.routes.js'
import { LedgerError } from './services/ledger.service.js'
import { jsonError } from './utils/response.js'
import { requestId } from './middlewares/request-id.js'
import { createLogger } from './config/logger.js'
import { loadEnv } from './config/env.js'

const httpLog = createLogger('http')
const env = loadEnv()

const configuredOrigins = (env.CORS_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

const allowedOrigins = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://www.sitesledger.app',
  'https://sitesledger.app',
  'https://www.siteledger.app',
  'https://siteledger.app',
  ...configuredOrigins,
])

function isAllowedOrigin(origin?: string | null) {
  if (!origin) return false

  if (allowedOrigins.has(origin)) {
    return true
  }

  try {
    const url = new URL(origin)
    const isLocalHttp = url.protocol === 'http:' && (
      url.hostname === 'localhost'
      || url.hostname === '127.0.0.1'
      || url.hostname === '::1'
      || url.hostname === '[::1]'
    )

    return isLocalHttp
  } catch {
    return false
  }
}

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

app.use('*', cors({
  origin: (origin) => {
    return isAllowedOrigin(origin) ? origin : null
  },
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
  exposeHeaders: ['Content-Length', 'X-Request-ID'],
  maxAge: 600,
  credentials: true,
}))

app.use('*', requestId)
app.use('*', pinoLogger)

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
    { name: 'Payments', description: 'Immutable receipts and payment reversal workflow' },
    { name: 'Employees', description: 'Manage employee profiles and employment details' },
    { name: 'Attendance', description: 'Mark and track employee attendance' },
    { name: 'Employee Transactions', description: 'Track salary, bonus, deduction, and other employee transactions' },
    { name: 'Salary Reminders', description: 'Generate and track monthly salary reminders' },
    { name: 'Employee Documents', description: 'Store and retrieve employee documents and metadata' },
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
app.route('/api/payments', paymentRoutes)
app.route('/api/employees/salary-reminders', salaryReminderRoutes)
app.route('/api/employees', employeeRoutes)
app.route('/api/employees', salaryPaymentRoutes)
app.route('/api/attendance', attendanceRoutes)
app.route('/api/transactions', employeeTransactionRoutes)
app.route('/api/documents', employeeDocumentRoutes)

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

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { jsonOk } from '../utils/response.js'
import { prisma } from '../db/prisma.js'
import { isRedisReady } from '../db/redis.js'
import { cacheService } from '../services/cache.service.js'

export const healthRoutes = new OpenAPIHono()

// ── GET / — Liveness probe (fast, no dependency checks) ──

const healthResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    status: z.literal('ok'),
    timestamp: z.string(),
  }),
})

const route = createRoute({
  method: 'get',
  path: '/',
  tags: ['Health'],
  summary: 'Health check',
  description: 'Returns server status and current timestamp to verify the API is running.',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: healthResponseSchema,
        },
      },
      description: 'Server is healthy',
    },
  },
})

healthRoutes.openapi(route, (c) => {
  return jsonOk(c, {
    status: 'ok',
    timestamp: new Date().toISOString(),
  }) as any
})

// ── GET /ready — Readiness probe (checks DB + Redis) ──

const readyResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    status: z.enum(['ok', 'degraded']),
    timestamp: z.string(),
    uptime: z.number(),
    checks: z.object({
      database: z.object({ status: z.enum(['ok', 'error']), latency_ms: z.number().optional() }),
      redis: z.object({ status: z.enum(['ok', 'error', 'disconnected']), latency_ms: z.number().optional() }),
      cache_circuit: z.enum(['CLOSED', 'OPEN', 'HALF_OPEN']),
    }),
  }),
})

const readyRoute = createRoute({
  method: 'get',
  path: '/ready',
  tags: ['Health'],
  summary: 'Readiness check',
  description: 'Returns detailed status of all dependencies (database, Redis) and circuit breaker state.',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: readyResponseSchema,
        },
      },
      description: 'Readiness status with dependency checks',
    },
  },
})

healthRoutes.openapi(readyRoute, async (c) => {
  // Check database
  let dbStatus: 'ok' | 'error' = 'ok'
  let dbLatency: number | undefined
  try {
    const start = Date.now()
    await prisma.$queryRaw`SELECT 1`
    dbLatency = Date.now() - start
  } catch {
    dbStatus = 'error'
  }

  // Check Redis
  let redisStatus: 'ok' | 'error' | 'disconnected' = 'disconnected'
  let redisLatency: number | undefined
  if (isRedisReady()) {
    try {
      const { getRedisClient } = await import('../db/redis.js')
      const client = getRedisClient()
      if (client) {
        const start = Date.now()
        await client.ping()
        redisLatency = Date.now() - start
        redisStatus = 'ok'
      }
    } catch {
      redisStatus = 'error'
    }
  }

  const { redisCircuitBreaker } = await import('../services/circuit-breaker.js')

  const overallStatus = dbStatus === 'ok' ? 'ok' : 'degraded'

  return jsonOk(c, {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {
      database: { status: dbStatus, ...(dbLatency !== undefined ? { latency_ms: dbLatency } : {}) },
      redis: { status: redisStatus, ...(redisLatency !== undefined ? { latency_ms: redisLatency } : {}) },
      cache_circuit: redisCircuitBreaker.currentState,
    },
  }) as any
})

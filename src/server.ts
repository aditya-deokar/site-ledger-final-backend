// import 'dotenv/config'
// import { serve } from '@hono/node-server'
// import { app } from './app.js'
// import { loadEnv } from './config/env.js'
// import { createLogger } from './config/logger.js'
// import { connectRedis, disconnectRedis } from './db/redis.js'
// import { disconnectPrisma } from './db/prisma.js'
// import { cors } from 'hono/cors'

// const env = loadEnv()
// const log = createLogger('server')

// // ── Startup ─────────────────────────────────────────

// async function start() {
//   // Connect Redis (non-blocking — app runs even if Redis fails)
//   await connectRedis()

//   const server = serve({
//     fetch: app.fetch,
//     port: env.PORT,
//     hostname: "0.0.0.0",
//   })

//   // Handle port-in-use and other server errors gracefully
//   server.on('error', (err: NodeJS.ErrnoException) => {
//     if (err.code === 'EADDRINUSE') {
//       log.fatal({ port: env.PORT }, `Port ${env.PORT} is already in use. Kill the other process or change PORT in .env`)
//     } else {
//       log.fatal({ err: err.message, code: err.code }, 'Server error')
//     }
//     process.exit(1)
//   })

//   server.on('listening', () => {
//     log.info({ port: env.PORT, env: env.NODE_ENV }, `Server running on http://localhost:${env.PORT}`)
//   })

//   // ── Graceful Shutdown ───────────────────────────────

//   let shuttingDown = false

//   async function shutdown(signal: string) {
//     if (shuttingDown) return
//     shuttingDown = true
//     log.info({ signal }, 'Graceful shutdown initiated')

//     // 1. Stop accepting new connections + wait for in-flight (max 10s)
//     await new Promise<void>((resolve) => {
//       const timeout = setTimeout(() => {
//         log.warn('Shutdown timeout reached, forcing close')
//         resolve()
//       }, 10_000)

//       server.close(() => {
//         clearTimeout(timeout)
//         log.info('HTTP server closed')
//         resolve()
//       })
//     })

//     // 2. Disconnect services
//     await disconnectRedis()
//     await disconnectPrisma()

//     log.info('Shutdown complete')
//     process.exit(0)
//   }

//   process.on('SIGTERM', () => shutdown('SIGTERM'))
//   process.on('SIGINT', () => shutdown('SIGINT'))
// }

// start().catch((err) => {
//   log.fatal({ err }, 'Failed to start server')
//   process.exit(1)
// })



import 'dotenv/config'
import { serve } from '@hono/node-server'
import { app } from './app.js'
import { loadEnv } from './config/env.js'
import { createLogger } from './config/logger.js'
import { connectRedis, disconnectRedis } from './db/redis.js'
import { disconnectPrisma } from './db/prisma.js'
import { cors } from 'hono/cors'

const env = loadEnv()
const log = createLogger('server')

// ── Startup ─────────────────────────────────────────

async function start() {
  // Connect Redis (non-blocking — app runs even if Redis fails)
  void connectRedis()

  const server = serve({
    fetch: app.fetch,
    port: env.PORT,
    hostname: "0.0.0.0", // Crucial for Docker access
  })

  // Handle port-in-use and other server errors gracefully
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.fatal({ port: env.PORT }, `Port ${env.PORT} is already in use. Kill the other process or change PORT in .env`)
    } else {
      log.fatal({ err: err.message, code: err.code }, 'Server error')
    }
    process.exit(1)
  })

  server.on('listening', () => {
    log.info({ port: env.PORT, env: env.NODE_ENV }, `Server running on http://localhost:${env.PORT}`)
  })

  // ── Graceful Shutdown ───────────────────────────────

  let shuttingDown = false

  async function shutdown(signal: string) {
    if (shuttingDown) return
    shuttingDown = true
    log.info({ signal }, 'Graceful shutdown initiated')

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        log.warn('Shutdown timeout reached, forcing close')
        resolve()
      }, 10_000)

      server.close(() => {
        clearTimeout(timeout)
        log.info('HTTP server closed')
        resolve()
      })
    })

    await disconnectRedis()
    await disconnectPrisma()

    log.info('Shutdown complete')
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

start().catch((err) => {
  log.fatal({ err }, 'Failed to start server')
  process.exit(1)
})

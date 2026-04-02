import pino from 'pino'
import { loadEnv } from './env.js'

let env: ReturnType<typeof loadEnv>
try {
  env = loadEnv()
} catch {
  env = { NODE_ENV: 'development', LOG_LEVEL: 'info' } as ReturnType<typeof loadEnv>
}

export const logger = pino({
  level: env.LOG_LEVEL,
  ...(env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
  base: { service: 'gaa-builders', env: env.NODE_ENV, pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
})

export function createLogger(component: string) {
  return logger.child({ component })
}

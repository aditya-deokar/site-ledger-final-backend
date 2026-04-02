import { createClient, type RedisClientType } from 'redis'
import { createLogger } from '../config/logger.js'
import { loadEnv } from '../config/env.js'

const log = createLogger('redis')

let client: RedisClientType | null = null

export function getRedisClient(): RedisClientType | null {
  return client
}

export function isRedisReady(): boolean {
  return client?.isReady ?? false
}

export async function connectRedis(): Promise<void> {
  const env = loadEnv()

  client = createClient({
    username: env.REDIS_USERNAME,
    password: env.REDIS_PASSWORD,
    socket: {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      connectTimeout: env.REDIS_CONNECT_TIMEOUT,
      reconnectStrategy(retries) {
        if (retries > 20) {
          log.error({ retries }, 'Redis max reconnect attempts reached, giving up')
          return new Error('Redis max reconnect attempts exceeded')
        }
        const delay = Math.min(retries * 100, 30_000)
        log.warn({ retries, delay }, 'Redis reconnecting')
        return delay
      },
      ...(env.REDIS_TLS ? { tls: true } : {}),
    },
  }) as RedisClientType

  client.on('connect', () => log.info('Redis connecting'))
  client.on('ready', () => log.info('Redis ready'))
  client.on('error', (err) => log.error({ err: err.message }, 'Redis client error'))
  client.on('end', () => log.warn('Redis connection closed'))

  try {
    await client.connect()
    log.info({ host: env.REDIS_HOST, port: env.REDIS_PORT }, 'Redis connected successfully')
  } catch (err) {
    log.error({ err: (err as Error).message }, 'Redis initial connection failed — running without cache')
    client = null
  }
}

export async function disconnectRedis(): Promise<void> {
  if (client) {
    try {
      await client.quit()
      log.info('Redis disconnected gracefully')
    } catch (err) {
      log.error({ err: (err as Error).message }, 'Redis disconnect error, forcing close')
      try { client.disconnect() } catch { /* ignore */ }
    }
    client = null
  }
}

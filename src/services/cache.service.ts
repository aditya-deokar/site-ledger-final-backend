import { getRedisClient, isRedisReady } from '../db/redis.js'
import { redisCircuitBreaker } from './circuit-breaker.js'
import { createLogger } from '../config/logger.js'

const log = createLogger('cache')

class CacheService {
  async get<T>(key: string): Promise<T | null> {
    if (!this.canOperate()) return null

    try {
      const client = getRedisClient()
      if (!client) return null

      const data = await client.get(key)
      if (data === null) {
        log.info({ key }, 'Cache MISS')
        return null
      }

      redisCircuitBreaker.onSuccess()
      log.info({ key }, 'Cache HIT')
      return JSON.parse(data) as T
    } catch (err) {
      this.handleError('GET', key, err)
      return null
    }
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (!this.canOperate()) return

    try {
      const client = getRedisClient()
      if (!client) return

      const serialized = JSON.stringify(value)

      if (ttlSeconds) {
        await client.setEx(key, ttlSeconds, serialized)
      } else {
        await client.set(key, serialized)
      }

      redisCircuitBreaker.onSuccess()
      log.info({ key, ttl: ttlSeconds }, 'Cache SET')
    } catch (err) {
      this.handleError('SET', key, err)
    }
  }

  async del(key: string): Promise<void> {
    if (!this.canOperate()) return

    try {
      const client = getRedisClient()
      if (!client) return

      await client.del(key)
      redisCircuitBreaker.onSuccess()
      log.info({ key }, 'Cache DEL')
    } catch (err) {
      this.handleError('DEL', key, err)
    }
  }

  async delByPattern(pattern: string): Promise<void> {
    if (!this.canOperate()) return

    try {
      const client = getRedisClient()
      if (!client) return

      for await (const keys of client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
        if (Array.isArray(keys)) {
          for (const key of keys) await client.del(key)
        } else {
          await client.del(keys as string)
        }
      }

      redisCircuitBreaker.onSuccess()
      log.debug({ pattern }, 'Cache del by pattern')
    } catch (err) {
      this.handleError('DEL_PATTERN', pattern, err)
    }
  }

  isHealthy(): boolean {
    return isRedisReady() && redisCircuitBreaker.isAllowed()
  }

  private canOperate(): boolean {
    if (!isRedisReady()) return false
    if (!redisCircuitBreaker.isAllowed()) {
      log.debug({ state: redisCircuitBreaker.currentState }, 'Circuit breaker blocking Redis operation')
      return false
    }
    return true
  }

  private handleError(operation: string, key: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    redisCircuitBreaker.onFailure()

    // Detect OOM — skip writes but reads may still work
    if (message.includes('OOM')) {
      log.error({ operation, key, err: message, circuit_state: redisCircuitBreaker.currentState }, 'Redis OOM — memory full')
      return
    }

    // Detect auth failure — fatal
    if (message.includes('WRONGPASS') || message.includes('NOAUTH')) {
      log.fatal({ operation, key, err: message }, 'Redis auth failure — check credentials')
      return
    }

    log.error({ operation, key, err: message, circuit_state: redisCircuitBreaker.currentState }, 'Redis command failed')
  }
}

export const cacheService = new CacheService()

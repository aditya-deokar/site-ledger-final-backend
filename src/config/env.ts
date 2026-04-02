import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  PORT: z.coerce.number().int().positive().default(5000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Redis
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_USERNAME: z.string().default('default'),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_TLS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  REDIS_CONNECT_TIMEOUT: z.coerce.number().int().positive().default(5000),
  REDIS_COMMAND_TIMEOUT: z.coerce.number().int().positive().default(3000),
})

export type Env = z.infer<typeof envSchema>

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    throw new Error(`Invalid environment variables:\n${issues.join('\n')}`)
  }
  return parsed.data
}

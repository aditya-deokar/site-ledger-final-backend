import 'dotenv/config'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

function normalizeConnectionString(connectionString: string) {
  if (/([?&])uselibpqcompat=/i.test(connectionString)) {
    return connectionString
  }

  // pg currently treats these aliases as verify-full anyway, so normalize now
  // to preserve the same TLS behavior and avoid the deprecation warning.
  return connectionString.replace(/([?&]sslmode=)(prefer|require|verify-ca)(?=(&|$))/i, '$1verify-full')
}

const rawConnectionString = process.env.DATABASE_URL?.trim().replace(/^['"]|['"]$/g, '')

if (!rawConnectionString) {
  throw new Error('DATABASE_URL is required to initialize Prisma Client')
}

const connectionString = normalizeConnectionString(rawConnectionString)
const adapter = new PrismaPg({ connectionString })

export const prisma = new PrismaClient({
  adapter,
  log: ['warn', 'error'],
})

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect()
}

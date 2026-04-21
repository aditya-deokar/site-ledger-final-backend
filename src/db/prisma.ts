import 'dotenv/config'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

const connectionString = process.env.DATABASE_URL?.trim().replace(/^['"]|['"]$/g, '')

if (!connectionString) {
  throw new Error('DATABASE_URL is required to initialize Prisma Client')
}

const adapter = new PrismaPg({ connectionString })

export const prisma = new PrismaClient({
  adapter,
  log: ['warn', 'error'],
})

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect()
}

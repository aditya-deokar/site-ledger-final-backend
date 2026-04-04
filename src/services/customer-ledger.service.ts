import { prisma } from '../db/prisma.js'
import { getCustomerPaidTotal, sumLedgerAmounts, type LedgerReadDb } from './ledger-read.service.js'

export { getCustomerPaidTotal, sumLedgerAmounts } from './ledger-read.service.js'

export async function getCustomerRemaining(
  customerId: string,
  tx?: LedgerReadDb,
): Promise<number> {
  const db = tx ?? prisma
  const customer = await db.customer.findUnique({
    where: { id: customerId },
    select: { sellingPrice: true },
  })

  if (!customer) {
    throw new Error('CUSTOMER_NOT_FOUND')
  }

  const paidTotal = await getCustomerPaidTotal(customerId, db)
  return customer.sellingPrice - paidTotal
}

import { prisma } from '../db/prisma.js'
import { getCustomerPaidTotal, sumDirectionalLedgerAmounts, sumLedgerAmounts, type LedgerReadDb } from './ledger-read.service.js'

export { getCustomerPaidTotal, sumDirectionalLedgerAmounts, sumLedgerAmounts } from './ledger-read.service.js'

export async function getCustomerRemaining(
  customerId: string,
  tx?: LedgerReadDb,
): Promise<number> {
  const db = tx ?? prisma
  const customer = await db.customer.findUnique({
    where: { id: customerId },
    select: {
      sellingPrice: true,
      agreementLines: {
        where: { isDeleted: false },
        select: { type: true, amount: true },
      },
    },
  })

  if (!customer) {
    throw new Error('CUSTOMER_NOT_FOUND')
  }

  const agreementTotal = customer.agreementLines.length > 0
    ? customer.agreementLines.reduce((sum, line) => {
        const amount = Number(line.amount)
        return sum + (line.type === 'DISCOUNT' || line.type === 'CREDIT' ? -amount : amount)
      }, 0)
    : customer.sellingPrice

  const paidTotal = await getCustomerPaidTotal(customerId, db)
  return agreementTotal - paidTotal
}

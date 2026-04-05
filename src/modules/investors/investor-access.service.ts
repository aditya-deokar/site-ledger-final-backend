import { prisma } from '../../db/prisma.js'
import { getCompanyForUser } from '../../shared/access/company-access.js'

export async function getInvestorForUser(investorId: string, userId: string) {
  const company = await getCompanyForUser(userId)
  if (!company) return { company: null, investor: null }

  const investor = await prisma.investor.findFirst({
    where: { id: investorId, companyId: company.id, isDeleted: false },
  })

  return { company, investor }
}

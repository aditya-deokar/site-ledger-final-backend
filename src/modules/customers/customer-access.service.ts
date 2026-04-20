import { prisma } from '../../db/prisma.js'
import { getCompanyForUser } from '../../shared/access/company-access.js'

export async function verifySiteOwnership(siteId: string, userId: string) {
  const company = await getCompanyForUser(userId)
  if (!company) return { company: null, site: null }

  const site = await prisma.site.findFirst({
    where: { id: siteId, companyId: company.id },
  })

  return { company, site }
}

export async function getCustomerForUser(
  customerId: string,
  userId: string,
  options?: { includeCancelled?: boolean },
) {
  const company = await getCompanyForUser(userId)
  if (!company) return { company: null, customer: null }

  const customer = await prisma.customer.findFirst({
    where: {
      id: customerId,
      companyId: company.id,
      isDeleted: false,
      ...(options?.includeCancelled ? {} : { dealStatus: 'ACTIVE' }),
    },
  })

  return { company, customer }
}

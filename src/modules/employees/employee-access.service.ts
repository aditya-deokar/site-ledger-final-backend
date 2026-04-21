import { prisma } from '../../db/prisma.js'
import { getCompanyForUser } from '../../shared/access/company-access.js'

export async function getEmployeeForUser(
  employeeId: string,
  userId: string,
  options?: { includeDeleted?: boolean },
) {
  const company = await getCompanyForUser(userId)
  if (!company) return { company: null, employee: null }

  const employee = await prisma.employee.findFirst({
    where: {
      id: employeeId,
      companyId: company.id,
      ...(options?.includeDeleted ? {} : { isDeleted: false }),
    },
  })

  return { company, employee }
}

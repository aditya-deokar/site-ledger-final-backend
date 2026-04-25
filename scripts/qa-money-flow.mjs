import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import bcrypt from 'bcryptjs'

const BASE_URL = process.env.QA_API_BASE_URL || 'http://localhost:5000/api'
const connectionString = process.env.DATABASE_URL?.trim().replace(/^['"]|['"]$/g, '')

if (!connectionString) {
  throw new Error('DATABASE_URL missing')
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const email = `qa-${runId}@sitesledger.test`
const password = `QaPass${runId}!1a`
const state = { email, userId: null, companyId: null, siteId: null }
const results = []

function round(value) {
  return Math.round(Number(value || 0) * 100) / 100
}

function record(name, pass, details = {}) {
  results.push({ name, pass: Boolean(pass), details })
  const status = pass ? 'PASS' : 'FAIL'
  const suffix = Object.keys(details).length ? ` | ${JSON.stringify(details)}` : ''
  console.log(`${status} | ${name}${suffix}`)
}

async function api(path, options = {}) {
  const { method = 'GET', body, token, allowError = false } = options
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Number(process.env.QA_API_TIMEOUT_MS || 15000))

  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = { raw: text.slice(0, 300) }
    }

    if (!allowError && !res.ok) {
      const message = json?.error || json?.message || text.slice(0, 200)
      throw new Error(`${method} ${path} -> ${res.status}: ${message}`)
    }

    return { status: res.status, ok: res.ok, json }
  } finally {
    clearTimeout(timeout)
  }
}

async function okData(path, options = {}) {
  const res = await api(path, options)
  if (!res.json?.ok) {
    throw new Error(`${options.method || 'GET'} ${path} did not return ok:true`)
  }
  return res.json.data
}

async function walletBalance(companyId, walletType, siteId = undefined) {
  const rows = await prisma.payment.findMany({
    where: {
      companyId,
      walletType,
      ...(siteId ? { siteId } : {}),
    },
    select: { direction: true, amount: true },
  })

  return round(rows.reduce((sum, row) => {
    return sum + (row.direction === 'IN' ? Number(row.amount) : -Number(row.amount))
  }, 0))
}

async function cleanup() {
  try {
    let resolvedCompanyId = state.companyId
    let resolvedUserId = state.userId

    if (!resolvedCompanyId && resolvedUserId) {
      const company = await prisma.company.findUnique({
        where: { createdBy: resolvedUserId },
        select: { id: true },
      })
      resolvedCompanyId = company?.id ?? null
    }

    if (!resolvedUserId) {
      const user = await prisma.user.findUnique({
        where: { email: state.email },
        select: { id: true },
      })
      resolvedUserId = user?.id ?? null
    }

    if (resolvedCompanyId) {
      const [sites, employees, investors] = await Promise.all([
        prisma.site.findMany({ where: { companyId: resolvedCompanyId }, select: { id: true } }),
        prisma.employee.findMany({ where: { companyId: resolvedCompanyId }, select: { id: true } }),
        prisma.investor.findMany({ where: { companyId: resolvedCompanyId }, select: { id: true } }),
      ])
      const siteIds = sites.map((site) => site.id)
      const employeeIds = employees.map((employee) => employee.id)
      const investorIds = investors.map((investor) => investor.id)

      await prisma.payment.deleteMany({ where: { companyId: resolvedCompanyId } })
      await prisma.salaryReminder.deleteMany({ where: { employeeId: { in: employeeIds } } })
      await prisma.employeeTransaction.deleteMany({ where: { employeeId: { in: employeeIds } } })
      await prisma.attendance.deleteMany({ where: { employeeId: { in: employeeIds } } })
      await prisma.employeeDocument.deleteMany({ where: { employeeId: { in: employeeIds } } })
      await prisma.employee.deleteMany({ where: { companyId: resolvedCompanyId } })
      await prisma.investorTransaction.deleteMany({ where: { investorId: { in: investorIds } } })
      await prisma.investor.deleteMany({ where: { companyId: resolvedCompanyId } })
      await prisma.companyWithdrawal.deleteMany({ where: { companyId: resolvedCompanyId } })
      await prisma.expense.deleteMany({ where: { siteId: { in: siteIds } } })
      await prisma.customer.deleteMany({ where: { companyId: resolvedCompanyId } })
      await prisma.flat.deleteMany({ where: { siteId: { in: siteIds } } })
      await prisma.floor.deleteMany({ where: { siteId: { in: siteIds } } })
      await prisma.wing.deleteMany({ where: { siteId: { in: siteIds } } })
      await prisma.site.deleteMany({ where: { companyId: resolvedCompanyId } })
      await prisma.vendor.deleteMany({ where: { companyId: resolvedCompanyId } })
      await prisma.partner.deleteMany({ where: { companyId: resolvedCompanyId } })
      await prisma.company.deleteMany({ where: { id: resolvedCompanyId } })
    }

    await prisma.verificationCode.deleteMany({ where: { email: state.email } })
    if (resolvedUserId) {
      await prisma.user.deleteMany({ where: { id: resolvedUserId } })
    } else {
      await prisma.user.deleteMany({ where: { email: state.email } })
    }

    console.log(`CLEANUP | deleted disposable tenant ${state.email}`)
  } catch (err) {
    console.error(`CLEANUP_FAIL | ${err?.message || err}`)
  }
}

async function run() {
  const health = await api('/health', { allowError: true })
  record('Backend health endpoint is reachable', health.ok, { status: health.status })

  const passwordHash = await bcrypt.hash(password, 10)
  const user = await prisma.user.create({
    data: { email, passwordHash, firstName: 'QA', lastName: 'Ledger' },
  })
  state.userId = user.id
  record('Disposable QA user seeded directly', true, { email })

  const login = await okData('/auth/signin', { method: 'POST', body: { email, password } })
  const token = login.accessToken
  record('API login returns JWT for disposable user', Boolean(token))

  const company = await okData('/company', {
    method: 'POST',
    token,
    body: { name: `QA Builders ${runId}`, address: 'QA Road' },
  })
  state.companyId = company.company.id
  record('Company can be created', Boolean(state.companyId), { companyId: state.companyId })

  const partner = await okData('/company/partners', {
    method: 'POST',
    token,
    body: { name: 'QA Capital Partner', investmentAmount: 1000000, stakePercentage: 100 },
  })
  record('Partner capital increases company wallet', round(await walletBalance(state.companyId, 'COMPANY')) === 1000000, {
    wallet: await walletBalance(state.companyId, 'COMPANY'),
    partnerId: partner.partner.id,
  })

  const siteResp = await okData('/sites', {
    method: 'POST',
    token,
    body: { name: `QA Site ${runId}`, address: 'QA Site Address', totalFloors: 1, totalFlats: 3 },
  })
  state.siteId = siteResp.site.id
  record('Site can be created', Boolean(state.siteId), { siteId: state.siteId })

  const floorsResp = await okData(`/sites/${state.siteId}/floors`, { token })
  const floor = floorsResp.floors[0]
  const [flatA, flatB] = floor.flats
  record('Auto-created site has usable flats', floorsResp.floors.length === 1 && floor.flats.length === 3, {
    floors: floorsResp.floors.length,
    flats: floor.flats.length,
  })

  const allocation = await okData(`/sites/${state.siteId}/fund`, {
    method: 'POST',
    token,
    body: { amount: 600000, note: 'QA allocation' },
  })
  record(
    'Company to site allocation updates both wallets',
    round(await walletBalance(state.companyId, 'COMPANY')) === 400000
      && round(await walletBalance(state.companyId, 'SITE', state.siteId)) === 600000,
    {
      companyWallet: await walletBalance(state.companyId, 'COMPANY'),
      siteWallet: await walletBalance(state.companyId, 'SITE', state.siteId),
      apiSiteFund: allocation.siteAllocatedFund,
    },
  )

  const booking = await okData(`/sites/${state.siteId}/flats/${flatA.id}/customer`, {
    method: 'POST',
    token,
    body: {
      name: 'QA Buyer One',
      phone: '9999990001',
      email: 'buyer1@example.com',
      sellingPrice: 500000,
      bookingAmount: 100000,
      paymentMode: 'UPI',
      referenceNumber: 'QA-BOOK-1',
    },
  })
  const customerId = booking.customer.id
  record(
    'Flat booking records customer payment and marks flat booked',
    booking.customer.amountPaid === 100000
      && booking.customer.remaining === 400000
      && booking.customer.flatStatus === 'BOOKED',
    {
      customerId,
      amountPaid: booking.customer.amountPaid,
      remaining: booking.customer.remaining,
      flatStatus: booking.customer.flatStatus,
    },
  )

  const initialAgreement = await okData(`/customers/${customerId}/agreement`, { token })
  const baseLine = initialAgreement.agreement.lines.find((line) => line.type === 'BASE_PRICE')
  record(
    'Booking creates a base agreement line and keeps payable equal to the base price',
    Boolean(baseLine)
      && round(initialAgreement.agreement.totals.payableTotal) === 500000
      && round(initialAgreement.agreement.totals.profitRevenue) === 500000,
    {
      baseLineId: baseLine?.id,
      payableTotal: initialAgreement.agreement.totals.payableTotal,
      profitRevenue: initialAgreement.agreement.totals.profitRevenue,
    },
  )

  const extraBase = await api(`/customers/${customerId}/agreement-lines`, {
    method: 'POST',
    token,
    body: { type: 'BASE_PRICE', label: 'Duplicate base', amount: 1000, affectsProfit: true },
    allowError: true,
  })
  record('Duplicate base price lines are rejected', extraBase.status === 400, {
    status: extraBase.status,
    error: extraBase.json?.error,
  })

  const taxLine = await okData(`/customers/${customerId}/agreement-lines`, {
    method: 'POST',
    token,
    body: { type: 'TAX', label: 'GST 10%', amount: 50000, affectsProfit: false },
  })
  const chargeLine = await okData(`/customers/${customerId}/agreement-lines`, {
    method: 'POST',
    token,
    body: { type: 'CHARGE', label: 'Parking', amount: 10000, affectsProfit: true },
  })
  const discountLine = await okData(`/customers/${customerId}/agreement-lines`, {
    method: 'POST',
    token,
    body: { type: 'DISCOUNT', label: 'Closing Discount', amount: 10000, affectsProfit: true },
  })
  const agreementAfterLines = await okData(`/customers/${customerId}/agreement`, { token })
  record(
    'Tax, charge, and discount lines keep agreement total and profit basis separate',
    round(agreementAfterLines.agreement.totals.payableTotal) === 550000
      && round(agreementAfterLines.agreement.totals.tax) === 50000
      && round(agreementAfterLines.agreement.totals.charges) === 10000
      && round(agreementAfterLines.agreement.totals.discounts) === 10000
      && round(agreementAfterLines.agreement.totals.profitRevenue) === 500000
      && round(agreementAfterLines.agreement.remaining) === 450000,
    {
      payableTotal: agreementAfterLines.agreement.totals.payableTotal,
      tax: agreementAfterLines.agreement.totals.tax,
      charges: agreementAfterLines.agreement.totals.charges,
      discounts: agreementAfterLines.agreement.totals.discounts,
      profitRevenue: agreementAfterLines.agreement.totals.profitRevenue,
      remaining: agreementAfterLines.agreement.remaining,
      taxLineId: taxLine.line.id,
      chargeLineId: chargeLine.line.id,
      discountLineId: discountLine.line.id,
    },
  )

  const deleteBaseLine = baseLine?.id
    ? await api(`/customers/${customerId}/agreement-lines/${baseLine.id}`, {
      method: 'DELETE',
      token,
      allowError: true,
    })
    : { status: 0, json: { error: 'Base line missing' } }
  record('Base agreement line cannot be deleted', deleteBaseLine.status === 400, {
    status: deleteBaseLine.status,
    error: deleteBaseLine.json?.error,
  })

  const installment = await okData(`/customers/${customerId}/payment`, {
    method: 'PATCH',
    token,
    body: {
      amount: 450000,
      paymentMode: 'BANK_TRANSFER',
      referenceNumber: 'QA-INST-1',
      note: 'Final installment',
    },
  })
  const soldFlat = await prisma.flat.findUnique({ where: { id: flatA.id }, select: { status: true } })
  record(
    'Final customer payment marks flat sold and clears balance',
    installment.customer.amountPaid === 550000
      && installment.customer.remaining === 0
      && soldFlat?.status === 'SOLD',
    {
      amountPaid: installment.customer.amountPaid,
      remaining: installment.customer.remaining,
      dbFlatStatus: soldFlat?.status,
    },
  )

  const overpayCustomer = await api(`/customers/${customerId}/payment`, {
    method: 'PATCH',
    token,
    body: { amount: 1, paymentMode: 'CASH' },
    allowError: true,
  })
  record('Customer overpayment is rejected', overpayCustomer.status === 400, {
    status: overpayCustomer.status,
    error: overpayCustomer.json?.error,
  })

  const customerPayments = await okData(`/customers/${customerId}/payments`, { token })
  const lastPayment = customerPayments.payments.find((payment) => payment.referenceNumber === 'QA-INST-1')
  record(
    'Customer payment history keeps payment mode and reference',
    Boolean(lastPayment?.paymentMode === 'BANK_TRANSFER' && lastPayment?.referenceNumber === 'QA-INST-1'),
    { paymentMode: lastPayment?.paymentMode, referenceNumber: lastPayment?.referenceNumber },
  )

  const booking2 = await okData(`/sites/${state.siteId}/flats/${flatB.id}/customer`, {
    method: 'POST',
    token,
    body: {
      name: 'QA Buyer Two',
      phone: '9999990002',
      sellingPrice: 200000,
      bookingAmount: 50000,
      paymentMode: 'CASH',
    },
  })
  const cancel = await okData(`/sites/${state.siteId}/flats/${flatB.id}/customer/${booking2.customer.id}/cancel`, {
    method: 'PATCH',
    token,
    body: { reason: 'QA cancellation', refundAmount: 50000 },
  })
  const canceledFlat = await prisma.flat.findUnique({ where: { id: flatB.id }, select: { status: true } })
  record(
    'Customer cancellation refunds and frees flat',
    cancel.customer.dealStatus === 'CANCELLED'
      && canceledFlat?.status === 'AVAILABLE'
      && cancel.refund?.amount === 50000,
    {
      dealStatus: cancel.customer.dealStatus,
      flatStatus: canceledFlat?.status,
      refund: cancel.refund?.amount,
    },
  )

  const vendor = await okData('/vendors', {
    method: 'POST',
    token,
    body: { name: 'QA Cement Vendor', type: 'SUPPLIER', phone: '8888880001', email: 'vendor@example.com' },
  })
  const vendorId = vendor.vendor.id
  record('Vendor can be created', Boolean(vendorId), { vendorId })

  const expense = await okData(`/sites/${state.siteId}/expenses`, {
    method: 'POST',
    token,
    body: { type: 'VENDOR', vendorId, description: 'Cement bill', amount: 120000, amountPaid: 20000 },
  })
  const expenseId = expense.expense.id
  const expensePay = await okData(`/sites/${state.siteId}/expenses/${expenseId}/payment`, {
    method: 'PATCH',
    token,
    body: { amount: 100000, note: 'Final vendor payment' },
  })
  const vendorSummary = await okData(`/vendors/${vendorId}`, { token })
  record(
    'Vendor expense payment completes payable and vendor summary',
    expensePay.expense.paymentStatus === 'COMPLETED'
      && vendorSummary.vendor.totalBilled === 120000
      && vendorSummary.vendor.totalPaid === 120000
      && vendorSummary.vendor.totalOutstanding === 0,
    {
      expenseStatus: expensePay.expense.paymentStatus,
      vendorBilled: vendorSummary.vendor.totalBilled,
      vendorPaid: vendorSummary.vendor.totalPaid,
      vendorOutstanding: vendorSummary.vendor.totalOutstanding,
    },
  )

  const expenseOverpay = await api(`/sites/${state.siteId}/expenses/${expenseId}/payment`, {
    method: 'PATCH',
    token,
    body: { amount: 1 },
    allowError: true,
  })
  record('Vendor/expense overpayment is rejected', expenseOverpay.status === 400, {
    status: expenseOverpay.status,
    error: expenseOverpay.json?.error,
  })

  const siteWithdraw = await okData(`/sites/${state.siteId}/withdraw`, {
    method: 'POST',
    token,
    body: { amount: 50000, note: 'QA pullback' },
  })
  record(
    'Site to company withdrawal updates both wallets',
    round(await walletBalance(state.companyId, 'COMPANY')) === 450000
      && round(await walletBalance(state.companyId, 'SITE', state.siteId)) === 980000,
    {
      companyWallet: await walletBalance(state.companyId, 'COMPANY'),
      siteWallet: await walletBalance(state.companyId, 'SITE', state.siteId),
      apiCompanyFund: siteWithdraw.companyAvailableFund,
    },
  )

  const companyWithdraw = await okData('/company/withdraw', {
    method: 'POST',
    token,
    body: { amount: 25000, amountPaid: 10000, note: 'Owner draw' },
  })
  record(
    'Company withdrawal only deducts paid amount and tracks remaining',
    companyWithdraw.withdrawal.amountPaid === 10000
      && companyWithdraw.withdrawal.remaining === 15000
      && round(await walletBalance(state.companyId, 'COMPANY')) === 440000,
    {
      amountPaid: companyWithdraw.withdrawal.amountPaid,
      remaining: companyWithdraw.withdrawal.remaining,
      companyWallet: await walletBalance(state.companyId, 'COMPANY'),
    },
  )

  const fixedInvestor = await okData('/investors', {
    method: 'POST',
    token,
    body: { name: 'QA Fixed Investor', type: 'FIXED_RATE', fixedRate: 12, phone: '7777770001' },
  })
  const fixedInvestorId = fixedInvestor.investor.id
  const fixedPrincipal = await okData(`/investors/${fixedInvestorId}/transactions`, {
    method: 'POST',
    token,
    body: { amount: 100000, amountPaid: 100000, note: 'Fixed principal' },
  })
  const fixedReturn = await okData(`/investors/${fixedInvestorId}/return`, {
    method: 'POST',
    token,
    body: { amount: 30000, amountPaid: 30000, note: 'Partial principal return' },
  })
  const fixedInterest = await okData(`/investors/${fixedInvestorId}/interest`, {
    method: 'POST',
    token,
    body: { amount: 5000, amountPaid: 5000, note: 'Interest payout' },
  })
  record(
    'Fixed-rate investor principal, return and interest update company wallet',
    fixedPrincipal.investor.totalInvested === 100000
      && fixedReturn.investor.totalReturned === 30000
      && fixedInterest.investor.interestPaid === 5000
      && round(await walletBalance(state.companyId, 'COMPANY')) === 505000,
    {
      totalInvested: fixedPrincipal.investor.totalInvested,
      totalReturned: fixedReturn.investor.totalReturned,
      interestPaid: fixedInterest.investor.interestPaid,
      companyWallet: await walletBalance(state.companyId, 'COMPANY'),
    },
  )

  const equityInvestor = await okData('/investors', {
    method: 'POST',
    token,
    body: {
      name: 'QA Equity Investor',
      type: 'EQUITY',
      siteId: state.siteId,
      equityPercentage: 10,
      phone: '7777770002',
    },
  })
  const equityInvestorId = equityInvestor.investor.id
  const equityPrincipal = await okData(`/investors/${equityInvestorId}/transactions`, {
    method: 'POST',
    token,
    body: { amount: 100000, amountPaid: 100000, note: 'Equity principal' },
  })
  const equityPayout = await okData(`/investors/${equityInvestorId}/interest`, {
    method: 'POST',
    token,
    body: { amount: 20000, amountPaid: 20000, note: 'Profit share' },
  })
  const equityOverpay = await api(`/investors/${equityInvestorId}/interest`, {
    method: 'POST',
    token,
    body: { amount: 50000, amountPaid: 50000, note: 'Too much profit share' },
    allowError: true,
  })
  record(
    'Equity investor funds site and profit payout is capped',
    equityPrincipal.investor.totalInvested === 100000
      && equityPayout.investor.interestPaid === 20000
      && equityOverpay.status === 400,
    {
      totalInvested: equityPrincipal.investor.totalInvested,
      profitPaid: equityPayout.investor.interestPaid,
      overpayStatus: equityOverpay.status,
      siteWallet: await walletBalance(state.companyId, 'SITE', state.siteId),
    },
  )

  const report = await okData(`/sites/${state.siteId}/report`, { token })
  record(
    'Site report agrees with primary ledger totals before unsafe probes',
    report.report.financialSummary.customerCollections === 550000
      && report.report.financialSummary.totalAgreementValue === 550000
      && report.report.financialSummary.netSaleValue === 500000
      && report.report.expenseSummary.totalPaid === 120000
      && report.report.investorSummary.totalInvested === 100000,
    {
      customerCollections: report.report.financialSummary.customerCollections,
      agreementValue: report.report.financialSummary.totalAgreementValue,
      netSaleValue: report.report.financialSummary.netSaleValue,
      expensePaid: report.report.expenseSummary.totalPaid,
      equityInvested: report.report.investorSummary.totalInvested,
      remainingFund: report.report.financialSummary.remainingFund,
    },
  )

  const sellingProbe = await api(`/sites/${state.siteId}/flats/${flatA.id}/customer/${customerId}`, {
    method: 'PUT',
    token,
    body: { name: 'QA Buyer One Renamed', sellingPrice: 600000 },
    allowError: true,
  })
  const customerAfterPriceProbe = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { sellingPrice: true, name: true },
  })
  const silentlyIgnored = sellingProbe.ok && round(customerAfterPriceProbe?.sellingPrice) === 500000
  record('Selling price revision is explicit, rejected, or handled safely', !silentlyIgnored, {
    status: sellingProbe.status,
    dbSellingPrice: round(customerAfterPriceProbe?.sellingPrice),
    dbName: customerAfterPriceProbe?.name,
  })

  const historicalPaymentDate = '2020-01-02T00:00:00.000Z'
  const datedExpense = await okData(`/sites/${state.siteId}/expenses`, {
    method: 'POST',
    token,
    body: {
      type: 'GENERAL',
      reason: 'Dated QA payment',
      amount: 1000,
      amountPaid: 200,
      paymentDate: historicalPaymentDate,
    },
  })
  const datedPayment = await prisma.payment.findFirst({
    where: { expenseId: datedExpense.expense.id },
    orderBy: { postedAt: 'asc' },
    select: { postedAt: true },
  })
  record('Expense initial payment uses supplied paymentDate', datedPayment?.postedAt?.toISOString() === historicalPaymentDate, {
    requested: historicalPaymentDate,
    apiPaymentDate: datedExpense.expense.paymentDate,
    dbPostedAt: datedPayment?.postedAt?.toISOString(),
  })

  const beforeDeleteReport = await okData(`/sites/${state.siteId}/report`, { token })
  const beforeDeleteFund = await okData(`/sites/${state.siteId}/fund`, { token })
  const deletePaidExpense = await api(`/sites/${state.siteId}/expenses/${datedExpense.expense.id}`, {
    method: 'DELETE',
    token,
    allowError: true,
  })
  const afterDeleteReport = await okData(`/sites/${state.siteId}/report`, { token })
  const afterDeleteFund = await okData(`/sites/${state.siteId}/fund`, { token })
  const reportDroppedPaid = round(afterDeleteReport.report.expenseSummary.totalPaid) < round(beforeDeleteReport.report.expenseSummary.totalPaid)
  const fundStayedAffected = round(afterDeleteFund.remainingFund) === round(beforeDeleteFund.remainingFund)
  record(
    'Paid expense cannot disappear from reports while ledger cash remains affected',
    deletePaidExpense.status >= 400 || (!reportDroppedPaid && !fundStayedAffected),
    {
      deleteStatus: deletePaidExpense.status,
      reportPaidBefore: beforeDeleteReport.report.expenseSummary.totalPaid,
      reportPaidAfter: afterDeleteReport.report.expenseSummary.totalPaid,
      fundBefore: beforeDeleteFund.remainingFund,
      fundAfter: afterDeleteFund.remainingFund,
    },
  )

  const flatBeforeManual = await prisma.flat.findUnique({
    where: { id: flatA.id },
    select: { status: true },
  })
  const manualFlatChange = await api(`/sites/${state.siteId}/floors/${floor.id}/flats/${flatA.id}`, {
    method: 'PUT',
    token,
    body: { status: 'AVAILABLE' },
    allowError: true,
  })
  const flatAfterManual = await prisma.flat.findUnique({
    where: { id: flatA.id },
    select: { status: true, customer: { select: { id: true, dealStatus: true } } },
  })
  record(
    'Manual flat status change is blocked when an active customer exists',
    manualFlatChange.status >= 400 && flatAfterManual?.status === flatBeforeManual?.status,
    {
      status: manualFlatChange.status,
      dbFlatStatusBefore: flatBeforeManual?.status,
      dbFlatStatus: flatAfterManual?.status,
      activeCustomerId: flatAfterManual?.customer?.id,
      activeCustomerDealStatus: flatAfterManual?.customer?.dealStatus,
    },
  )

  const directTransferGroups = await prisma.payment.groupBy({
    by: ['entryGroupId'],
    where: { companyId: state.companyId, entryGroupId: { not: null } },
    _count: { _all: true },
  })
  const brokenTransferGroups = directTransferGroups.filter((group) => group._count._all !== 2).length
  record('Disposable tenant has no broken paired transfers before cleanup', brokenTransferGroups === 0, {
    brokenTransferGroups,
  })
}

try {
  await run()
} catch (err) {
  console.error(`FATAL | ${err?.stack || err?.message || err}`)
  record('QA scenario completed without fatal exception', false, {
    error: err?.message || String(err),
  })
} finally {
  await cleanup()
  const leftovers = await prisma.user.count({ where: { email } })
  console.log(`LEFTOVER_CHECK | qaUserRows=${leftovers}`)
  await prisma.$disconnect()

  const passed = results.filter((result) => result.pass).length
  const failed = results.length - passed
  console.log(`SUMMARY | passed=${passed} failed=${failed} total=${results.length}`)
  const failedNames = results.filter((result) => !result.pass).map((result) => result.name)
  if (failedNames.length) {
    console.log(`FAILED_CHECKS | ${JSON.stringify(failedNames)}`)
  }

  process.exit(failed > 0 ? 1 : 0)
}

import { sumLedgerAmounts } from '../../services/customer-ledger.service.js'

export function mapCompanyCustomerSummary(customer: {
  id: string
  name: string
  phone: string | null
  email: string | null
  sellingPrice: number
  bookingAmount: number
  flatId: string | null
  siteId: string | null
  createdAt: Date
  ledgerEntries: Array<{ amount: number | string | { toString(): string } }>
  flat: {
    flatNumber: number | null
    status: string
    floor: { floorNumber: number | null } | null
  } | null
  site: { id: string; name: string } | null
}) {
  const amountPaid = sumLedgerAmounts(customer.ledgerEntries)

  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    sellingPrice: customer.sellingPrice,
    bookingAmount: customer.bookingAmount,
    amountPaid,
    remaining: customer.sellingPrice - amountPaid,
    flatId: customer.flatId,
    flatNumber: customer.flat?.flatNumber ?? null,
    floorNumber: customer.flat?.floor?.floorNumber ?? null,
    flatStatus: customer.flat?.status ?? null,
    siteId: customer.siteId,
    siteName: customer.site?.name ?? null,
    createdAt: customer.createdAt,
  }
}

export function mapSiteCustomerResponse(customer: {
  id: string
  name: string
  phone: string | null
  email: string | null
  sellingPrice: number
  bookingAmount: number
  customerType: 'CUSTOMER' | 'EXISTING_OWNER' | null
  flatId: string | null
  createdAt: Date
  ledgerEntries: Array<{ amount: number | string | { toString(): string } }>
  flat: {
    flatNumber: number | null
    customFlatId: string | null
    status: string
    floor: { floorNumber: number; floorName: string | null }
  }
}) {
  const amountPaid = sumLedgerAmounts(customer.ledgerEntries)

  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    sellingPrice: customer.sellingPrice,
    bookingAmount: customer.bookingAmount,
    amountPaid,
    remaining: customer.sellingPrice - amountPaid,
    customerType: customer.customerType,
    flatId: customer.flatId,
    flatNumber: customer.flat.flatNumber,
    floorNumber: customer.flat.floor.floorNumber,
    customFlatId: customer.flat.customFlatId ?? null,
    floorName: customer.flat.floor.floorName ?? null,
    flatStatus: customer.flat.status,
    createdAt: customer.createdAt,
  }
}

export function mapFlatCustomerResponse(customer: {
  id: string
  name: string
  phone: string | null
  email: string | null
  sellingPrice: number
  bookingAmount: number
  customerType: 'CUSTOMER' | 'EXISTING_OWNER' | null
  flatId: string | null
  createdAt: Date
  ledgerEntries: Array<{ amount: number | string | { toString(): string } }>
  flat: {
    flatNumber: number | null
    status: string
    floor: { floorNumber: number }
  }
}) {
  const amountPaid = sumLedgerAmounts(customer.ledgerEntries)

  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    sellingPrice: customer.sellingPrice,
    bookingAmount: customer.bookingAmount,
    amountPaid,
    remaining: customer.sellingPrice - amountPaid,
    customerType: customer.customerType,
    flatId: customer.flatId,
    flatNumber: customer.flat.flatNumber,
    floorNumber: customer.flat.floor.floorNumber,
    flatStatus: customer.flat.status,
    createdAt: customer.createdAt,
  }
}

export function mapBookingCustomerResponse(input: {
  customer: {
    id: string
    name: string
    phone: string | null
    email: string | null
    sellingPrice: number
    bookingAmount: number
    customerType: 'CUSTOMER' | 'EXISTING_OWNER' | null
    flatId: string | null
    createdAt: Date
  }
  flatNumber: number | null
  floorNumber: number
  flatStatus: string
  amountPaid: number
  remaining: number
}) {
  return {
    id: input.customer.id,
    name: input.customer.name,
    phone: input.customer.phone,
    email: input.customer.email,
    sellingPrice: input.customer.sellingPrice,
    bookingAmount: input.customer.bookingAmount,
    amountPaid: input.amountPaid,
    remaining: input.remaining,
    customerType: input.customer.customerType,
    flatId: input.customer.flatId,
    flatNumber: input.flatNumber,
    floorNumber: input.floorNumber,
    flatStatus: input.flatStatus,
    createdAt: input.customer.createdAt,
  }
}

export function mapUpdatedCustomerResponse(input: {
  customer: {
    id: string
    name: string
    phone: string | null
    email: string | null
    sellingPrice: number
    bookingAmount: number
    customerType: 'CUSTOMER' | 'EXISTING_OWNER' | null
    flatId: string | null
    createdAt: Date
    flat: { flatNumber: number | null; floor: { floorNumber: number } }
  }
  flatStatus: string
  amountPaid: number
  remaining: number
}) {
  return {
    id: input.customer.id,
    name: input.customer.name,
    phone: input.customer.phone,
    email: input.customer.email,
    sellingPrice: input.customer.sellingPrice,
    bookingAmount: input.customer.bookingAmount,
    amountPaid: input.amountPaid,
    remaining: input.remaining,
    customerType: input.customer.customerType,
    flatId: input.customer.flatId,
    flatNumber: input.customer.flat.flatNumber,
    floorNumber: input.customer.flat.floor.floorNumber,
    flatStatus: input.flatStatus,
    createdAt: input.customer.createdAt,
  }
}

export function mapCustomerPaymentHistoryItem(payment: {
  id: string
  amount: number | string | { toString(): string }
  note: string | null
  postedAt: Date
}) {
  return {
    id: payment.id,
    amount: Number(payment.amount),
    note: payment.note,
    createdAt: payment.postedAt,
  }
}

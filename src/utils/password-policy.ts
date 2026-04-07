export const PASSWORD_POLICY_SUMMARY =
  'Password must be at least 8 characters and include uppercase, lowercase, number, and special character.'

export const COMMON_PASSWORD_MESSAGE =
  'This password is too common. Please choose a stronger password.'

const COMMON_WEAK_PASSWORDS = new Set([
  '123123123',
  'password',
  'admin123',
  '12345678',
  'qwerty123',
])

const PASSWORD_RULES = [
  {
    id: 'length',
    message: 'Password must be at least 8 characters long.',
    test: (password: string) => password.length >= 8,
  },
  {
    id: 'uppercase',
    message: 'Password must include at least one uppercase letter.',
    test: (password: string) => /[A-Z]/.test(password),
  },
  {
    id: 'lowercase',
    message: 'Password must include at least one lowercase letter.',
    test: (password: string) => /[a-z]/.test(password),
  },
  {
    id: 'number',
    message: 'Password must include at least one number.',
    test: (password: string) => /[0-9]/.test(password),
  },
  {
    id: 'special',
    message: 'Password must include at least one special character.',
    test: (password: string) => /[^A-Za-z0-9\s]/.test(password),
  },
] as const

export function isCommonWeakPassword(password: string) {
  return COMMON_WEAK_PASSWORDS.has(password)
}

export function getPasswordValidationMessages(password: string) {
  const messages = PASSWORD_RULES
    .filter((rule) => !rule.test(password))
    .map((rule) => rule.message)

  if (isCommonWeakPassword(password)) {
    return [COMMON_PASSWORD_MESSAGE, ...messages]
  }

  return messages
}

export function getPasswordValidationMessage(password: string) {
  return getPasswordValidationMessages(password)[0] ?? null
}

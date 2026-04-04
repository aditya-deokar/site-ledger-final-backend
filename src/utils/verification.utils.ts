import { VERIFICATION_CODE_LENGTH } from '../constants/auth.constants.js';

/**
 * Generates a n-digit numeric code for verification.
 * By default it's 6 digits.
 */
export function generateVerificationCode(): string {
  const min = Math.pow(10, VERIFICATION_CODE_LENGTH - 1);
  const max = Math.pow(10, VERIFICATION_CODE_LENGTH) - 1;
  return Math.floor(min + Math.random() * (max - min + 1)).toString();
}

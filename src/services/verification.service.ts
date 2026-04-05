import { prisma } from '../db/prisma.js';
import { generateVerificationCode } from '../utils/verification.utils.js';
import { sendVerificationEmail } from '../utils/email.utils.js'; 
import { VERIFICATION_CODE_EXPIRY_MINUTES } from '../constants/auth.constants.js';
import { VerificationType } from '@prisma/client';

export class VerificationService {
  /**
   * Generates a code, stores it in DB, and sends it to the user.
   */
  static async sendVerificationCode(email: string, type: VerificationType, payload?: any) {
    const code = generateVerificationCode();
    const expiresAt = new Date(Date.now() + VERIFICATION_CODE_EXPIRY_MINUTES * 60 * 1000);

    // Store or update in DB
    await prisma.verificationCode.upsert({
      where: { email_type: { email, type } },
      update: { code, payload, expiresAt, createdAt: new Date() },
      create: { email, code, type, payload, expiresAt },
    });

    // Send email
    await sendVerificationEmail(email, code);
    return code; // Return code for response in development / testing if needed, safely handled in routes.
  }

  /**
   * Checks if a code is valid for a given email and type.
   */
  static async verifyCode(email: string, code: string, type: VerificationType) {
    const entry = await prisma.verificationCode.findUnique({
      where: { email_type: { email, type } },
    });

    if (!entry) return { success: false, message: 'Invalid or expired verification code' };
    if (entry.code !== code) return { success: false, message: 'Verification code is incorrect' };
    if (entry.expiresAt < new Date()) {
      // Cleanup expired code
      await this.cleanup(email, type);
      return { success: false, message: 'Verification code has expired' };
    }

    return { success: true, payload: entry.payload };
  }

  /**
   * Removes a code from DB after successful verification.
   */
  static async cleanup(email: string, type: VerificationType) {
    await prisma.verificationCode.delete({
      where: { email_type: { email, type } },
    }).catch(() => {}); // Ignore if not exists
  }
}

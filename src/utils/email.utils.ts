import nodemailer from 'nodemailer';
import { loadEnv } from '../config/env.js';
import { VERIFICATION_CODE_EXPIRY_MINUTES } from '../constants/auth.constants.js';

const env = loadEnv();

/**
 * Creates a transporter for sending emails.
 */
const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST || 'smtp.ethereal.email', // Using ethereal for dev if no SMTP config is provided
  port: env.SMTP_PORT || 587,
  auth: {
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
  },
});

/**
 * Sends a verification email containing a numeric code.
 */
export async function sendVerificationEmail(email: string, code: string) {
  const from = env.SMTP_FROM || 'noreply@site-ledger.com';
  
  // If no HOST is provided, log to console for development
  if (!env.SMTP_HOST) {
    console.log(`[DEV EMAIL] To: ${email}, Code: ${code}`);
    return;
  }

  try {
    await transporter.sendMail({
      from: `"SiteLedger" <${from}>`,
      to: email,
      subject: 'Verify your account',
      text: `Your verification code is: ${code}. It will expire in ${VERIFICATION_CODE_EXPIRY_MINUTES} minutes.`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #efefef; border-radius: 10px;">
          <h2 style="color: #333;">Welcome to SiteLedger</h2>
          <p>Please use the following 6-digit code to verify your account:</p>
          <div style="font-size: 32px; font-weight: bold; background: #f4f4f4; padding: 10px; text-align: center; border-radius: 5px; letter-spacing: 5px; color: #000;">
            ${code}
          </div>
          <p style="color: #666; margin-top: 20px;">This code will expire in ${VERIFICATION_CODE_EXPIRY_MINUTES} minutes.</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
          <p style="font-size: 12px; color: #aaa;">If you did not request this, please ignore this email.</p>
        </div>
      `,
    });
  } catch (error) {
    console.error('Failed to send email:', error);
    // In dev, we might not want to throw and break the flow if SMTP is just misconfigured
    if (env.NODE_ENV === 'production') {
      throw error;
    }
  }
}

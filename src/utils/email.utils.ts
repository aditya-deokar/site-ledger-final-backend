import nodemailer from 'nodemailer';
import { loadEnv } from '../config/env.js';
import { VERIFICATION_CODE_EXPIRY_MINUTES } from '../constants/auth.constants.js';

const env = loadEnv();

/**
 * Creates a transporter for sending emails when SMTP is configured.
 */
function getTransporter() {
  if (!env.SMTP_HOST) {
    return null;
  }

  if (!env.SMTP_USER || !env.SMTP_PASS) {
    throw new Error('SMTP is configured, but SMTP_USER or SMTP_PASS is missing.');
  }

  const port = env.SMTP_PORT || 587;

  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
  });
}

function isSmtpAuthError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'EAUTH'
  );
}

/**
 * Sends a verification email containing a numeric code.
 */
export async function sendVerificationEmail(email: string, code: string) {
  const from = env.SMTP_FROM || env.SMTP_USER || 'noreply@site-ledger.com';

  // If no HOST is provided, log to console for development
  if (!env.SMTP_HOST) {
    console.log(`[DEV EMAIL] To: ${email}, Code: ${code}`);
    return;
  }

  const transporter = getTransporter();

  try {
    await transporter?.sendMail({
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

    if (isSmtpAuthError(error)) {
      throw new Error(
        'SMTP authentication failed. Update SMTP_USER and SMTP_PASS. If you are using Gmail, SMTP_PASS must be a Google App Password.',
        { cause: error },
      );
    }

    if (error instanceof Error) {
      throw new Error(`Failed to send verification email: ${error.message}`, { cause: error });
    }

    throw new Error('Failed to send verification email.');
  }
}

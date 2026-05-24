/**
 * Email notification service.
 * Wraps SMTP transport with template rendering and delivery tracking.
 */

export interface EmailTemplate {
  subject: string;
  htmlBody: string;
  textBody: string;
}

export interface EmailMessage {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  from?: string;
  replyTo?: string;
  template: EmailTemplate;
  attachments?: Array<{ filename: string; content: Buffer | string; mimeType: string }>;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;     // TLS on connect (port 465)
  user: string;
  password: string;
  fromAddress: string;
  fromName: string;
}

/** Sanitize an email address list to an array. */
function toArray(addr: string | string[] | undefined): string[] {
  if (!addr) return [];
  return Array.isArray(addr) ? addr : [addr];
}

/**
 * Send an email via SMTP.
 * This is a stub — real impl would use nodemailer or similar.
 */
export async function sendEmail(
  config: SmtpConfig,
  message: EmailMessage
): Promise<SendResult> {
  const recipients = [
    ...toArray(message.to),
    ...toArray(message.cc),
  ];

  if (recipients.length === 0) throw new Error("No recipients specified");

  // Validate addresses
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const invalid = recipients.filter((r) => !emailRe.test(r));
  if (invalid.length > 0) throw new Error(`Invalid recipient addresses: ${invalid.join(", ")}`);

  void config;
  // Stub — log the message and return fake result
  const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@${config.host}>`;
  return { messageId, accepted: recipients, rejected: [] };
}

// ─── Template helpers ──────────────────────────────────────────────────────────

/** Interpolate a template string by replacing {{key}} placeholders. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

export const TEMPLATES = {
  welcomeEmail: (name: string, verifyLink: string): EmailTemplate => ({
    subject: `Welcome to the platform, ${name}!`,
    htmlBody: `<p>Hi ${name},</p><p>Click <a href="${verifyLink}">here</a> to verify your email.</p>`,
    textBody: `Hi ${name},\n\nClick here to verify your email: ${verifyLink}`,
  }),

  passwordReset: (resetLink: string, expiryMinutes: number): EmailTemplate => ({
    subject: "Password reset request",
    htmlBody: `<p>A password reset was requested. <a href="${resetLink}">Reset now</a> (expires in ${expiryMinutes} minutes).</p>`,
    textBody: `A password reset was requested. Visit: ${resetLink}\n\nExpires in ${expiryMinutes} minutes.`,
  }),
};

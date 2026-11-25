import nodemailer from "nodemailer";

const STORE = "arvessofragrances@gmail.com";

export function mailIsConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export async function sendStoreMail(message: { to: string; subject: string; text: string }) {
  const to = message.to.trim().toLowerCase();
  if (!to.includes("@") || to.endsWith("@arvessofragrances.local")) {
    return { sent: false as const, reason: "no-address" as const };
  }
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    return { sent: false as const, reason: "not-configured" as const };
  }
  const port = Number(process.env.SMTP_PORT || 587);
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  await transport.sendMail({
    from: process.env.MAIL_FROM || `Arvessó Fragrances <${user}>`,
    replyTo: STORE,
    to,
    subject: message.subject,
    text: message.text,
  });
  return { sent: true as const };
}

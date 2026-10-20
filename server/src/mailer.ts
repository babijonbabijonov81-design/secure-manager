// Outgoing email for verification and recovery codes. Configure ONE of:
//   BREVO_API_KEY  + MAIL_FROM   (https://brevo.com, free 300 emails/day, works on any hosting)
//   RESEND_API_KEY + MAIL_FROM   (https://resend.com)
//   SMTP_URL       + MAIL_FROM   (e.g. smtps://user:app-password@smtp.gmail.com:465)
//   MAIL_LOG=1                   (development: print codes to the server log instead)
//   MAIL_LOG=/path/mail.jsonl    (tests: append messages to a file)

export type Mailer = (message: { to: string; subject: string; html: string; text: string }) => Promise<void>;

function parseFrom(from: string): { email: string; name: string } {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  return match ? { name: match[1] || 'Veil', email: match[2] } : { name: 'Veil', email: from.trim() };
}

async function check(response: Response, provider: string): Promise<void> {
  if (!response.ok) throw new Error(`${provider}: ${response.status} ${await response.text().catch(() => '')}`.slice(0, 300));
}

export function mailerFromEnv(env: NodeJS.ProcessEnv, log: (message: string) => void): Mailer | null {
  const from = env.MAIL_FROM ?? '';
  if (env.BREVO_API_KEY && from) {
    const sender = parseFrom(from);
    return async ({ to, subject, html, text }) =>
      check(
        await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': env.BREVO_API_KEY!, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ sender, to: [{ email: to }], subject, htmlContent: html, textContent: text }),
        }),
        'Brevo',
      );
  }
  if (env.RESEND_API_KEY && from) {
    return async ({ to, subject, html, text }) =>
      check(
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from, to: [to], subject, html, text }),
        }),
        'Resend',
      );
  }
  if (env.SMTP_URL && from) {
    let transport: { sendMail(options: object): Promise<unknown> } | null = null;
    return async ({ to, subject, html, text }) => {
      if (!transport) {
        const nodemailer = await import('nodemailer');
        transport = nodemailer.createTransport(env.SMTP_URL!);
      }
      await transport.sendMail({ from, to, subject, html, text });
    };
  }
  if (env.MAIL_LOG === '1') {
    return async ({ to, text }) => log(`[mail to ${to}] ${text}`);
  }
  if (env.MAIL_LOG) {
    // Testing: append messages as JSON lines to the given file.
    const file = env.MAIL_LOG;
    return async ({ to, text }) => {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(file, `${JSON.stringify({ to, text, at: Date.now() })}\n`);
    };
  }
  return null;
}

export function codeEmail(code: string, purpose: 'confirm' | 'recover'): { subject: string; html: string; text: string } {
  const title = purpose === 'confirm' ? 'Подтверждение почты' : 'Восстановление аккаунта';
  const lead =
    purpose === 'confirm'
      ? 'Вы указали эту почту для восстановления аккаунта Veil. Введите код в приложении:'
      : 'Кто-то (надеемся, вы) восстанавливает аккаунт Veil на новом устройстве. Код:';
  const text = `${title}\n\n${lead} ${code}\n\nКод действует 15 минут. Если это были не вы — просто проигнорируйте письмо.`;
  const html = `<!doctype html><html><body style="margin:0;background:#f2f4f8;font-family:-apple-system,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table width="440" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:20px;padding:36px;box-shadow:0 10px 40px rgba(20,30,60,.08)">
<tr><td style="font-size:22px;font-weight:800;color:#141824;padding-bottom:6px">🛡️ Veil</td></tr>
<tr><td style="font-size:17px;font-weight:700;color:#141824;padding:12px 0 4px">${title}</td></tr>
<tr><td style="font-size:14px;line-height:1.55;color:#5a6075">${lead}</td></tr>
<tr><td align="center" style="padding:24px 0"><div style="display:inline-block;font-size:34px;letter-spacing:10px;font-weight:800;color:#141824;background:#eef1f6;border-radius:14px;padding:14px 22px">${code}</div></td></tr>
<tr><td style="font-size:12.5px;line-height:1.5;color:#8e93a6">Код действует 15 минут. Если это были не вы — просто проигнорируйте письмо, без кода доступ к аккаунту получить нельзя.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject: `${code} — ${title} Veil`, html, text };
}

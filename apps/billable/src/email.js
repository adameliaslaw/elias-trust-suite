'use strict';
// Payment-request email via SendGrid, adapted from the firm's
// estate-plan-generator template: firm-branded header, amount + description
// card, a Pay Now button, and a confidentiality footer.
//
// Config: sendgridApiKey (kept out of the dashboard config API),
//         firmName, firmEmail, firmPhone, emailColor (optional).

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function buildPaymentEmail(config, { clientName, amountCents, description, payUrl }) {
  const firmName = config.firmName || 'Your Law Firm';
  const firmEmail = config.firmEmail || '';
  const firmPhone = config.firmPhone || '';
  const color = config.emailColor || '#1a365d';
  const formattedAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
    .format(amountCents / 100);
  const contactLine = [firmPhone, firmEmail].filter(Boolean).join(' &nbsp;|&nbsp; ');

  const bodyHtml = `
<h2 style="margin:0 0 16px;font-size:22px;color:#1a202c;">Payment Request</h2>
<p style="margin:0 0 12px;">
  Dear ${escapeHtml(clientName || 'Valued Client')}, a payment of <strong>${formattedAmount}</strong>
  is requested for the following:
</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0;width:100%;">
  <tr>
    <td style="padding:12px 20px;background:#f0f4f8;border-radius:6px;border-left:4px solid ${color};">
      <strong>Description:</strong> ${escapeHtml(description)}<br />
      <strong>Amount Due:</strong> <span style="font-size:18px;font-weight:700;color:#1a202c;">${formattedAmount}</span>
    </td>
  </tr>
</table>
<p style="margin:0 0 24px;">Please click the button below to complete your secure payment:</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px auto;">
  <tr>
    <td align="center" style="border-radius:6px;background-color:${color};">
      <a href="${escapeHtml(payUrl)}" target="_blank"
         style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;
                color:#ffffff;text-decoration:none;border-radius:6px;
                background-color:${color};mso-padding-alt:14px 32px;"
      >Pay Now — ${formattedAmount}</a>
    </td>
  </tr>
</table>
<p style="margin:24px 0 0;font-size:13px;color:#718096;">
  If the button does not work, copy and paste this link into your browser:<br />
  <a href="${escapeHtml(payUrl)}" style="color:${color};word-break:break-all;">${escapeHtml(payUrl)}</a>
</p>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1.0" /><title>${escapeHtml(firmName)}</title></head>
<body style="margin:0;padding:0;background-color:#f4f6f9;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Payment of ${formattedAmount} requested&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f9;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0"
             style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.08);overflow:hidden;">
        <tr><td style="background-color:${color};padding:24px 32px;text-align:center;">
          <div style="font-size:22px;font-weight:700;color:#ffffff;">${escapeHtml(firmName)}</div>
        </td></tr>
        <tr><td style="padding:32px 40px 24px;color:#1a202c;font-size:15px;line-height:1.6;">${bodyHtml}</td></tr>
        <tr><td style="padding:0 40px;"><hr style="border:none;border-top:1px solid #e2e8f0;margin:0;" /></td></tr>
        <tr><td style="padding:20px 40px 28px;color:#718096;font-size:12px;line-height:1.5;">
          <p style="margin:0 0 8px;">${escapeHtml(firmName)}${contactLine ? ` &nbsp;|&nbsp; ${contactLine}` : ''}</p>
          <p style="margin:0;font-size:11px;color:#a0aec0;">
            <strong>CONFIDENTIALITY NOTICE:</strong> This email and any attachments are for the
            exclusive and confidential use of the intended recipient.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return {
    subject: `Payment Request — ${formattedAmount} — ${firmName}`,
    html,
  };
}

async function sendPaymentEmail(config, { to, clientName, amountCents, description, payUrl }, fetchImpl = fetch) {
  const key = (config.sendgridApiKey || '').trim();
  if (!key) {
    throw new Error('SendGrid not configured. Set it with: billable config sendgridApiKey <key> ' +
      '(and firmEmail for the from address)');
  }
  if (!config.firmEmail) {
    throw new Error('Set the from address first: billable config firmEmail you@yourfirm.com');
  }
  const { subject, html } = buildPaymentEmail(config, { clientName, amountCents, description, payUrl });
  const res = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to, name: clientName || '' }], subject }],
      from: { email: config.firmEmail, name: config.firmName || config.firmEmail },
      content: [{ type: 'text/html', value: html }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SendGrid error ${res.status}: ${body.slice(0, 300)}`);
  }
  return { to, subject };
}

module.exports = { buildPaymentEmail, sendPaymentEmail };

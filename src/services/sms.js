import twilio from 'twilio';

const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

function normalizePhoneNumber(phone) {
  const raw = String(phone ?? '').trim();

  if (!raw) return null;

  const digits = raw.replace(/\D/g, '');

  // Indian mobile: 9322677248 -> +919322677248
  if (digits.length === 10) {
    return `+91${digits}`;
  }

  // Indian mobile: 919322677248 -> +919322677248
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+${digits}`;
  }

  const candidate = `+${digits}`;

  return E164_PATTERN.test(candidate) ? candidate : null;
}

function formatMoney(value) {
  return `Rs ${Number(value || 0).toLocaleString('en-IN')}`;
}

function planLabel(planTier) {
  const labels = {
    basic: 'Basic',
    standard: 'Standard',
    premium: 'Premium',
  };

  return labels[planTier] || planTier || 'Plan';
}

function getSenderOptions() {
  const messagingServiceSid =
    process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();

  const from = process.env.TWILIO_SMS_FROM?.trim();

  if (messagingServiceSid) {
    return { messagingServiceSid };
  }

  if (from) {
    return { from };
  }

  return null;
}

export function buildStudentEnrollmentSmsMessage({
  parentPhone,
  schoolName,
  studentName,
  planTier,
  planDuration,
  amount,
  paidAmount,
  remainingAmount,
  loginEmail,
}) {
  const appUrl = process.env.STUDENT_APP_URL || '';

  const lines = [
    `Student Shield: ${studentName} has been enrolled at ${schoolName}.`,
    `Plan: ${planLabel(planTier)} (${planDuration || 'yearly'}).`,
    `Fees: ${formatMoney(amount)}. Paid: ${formatMoney(paidAmount)}. Pending: ${formatMoney(remainingAmount)}.`,
    `Login: ${loginEmail}.`,
    appUrl ? `App: ${appUrl}` : null,
    '- Student Shield',
  ].filter(Boolean);

  return {
    to: normalizePhoneNumber(parentPhone),
    message: lines.join(' '),
  };
}

export async function sendSmsTextMessage({ to, message }) {
  if (process.env.SMS_ENABLED !== 'true') {
    return {
      sent: false,
      skipped: true,
      reason: 'SMS_ENABLED is not true',
    };
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const senderOptions = getSenderOptions();

  if (!accountSid || !authToken) {
    return {
      sent: false,
      skipped: true,
      reason: 'Twilio credentials are missing',
    };
  }

  if (!senderOptions) {
    return {
      sent: false,
      skipped: true,
      reason:
        'Configure TWILIO_MESSAGING_SERVICE_SID or TWILIO_SMS_FROM',
    };
  }

  if (!to) {
    return {
      sent: false,
      skipped: true,
      reason: 'Parent phone number is missing or invalid',
    };
  }

  const body = String(message ?? '').trim();

  if (!body) {
    return {
      sent: false,
      skipped: true,
      reason: 'SMS body is empty',
    };
  }

  try {
    const client = twilio(accountSid, authToken);

    const response = await client.messages.create({
      to,
      body,
      ...senderOptions,
    });

    return {
      sent: true,
      to: response.to,
      message_id: response.sid,
      status: response.status,
    };
  } catch (error) {
    return {
      sent: false,
      error: error?.message || 'Twilio SMS send failed',
      code: error?.code ?? null,
      status: error?.status ?? null,
    };
  }
}
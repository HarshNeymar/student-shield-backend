function normalizeIndianPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');

  if (!digits) return null;

  // If 10 digit Indian number, prefix 91
  if (digits.length === 10) {
    return `91${digits}`;
  }

  // If already has country code
  return digits;
}

function formatMoney(value) {
  return `₹${Number(value || 0).toLocaleString('en-IN')}`;
}

function paymentTypeLabel(type) {
  const labels = {
    one_time: 'One-Time Payment',
    installment: 'Installment Payment',
    paid_with_fees: 'Paid with School Fees',
  };

  return labels[type] || type || 'Payment';
}

function planLabel(plan) {
  const labels = {
    basic: 'Basic Plan',
    standard: 'Standard Plan',
    premium: 'Premium Plan',
  };

  return labels[plan] || plan || 'Plan';
}

export function buildStudentEnrollmentWhatsAppMessage({
  parentPhone,
  schoolName,
  studentName,
  classAssigned,
  planTier,
  planDuration,
  amount,
  paymentMode,
  paymentType,
  paidAmount,
  remainingAmount,
  installmentDates = [],
  receipt,
  loginEmail,
  password,
}) {
  const appUrl = process.env.STUDENT_APP_URL || 'Student Shield app';

  const lines = [
    `🎓 *Student Shield Enrollment Confirmation*`,
    ``,
    `Dear Parent,`,
    ``,
    `Your child has been enrolled successfully in *Student Shield*.`,
    ``,
    `*Student Details*`,
    `Name: ${studentName}`,
    `Class: ${classAssigned || '-'}`,
    `School: ${schoolName}`,
    ``,
    `*Plan Details*`,
    `Plan: ${planLabel(planTier)}`,
    `Duration: ${planDuration || 'yearly'}`,
    `Total Fees: ${formatMoney(amount)}`,
    ``,
    `*Payment Details*`,
    `Payment Type: ${paymentTypeLabel(paymentType)}`,
    `Payment Mode: ${paymentMode || '-'}`,
    `Paid Amount: ${formatMoney(paidAmount)}`,
    `Pending Amount: ${formatMoney(remainingAmount)}`,
  ];

  if (paymentType === 'installment') {
    lines.push(
      ``,
      `*Installment Details*`,
      `1st Installment: ${formatMoney(paidAmount)} - Paid`,
      `2nd Installment: ${formatMoney(remainingAmount)} - Pending`,
      `1st Date: ${installmentDates?.[0] || '-'}`,
      `2nd Due Date: ${installmentDates?.[1] || '-'}`
    );
  }

  lines.push(
    ``,
    `*Receipt*`,
    `Receipt No: ${receipt?.receipt_no || receipt?.receiptNo || '-'}`,
    ``,
    `*Student Login Details*`,
    `Login Email: ${loginEmail}`,
    `Password: ${password}`,
    ``,
    `App Link: ${appUrl}`,
    ``,
    `Thank you,`,
    `*${schoolName} / Student Shield Team*`
  );

  return {
    to: normalizeIndianPhone(parentPhone),
    message: lines.join('\n'),
  };
}

export async function sendWhatsAppTextMessage({ to, message }) {
  if (process.env.WHATSAPP_ENABLED !== 'true') {
    return {
      sent: false,
      skipped: true,
      reason: 'WHATSAPP_ENABLED is not true',
    };
  }

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v20.0';

  if (!phoneNumberId || !accessToken) {
    return {
      sent: false,
      skipped: true,
      reason: 'WhatsApp credentials missing',
    };
  }

  if (!to) {
    return {
      sent: false,
      skipped: true,
      reason: 'Parent phone number missing',
    };
  }

  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: {
        preview_url: false,
        body: message,
      },
    }),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    return {
      sent: false,
      error: data?.error?.message || 'WhatsApp send failed',
      raw: data,
    };
  }

  return {
    sent: true,
    to,
    message_id: data?.messages?.[0]?.id ?? null,
    raw: data,
  };
}
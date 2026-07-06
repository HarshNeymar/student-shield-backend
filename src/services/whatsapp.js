function normalizeWhatsAppRecipient(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');

  if (!digits) return null;

  // Indian local mobile: 9322677248 -> 919322677248
  if (/^[6-9]\d{9}$/.test(digits)) {
    return `91${digits}`;
  }

  // Supports input such as 0091XXXXXXXXXX
  const normalized = digits.startsWith('00') ? digits.slice(2) : digits;

  return /^\d{8,15}$/.test(normalized) ? normalized : null;
}

function textValue(value, fallback = '-') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function planLabel(planTier) {
  const labels = {
    basic: 'Basic',
    standard: 'Standard',
    premium: 'Premium',
  };

  return labels[String(planTier ?? '').toLowerCase()] || 'Plan';
}

export function buildStudentEnrollmentWhatsAppTemplate({
  parentPhone,
  studentName,
  schoolName,
  planTier,
  loginEmail,
}) {
  return {
    to: normalizeWhatsAppRecipient(parentPhone),

    templateName:
      process.env.WHATSAPP_STUDENT_ENROLLMENT_TEMPLATE?.trim() ||
      'student_enrollment_confirmation',

    languageCode:
      process.env.WHATSAPP_STUDENT_ENROLLMENT_TEMPLATE_LANGUAGE?.trim() ||
      'en_US',

    // Must match {{1}}, {{2}}, {{3}}, {{4}} in Meta template body.
    bodyParameters: [
      textValue(studentName),
      textValue(schoolName),
      planLabel(planTier),
      textValue(loginEmail),
    ],
  };
}

export async function sendWhatsAppTemplateMessage({
  to,
  templateName,
  languageCode,
  bodyParameters = [],
}) {
  if (process.env.WHATSAPP_ENABLED !== 'true') {
    return {
      sent: false,
      skipped: true,
      reason: 'WHATSAPP_ENABLED is not true',
    };
  }

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  const apiVersion = process.env.WHATSAPP_API_VERSION?.trim();

  if (!phoneNumberId || !accessToken || !apiVersion) {
    return {
      sent: false,
      skipped: true,
      reason:
        'WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, or WHATSAPP_API_VERSION is missing',
    };
  }

  if (!to) {
    return {
      sent: false,
      skipped: true,
      reason: 'Parent WhatsApp number is missing or invalid',
    };
  }

  if (!templateName) {
    return {
      sent: false,
      skipped: true,
      reason: 'WhatsApp template name is missing',
    };
  }

  try {
    const response = await fetch(
      `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'template',
          template: {
            name: templateName,
            language: {
              code: languageCode,
            },
            components: [
              {
                type: 'body',
                parameters: bodyParameters.map((value) => ({
                  type: 'text',
                  text: textValue(value),
                })),
              },
            ],
          },
        }),
      }
    );

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      return {
        sent: false,
        to,
        error: data?.error?.message || 'WhatsApp template send failed',
        code: data?.error?.code ?? null,
        error_subcode: data?.error?.error_subcode ?? null,
        raw: data,
      };
    }

    return {
      sent: true,
      accepted: true,
      to,
      message_id: data?.messages?.[0]?.id ?? null,
      status: data?.messages?.[0]?.message_status || 'accepted',
    };
  } catch (error) {
    return {
      sent: false,
      to,
      error: error?.message || 'WhatsApp request failed',
    };
  }
}
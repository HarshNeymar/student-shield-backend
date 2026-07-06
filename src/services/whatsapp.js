function normalizeWhatsAppRecipient(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');

  if (!digits) return null;

  // Indian local number: 9322677248 -> 919322677248
  if (/^[6-9]\d{9}$/.test(digits)) {
    return `91${digits}`;
  }

  // Supports 0091XXXXXXXXXX as well
  const normalized = digits.startsWith('00') ? digits.slice(2) : digits;

  return /^\d{8,15}$/.test(normalized) ? normalized : null;
}

function normalizeMetaId(value) {
  const id = String(value ?? '')
    .trim()
    .replace(/^["']|["']$/g, '');

  return /^\d{8,30}$/.test(id) ? id : null;
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

function getWhatsAppConfig() {
  const phoneNumberId = normalizeMetaId(
    process.env.WHATSAPP_PHONE_NUMBER_ID
  );

  const wabaId = normalizeMetaId(
    process.env.WHATSAPP_WABA_ID
  );

  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  const apiVersion = process.env.WHATSAPP_API_VERSION?.trim();

  if (!phoneNumberId) {
    return {
      valid: false,
      reason: 'WHATSAPP_PHONE_NUMBER_ID is missing or invalid',
    };
  }

  if (!accessToken) {
    return {
      valid: false,
      reason: 'WHATSAPP_ACCESS_TOKEN is missing',
    };
  }

  if (!apiVersion) {
    return {
      valid: false,
      reason: 'WHATSAPP_API_VERSION is missing',
    };
  }

  if (wabaId && phoneNumberId === wabaId) {
    return {
      valid: false,
      reason:
        'WHATSAPP_PHONE_NUMBER_ID is incorrectly set to the WABA ID. Use the Phone Number ID of your registered WhatsApp sender.',
    };
  }

  return {
    valid: true,
    phoneNumberId,
    wabaId,
    accessToken,
    apiVersion,
  };
}

async function metaRequest({ config, path, method = 'GET', body }) {
  const response = await fetch(
    `https://graph.facebook.com/${config.apiVersion}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    }
  );

  const data = await response.json().catch(() => null);

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
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

    // Must match {{1}}, {{2}}, {{3}}, {{4}} in your Meta template.
    bodyParameters: [
      textValue(studentName),
      textValue(schoolName),
      planLabel(planTier),
      textValue(loginEmail),
    ],
  };
}

/**
 * Run this temporarily to confirm the configured Phone Number ID.
 * It should return your actual registered number, for example +91 93226 77248.
 */
export async function getConfiguredWhatsAppSender() {
  const config = getWhatsAppConfig();

  if (!config.valid) {
    return {
      success: false,
      error: config.reason,
    };
  }

  const result = await metaRequest({
    config,
    path: `/${config.phoneNumberId}?fields=id,display_phone_number,verified_name,code_verification_status,quality_rating`,
  });

  if (!result.ok) {
    return {
      success: false,
      configured_phone_number_id: config.phoneNumberId,
      error: result.data?.error?.message || 'Unable to load sender details',
      code: result.data?.error?.code ?? null,
      raw: result.data,
    };
  }

  return {
    success: true,
    sender: result.data,
  };
}

/**
 * Uses your WABA ID to list all real registered numbers under that account.
 * Pick the id matching your Student Shield phone number and put it in
 * WHATSAPP_PHONE_NUMBER_ID.
 */
export async function getWabaPhoneNumbers() {
  const config = getWhatsAppConfig();

  if (!config.valid) {
    return {
      success: false,
      error: config.reason,
    };
  }

  if (!config.wabaId) {
    return {
      success: false,
      error: 'WHATSAPP_WABA_ID is missing',
    };
  }

  const result = await metaRequest({
    config,
    path: `/${config.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,code_verification_status`,
  });

  if (!result.ok) {
    return {
      success: false,
      error: result.data?.error?.message || 'Unable to fetch WABA phone numbers',
      code: result.data?.error?.code ?? null,
      raw: result.data,
    };
  }

  return {
    success: true,
    phone_numbers: result.data?.data || [],
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

  const config = getWhatsAppConfig();

  if (!config.valid) {
    return {
      sent: false,
      skipped: true,
      reason: config.reason,
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

  const result = await metaRequest({
    config,
    method: 'POST',
    path: `/${config.phoneNumberId}/messages`,
    body: {
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
    },
  });

  if (!result.ok) {
    const metaError = result.data?.error;

    return {
      sent: false,
      to,
      configured_phone_number_id: config.phoneNumberId,
      error: metaError?.message || 'WhatsApp template send failed',
      code: metaError?.code ?? null,
      error_subcode: metaError?.error_subcode ?? null,

      hint:
        metaError?.code === 100 && metaError?.error_subcode === 33
          ? 'The configured WHATSAPP_PHONE_NUMBER_ID is wrong or your access token has no access to this sender.'
          : null,

      raw: result.data,
    };
  }

  return {
    sent: true,
    accepted: true,
    to,
    message_id: result.data?.messages?.[0]?.id ?? null,
    status: result.data?.messages?.[0]?.message_status || 'accepted',
  };
}
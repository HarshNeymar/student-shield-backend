import crypto from 'node:crypto';
import { Router } from 'express';

const router = Router();

const safeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));

  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
};

const isMetaSignatureValid = (req) => {
  const appSecret = process.env.META_APP_SECRET;
  const signature = req.get('x-hub-signature-256');

  if (!appSecret || !signature || !req.rawBody) {
    return false;
  }

  const expectedSignature = `sha256=${crypto
    .createHmac('sha256', appSecret)
    .update(req.rawBody)
    .digest('hex')}`;

  return safeEqual(signature, expectedSignature);
};

// Meta calls this when you click "Verify and save".
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const verifyToken = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (
    mode === 'subscribe' &&
    verifyToken &&
    safeEqual(verifyToken, process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN)
  ) {
    console.log('WhatsApp webhook verified successfully.');

    return res.status(200).type('text/plain').send(String(challenge));
  }

  console.warn('WhatsApp webhook verification rejected.');

  return res.status(403).json({
    success: false,
    error: 'Webhook verification failed.',
  });
});

// Meta calls this for incoming messages and sent/delivered/read/failed statuses.
router.post('/', async (req, res) => {
  if (!isMetaSignatureValid(req)) {
    console.warn('Invalid WhatsApp webhook signature.');

    return res.status(401).json({
      success: false,
      error: 'Invalid webhook signature.',
    });
  }

  try {
    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];

    for (const entry of entries) {
      for (const change of entry?.changes || []) {
        const value = change?.value || {};

        for (const status of value.statuses || []) {
          console.log('WhatsApp message status:', {
            messageId: status.id,
            status: status.status,
            recipientId: status.recipient_id,
            timestamp: status.timestamp,
            error: status.errors?.[0]?.message || null,
          });
        }

        for (const message of value.messages || []) {
          console.log('Incoming WhatsApp message:', {
            messageId: message.id,
            from: message.from,
            type: message.type,
            timestamp: message.timestamp,
          });
        }
      }
    }

    // Meta requires a fast 200 response.
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('WhatsApp webhook processing failed:', error);

    // Return 200 so Meta does not keep retrying a malformed event forever.
    return res.status(200).json({
      success: true,
      warning: 'Webhook received but processing failed.',
    });
  }
});

export default router;
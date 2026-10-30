/**
 * FreeSite SaaS — Universal Webhook Event Dispatcher
 * Secure event notifications with HMAC-SHA256 signature verification & delivery tracking.
 */

const crypto = require('crypto');
const axios = require('axios');
const { pool } = require('./database');

async function triggerWebhookEvent(eventName, payloadData) {
  // ব্যাকগ্রাউন্ডে নন-ব্লকিং এক্সিকিউশন
  setImmediate(async () => {
    try {
      const hooks = await pool.query(
        `SELECT id, target_url, secret, subscribed_events 
         FROM api_webhooks 
         WHERE is_active = TRUE AND $1 = ANY(subscribed_events)`,
        [eventName]
      );

      if (hooks.rows.length === 0) return;

      const eventPayload = {
        event: eventName,
        timestamp: new Date().toISOString(),
        data: payloadData
      };
      const payloadString = JSON.stringify(eventPayload);

      for (const hook of hooks.rows) {
        // HMAC SHA256 Signature তৈরি
        const signature = crypto
          .createHmac('sha256', hook.secret)
          .update(payloadString)
          .digest('hex');

        let success = false;
        let responseCode = null;
        let responseBody = '';

        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const res = await axios.post(hook.target_url, eventPayload, {
              headers: {
                'Content-Type': 'application/json',
                'X-FreeSite-Event': eventName,
                'X-FreeSite-Signature': signature,
                'User-Agent': 'FreeSite-Webhook-Engine/1.0'
              },
              timeout: 6000
            });
            responseCode = res.status;
            responseBody = JSON.stringify(res.data).substring(0, 300);
            success = true;
            break; // সফল হলে লুপ শেষ
          } catch (err) {
            responseCode = err.response?.status || 500;
            responseBody = (err.response?.data ? JSON.stringify(err.response.data) : err.message).substring(0, 300);
            await new Promise((r) => setTimeout(r, 1500 * attempt)); // ব্যাকঅফ রিট্রাই
          }
        }

        // লগ ডাটাবেজে সংরক্ষণ
        await pool.query(
          `INSERT INTO webhook_delivery_logs (webhook_id, event_name, payload, response_code, response_body, success)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [hook.id, eventName, eventPayload, responseCode, responseBody, success]
        );
      }
    } catch (globalErr) {
      console.error('[WEBHOOK ERROR]:', globalErr.message);
    }
  });
}

module.exports = {
  triggerWebhookEvent
};

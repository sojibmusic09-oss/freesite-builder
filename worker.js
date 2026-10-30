/**
 * FreeSite SaaS — Lightweight Background Worker Node
 * Runs assigned WhatsApp bots from PostgreSQL database
 */

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const pino = require('pino');
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  delay,
  Browsers,
  initAuthCreds,
  BufferJSON
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3001;
const SERVER_ID = parseInt(process.env.SERVER_ID || 2, 10);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const activeSockets = new Map();

// PostgreSQL Session Store
async function usePostgresAuthState(botId) {
  const getSession = async (key) => {
    const res = await pool.query('SELECT session_data FROM whatsapp_sessions WHERE bot_id = $1 AND session_key = $2', [botId, key]);
    if (res.rows.length > 0) return JSON.parse(res.rows[0].session_data, BufferJSON.reviver);
    return null;
  };
  const setSession = async (key, value) => {
    if (!value) await pool.query('DELETE FROM whatsapp_sessions WHERE bot_id = $1 AND session_key = $2', [botId, key]);
    else {
      await pool.query(
        `INSERT INTO whatsapp_sessions (bot_id, session_key, session_data, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (bot_id, session_key) DO UPDATE SET session_data = $3, updated_at = NOW()`,
        [botId, key, JSON.stringify(value, BufferJSON.replacer)]
      );
    }
  };
  let creds = await getSession('creds') || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const d = {};
          for (const id of ids) { const v = await getSession(`${type}-${id}`); if (v) d[id] = v; }
          return d;
        },
        set: async (data) => {
          for (const cat in data) { for (const id in data[cat]) await setSession(`${cat}-${id}`, data[cat][id]); }
        }
      }
    },
    saveCreds: () => setSession('creds', creds)
  };
}

async function startWorkerBot(botId) {
  try {
    const { state, saveCreds } = await usePostgresAuthState(botId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: state,
      browser: Browsers.macOS('Desktop'),
      markOnlineOnConnect: true
    });

    activeSockets.set(botId, sock);
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      if (u.connection === 'open') {
        console.log(`[WORKER #${SERVER_ID}]: ✅ Bot #${botId} Connected!`);
        await pool.query("UPDATE whatsapp_bots SET status = 'CONNECTED' WHERE id = $1", [botId]);
      } else if (u.connection === 'close') {
        await pool.query("UPDATE whatsapp_bots SET status = 'DISCONNECTED' WHERE id = $1", [botId]);
        setTimeout(() => startWorkerBot(botId), 10000);
      }
    });
  } catch (e) {
    console.error(`Bot #${botId} worker error:`, e.message);
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', workerId: SERVER_ID, runningBots: activeSockets.size });
});

app.listen(PORT, async () => {
  console.log(`[INFO]: Worker #${SERVER_ID} listening on port ${PORT}`);
  // এই সার্ভার আইডিতে যেসব বট এসাইন করা সেগুলো চালানো
  const bots = await pool.query('SELECT id FROM whatsapp_bots WHERE server_id = $1', [SERVER_ID]);
  for (const b of bots.rows) {
    await startWorkerBot(b.id);
  }
});

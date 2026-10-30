/**
 * FreeSite SaaS — Multi-Tenant Branded WhatsApp AI Bot Platform
 * Models: gemini-3.5-flash, gemini-2.5-flash, gemini-3.1-flash-lite, gemini-3.6-flash, gemini-3.8-flash
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const pino = require('pino');

// ডাটাবেজ, অবিকৃত AI Engine ও ওয়েবসাইট এনালাইজার
const { pool, initializeDatabase } = require('./database');
const { analyzeAndExtractWebsiteKnowledge } = require('./website_analyzer');
const {
  getActiveGenAIClient,
  rotateToNextApiKey,
  trackTokenUsage,
  tokenStats,
  parseBudgetFromText,
  searchSmartProducts,
  transcribeAudioWithGemini,
  callGeminiUltraFast,
  GEMINI_MODEL,
  GEMINI_FALLBACK_MODELS
} = require('./ai_engine');

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
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const activeSockets = new Map();
const botChatHistories = new Map();

// PostgreSQL সেশন এডাপ্টার (সার্ভার স্লিপ বা রিস্টার্ট হলেও WhatsApp কানেক্টেড থাকবে)
async function usePostgresAuthState(botId) {
  const getSession = async (key) => {
    const res = await pool.query('SELECT session_data FROM whatsapp_sessions WHERE bot_id = $1 AND session_key = $2', [botId, key]);
    if (res.rows.length > 0) return JSON.parse(res.rows[0].session_data, BufferJSON.reviver);
    return null;
  };

  const setSession = async (key, value) => {
    if (value === null || value === undefined) {
      await pool.query('DELETE FROM whatsapp_sessions WHERE bot_id = $1 AND session_key = $2', [botId, key]);
    } else {
      const dataStr = JSON.stringify(value, BufferJSON.replacer);
      await pool.query(
        `INSERT INTO whatsapp_sessions (bot_id, session_key, session_data, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (bot_id, session_key)
         DO UPDATE SET session_data = $3, updated_at = NOW()`,
        [botId, key, dataStr]
      );
    }
  };

  let creds = await getSession('creds');
  if (!creds) {
    creds = initAuthCreds();
    await setSession('creds', creds);
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            const val = await getSession(`${type}-${id}`);
            if (val) data[id] = val;
          }
          return data;
        },
        set: async (data) => {
          for (const category in data) {
            for (const id in data[category]) {
              await setSession(`${category}-${id}`, data[category][id]);
            }
          }
        }
      }
    },
    saveCreds: () => setSession('creds', creds)
  };
}

// ================= সাবডোমেন রাউটার: ইউজারের নিজস্ব ব্র্যান্ডেড ড্যাশবোর্ড =================
app.use(async (req, res, next) => {
  const host = (req.headers.host || '').toLowerCase().split(':')[0];
  const targetDomains = ['sojib.qd.je', 'sojib.de5.net', 'sojub.cc.cd'];

  for (const baseDomain of targetDomains) {
    if (host.endsWith(baseDomain) && host !== baseDomain && !host.startsWith('www.')) {
      const subdomain = host.replace(`.${baseDomain}`, '').trim();

      if (['admin', 'api', 'dashboard', 'mail'].includes(subdomain)) return next();

      try {
        const botRes = await pool.query(
          `SELECT b.*, h.theme_color, h.accent_color 
           FROM whatsapp_bots b 
           JOIN hosted_websites h ON b.id = h.bot_id 
           WHERE h.subdomain = $1 AND h.base_domain = $2`,
          [subdomain, baseDomain]
        );

        if (botRes.rows.length > 0) {
          const bot = botRes.rows[0];
          // ইউজারের নিজস্ব ব্র্যান্ডেড ড্যাশবোর্ড রেন্ডার
          return res.send(generateUserBrandedDashboard(bot, `${subdomain}.${baseDomain}`));
        } else {
          return res.status(404).send(`
            <div style="font-family:sans-serif; text-align:center; padding:50px; background:#09090b; color:#fff; min-height:100vh;">
              <h2>⚠️ ড্যাশবোর্ড পাওয়া যায়নি!</h2>
              <p><b>${subdomain}.${baseDomain}</b> এখনো তৈরি করা হয়নি।</p>
              <a href="https://${baseDomain}" style="color:#38bdf8;">নতুন ড্যাশবোর্ড তৈরি করুন</a>
            </div>
          `);
        }
      } catch (err) {
        return res.status(500).send('Database Error on Subdomain');
      }
    }
  }
  next();
});

// ইউজারের নিজস্ব ড্যাশবোর্ডের HTML জেনারেটর (কালার চেঞ্জ সহ)
function generateUserBrandedDashboard(bot, fullUrl) {
  const primaryColor = bot.theme_color || '#3b82f6';
  return `<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${bot.bot_name} — AI WhatsApp Control Center</title>
  <link href="https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css">
  <style>
    :root { --primary: ${primaryColor}; --bg: #09090b; --card: #18181b; --border: #27272a; --text: #fafafa; }
    * { box-sizing: border-box; margin:0; padding:0; font-family: 'Hind Siliguri', sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 15px; }
    .container { max-width: 800px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: center; padding: 20px 0; border-bottom: 1px solid var(--border); margin-bottom: 20px; }
    .brand-title { font-size: 22px; font-weight: 700; color: var(--primary); display: flex; align-items: center; gap: 8px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 20px; }
    .card h3 { font-size: 17px; margin-bottom: 15px; display: flex; align-items: center; gap: 8px; color: var(--primary); }
    .form-group { margin-bottom: 15px; }
    label { display: block; font-size: 13px; color: #a1a1aa; margin-bottom: 6px; }
    input, select { width: 100%; padding: 12px; background: #000; border: 1px solid var(--border); border-radius: 8px; color: #fff; font-size: 14px; outline: none; }
    button { width: 100%; padding: 12px; background: var(--primary); color: #fff; border: none; border-radius: 8px; font-weight: 700; cursor: pointer; display: flex; justify-content: center; align-items: center; gap: 8px; }
    .code-box { background: #000; border: 2px dashed var(--primary); padding: 18px; border-radius: 10px; text-align: center; margin-top: 15px; display: none; }
    .code-text { font-size: 28px; font-weight: 800; letter-spacing: 5px; color: #4ade80; font-family: monospace; }
    .color-picker-box { display: flex; gap: 10px; margin-top: 10px; }
    .color-dot { width: 32px; height: 32px; border-radius: 50%; cursor: pointer; border: 2px solid transparent; }
    .color-dot.active { border-color: #fff; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <div class="brand-title"><i class="ti ti-robot"></i> ${bot.bot_name}</div>
        <p style="font-size:12px; color:#a1a1aa;">🔗 ড্যাশবোর্ড লিংক: ${fullUrl}</p>
      </div>
      <div style="font-size:12px; color:#4ade80; background:rgba(74,222,128,0.1); padding:5px 12px; border-radius:20px; border:1px solid #16a34a;">
        ● ${bot.status || 'DISCONNECTED'}
      </div>
    </div>

    <!-- থিম কালার বদলানোর অপশন -->
    <div class="card">
      <h3><i class="ti ti-palette"></i> ড্যাশবোর্ডের থিম কালার পরিবর্তন করুন</h3>
      <p style="font-size:13px; color:#a1a1aa;">আপনার পছন্দের রঙ বেছে নিন:</p>
      <div class="color-picker-box">
        <div class="color-dot" style="background:#3b82f6;" onclick="changeTheme('#3b82f6')"></div>
        <div class="color-dot" style="background:#10b981;" onclick="changeTheme('#10b981')"></div>
        <div class="color-dot" style="background:#8b5cf6;" onclick="changeTheme('#8b5cf6')"></div>
        <div class="color-dot" style="background:#ef4444;" onclick="changeTheme('#ef4444')"></div>
        <div class="color-dot" style="background:#f59e0b;" onclick="changeTheme('#f59e0b')"></div>
        <div class="color-dot" style="background:#ec4899;" onclick="changeTheme('#ec4899')"></div>
      </div>
    </div>

    <!-- হোয়াটসঅ্যাপ কানেক্ট ও পেয়ারিং কোড -->
    <div class="card">
      <h3><i class="ti ti-brand-whatsapp"></i> হোয়াটসঅ্যাপ কানেক্ট করুন (Pairing Code)</h3>
      <div class="form-group">
        <label>আপনার হোয়াটসঅ্যাপ মোবাইল নম্বর (যেমন: 88017...):</label>
        <input type="text" id="phoneInput" placeholder="8801XXXXXXXXX" value="${bot.phone_number || ''}">
      </div>
      <button onclick="requestPairingCode(${bot.id})"><i class="ti ti-key"></i> পেয়ারিং কোড নিন</button>

      <div id="codeBanner" class="code-box">
        <div style="font-size:12px; color:#38bdf8; margin-bottom:5px;">WHATSAPP LINKING CODE:</div>
        <div id="codeDisplay" class="code-text">----</div>
        <p style="font-size:12px; color:#a1a1aa; margin-top:8px;">হোয়াটসঅ্যাপের Linked Devices ➔ Link with phone number-এ কোডটি দিন।</p>
      </div>
    </div>

    <!-- এআই নলেজ বেজ (ওয়েবসাইট এনালাইসিস থেকে পাওয়া) -->
    <div class="card">
      <h3><i class="ti ti-brain"></i> এআই যে তথ্যগুলো শিখেছে</h3>
      <p style="font-size:13px; color:#a1a1aa; margin-bottom:10px;"><b>ওয়েবসাইট:</b> <a href="${bot.website_url}" target="_blank" style="color:var(--primary);">${bot.website_url || 'N/A'}</a></p>
      <p style="font-size:13px; color:#a1a1aa; margin-bottom:10px;"><b>ব্যবসার ধরন:</b> ${bot.business_type || 'ই-কমার্স শপ'}</p>
      <p style="font-size:13px; color:#a1a1aa;"><b>ডেলিভারি পলিসি:</b> সিটির ভেতরে ৳${bot.delivery_inside}, বাইরে ৳${bot.delivery_outside}</p>
    </div>
  </div>

  <script>
    async function requestPairingCode(botId) {
      const phone = document.getElementById('phoneInput').value;
      if (!phone) return alert('ফোন নম্বর লিখুন!');
      document.getElementById('codeBanner').style.display = 'block';
      document.getElementById('codeDisplay').innerText = 'লোড হচ্ছে...';

      const res = await fetch('/api/request-pairing-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId, phone })
      });
      const data = await res.json();
      if (data.success) {
        document.getElementById('codeDisplay').innerText = data.pairingCode;
      } else {
        document.getElementById('codeDisplay').innerText = 'ব্যর্থ';
        alert(data.message || 'কোড পাওয়া যায়নি');
      }
    }

    async function changeTheme(color) {
      document.documentElement.style.setProperty('--primary', color);
      await fetch('/api/user/update-theme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId: ${bot.id}, themeColor: color })
      });
    }
  </script>
</body>
</html>`;
}

// ================= AI মেসেজ প্রসেসিং (অবিকৃত AI Engine সমন্বিত) =================
async function handleDynamicCustomerMessage(botRow, customerPhone, text, sock, imageBuffer = null, imageMime = null) {
  const cleanInput = (text || '').trim();
  const botId = botRow.id;

  const historyKey = `${botId}_${customerPhone}`;
  if (!botChatHistories.has(historyKey)) botChatHistories.set(historyKey, []);
  const history = botChatHistories.get(historyKey);

  let combinedQuery = cleanInput;
  if (history.length > 0) {
    const lastUserMsg = [...history].reverse().find(h => h.role === 'user');
    if (lastUserMsg) combinedQuery = `${lastUserMsg.text} ${cleanInput}`;
  }

  // ওয়েবসাইট এনালাইসিস থেকে পাওয়া প্রোডাক্টস লোড
  const productsQuery = await pool.query('SELECT * FROM bot_products WHERE bot_id = $1', [botId]);
  const cachedCatalog = productsQuery.rows.map(p => ({
    id: p.id,
    name: p.name,
    price: parseFloat(p.price || 0),
    category: p.category || '',
    in_stock: Boolean(p.in_stock),
    buy_link: p.buy_link || `${botRow.website_url || ''}/?p=${p.id}`,
    description: p.description || ''
  }));

  const searchResult = searchSmartProducts(combinedQuery, cachedCatalog);

  let catalogContext = '';
  if (searchResult.items && searchResult.items.length > 0) {
    catalogContext = searchResult.items.map(p => 
      `• [ID:${p.id}] ${p.name} | মূল্য: ৳${p.price} | লিংক: ${p.buy_link}`
    ).join('\n');
  } else {
    catalogContext = cachedCatalog.slice(0, 8).map(p => 
      `• [ID:${p.id}] ${p.name} | মূল্য: ৳${p.price} | লিংক: ${p.buy_link}`
    ).join('\n');
  }

  const conversationHistoryText = history.length > 0 
    ? history.map(h => `${h.role === 'user' ? 'গ্রাহক' : 'অ্যাসিস্ট্যান্ট'}: ${h.text}`).join('\n')
    : 'এখনই কথোপকথন শুরু হয়েছে।';

  const systemPrompt = `তুমি ${botRow.bot_name} (${botRow.website_url || ''}) এর একজন সিনিয়র স্মার্ট সেলস অ্যাসিস্ট্যান্ট। ব্যবসার ধরন: ${botRow.business_type || 'ই-কমার্স'}।

আচরণের মূল নিয়মাবলী:
১. কাস্টমারকে আপন মানুষের মতো "ভাইয়া" সম্বোধন করবে। কথার টোন হবে মিষ্টি, হেল্পফুল ও আন্তরিক।
২. কাস্টমার কোনো পণ্য দেখতে চাইলেই পণ্যের নাম, দাম এবং অবশ্যই পণ্যের লিংক উল্লেখ করবে।
৩. ডেলিভারি তথ্য: সিটির ভেতরে ৳${botRow.delivery_inside || 70}, বাইরে ৳${botRow.delivery_outside || 130} (ক্যাশ অন ডেলিভারি)।
৪. অর্ডার চাইলে এই ফর্মটি পূরণ করতে বলবে:
*১. আপনার নাম:*
*২. মোবাইল নম্বর:* ${customerPhone}
*৩. সম্পূর্ণ ঠিকানা:*
*৪. পণ্যের নাম:*

পূর্ববর্তী চ্যাট হিস্ট্রি:
${conversationHistoryText}

আমাদের শপের প্রাসঙ্গিক পণ্য তালিকা:
${catalogContext}`;

  const userPrompt = imageBuffer ? `গ্রাহক পণ্যের ছবি পাঠিয়েছেন এবং লিখেছেন: "${cleanInput}"` : `গ্রাহক: "${cleanInput}"`;

  let reply = await callGeminiUltraFast(userPrompt, systemPrompt, imageBuffer, imageMime);
  reply = reply.replace(/\*\*/g, '*');

  history.push({ role: 'user', text: cleanInput || 'ছবি পাঠিয়েছেন', time: Date.now() });
  history.push({ role: 'assistant', text: reply, time: Date.now() });
  if (history.length > 8) history.shift();

  return reply;
}

// ================= ডাইনামিক Baileys Bot স্টার্টার =================
async function startTenantBot(botId) {
  try {
    const res = await pool.query('SELECT * FROM whatsapp_bots WHERE id = $1', [botId]);
    if (res.rows.length === 0) return null;
    const botRow = res.rows[0];

    const { state, saveCreds } = await usePostgresAuthState(botId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000
    });

    activeSockets.set(botId, { sock, state: { connected: false, pairingCode: null } });

    sock.ev.on('creds.update', saveCreds);

    // অটো কল রিজেক্ট
    sock.ev.on('call', async (calls) => {
      for (const call of calls) {
        if (call.status === 'offer') {
          try {
            await sock.rejectCall(call.id, call.from);
            await sock.sendMessage(call.from, {
              text: `⚠️ *এটি আমাদের স্বয়ংক্রিয় এআই রোবট সিস্টেম।* \nসরাসরি কল রিসিভ করা সম্ভব নয়। আপনার পছন্দের পণ্য বা তথ্য এখানে লিখে বা ভয়েস রেকর্ড দিয়ে জানান ❤️`
            });
          } catch (e) {}
        }
      }
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      const b = activeSockets.get(botId);

      if (connection === 'close') {
        if (b) b.state.connected = false;
        await pool.query("UPDATE whatsapp_bots SET status = 'DISCONNECTED' WHERE id = $1", [botId]);
        if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => startTenantBot(botId), 8000);
        }
      } else if (connection === 'open') {
        if (b) b.state.connected = true;
        await pool.query("UPDATE whatsapp_bots SET status = 'CONNECTED' WHERE id = $1", [botId]);
        console.log(`[INFO]: ✅ Bot #${botId} (${botRow.bot_name}) is LIVE!`);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      try {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        if (sender.includes('@g.us')) return;

        const msgContent = msg.message.ephemeralMessage?.message || msg.message.viewOnceMessage?.message || msg.message;
        let text = (msgContent.conversation || msgContent.extendedTextMessage?.text || msgContent.imageMessage?.caption || '').trim();

        const isAudio = Boolean(msgContent.audioMessage);
        const isImage = Boolean(msgContent.imageMessage);
        if (!text && !isAudio && !isImage) return;

        try {
          await sock.readMessages([msg.key]);
          await sock.sendPresenceUpdate('composing', sender);
        } catch (e) {}

        let imageBuffer = null;
        let imageMime = 'image/jpeg';
        if (isImage) {
          try {
            imageBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
            imageMime = msgContent.imageMessage.mimetype || 'image/jpeg';
          } catch (e) {}
        }

        if (isAudio) {
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
            text = await transcribeAudioWithGemini(buffer, msgContent.audioMessage.mimetype || 'audio/ogg');
          } catch (e) {}
        }

        if (!text && !isImage) return;

        let reply = await handleDynamicCustomerMessage(botRow, sender.replace(/[^0-9]/g, ''), text, sock, imageBuffer, imageMime);
        if (isAudio) reply = `🎤 *আপনার ভয়েস:* "${text}"\n\n${reply}`;

        await sock.sendMessage(sender, { text: reply });
        await sock.sendPresenceUpdate('paused', sender);
      } catch (err) {}
    });

    return sock;
  } catch (err) {
    return null;
  }
}

// ================= API ENDPOINTS =================

// ১. মেইন পেজ থেকে বট ও ড্যাশবোর্ড তৈরি করা (ওয়েবসাইট এনালাইসিস সহ)
app.post('/api/launch-bot-dashboard', async (req, res) => {
  try {
    const { bot_name, website_url, subdomain, base_domain } = req.body;
    const cleanSub = String(subdomain || '').toLowerCase().replace(/[^a-z0-9-]/g, '');

    if (!cleanSub || !base_domain) {
      return res.status(400).json({ success: false, message: 'সঠিক সাবডোমেইন ও ডোমেন দিন।' });
    }

    // ব্যাকগ্রাউন্ডে ওয়েবসাইটের নলেজ এনালাইসিস
    const siteKnowledge = await analyzeAndExtractWebsiteKnowledge(website_url);

    // বট তৈরি
    const botInsert = await pool.query(
      `INSERT INTO whatsapp_bots (bot_name, website_url, system_prompt, status)
       VALUES ($1, $2, $3, 'DISCONNECTED') RETURNING id`,
      [bot_name || siteKnowledge.title, website_url, siteKnowledge.description]
    );
    const botId = botInsert.rows[0].id;

    // এক্সট্রাক্ট করা প্রোডাক্ট ডাটাবেজে সংরক্ষণ
    for (const p of siteKnowledge.products) {
      await pool.query(
        `INSERT INTO bot_products (bot_id, name, price, category, description, buy_link)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [botId, p.name, p.price, p.category, p.description, p.buy_link]
      );
    }

    // সাবডোমেন ড্যাশবোর্ড রেজিস্টার
    await pool.query(
      `INSERT INTO hosted_websites (subdomain, base_domain, bot_id, theme_color)
       VALUES ($1, $2, $3, '#3b82f6')
       ON CONFLICT (subdomain, base_domain) DO UPDATE SET bot_id = $3`,
      [cleanSub, base_domain, botId]
    );

    res.json({
      success: true,
      botId,
      dashboardUrl: `https://${cleanSub}.${base_domain}`,
      message: `🎉 অভিনন্দন! আপনার "${bot_name}" ড্যাশবোর্ড তৈরি হয়েছে এবং ওয়েবসাইট অ্যানালাইসিস সম্পন্ন!`
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ২. পেয়ারিং কোড রিকোয়েস্ট
app.post('/api/request-pairing-code', async (req, res) => {
  try {
    const { botId, phone } = req.body;
    let cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('01') && cleanPhone.length === 11) cleanPhone = '88' + cleanPhone;

    let botObj = activeSockets.get(Number(botId));
    if (!botObj || !botObj.sock) {
      await startTenantBot(Number(botId));
      await delay(2500);
      botObj = activeSockets.get(Number(botId));
    }

    if (botObj && botObj.sock && !botObj.sock.authState.creds.registered) {
      await delay(1500);
      const code = await botObj.sock.requestPairingCode(cleanPhone);
      return res.json({ success: true, pairingCode: code });
    }
    return res.status(400).json({ success: false, message: 'বট ইতিমধ্যে সংযুক্ত আছে।' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ৩. ড্যাশবোর্ডের থিম কালার আপডেট
app.post('/api/user/update-theme', async (req, res) => {
  try {
    const { botId, themeColor } = req.body;
    await pool.query('UPDATE hosted_websites SET theme_color = $1 WHERE bot_id = $2', [themeColor, botId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

// ================= SUPER ADMIN ENDPOINTS =================
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/api/admin/overview', async (req, res) => {
  try {
    const users = await pool.query('SELECT * FROM users');
    const bots = await pool.query('SELECT * FROM whatsapp_bots');
    const websites = await pool.query('SELECT * FROM hosted_websites');
    const servers = await pool.query('SELECT * FROM worker_servers');
    res.json({ success: true, users: users.rows, bots: bots.rows, websites: websites.rows, servers: servers.rows });
  } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/transfer-bot', async (req, res) => {
  try {
    const { botId, targetServerId } = req.body;
    await pool.query('UPDATE whatsapp_bots SET server_id = $1 WHERE id = $2', [targetServerId, botId]);
    res.json({ success: true, message: `বট #${botId} সফলভাবে সার্ভার #${targetServerId}-এ ট্রান্সফার করা হয়েছে!` });
  } catch (e) { res.status(500).json({ success: false }); }
});

// রুট ভিউ: একদম ক্লিন ও মিনিমাল ক্রিয়েশন পেজ
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// সার্ভার চালু
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[INFO]: 🚀 FreeSite Master Server is running on port ${PORT}`);
  try {
    await initializeDatabase();
    // ডাটাবেজে bot_id ও theme_color কলাম নিশ্চিত করা
    await pool.query('ALTER TABLE hosted_websites ADD COLUMN IF NOT EXISTS bot_id INT REFERENCES whatsapp_bots(id) ON DELETE CASCADE;');
    await pool.query('ALTER TABLE hosted_websites ADD COLUMN IF NOT EXISTS theme_color VARCHAR(30) DEFAULT \'#3b82f6\';');
    await pool.query('ALTER TABLE whatsapp_bots ADD COLUMN IF NOT EXISTS business_type VARCHAR(100);');

    const bots = await pool.query("SELECT id FROM whatsapp_bots WHERE status = 'CONNECTED'");
    for (const row of bots.rows) await startTenantBot(row.id);
  } catch (e) {}
});

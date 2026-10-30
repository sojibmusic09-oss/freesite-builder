/**
 * FreeSite Builder & AI WhatsApp Bot SaaS — Master Server
 * Multi-Tenant | 3 Wildcard Domains | Neon DB | Super Admin Panel
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const pino = require('pino');

// ১. ডাটাবেজ কানেক্টর ও অবিকৃত AI Engine লোড করা
const { pool, initializeDatabase } = require('./database');
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

// চ্যাট রেট-লিমিট
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  validate: { xForwardedForHeader: false }
});

// সক্রিয় বটের মেমোরি পুল ও চ্যাট হিস্ট্রি
const activeSockets = new Map();
const botChatHistories = new Map();

// ================= ২. PostgreSQL-ভিত্তিক Baileys Auth Adapter =================
// (Render রিস্টার্ট বা স্লিপ হলেও WhatsApp লগআউট হবে না)
async function usePostgresAuthState(botId) {
  const getSession = async (key) => {
    const res = await pool.query('SELECT session_data FROM whatsapp_sessions WHERE bot_id = $1 AND session_key = $2', [botId, key]);
    if (res.rows.length > 0) {
      return JSON.parse(res.rows[0].session_data, BufferJSON.reviver);
    }
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
              const value = data[category][id];
              const key = `${category}-${id}`;
              await setSession(key, value);
            }
          }
        }
      }
    },
    saveCreds: () => setSession('creds', creds)
  };
}

// ================= ৩. সাবডোমেইন রাউটিং ইঞ্জিন (৩টি ডোমেইনের জন্য) =================
// ব্যবহারকারীর সাইট: user1.sojib.qd.je, shop.sojib.de5.net, test.sojub.cc.cd
app.use(async (req, res, next) => {
  const host = (req.headers.host || '').toLowerCase().split(':')[0];
  const targetDomains = ['sojib.qd.je', 'sojib.de5.net', 'sojub.cc.cd'];

  for (const baseDomain of targetDomains) {
    if (host.endsWith(baseDomain) && host !== baseDomain && !host.startsWith('www.')) {
      const subdomain = host.replace(`.${baseDomain}`, '').trim();

      // রিজার্ভড সাবডোমেন নিরাপত্তা
      if (['admin', 'api', 'dashboard', 'mail', 'cpanel'].includes(subdomain)) {
        return next();
      }

      try {
        const site = await pool.query(
          'SELECT html_content FROM hosted_websites WHERE subdomain = $1 AND base_domain = $2 AND is_published = TRUE',
          [subdomain, baseDomain]
        );
        if (site.rows.length > 0) {
          return res.send(site.rows[0].html_content);
        } else {
          return res.status(404).send(`
            <div style="font-family:sans-serif; text-align:center; padding:50px; background:#09090b; color:#fff; min-height:100vh;">
              <h2 style="color:#ef4444;">⚠️ Website Not Found</h2>
              <p>The subdomain <b>${subdomain}.${baseDomain}</b> has not been created or published yet.</p>
              <a href="https://${baseDomain}" style="color:#38bdf8;">Create your free website with FreeSite Builder</a>
            </div>
          `);
        }
      } catch (err) {
        return res.status(500).send('Database connection error on hosted domain.');
      }
    }
  }
  next();
});

// ================= ৪. Dynamic Multi-Tenant AI মেসেজ হ্যান্ডলার =================
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

  // বটের নিজস্ব প্রোডাক্ট ডাটাবেজ থেকে লোড
  const productsQuery = await pool.query(
    'SELECT id, name, price, category, in_stock, buy_link, description FROM bot_products WHERE bot_id = $1',
    [botId]
  );
  const cachedCatalog = productsQuery.rows.map(p => ({
    id: p.id,
    name: p.name,
    price: parseFloat(p.price || 0),
    category: p.category || '',
    in_stock: Boolean(p.in_stock),
    buy_link: p.buy_link || `${botRow.website_url || ''}/?p=${p.id}`,
    description: p.description || ''
  }));

  // অবিকৃত AI searchSmartProducts লজিক চালানো
  const searchResult = searchSmartProducts(combinedQuery, cachedCatalog);

  let catalogContext = '';
  if (searchResult.items && searchResult.items.length > 0) {
    catalogContext = searchResult.items.map(p => 
      `• [ID:${p.id}] ${p.name} | মূল্য: ৳${p.price} | স্টক: ${p.in_stock ? 'মজুদ আছে' : 'স্টক শেষ'} | লিংক: ${p.buy_link}`
    ).join('\n');
  } else {
    catalogContext = cachedCatalog.slice(0, 8).map(p => 
      `• [ID:${p.id}] ${p.name} | মূল্য: ৳${p.price} | স্টক: ${p.in_stock ? 'মজুদ আছে' : 'স্টক শেষ'} | লিংক: ${p.buy_link}`
    ).join('\n');
  }

  const conversationHistoryText = history.length > 0 
    ? history.map(h => `${h.role === 'user' ? 'গ্রাহক' : 'অ্যাসিস্ট্যান্ট'}: ${h.text}`).join('\n')
    : 'এখনই কথোপকথন শুরু হয়েছে।';

  // ডাইনামিক টেন্যান্ট প্রম্পট
  const businessName = botRow.bot_name || 'আমাদের শপ';
  const shopUrl = botRow.website_url || '';
  const addressing = botRow.addressing_style || 'ভাইয়া';
  const delInside = botRow.delivery_inside || 70;
  const delOutside = botRow.delivery_outside || 130;

  const systemPrompt = `তুমি ${businessName} (${shopUrl}) এর শোরুমের একজন অত্যন্ত চটপটে, ভদ্র ও অভিজ্ঞ সিনিয়র সেলস অ্যাসিস্ট্যান্ট। তুমি কাস্টমারের সাথে রক্ত-মাংসের মানুষের মতো মিষ্টি ও সাবলীলভাবে কথা বলবে।

আচরণের মূল নিয়মাবলী:
১. কাস্টমারকে আপন মানুষের মতো "${addressing}" সম্বোধন করবে। কথার টোন হবে মিষ্টি, হেল্পফুল ও আন্তরিক।
২. সাধারণ আলাপ: কাস্টমার নরমালি কথা বলতে চাইলে বা গল্প করতে চাইলে বন্ধুর মতো সাধারণ কথা বলো।
৩. ফানি ও মজা: কাস্টমার যদি মজা করে বা হাসির কথা বলে, তবে শালীনভাবে চটপটে ও ফানি মেজাজে হাসিখুশি মজা করো।
৪. পণ্য দেখতে চাওয়া: কাস্টমার কোনো পণ্য দেখতে চাইলেই পণ্যের নাম, দাম এবং অবশ্যই পণ্যের লিংক উল্লেখ করবে।
৫. ছবি দেখে চেনা: কাস্টমার কোনো পণ্যের ছবি পাঠালে মনোযোগ দিয়ে দেখে শনাক্ত করো এবং ক্যাটালগের সাথে মিলিয়ে দাম ও লিংক জানিয়ে দাও।
৬. ফন্ট নিয়ম: কখনো ডাবল স্টার (**) ব্যবহার করবে না। বোল্ড করতে চাইলে শুধু সিঙ্গেল স্টার (*) ব্যবহার করবে।
৭. ডেলিভারি তথ্য: ডেলিভারি চার্জ সিটির ভেতরে ৳${delInside}, বাইরে ৳${delOutside} (ক্যাশ অন ডেলিভারি, পার্সেল চেক করে টাকা দেওয়ার সুযোগ আছে)।
৮. অর্ডার চাওয়া: কাস্টমার অর্ডার করতে চাইলে নিচের নির্ধারিত অর্ডার ফর্মটি পূরণ করতে বলবে:

*১. আপনার পুরো নাম :*
*২. মোবাইল নম্বর :* ${customerPhone}
*৩. সম্পূর্ণ ঠিকানা :*
*৪. জেলা ও থানা :*
*৫. পণ্যের নাম :* [পণ্যটির নাম]
━━━━━━━━━━━━━━━━━━━━

পূর্ববর্তী চ্যাট হিস্ট্রি:
${conversationHistoryText}

আমাদের শপের প্রাসঙ্গিক পণ্য তালিকা:
${catalogContext}`;

  const userPrompt = imageBuffer 
    ? `গ্রাহক একটি পণ্যের ছবি পাঠিয়েছেন এবং লিখেছেন: "${cleanInput || 'এই পণ্যটি আছে কি?'}"`
    : `গ্রাহক: "${cleanInput}"`;

  // অবিকৃত callGeminiUltraFast লজিক কল
  let reply = await callGeminiUltraFast(userPrompt, systemPrompt, imageBuffer, imageMime);
  reply = reply.replace(/\*\*/g, '*');

  history.push({ role: 'user', text: cleanInput || 'ছবি পাঠিয়েছেন', time: Date.now() });
  history.push({ role: 'assistant', text: reply, time: Date.now() });
  if (history.length > 8) history.shift();

  return reply;
}

// ================= ৫. ডাইনামিক Baileys Bot স্টার্টার =================
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
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000
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
              text: `⚠️ *এটি আমাদের স্বয়ংক্রিয় এআই রোবট সিস্টেম।* \nসরাসরি কল রিসিভ করা সম্ভব নয়। দয়া করে আপনার কাঙ্ক্ষিত পণ্য বা তথ্য এখানে লিখে অথবা ভয়েস রেকর্ড করে জানান ❤️`
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
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => startTenantBot(botId), 8000);
        }
      } else if (connection === 'open') {
        if (b) {
          b.state.connected = true;
          b.state.pairingCode = null;
        }
        await pool.query("UPDATE whatsapp_bots SET status = 'CONNECTED' WHERE id = $1", [botId]);
        console.log(`[INFO]: ✅ WhatsApp Bot #${botId} (${botRow.bot_name}) is LIVE!`);
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
            const mime = msgContent.audioMessage.mimetype || 'audio/ogg';
            text = await transcribeAudioWithGemini(buffer, mime);
          } catch (e) {}
        }

        if (!text && !isImage) return;

        let reply = await handleDynamicCustomerMessage(botRow, sender.replace(/[^0-9]/g, ''), text, sock, imageBuffer, imageMime);

        if (isAudio) {
          reply = `🎤 *আপনার ভয়েস:* "${text}"\n\n${reply}`;
        }

        await sock.sendMessage(sender, { text: reply });
        await sock.sendPresenceUpdate('paused', sender);
      } catch (err) {
        console.error(`[ERROR]: Bot #${botId} message error:`, err.message);
      }
    });

    return sock;
  } catch (err) {
    console.error(`[ERROR]: Failed to start bot #${botId}:`, err.message);
    return null;
  }
}

// ================= ৬. মোবাইল ড্যাশবোর্ড ও API এন্ডপয়েন্টস =================

// হেলথ চেক
app.get('/health', (req, res) => {
  res.json({ status: 'ok', server: 'FreeSite Master Render Node', timestamp: Date.now() });
});

// ১. বট তৈরি করা
app.post('/api/create-bot', async (req, res) => {
  try {
    const { bot_name, phone_number, website_url, addressing_style, delivery_inside, delivery_outside } = req.body;
    const result = await pool.query(
      `INSERT INTO whatsapp_bots (bot_name, phone_number, website_url, addressing_style, delivery_inside, delivery_outside, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'PAIRING') RETURNING id`,
      [bot_name || 'My Shop Bot', phone_number, website_url, addressing_style || 'ভাইয়া', delivery_inside || 70, delivery_outside || 130]
    );
    const botId = result.rows[0].id;
    res.json({ success: true, botId, message: 'বট তৈরি হয়েছে! এবার পেয়ারিং কোড রিকোয়েস্ট করুন।' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ২. পেয়ারিং কোড জেনারেট
app.post('/api/request-pairing-code', async (req, res) => {
  try {
    const { botId, phone } = req.body;
    let cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('01') && cleanPhone.length === 11) cleanPhone = '88' + cleanPhone;

    if (!cleanPhone || cleanPhone.length < 11) {
      return res.status(400).json({ success: false, message: 'সঠিক আন্তর্জাতিক নম্বর দিন (যেমন: 88017...)' });
    }

    let botObj = activeSockets.get(Number(botId));
    if (!botObj || !botObj.sock) {
      await startTenantBot(Number(botId));
      await delay(2500);
      botObj = activeSockets.get(Number(botId));
    }

    if (botObj && botObj.sock && !botObj.sock.authState.creds.registered) {
      await delay(1500);
      const code = await botObj.sock.requestPairingCode(cleanPhone);
      botObj.state.pairingCode = code;
      return res.json({ success: true, pairingCode: code });
    }

    return res.status(400).json({ success: false, message: 'বটটি ইতিমধ্যে সংযুক্ত রয়েছে।' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ৩. ওয়েবসাইট সাবডোমেন পাবলিশ করা (৩টি ডোমেনের জন্য)
app.post('/api/publish-website', async (req, res) => {
  try {
    const { subdomain, base_domain, html_content } = req.body;
    const allowedDomains = ['sojib.qd.je', 'sojib.de5.net', 'sojub.cc.cd'];

    if (!allowedDomains.includes(base_domain)) {
      return res.status(400).json({ success: false, message: 'অনুমোদিত ডোমেন নির্বাচন করুন।' });
    }

    const cleanSub = String(subdomain || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!cleanSub || cleanSub.length < 2) {
      return res.status(400).json({ success: false, message: 'সঠিক সাবডোমেইন নাম দিন।' });
    }

    if (['admin', 'api', 'dashboard', 'mail', 'www'].includes(cleanSub)) {
      return res.status(400).json({ success: false, message: 'এই সাবডোমেনটি সিস্টেম সংরক্ষিত।' });
    }

    await pool.query(
      `INSERT INTO hosted_websites (subdomain, base_domain, html_content, is_published)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (subdomain, base_domain)
       DO UPDATE SET html_content = $3, is_published = TRUE`,
      [cleanSub, base_domain, html_content]
    );

    res.json({
      success: true,
      url: `https://${cleanSub}.${base_domain}`,
      message: `🎉 ওয়েবসাইট সফলভাবে লাইভ হয়েছে: https://${cleanSub}.${base_domain}`
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ================= ৭. SUPER ADMIN API এন্ডপয়েন্টস =================

// অ্যাডমিন ড্যাশবোর্ড লোড
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// অ্যাডমিনের সব তথ্য ওভারভিউ
app.get('/api/admin/overview', async (req, res) => {
  try {
    const users = await pool.query('SELECT id, email, role, plan, created_at FROM users ORDER BY id DESC');
    const bots = await pool.query('SELECT id, bot_name, phone_number, server_id, status FROM whatsapp_bots ORDER BY id DESC');
    const websites = await pool.query('SELECT id, subdomain, base_domain, is_published, created_at FROM hosted_websites ORDER BY id DESC');
    const servers = await pool.query('SELECT id, server_name, server_url, current_load, max_capacity FROM worker_servers ORDER BY id DESC');

    res.json({
      success: true,
      users: users.rows,
      bots: bots.rows,
      websites: websites.rows,
      servers: servers.rows
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ইউজারের প্ল্যান Free ⇄ Premium করা
app.post('/api/admin/update-user-plan', async (req, res) => {
  try {
    const { userId, plan } = req.body;
    await pool.query('UPDATE users SET plan = $1 WHERE id = $2', [plan, userId]);
    res.json({ success: true, message: `ইউজারের প্ল্যান ${plan}-এ পরিবর্তিত হয়েছে!` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ওয়েবসাইট ডিলিট করা
app.post('/api/admin/delete-site', async (req, res) => {
  try {
    const { id } = req.body;
    await pool.query('DELETE FROM hosted_websites WHERE id = $1', [id]);
    res.json({ success: true, message: 'ওয়েবসাইটটি ডাটাবেজ থেকে ডিলিট করা হয়েছে।' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// সার্ভার নোড যোগ ও বট ট্রান্সফার
app.post('/api/admin/add-server', async (req, res) => {
  try {
    const { server_name, server_url, max_capacity } = req.body;
    await pool.query(
      'INSERT INTO worker_servers (server_name, server_url, max_capacity) VALUES ($1, $2, $3)',
      [server_name, server_url, max_capacity || 10]
    );
    res.json({ success: true, message: 'নতুন রেন্ডার সার্ভার সফলভাবে যুক্ত হয়েছে।' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/transfer-bot', async (req, res) => {
  try {
    const { botId, targetServerId } = req.body;
    await pool.query('UPDATE whatsapp_bots SET server_id = $1 WHERE id = $2', [targetServerId, botId]);
    res.json({ success: true, message: `বট #${botId} সফলভাবে নতুন সার্ভার #${targetServerId}-এ ট্রান্সফার করা হয়েছে!` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// রুট ভিউ (User Portal)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ================= ৮. সার্ভার চালু =================
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[INFO]: 🚀 FreeSite Master Server running on port ${PORT}`);
  try {
    await initializeDatabase();
    // পূর্বে সংযুক্ত বটগুলো স্বয়ংক্রিয়ভাবে সক্রিয় করা
    const bots = await pool.query("SELECT id FROM whatsapp_bots WHERE status = 'CONNECTED'");
    for (const row of bots.rows) {
      await startTenantBot(row.id);
    }
  } catch (e) {
    console.error('[ERROR]: Server startup database check failed:', e.message);
  }
});

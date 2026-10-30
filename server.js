/**
 * FreeSite SaaS — Multi-Tenant WhatsApp AI Bot Platform
 * Full Dashboard (Token Stats + Live Logs + Color Picker + API Manager)
 * Multi-Server Health & Auto-Rebalancing Engine
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const pino = require('pino');
const { GoogleGenAI } = require('@google/genai');

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
const botLiveLogs = new Map();

function addBotLog(botId, type, message) {
  const bId = Number(botId);
  if (!botLiveLogs.has(bId)) botLiveLogs.set(bId, []);
  const logs = botLiveLogs.get(bId);
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  logs.unshift({ time, type, message });
  if (logs.length > 50) logs.pop();
}

// PostgreSQL সেশন এডাপ্টার (Render স্লিপ বা রিস্টার্ট হলেও WhatsApp লগআউট হবে না)
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

// ================= সাবডোমেন রাউটার (qd.je চিরতরে বাদ) =================
app.use(async (req, res, next) => {
  // API বা Admin হলে পাস করবে
  if (req.path.startsWith('/api/') || req.path === '/admin') return next();

  // Host বিশ্লেষণ
  const rawHost = req.headers['x-forwarded-host'] || req.headers.host || '';
  const host = rawHost.toLowerCase().split(':')[0].trim();
  const targetDomains = ['sojib.de5.net', 'sojub.cc.cd']; // qd.je বাদ

  let detectedSub = req.query.sub || null; // ?sub=daimondghor সাপোর্ট
  let detectedBase = 'sojib.de5.net';

  for (const base of targetDomains) {
    if (host.endsWith(base) && host !== base && !host.startsWith('www.')) {
      detectedSub = host.replace(`.${base}`, '').trim();
      detectedBase = base;
      break;
    }
  }

  if (detectedSub && !['admin', 'api', 'dashboard', 'mail', 'www'].includes(detectedSub)) {
    try {
      // বটের তথ্য ডাটাবেজ থেকে উদ্ধার
      const botRes = await pool.query(
        `SELECT b.*, h.theme_color 
         FROM whatsapp_bots b 
         LEFT JOIN hosted_websites h ON b.id = h.bot_id 
         WHERE b.subdomain = $1 OR h.subdomain = $1 
         ORDER BY b.id DESC LIMIT 1`,
        [detectedSub]
      );

      if (botRes.rows.length > 0) {
        const bot = botRes.rows[0];
        return res.send(generateUserBrandedDashboard(bot, `${detectedSub}.${detectedBase}`));
      }
    } catch (err) {
      console.error('[ROUTER ERROR]:', err);
    }
  }
  next();
});

// ================= সম্পূর্ণ প্রিমিয়াম ইউজার ড্যাশবোর্ড জেনারেটর =================
function generateUserBrandedDashboard(bot, fullUrl) {
  const primaryColor = bot.theme_color || '#38bdf8';
  const typeTitle = bot.bot_type === 'personal' ? 'ব্যক্তিগত AI সহকারী' : (bot.bot_type === 'business_no_site' ? 'শপ অ্যাসিস্ট্যান্ট' : 'ই-কমার্স সেলস বট');

  return `<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${bot.bot_name} — Control Center</title>
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
    .card h3 { font-size: 16px; margin-bottom: 15px; display: flex; align-items: center; gap: 8px; color: var(--primary); }
    .form-group { margin-bottom: 15px; }
    label { display: block; font-size: 13px; color: #a1a1aa; margin-bottom: 6px; }
    input, select { width: 100%; padding: 12px; background: #000; border: 1px solid var(--border); border-radius: 8px; color: #fff; font-size: 14px; outline: none; }
    button { width: 100%; padding: 12px; background: var(--primary); color: #fff; border: none; border-radius: 8px; font-weight: 700; cursor: pointer; display: flex; justify-content: center; align-items: center; gap: 8px; }
    
    /* Stats Grid */
    .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
    .stat-box { background: #000; border: 1px solid var(--border); border-radius: 10px; padding: 15px; text-align: center; }
    .stat-val { font-size: 24px; font-weight: 700; color: var(--primary); margin-top: 4px; }
    .stat-lbl { font-size: 12px; color: #a1a1aa; }

    /* Terminal Logs */
    .terminal-window { background: #000; border: 1px solid #27272a; border-radius: 8px; padding: 12px; height: 200px; overflow-y: auto; font-family: monospace; font-size: 13px; }
    .log-line { margin-bottom: 6px; display: flex; gap: 8px; }
    .log-time { color: #71717a; }
    .log-msg { color: #e4e4e7; }
    .log-msg.success { color: #4ade80; }
    .log-msg.info { color: #38bdf8; }
    .log-msg.warn { color: #fbbf24; }

    /* Code Box */
    .code-box { background: #000; border: 2px dashed var(--primary); padding: 16px; border-radius: 10px; text-align: center; margin-top: 15px; display: none; }
    .code-text { font-size: 26px; font-weight: 800; letter-spacing: 5px; color: #4ade80; font-family: monospace; }
    .color-picker-box { display: flex; gap: 10px; margin-top: 10px; }
    .color-dot { width: 32px; height: 32px; border-radius: 50%; cursor: pointer; border: 2px solid transparent; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <div class="brand-title"><i class="ti ti-robot"></i> ${bot.bot_name}</div>
        <p style="font-size:12px; color:#a1a1aa;">🔗 ডোমেইন: ${fullUrl} | মোড: ${typeTitle}</p>
      </div>
      <div style="font-size:12px; color:#4ade80; background:rgba(74,222,128,0.1); padding:5px 12px; border-radius:20px; border:1px solid #16a34a;">
        ● ${bot.status || 'DISCONNECTED'}
      </div>
    </div>

    <!-- 📊 API & Token Usage Stats -->
    <div class="stats-grid">
      <div class="stat-box">
        <div class="stat-lbl">মোট টোকেন খরচ (Total Tokens)</div>
        <div class="stat-val" id="tokenVal">${bot.tokens_used || 0}</div>
      </div>
      <div class="stat-box">
        <div class="stat-lbl">আজকের মোট মেসেজ (Requests Today)</div>
        <div class="stat-val" id="reqVal">${bot.requests_today || 0}</div>
      </div>
    </div>

    <!-- 📲 WhatsApp Linking & Pairing Code -->
    <div class="card">
      <h3><i class="ti ti-brand-whatsapp"></i> হোয়াটসঅ্যাপ কানেক্ট করুন (Pairing Code)</h3>
      <div class="form-group">
        <label>আপনার হোয়াটসঅ্যাপ মোবাইল নম্বর (যেমন: 88017...):</label>
        <input type="text" id="phoneInput" placeholder="8801XXXXXXXXX" value="${bot.phone_number || ''}">
      </div>
      <button onclick="requestPairingCode(${bot.id})"><i class="ti ti-key"></i> পেয়ারিং কোড জেনারেট করুন</button>

      <div id="codeBanner" class="code-box">
        <div style="font-size:12px; color:var(--primary); margin-bottom:5px;">WHATSAPP PAIRING CODE:</div>
        <div id="codeDisplay" class="code-text">----</div>
        <p style="font-size:12px; color:#a1a1aa; margin-top:8px;">হোয়াটসঅ্যাপের Linked Devices ➔ Link with phone number-এ কোডটি লিখুন।</p>
      </div>
    </div>

    <!-- 📜 লাইভ কনসোল লগ উইন্ডো -->
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h3 style="margin:0;"><i class="ti ti-terminal-2"></i> লাইভ অ্যাক্টিভিটি লগ (Live Console)</h3>
        <span style="font-size:11px; color:#4ade80;">● Auto-updating</span>
      </div>
      <div class="terminal-window" id="terminalBox">
        <div class="log-line"><span class="log-time">[System]</span><span class="log-msg info">লগ টার্মিনাল সক্রিয়...</span></div>
      </div>
    </div>

    <!-- 🔑 ইউজারের নিজস্ব Gemini API Key সেটিংস -->
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <h3 style="margin:0;"><i class="ti ti-key"></i> আপনার নিজস্ব Gemini API Key</h3>
        <span style="font-size:11px; padding:3px 8px; border-radius:5px; background:rgba(56,189,248,0.15); color:var(--primary);" id="keyBadge">
          ${bot.gemini_api_key ? '✅ নিজস্ব API Key সক্রিয়' : 'ℹ️ প্ল্যাটফর্ম ডিফল্ট Key'}
        </span>
      </div>
      <p style="font-size:13px; color:#a1a1aa; margin-bottom:10px;">আপনার নিজস্ব Gemini API Key দিলে কোনো লিমিট ছাড়া বট চলবে:</p>
      <div class="form-group">
        <input type="password" id="apiKeyInput" placeholder="AIzaSy..." value="${bot.gemini_api_key || ''}">
      </div>
      <button onclick="saveApiKey(${bot.id})"><i class="ti ti-device-floppy"></i> API Key সংরক্ষণ করুন</button>
    </div>

    <!-- 🎨 ড্যাশবোর্ড কালার চেঞ্জ -->
    <div class="card">
      <h3><i class="ti ti-palette"></i> ড্যাশবোর্ডের রঙ পরিবর্তন করুন</h3>
      <p style="font-size:13px; color:#a1a1aa;">আপনার পছন্দের নিয়ন থিম সিলেক্ট করুন:</p>
      <div class="color-picker-box">
        <div class="color-dot" style="background:#38bdf8;" onclick="changeTheme('#38bdf8')"></div>
        <div class="color-dot" style="background:#10b981;" onclick="changeTheme('#10b981')"></div>
        <div class="color-dot" style="background:#a855f7;" onclick="changeTheme('#a855f7')"></div>
        <div class="color-dot" style="background:#ef4444;" onclick="changeTheme('#ef4444')"></div>
        <div class="color-dot" style="background:#f59e0b;" onclick="changeTheme('#f59e0b')"></div>
        <div class="color-dot" style="background:#ec4899;" onclick="changeTheme('#ec4899')"></div>
      </div>
    </div>
  </div>

  <script>
    // লাইভ লগ ও স্ট্যাটস অটো-ফেচিং
    async function fetchLiveUpdates() {
      try {
        const res = await fetch('/api/user/bot-logs?botId=${bot.id}');
        const data = await res.json();
        if (data.success) {
          if (data.logs && data.logs.length > 0) {
            document.getElementById('terminalBox').innerHTML = data.logs.map(l => 
              \`<div class="log-line"><span class="log-time">[\${l.time}]</span> <span class="log-msg \${l.type}">\${l.message}</span></div>\`
            ).join('');
          }
          if (data.stats) {
            document.getElementById('tokenVal').innerText = data.stats.tokens;
            document.getElementById('reqVal').innerText = data.stats.requests;
          }
        }
      } catch (e) {}
    }
    setInterval(fetchLiveUpdates, 3000);
    fetchLiveUpdates();

    async function saveApiKey(botId) {
      const apiKey = document.getElementById('apiKeyInput').value.trim();
      const res = await fetch('/api/user/update-api-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId, apiKey })
      });
      const data = await res.json();
      if(data.success) {
        alert('✅ API Key সফলভাবে আপডেট হয়েছে!');
        document.getElementById('keyBadge').innerText = apiKey ? '✅ নিজস্ব API Key সক্রিয়' : 'ℹ️ প্ল্যাটফর্ম ডিফল্ট Key';
      }
    }

    async function requestPairingCode(botId) {
      const phone = document.getElementById('phoneInput').value;
      if (!phone) return alert('ফোন নম্বর দিন!');
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
        alert(data.message || 'কোড তৈরি হয়নি');
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

// ================= AI মেসেজ এক্সিকিউশন (টোকেন কাউন্ট সহ) =================
async function executeGeminiForTenant(botRow, userPrompt, systemPrompt, imageBuffer = null, imageMime = 'image/jpeg') {
  let reply = '';
  let usedTokens = 0;

  if (botRow.gemini_api_key && botRow.gemini_api_key.trim().length > 20) {
    try {
      const client = new GoogleGenAI({ apiKey: botRow.gemini_api_key.trim() });
      const contents = [];
      if (imageBuffer) contents.push({ inlineData: { data: imageBuffer.toString('base64'), mimeType: imageMime } });
      contents.push(userPrompt);

      const response = await client.models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config: { systemInstruction, temperature: 0.35, maxOutputTokens: 1200, thinkingConfig: { thinkingBudget: 0 } }
      });
      reply = response.text?.trim() || response.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
      usedTokens = response.usageMetadata?.totalTokenCount || 50;
    } catch (err) {
      addBotLog(botRow.id, 'warn', `ইউজার কী ব্যর্থ: ${err.message} (সেন্ট্রাল কী দিয়ে ট্রাই হচ্ছে)`);
    }
  }

  if (!reply) {
    reply = await callGeminiUltraFast(userPrompt, systemPrompt, imageBuffer, imageMime);
    usedTokens = 45;
  }

  // ডাটাবেজে টোকেন এবং রিকোয়েস্ট কাউন্টার আপডেট
  try {
    await pool.query(
      `UPDATE whatsapp_bots 
       SET tokens_used = COALESCE(tokens_used, 0) + $1, 
           requests_today = COALESCE(requests_today, 0) + 1 
       WHERE id = $2`,
      [usedTokens, botRow.id]
    );
  } catch (e) {}

  return reply;
}

// ================= ডাইনামিক AI মেসেজ হ্যান্ডলার =================
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

  let catalogContext = '';
  if (botRow.bot_type === 'business_site') {
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
    if (searchResult.items && searchResult.items.length > 0) {
      catalogContext = searchResult.items.map(p => `• [ID:${p.id}] ${p.name} | মূল্য: ৳${p.price} | লিংক: ${p.buy_link}`).join('\n');
    }
  }

  const conversationHistoryText = history.length > 0 
    ? history.map(h => `${h.role === 'user' ? 'গ্রাহক' : 'অ্যাসিস্ট্যান্ট'}: ${h.text}`).join('\n')
    : 'এখনই কথোপকথন শুরু হয়েছে।';

  let systemPrompt = '';
  if (botRow.bot_type === 'personal') {
    systemPrompt = `তুমি ${botRow.bot_name} এর অত্যন্ত বুদ্ধিমান ও মিষ্টি ব্যক্তিগত সহকারী (Personal AI Assistant)। ব্যবহারকারীর পরিচয়: ${botRow.system_prompt || 'ব্যক্তিগত ইউজার'}। কাস্টমারকে "ভাইয়া" সম্বোধন করবে। পূর্ববর্তী হিস্ট্রি: ${conversationHistoryText}`;
  } else if (botRow.bot_type === 'business_no_site') {
    systemPrompt = `তুমি ${botRow.bot_name} এর সেলস অ্যাসিস্ট্যান্ট। দোকান ও পণ্যের বিবরণ: ${botRow.system_prompt}। ডেলিভারি: ভেতরে ৳${botRow.delivery_inside || 70}, বাইরে ৳${botRow.delivery_outside || 130}। হিস্ট্রি: ${conversationHistoryText}`;
  } else {
    systemPrompt = `তুমি ${botRow.bot_name} এর সেলস অ্যাসিস্ট্যান্ট। পণ্য দেখতে চাইলে নাম, দাম এবং লিংক দাও। ক্যাটালগ: ${catalogContext}। হিস্ট্রি: ${conversationHistoryText}`;
  }

  const userPrompt = imageBuffer ? `গ্রাহক পণ্যের ছবি পাঠিয়েছেন এবং লিখেছেন: "${cleanInput}"` : `গ্রাহক: "${cleanInput}"`;
  let reply = await executeGeminiForTenant(botRow, userPrompt, systemPrompt, imageBuffer, imageMime);
  reply = reply.replace(/\*\*/g, '*');

  history.push({ role: 'user', text: cleanInput || 'ছবি পাঠিয়েছেন', time: Date.now() });
  history.push({ role: 'assistant', text: reply, time: Date.now() });
  if (history.length > 8) history.shift();

  return reply;
}

// ================= ANTI-BAN Baileys Bot স্টার্টার =================
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
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: false,
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      retryRequestDelayMs: 500,
      maxMsgRetryCount: 3
    });

    activeSockets.set(botId, { sock, state: { connected: false, pairingCode: null } });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      const b = activeSockets.get(botId);

      if (connection === 'close') {
        if (b) b.state.connected = false;
        await pool.query("UPDATE whatsapp_bots SET status = 'DISCONNECTED' WHERE id = $1", [botId]);
        addBotLog(botId, 'warn', '⚠️ সেশন সাময়িক ডিসকানেক্ট। রি-কানেক্ট হচ্ছে...');
        if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => startTenantBot(botId), 10000);
        }
      } else if (connection === 'open') {
        if (b) {
          b.state.connected = true;
          b.state.pairingCode = null;
        }
        await pool.query("UPDATE whatsapp_bots SET status = 'CONNECTED' WHERE id = $1", [botId]);
        addBotLog(botId, 'success', `🎉 WhatsApp সফলভাবে কানেক্ট হয়েছে!`);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      try {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        if (sender.includes('@g.us')) return;

        const cleanSender = sender.replace(/[^0-9]/g, '');
        const msgContent = msg.message.ephemeralMessage?.message || msg.message.viewOnceMessage?.message || msg.message;
        let text = (msgContent.conversation || msgContent.extendedTextMessage?.text || msgContent.imageMessage?.caption || '').trim();

        const isAudio = Boolean(msgContent.audioMessage);
        const isImage = Boolean(msgContent.imageMessage);
        if (!text && !isAudio && !isImage) return;

        // 🛡️ ANTI-BAN হিউম্যান রিডিং ডিলে
        await delay(1200 + Math.random() * 800);
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
            addBotLog(botId, 'info', `🖼️ [${cleanSender}]: ছবি পাঠিয়েছেন।`);
          } catch (e) {}
        }

        if (isAudio) {
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
            text = await transcribeAudioWithGemini(buffer, msgContent.audioMessage.mimetype || 'audio/ogg');
            addBotLog(botId, 'info', `🎤 [${cleanSender} ভয়েস]: "${text}"`);
          } catch (e) {}
        }

        if (!text && !isImage) return;
        if (text) addBotLog(botId, 'info', `📩 [${cleanSender}]: "${text}"`);

        let reply = await handleDynamicCustomerMessage(botRow, cleanSender, text, sock, imageBuffer, imageMime);
        if (isAudio) reply = `🎤 *ভয়েস রেকর্ড:* "${text}"\n\n${reply}`;

        // 🛡️ হিউম্যান টাইপিং ডিলে
        const typingDelay = Math.min(3000, Math.max(1500, reply.length * 20));
        await delay(typingDelay);

        await sock.sendMessage(sender, { text: reply });
        await sock.sendPresenceUpdate('paused', sender);
        addBotLog(botId, 'success', `⚡ [এআই উত্তর পাঠানো সম্পন্ন]`);
      } catch (err) {
        addBotLog(botId, 'warn', `ত্রুটি: ${err.message}`);
      }
    });

    return sock;
  } catch (err) {
    return null;
  }
}

// ================= API ENDPOINTS =================

// ১. ড্যাশবোর্ড তৈরি
app.post('/api/launch-bot-dashboard', async (req, res) => {
  try {
    const { bot_type, bot_name, website_url, custom_info, subdomain, base_domain } = req.body;
    const cleanSub = String(subdomain || '').toLowerCase().replace(/[^a-z0-9-]/g, '');

    if (!cleanSub) return res.status(400).json({ success: false, message: 'সঠিক সাবডোমেইন নাম দিন।' });

    let finalPrompt = custom_info || '';
    let extractedProducts = [];

    if (bot_type === 'business_site' && website_url) {
      const siteKnowledge = await analyzeAndExtractWebsiteKnowledge(website_url);
      finalPrompt = siteKnowledge.description;
      extractedProducts = siteKnowledge.products || [];
    }

    // বটের রো তৈরি (subdomain সরাসরি সেভ হচ্ছে)
    const botInsert = await pool.query(
      `INSERT INTO whatsapp_bots (bot_name, website_url, system_prompt, bot_type, subdomain, status)
       VALUES ($1, $2, $3, $4, $5, 'DISCONNECTED') RETURNING id`,
      [bot_name || 'My Bot', website_url || '', finalPrompt, bot_type || 'personal', cleanSub]
    );
    const botId = botInsert.rows[0].id;

    for (const p of extractedProducts) {
      await pool.query(
        `INSERT INTO bot_products (bot_id, name, price, category, description, buy_link)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [botId, p.name, p.price, p.category, p.description, p.buy_link]
      );
    }

    await pool.query(
      `INSERT INTO hosted_websites (subdomain, base_domain, bot_id, theme_color)
       VALUES ($1, $2, $3, '#38bdf8')
       ON CONFLICT (subdomain, base_domain) DO UPDATE SET bot_id = $3`,
      [cleanSub, base_domain || 'sojib.de5.net', botId]
    );

    addBotLog(botId, 'info', `🚀 ড্যাশবোর্ড সক্রিয় হয়েছে!`);

    res.json({
      success: true,
      botId,
      dashboardUrl: `https://${cleanSub}.${base_domain || 'sojib.de5.net'}`
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ২. ড্যাশবোর্ডের লাইভ লগ ও টোকেন স্ট্যাটস ফেচ করা
app.get('/api/user/bot-logs', async (req, res) => {
  const botId = Number(req.query.botId);
  const logs = botLiveLogs.get(botId) || [];
  let stats = { tokens: 0, requests: 0 };
  try {
    const s = await pool.query('SELECT tokens_used, requests_today FROM whatsapp_bots WHERE id = $1', [botId]);
    if (s.rows.length > 0) {
      stats.tokens = s.rows[0].tokens_used || 0;
      stats.requests = s.rows[0].requests_today || 0;
    }
  } catch (e) {}
  res.json({ success: true, logs, stats });
});

// ৩. API Key আপডেট
app.post('/api/user/update-api-key', async (req, res) => {
  try {
    const { botId, apiKey } = req.body;
    await pool.query('UPDATE whatsapp_bots SET gemini_api_key = $1 WHERE id = $2', [apiKey ? apiKey.trim() : null, botId]);
    addBotLog(botId, 'success', apiKey ? '🔑 নতুন Gemini API Key সংযুক্ত হয়েছে।' : 'ℹ️ প্ল্যাটফর্ম ডিফল্ট Key সক্রিয়।');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ৪. পেয়ারিং কোড রিকোয়েস্ট
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
      addBotLog(botId, 'info', `📲 পেয়ারিং কোড তৈরি: ${code}`);
      return res.json({ success: true, pairingCode: code });
    }
    return res.status(400).json({ success: false, message: 'বট ইতিমধ্যে সংযুক্ত রয়েছে।' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ৫. থিম কালার আপডেট
app.post('/api/user/update-theme', async (req, res) => {
  try {
    const { botId, themeColor } = req.body;
    await pool.query('UPDATE hosted_websites SET theme_color = $1 WHERE bot_id = $2', [themeColor, botId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

// ================= SUPER ADMIN ENDPOINTS (Auto Rebalancing) =================
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/api/admin/overview', async (req, res) => {
  try {
    const users = await pool.query('SELECT * FROM users');
    const bots = await pool.query('SELECT * FROM whatsapp_bots ORDER BY id DESC');
    const servers = await pool.query('SELECT * FROM worker_servers ORDER BY id DESC');
    res.json({ success: true, users: users.rows, bots: bots.rows, servers: servers.rows });
  } catch (e) { res.status(500).json({ success: false }); }
});

// 🔄 সার্ভারে বেশি চাপ পড়লে এক ক্লিকে ইউজার ভাগ করে দেওয়া (Auto-Rebalance)
app.post('/api/admin/rebalance-servers', async (req, res) => {
  try {
    const servers = await pool.query('SELECT id FROM worker_servers WHERE is_active = TRUE ORDER BY id ASC');
    if (servers.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'কোনো সক্রিয় ওয়ার্কার সার্ভার নেই!' });
    }
    const bots = await pool.query('SELECT id FROM whatsapp_bots ORDER BY id ASC');
    const srvIds = servers.rows.map(s => s.id);

    for (let i = 0; i < bots.rows.length; i++) {
      const assignedSrv = srvIds[i % srvIds.length]; // সমভাবে ভাগ
      await pool.query('UPDATE whatsapp_bots SET server_id = $1 WHERE id = $2', [assignedSrv, bots.rows[i].id]);
    }

    res.json({ success: true, message: `🎉 সফল! মোট ${bots.rows.length} টি বট ${srvIds.length} টি সার্ভারে সমানভাবে ভাগ করে দেওয়া হয়েছে!` });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// রুট ভিউ
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// সার্ভার চালু
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[INFO]: 🚀 FreeSite Master Server running on port ${PORT}`);
  try {
    await initializeDatabase();
    await pool.query('ALTER TABLE whatsapp_bots ADD COLUMN IF NOT EXISTS subdomain VARCHAR(100);');
    await pool.query('ALTER TABLE whatsapp_bots ADD COLUMN IF NOT EXISTS tokens_used INT DEFAULT 0;');
    await pool.query('ALTER TABLE whatsapp_bots ADD COLUMN IF NOT EXISTS requests_today INT DEFAULT 0;');
    await pool.query('ALTER TABLE whatsapp_bots ADD COLUMN IF NOT EXISTS gemini_api_key TEXT;');
    await pool.query('ALTER TABLE hosted_websites ADD COLUMN IF NOT EXISTS bot_id INT REFERENCES whatsapp_bots(id) ON DELETE CASCADE;');
    await pool.query('ALTER TABLE hosted_websites ADD COLUMN IF NOT EXISTS theme_color VARCHAR(30) DEFAULT \'#38bdf8\';');

    const bots = await pool.query("SELECT id FROM whatsapp_bots WHERE status = 'CONNECTED'");
    for (const row of bots.rows) await startTenantBot(row.id);
  } catch (e) {}
});

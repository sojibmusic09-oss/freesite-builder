/**
 * FreeSite SaaS — Multi-Tenant Branded WhatsApp AI Bot Platform
 * Live Dashboard Logs + User Custom Gemini API Key + Anti-Ban Engine
 * Models: gemini-3.5-flash, gemini-2.5-flash, gemini-3.1-flash-lite, gemini-3.6-flash, gemini-3.8-flash
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

// 📜 প্রতিটি বটের লাইভ লগ সংরক্ষণ ব্যবস্থা (Per-Bot Live Logs Buffer)
const botLiveLogs = new Map();

function addBotLog(botId, type, message) {
  const bId = Number(botId);
  if (!botLiveLogs.has(bId)) botLiveLogs.set(bId, []);
  const logs = botLiveLogs.get(bId);
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  logs.unshift({ time, type, message });
  if (logs.length > 50) logs.pop(); // সাম্প্রতিক ৫০টি লগ সংরক্ষণ
}

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

// ================= সাবডোমেন রাউটার: ইউজারের নিজস্ব ড্যাশবোর্ড =================
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

// ইউজারের নিজস্ব ড্যাশবোর্ডের HTML জেনারেটর (লাইভ লগ + কাস্টম API Key সহ)
function generateUserBrandedDashboard(bot, fullUrl) {
  const primaryColor = bot.theme_color || '#3b82f6';
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
    .card h3 { font-size: 17px; margin-bottom: 15px; display: flex; align-items: center; gap: 8px; color: var(--primary); }
    .form-group { margin-bottom: 15px; }
    label { display: block; font-size: 13px; color: #a1a1aa; margin-bottom: 6px; }
    input, select { width: 100%; padding: 12px; background: #000; border: 1px solid var(--border); border-radius: 8px; color: #fff; font-size: 14px; outline: none; }
    button { width: 100%; padding: 12px; background: var(--primary); color: #fff; border: none; border-radius: 8px; font-weight: 700; cursor: pointer; display: flex; justify-content: center; align-items: center; gap: 8px; }
    .code-box { background: #000; border: 2px dashed var(--primary); padding: 18px; border-radius: 10px; text-align: center; margin-top: 15px; display: none; }
    .code-text { font-size: 28px; font-weight: 800; letter-spacing: 5px; color: #4ade80; font-family: monospace; }
    .color-picker-box { display: flex; gap: 10px; margin-top: 10px; }
    .color-dot { width: 32px; height: 32px; border-radius: 50%; cursor: pointer; border: 2px solid transparent; }
    
    /* 📜 লাইভ কনসোল লগ উইন্ডো */
    .terminal-window {
      background: #000;
      border: 1px solid #27272a;
      border-radius: 8px;
      padding: 12px;
      height: 220px;
      overflow-y: auto;
      font-family: monospace;
      font-size: 13px;
    }
    .terminal-window::-webkit-scrollbar { width: 4px; }
    .terminal-window::-webkit-scrollbar-thumb { background: #3f3f46; border-radius: 4px; }
    .log-line { margin-bottom: 6px; display: flex; gap: 8px; }
    .log-time { color: #71717a; }
    .log-msg { color: #e4e4e7; }
    .log-msg.success { color: #4ade80; }
    .log-msg.info { color: #38bdf8; }
    .log-msg.warn { color: #fbbf24; }
    .badge-api { font-size: 11px; padding: 4px 8px; border-radius: 6px; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56,189,248,0.3); }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <div class="brand-title"><i class="ti ti-robot"></i> ${bot.bot_name}</div>
        <p style="font-size:12px; color:#a1a1aa;">🔗 ড্যাশবোর্ড: ${fullUrl} | মোড: ${typeTitle}</p>
      </div>
      <div style="font-size:12px; color:#4ade80; background:rgba(74,222,128,0.1); padding:5px 12px; border-radius:20px; border:1px solid #16a34a;">
        ● ${bot.status || 'DISCONNECTED'}
      </div>
    </div>

    <!-- 🔑 ইউজারের নিজস্ব Gemini API Key সেটিংস -->
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h3 style="margin:0;"><i class="ti ti-key"></i> Gemini AI API Key</h3>
        <span class="badge-api" id="apiKeyStatus">${bot.gemini_api_key ? '✅ নিজস্ব API Key সক্রিয়' : 'ℹ️ প্ল্যাটফর্ম ডিফল্ট Key'}</span>
      </div>
      <p style="font-size:13px; color:#a1a1aa; margin-bottom:10px;">
        আপনার নিজের Google Gemini API Key থাকলে এখানে দিন (ফাঁকা রাখলে আমাদের সেন্ট্রাল কী দিয়ে চলবে):
      </p>
      <div class="form-group">
        <input type="password" id="userApiKey" placeholder="AIzaSy..." value="${bot.gemini_api_key || ''}">
      </div>
      <button onclick="saveApiKey(${bot.id})"><i class="ti ti-device-floppy"></i> API Key সংরক্ষণ করুন</button>
    </div>

    <!-- 📜 লাইভ কনসোল লগ (Real-Time Terminal) -->
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h3 style="margin:0;"><i class="ti ti-terminal-2"></i> লাইভ বট অ্যাক্টিভিটি লগ (Live Logs)</h3>
        <span style="font-size:11px; color:#4ade80;">● Auto-updating</span>
      </div>
      <div class="terminal-window" id="terminalBox">
        <div class="log-line"><span class="log-time">[System]</span><span class="log-msg info">লগ টার্মিনাল প্রস্তুত হচ্ছে...</span></div>
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

    <!-- থিম কালার বদলানোর অপশন -->
    <div class="card">
      <h3><i class="ti ti-palette"></i> ড্যাশবোর্ডের রঙ পরিবর্তন করুন</h3>
      <div class="color-picker-box">
        <div class="color-dot" style="background:#3b82f6;" onclick="changeTheme('#3b82f6')"></div>
        <div class="color-dot" style="background:#10b981;" onclick="changeTheme('#10b981')"></div>
        <div class="color-dot" style="background:#8b5cf6;" onclick="changeTheme('#8b5cf6')"></div>
        <div class="color-dot" style="background:#ef4444;" onclick="changeTheme('#ef4444')"></div>
        <div class="color-dot" style="background:#f59e0b;" onclick="changeTheme('#f59e0b')"></div>
      </div>
    </div>
  </div>

  <script>
    // লাইভ লগ ফেচিং ফাংশন (প্রতি ৩ সেকেন্ড পর পর)
    async function fetchLiveLogs() {
      try {
        const res = await fetch('/api/user/bot-logs?botId=${bot.id}');
        const data = await res.json();
        if (data.success && data.logs) {
          const terminal = document.getElementById('terminalBox');
          if (data.logs.length === 0) {
            terminal.innerHTML = '<div class="log-line"><span class="log-time">[System]</span><span class="log-msg">এখনো কোনো ইনকামিং মেসেজ আসেনি।</span></div>';
            return;
          }
          terminal.innerHTML = data.logs.map(l => 
            \`<div class="log-line">
              <span class="log-time">[\${l.time}]</span> 
              <span class="log-msg \${l.type}">\${l.message}</span>
            </div>\`
          ).join('');
        }
      } catch (e) {}
    }
    setInterval(fetchLiveLogs, 3000);
    fetchLiveLogs();

    // নিজস্ব API Key সেভ করা
    async function saveApiKey(botId) {
      const apiKey = document.getElementById('userApiKey').value.trim();
      const res = await fetch('/api/user/update-api-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId, apiKey })
      });
      const data = await res.json();
      if (data.success) {
        alert('✅ Gemini API Key সফলভাবে আপডেট হয়েছে!');
        document.getElementById('apiKeyStatus').innerText = apiKey ? '✅ নিজস্ব API Key সক্রিয়' : 'ℹ️ প্ল্যাটফর্ম ডিফল্ট Key';
      } else {
        alert('ত্রুটি: ' + data.message);
      }
    }

    // পেয়ারিং কোড রিকোয়েস্ট
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

// ================= AI প্রসেসিং ইঞ্জিন (User Key ও Platform Key ইন্টিগ্রেটেড) =================
async function executeGeminiForTenant(botRow, userPrompt, systemPrompt, imageBuffer = null, imageMime = 'image/jpeg') {
  // ১. ইউজার যদি নিজের Gemini Key দেয়, তবে ইউজারের কী দিয়ে রান হবে
  if (botRow.gemini_api_key && botRow.gemini_api_key.trim().length > 20) {
    try {
      const client = new GoogleGenAI({ apiKey: botRow.gemini_api_key.trim() });
      const contents = [];
      if (imageBuffer) {
        contents.push({ inlineData: { data: imageBuffer.toString('base64'), mimeType: imageMime } });
      }
      contents.push(userPrompt);

      const response = await client.models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config: {
          systemInstruction,
          temperature: 0.35,
          maxOutputTokens: 1200,
          thinkingConfig: { thinkingBudget: 0 }
        }
      });
      const reply = response.text?.trim() || response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (reply) return reply;
    } catch (err) {
      addBotLog(botRow.id, 'warn', `⚠️ ইউজার API Key ত্রুটি: ${err.message} (ডিফল্ট কী ট্রাই হচ্ছে)`);
    }
  }

  // ২. অন্যথায় আমাদের অবিকৃত সেন্ট্রাল callGeminiUltraFast লজিক কল হবে
  return await callGeminiUltraFast(userPrompt, systemPrompt, imageBuffer, imageMime);
}

// ================= ডাইনামিক AI মেসেজ প্রসেসিং =================
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
    } else {
      catalogContext = cachedCatalog.slice(0, 8).map(p => `• [ID:${p.id}] ${p.name} | মূল্য: ৳${p.price} | লিংক: ${p.buy_link}`).join('\n');
    }
  }

  const conversationHistoryText = history.length > 0 
    ? history.map(h => `${h.role === 'user' ? 'গ্রাহক' : 'অ্যাসিস্ট্যান্ট'}: ${h.text}`).join('\n')
    : 'এখনই কথোপকথন শুরু হয়েছে।';

  let systemPrompt = '';
  if (botRow.bot_type === 'personal') {
    systemPrompt = `তুমি ${botRow.bot_name} এর অত্যন্ত বুদ্ধিমান, ভদ্র ও বিনয়ী ব্যক্তিগত সহকারী (Personal AI Assistant)।
ব্যবহারকারীর সম্পর্কে তথ্য: ${botRow.system_prompt || 'একজন প্রফেশনাল ব্যক্তি'}।
আচরণ:
১. কেউ মেসেজ দিলে অত্যন্ত মিষ্টি ও আপন মানুষের মতো "ভাইয়া" সম্বোধন করে কথা বলবে।
২. সাধারণ গল্প করলে বন্ধুর মতো কথা বলবে।
পূর্ববর্তী চ্যাট হিস্ট্রি:
${conversationHistoryText}`;
  } else if (botRow.bot_type === 'business_no_site') {
    systemPrompt = `তুমি ${botRow.bot_name} এর সিনিয়র কাস্টমার সার্ভিস ও সেলস অ্যাসিস্ট্যান্ট।
দোকান / ব্যবসার বিবরণ ও পণ্য: ${botRow.system_prompt || 'আমাদের দোকানে সেরা মানের পণ্য পাওয়া যায়'}।
ডেলিভারি তথ্য: সিটির ভেতরে ৳${botRow.delivery_inside || 70}, বাইরে ৳${botRow.delivery_outside || 130} (ক্যাশ অন ডেলিভারি)।
আচরণ:
১. কাস্টমারকে "ভাইয়া" সম্বোধন করবে।
২. পণ্যের বিষয়ে জানতে চাইলে বিনয়ের সাথে বুঝিয়ে বলবে।
পূর্ববর্তী চ্যাট হিস্ট্রি:
${conversationHistoryText}`;
  } else {
    systemPrompt = `তুমি ${botRow.bot_name} (${botRow.website_url || ''}) এর সিনিয়র সেলস অ্যাসিস্ট্যান্ট।
আচরণ:
১. কাস্টমারকে আপন মানুষের মতো "ভাইয়া" সম্বোধন করবে।
২. পণ্য দেখতে চাইলে নাম, দাম এবং অবশ্যই লিংক দেবে।
৩. ডেলিভারি তথ্য: ভেতরে ৳${botRow.delivery_inside || 70}, বাইরে ৳${botRow.delivery_outside || 130}।
৪. ক্যাটালগ:
${catalogContext}
পূর্ববর্তী চ্যাট হিস্ট্রি:
${conversationHistoryText}`;
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

    // 🛡️ ANTI-BAN MacBook Desktop Web Signature
    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: false,
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      emitOwnEvents: false,
      retryRequestDelayMs: 500,
      maxMsgRetryCount: 3
    });

    activeSockets.set(botId, { sock, state: { connected: false, pairingCode: null } });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('call', async (calls) => {
      for (const call of calls) {
        if (call.status === 'offer') {
          try {
            await delay(2000);
            await sock.rejectCall(call.id, call.from);
            addBotLog(botId, 'warn', `📞 কল অটো-রিজেক্ট করা হয়েছে: ${call.from.split('@')[0]}`);
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
        addBotLog(botId, 'warn', '⚠️ WhatsApp সেশন ডিসকানেক্ট হয়েছে। পুনরায় চেষ্টা হচ্ছে...');
        if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => startTenantBot(botId), 10000);
        }
      } else if (connection === 'open') {
        if (b) {
          b.state.connected = true;
          b.state.pairingCode = null;
        }
        await pool.query("UPDATE whatsapp_bots SET status = 'CONNECTED' WHERE id = $1", [botId]);
        addBotLog(botId, 'success', `🎉 WhatsApp সফলভাবে কানেক্ট হয়েছে! বট লাইভ।`);
        console.log(`[INFO]: ✅ Anti-Ban Bot #${botId} (${botRow.bot_name}) is LIVE!`);
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

        // 🛡️ ANTI-BAN হিউম্যান রিডিং সিমুলেশন
        await delay(1200 + Math.random() * 800);
        try {
          await sock.readMessages([msg.key]);
          await sock.presenceSubscribe(sender);
          await sock.sendPresenceUpdate('composing', sender);
        } catch (e) {}

        let imageBuffer = null;
        let imageMime = 'image/jpeg';
        if (isImage) {
          try {
            imageBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
            imageMime = msgContent.imageMessage.mimetype || 'image/jpeg';
            addBotLog(botId, 'info', `🖼️ [${cleanSender}] থেকে ছবি গ্রহণ করা হয়েছে।`);
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

        // 🛡️ ANTI-BAN হিউম্যান টাইপিং ডিলে
        const typingDelay = Math.min(3000, Math.max(1500, reply.length * 20));
        await delay(typingDelay);

        await sock.sendMessage(sender, { text: reply });
        await sock.sendPresenceUpdate('paused', sender);

        addBotLog(botId, 'success', `⚡ [বট উত্তর পাঠানো সম্পন্ন]: ${reply.substring(0, 45)}...`);
      } catch (err) {
        addBotLog(botId, 'warn', `এরর: ${err.message}`);
      }
    });

    return sock;
  } catch (err) {
    return null;
  }
}

// ================= API ENDPOINTS =================

// ১. বট ড্যাশবোর্ড লঞ্চ
app.post('/api/launch-bot-dashboard', async (req, res) => {
  try {
    const { bot_type, bot_name, website_url, custom_info, subdomain, base_domain } = req.body;
    const cleanSub = String(subdomain || '').toLowerCase().replace(/[^a-z0-9-]/g, '');

    if (!cleanSub || !base_domain) return res.status(400).json({ success: false, message: 'সঠিক সাবডোমেইন দিন।' });

    let finalPrompt = custom_info || '';
    let extractedProducts = [];

    if (bot_type === 'business_site' && website_url) {
      const siteKnowledge = await analyzeAndExtractWebsiteKnowledge(website_url);
      finalPrompt = siteKnowledge.description;
      extractedProducts = siteKnowledge.products || [];
    }

    const botInsert = await pool.query(
      `INSERT INTO whatsapp_bots (bot_name, website_url, system_prompt, bot_type, status)
       VALUES ($1, $2, $3, $4, 'DISCONNECTED') RETURNING id`,
      [bot_name || 'My Bot', website_url || '', finalPrompt, bot_type || 'personal']
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
       VALUES ($1, $2, $3, '#3b82f6')
       ON CONFLICT (subdomain, base_domain) DO UPDATE SET bot_id = $3`,
      [cleanSub, base_domain, botId]
    );

    addBotLog(botId, 'info', `🚀 ${bot_name} ড্যাশবোর্ড সক্রিয় হয়েছে!`);

    res.json({
      success: true,
      botId,
      dashboardUrl: `https://${cleanSub}.${base_domain}`
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ২. লাইভ লগ পাওয়ার API (User Dashboard Polling)
app.get('/api/user/bot-logs', (req, res) => {
  const botId = Number(req.query.botId);
  const logs = botLiveLogs.get(botId) || [];
  res.json({ success: true, logs });
});

// ৩. ইউজারের নিজস্ব API Key সংরক্ষণ API
app.post('/api/user/update-api-key', async (req, res) => {
  try {
    const { botId, apiKey } = req.body;
    await pool.query('UPDATE whatsapp_bots SET gemini_api_key = $1 WHERE id = $2', [apiKey ? apiKey.trim() : null, botId]);
    addBotLog(botId, 'success', apiKey ? '🔑 নতুন Gemini API Key সংযুক্ত হয়েছে।' : 'ℹ️ প্ল্যাটফর্ম ডিফল্ট কী নির্বাচিত হয়েছে।');
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
      addBotLog(botId, 'info', `📲 পেয়ারিং কোড তৈরি হয়েছে: ${code}`);
      return res.json({ success: true, pairingCode: code });
    }
    return res.status(400).json({ success: false, message: 'বট ইতিমধ্যে সংযুক্ত আছে।' });
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

// রুট ভিউ
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// সার্ভার চালু
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[INFO]: 🚀 Anti-Ban FreeSite Master Server running on port ${PORT}`);
  try {
    await initializeDatabase();
    await pool.query('ALTER TABLE whatsapp_bots ADD COLUMN IF NOT EXISTS bot_type VARCHAR(50) DEFAULT \'personal\';');
    await pool.query('ALTER TABLE whatsapp_bots ADD COLUMN IF NOT EXISTS gemini_api_key TEXT;');
    await pool.query('ALTER TABLE hosted_websites ADD COLUMN IF NOT EXISTS bot_id INT REFERENCES whatsapp_bots(id) ON DELETE CASCADE;');
    await pool.query('ALTER TABLE hosted_websites ADD COLUMN IF NOT EXISTS theme_color VARCHAR(30) DEFAULT \'#3b82f6\';');

    const bots = await pool.query("SELECT id FROM whatsapp_bots WHERE status = 'CONNECTED'");
    for (const row of bots.rows) await startTenantBot(row.id);
  } catch (e) {}
});

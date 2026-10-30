/**
 * FreeSite SaaS — Master Server (Subdomain Priority Router Fixed)
 * Architect: Sojib | WhatsApp: 01409084819 | TikTok: @sojib..music
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const pino = require('pino');
const { GoogleGenAI } = require('@google/genai');

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

// PostgreSQL সেশন অ্যাডাপ্টার
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

// ================= ১ নম্বর অগ্রাধিকার: সাবডোমেন রাউটার (TOP PRIORITY) =================
app.use(async (req, res, next) => {
  // API বা Admin রুট হলে ছাড়বে
  if (req.path.startsWith('/api/') || req.path === '/admin') return next();

  // Host বিশ্লেষণ
  const rawHost = req.headers['x-forwarded-host'] || req.headers.host || '';
  const host = rawHost.toLowerCase().split(':')[0].trim();
  const targetDomains = ['sojib.de5.net', 'sojub.cc.cd'];

  let detectedSub = req.query.sub || null;
  let detectedBase = 'sojib.de5.net';

  // ডিরেক্ট পাথ সাপোর্ট: /dash/daimondghor
  if (req.path.startsWith('/dash/')) {
    detectedSub = req.path.replace('/dash/', '').split('/')[0].trim();
  }

  for (const base of targetDomains) {
    if (host.endsWith(base) && host !== base && !host.startsWith('www.')) {
      detectedSub = host.replace(`.${base}`, '').trim();
      detectedBase = base;
      break;
    }
  }

  // যদি সাবডোমেন ডিটেক্ট হয়
  if (detectedSub && !['admin', 'api', 'dashboard', 'mail', 'www'].includes(detectedSub)) {
    try {
      const cleanSub = detectedSub.toLowerCase();
      const botRes = await pool.query(
        `SELECT b.*, h.theme_color 
         FROM whatsapp_bots b 
         LEFT JOIN hosted_websites h ON b.id = h.bot_id 
         WHERE LOWER(b.subdomain) = $1 OR LOWER(h.subdomain) = $1 
         ORDER BY b.id DESC LIMIT 1`,
        [cleanSub]
      );

      if (botRes.rows.length > 0) {
        const bot = botRes.rows[0];
        const pNumRes = await pool.query('SELECT key, value FROM admin_settings WHERE key IN (\'bkash_no\', \'nagad_no\', \'rocket_no\')');
        const payConfig = {};
        pNumRes.rows.forEach(r => payConfig[r.key] = r.value);

        // সরাসরি ইউজার ড্যাশবোর্ড রিটার্ন করবে (কোনো ক্রিয়েটর পেজ ঢুকতে পারবে না!)
        return res.send(generateUserBrandedDashboard(bot, `${cleanSub}.${detectedBase}`, payConfig));
      } else {
        return res.status(404).send(`
          <div style="font-family:sans-serif; text-align:center; padding:50px; background:#f8fafc; color:#0f172a; min-height:100vh;">
            <h2>⚠️ বট ড্যাশবোর্ড পাওয়া যায়নি!</h2>
            <p>সাবডোমেইন <b>${cleanSub}</b> ডাটাবেজে এখনো তৈরি করা হয়নি।</p>
            <a href="https://${detectedBase}" style="color:#059669; font-weight:700;">নতুন বট তৈরি করুন 👉</a>
          </div>
        `);
      }
    } catch (err) {
      console.error('[ROUTER ERROR]:', err);
    }
  }
  next();
});

// স্ট্যাটিক ফাইল মিডলওয়্যার (index: false দিয়ে বন্ধ করা হলো যাতে হাইজ্যাক না হয়)
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ================= সম্পূর্ণ ইউজার ড্যাশবোর্ড জেনারেটর =================
function generateUserBrandedDashboard(bot, fullUrl, payConfig = {}) {
  const primaryColor = bot.theme_color || '#10b981';
  const bkash = payConfig.bkash_no || '01409084819';
  const nagad = payConfig.nagad_no || '01409084819';
  const rocket = payConfig.rocket_no || '01409084819';

  return `<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${bot.bot_name} — Control Center</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=Hind+Siliguri:wght@400;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css">
  <style>
    :root {
      --primary: ${primaryColor};
      --bg: #f8fafc;
      --card: #ffffff;
      --border: #e2e8f0;
      --text: #0f172a;
      --muted: #64748b;
    }
    * { box-sizing: border-box; margin:0; padding:0; font-family: 'Plus Jakarta Sans', 'Hind Siliguri', sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 15px; }
    .container { max-width: 850px; margin: 0 auto; }
    
    .header {
      background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 20px;
      display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;
      box-shadow: 0 4px 20px -2px rgba(0,0,0,0.03);
    }
    .brand-title { font-size: 20px; font-weight: 800; color: #047857; display: flex; align-items: center; gap: 8px; }
    .status-badge { font-size: 12px; font-weight: 700; padding: 6px 14px; border-radius: 30px; }
    .status-badge.connected { background: #dcfce7; color: #15803d; border: 1px solid #bbf7d0; }
    .status-badge.disconnected { background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; }

    .card { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 22px; margin-bottom: 20px; box-shadow: 0 4px 20px -2px rgba(0,0,0,0.03); }
    .card h3 { font-size: 16px; font-weight: 700; color: #065f46; display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }

    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
    .stat-box { background: #f8fafc; border: 1px solid var(--border); border-radius: 12px; padding: 16px; text-align: center; }
    .stat-val { font-size: 24px; font-weight: 800; color: #059669; margin-top: 4px; }
    .stat-lbl { font-size: 12px; color: var(--muted); font-weight: 600; }

    .form-group { margin-bottom: 14px; }
    label { display: block; font-size: 13px; color: #334155; margin-bottom: 6px; font-weight: 600; }
    input, select, textarea {
      width: 100%; padding: 12px 14px; background: #ffffff; border: 1px solid var(--border);
      border-radius: 10px; font-size: 14px; color: #0f172a; outline: none; transition: 0.2s;
    }
    input:focus, select:focus, textarea:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.15); }

    button {
      width: 100%; padding: 13px; background: #059669; color: #fff; border: none;
      border-radius: 10px; font-weight: 700; cursor: pointer; display: flex; justify-content: center; align-items: center; gap: 8px; font-size: 14px;
    }
    button:hover { background: #047857; }

    .code-box { background: #f0fdf4; border: 2px dashed #059669; padding: 16px; border-radius: 12px; text-align: center; margin-top: 15px; display: none; }
    .code-val { font-size: 28px; font-weight: 800; letter-spacing: 6px; color: #047857; font-family: monospace; }

    .terminal-window { background: #0f172a; border-radius: 10px; padding: 14px; height: 180px; overflow-y: auto; font-family: monospace; font-size: 13px; color: #f8fafc; }
    .log-line { margin-bottom: 6px; }

    .payment-box { background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 12px; padding: 16px; margin-top: 14px; }
    .pay-methods { display: flex; gap: 8px; margin-bottom: 12px; }
    .pay-badge { flex: 1; text-align: center; padding: 8px; border-radius: 8px; font-size: 12px; font-weight: 700; border: 1px solid var(--border); cursor: pointer; background: #fff; }
    .pay-badge.active { background: #ecfdf5; border-color: #059669; color: #059669; }

    .color-dot { width: 32px; height: 32px; border-radius: 50%; cursor: pointer; border: 2px solid transparent; }
    .color-picker { display: flex; gap: 10px; margin-top: 10px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <div class="brand-title"><i class="ti ti-brand-whatsapp" style="color:#25d366; font-size:26px;"></i> ${bot.bot_name}</div>
        <p style="font-size:12px; color:var(--muted); margin-top:4px;">
          🌐 ডোমেইন: <a href="https://${fullUrl}" target="_blank" style="color:#059669; font-weight:600;">${fullUrl}</a> | প্ল্যান: <b>${(bot.plan || 'free').toUpperCase()}</b>
        </p>
      </div>
      <span class="status-badge ${bot.status === 'CONNECTED' ? 'connected' : 'disconnected'}">
        ● ${bot.status || 'DISCONNECTED'}
      </span>
    </div>

    <!-- 📊 লাইভ স্ট্যাটাস মিটার -->
    <div class="stats-grid">
      <div class="stat-box">
        <div class="stat-lbl">মোট টোকেন খরচ</div>
        <div class="stat-val" id="tokenVal">${bot.tokens_used || 0}</div>
      </div>
      <div class="stat-box">
        <div class="stat-lbl">আজকের মোট মেসেজ</div>
        <div class="stat-val" id="reqVal">${bot.requests_today || 0}</div>
      </div>
      <div class="stat-box">
        <div class="stat-lbl">সার্ভার গার্ড লিমিট</div>
        <div class="stat-val" style="color:#d97706;">${bot.rate_limit_daily || 300} req/day</div>
      </div>
    </div>

    <!-- 💬 লাইভ এআই টেস্ট চ্যাটবক্স (Live Test AI Connection) -->
    <div class="card" style="border: 2px solid #10b981;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h3><i class="ti ti-messages" style="color:#059669;"></i> লাইভ এআই কানেকশন টেস্ট (Live Test Chat)</h3>
        <span style="font-size:11px; padding:3px 8px; border-radius:12px; background:#dcfce7; color:#15803d; font-weight:700;">● AI Active</span>
      </div>
      <p style="font-size:12px; color:var(--muted); margin-bottom:10px;">
        WhatsApp কানেক্ট করার আগেই এখানে মেসেজ দিয়ে টেস্ট করুন এআই আপনার ওয়েবসাইটের তথ্য ঠিকমতো বলছে কি না:
      </p>
      <div id="testChatWindow" style="background:#f8fafc; border:1px solid var(--border); border-radius:10px; padding:12px; height:160px; overflow-y:auto; margin-bottom:10px; font-size:13px;">
        <div style="color:#64748b; font-style:italic;">বটের সাথে কথা বলতে নিচে মেসেজ লিখুন...</div>
      </div>
      <div style="display:flex; gap:8px;">
        <input type="text" id="testMsgInput" placeholder="যেমন: টুর্নামেন্টের ফি কত? অথবা নিয়ম কী?" style="flex:1;">
        <button onclick="sendTestChatMessage(${bot.id})" style="width:auto; padding:0 20px; background:#059669;">
          <i class="ti ti-send"></i> পাঠান
        </button>
      </div>
    </div>

    <!-- ✏️ সম্পূর্ণ বট এডিটিং ও ওয়েবসাইট রি-অ্যানালাইসিস সেকশন -->
    <div class="card">
      <h3><i class="ti ti-edit"></i> বটের তথ্য ও ওয়েবসাইট এডিট করুন</h3>
      <div class="form-group">
        <label>বটের নাম / প্ল্যাটফর্ম নাম:</label>
        <input type="text" id="editBotName" value="${bot.bot_name}">
      </div>
      <div class="form-group">
        <label>ওয়েবসাইট লিংক (Website URL):</label>
        <div style="display:flex; gap:8px;">
          <input type="url" id="editSiteUrl" value="${bot.website_url || ''}" placeholder="https://tournament-site.com">
          <button onclick="reanalyzeWebsite(${bot.id})" style="width:auto; white-space:nowrap; background:#0284c7; font-size:13px; padding:0 15px;">
            <i class="ti ti-refresh"></i> রি-অ্যানালাইজ করুন
          </button>
        </div>
      </div>
      <div class="form-group">
        <label>বটের ধরন (Bot Type):</label>
        <select id="editBotType">
          <option value="business_site" ${bot.bot_type === 'business_site' ? 'selected' : ''}>🛍️ ই-কমার্স শপ (ওয়েবসাইট লিংক)</option>
          <option value="business_no_site" ${bot.bot_type === 'business_no_site' ? 'selected' : ''}>🏬 সাধারণ দোকান (ওয়েবসাইট ছাড়া)</option>
          <option value="personal" ${bot.bot_type === 'personal' ? 'selected' : ''}>👤 পার্সোনাল ইউজার (ব্যক্তিগত সহকারী)</option>
        </select>
      </div>
      <div class="form-group">
        <label>এআই নির্দেশিকা / বায়ো / পণ্য বিবরণ:</label>
        <textarea id="editPrompt" rows="3">${bot.system_prompt || ''}</textarea>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
        <div class="form-group">
          <label>ডেলিভারি (সিটির ভেতরে ৳):</label>
          <input type="number" id="editDelIn" value="${bot.delivery_inside || 70}">
        </div>
        <div class="form-group">
          <label>ডেলিভারি (সিটির বাইরে ৳):</label>
          <input type="number" id="editDelOut" value="${bot.delivery_outside || 130}">
        </div>
      </div>
      <button onclick="saveBotSettings(${bot.id})" style="background:#0284c7;">
        <i class="ti ti-device-floppy"></i> বটের নতুন তথ্য সেভ করুন
      </button>
    </div>

    <!-- 📲 WhatsApp পেয়ারিং কোড সেকশন -->
    <div class="card">
      <h3><i class="ti ti-qrcode"></i> WhatsApp লিঙ্ক করুন (Pairing Code)</h3>
      <div class="form-group">
        <label>আপনার মোবাইল নম্বর (যেমন: 88017...):</label>
        <input type="text" id="phoneInput" placeholder="8801XXXXXXXXX" value="${bot.phone_number || ''}">
      </div>
      <button onclick="requestPairingCode(${bot.id})"><i class="ti ti-key"></i> পেয়ারিং কোড তৈরি করুন</button>

      <div id="codeBanner" class="code-box">
        <div style="font-size:12px; color:#047857; font-weight:700; margin-bottom:4px;">WHATSAPP PAIRING CODE:</div>
        <div id="codeDisplay" class="code-val">----</div>
        <p style="font-size:12px; color:#475569; margin-top:6px;">WhatsApp ➔ Linked Devices ➔ Link with phone number-এ কোডটি দিন।</p>
      </div>
    </div>

    <!-- 💳 প্রিমিয়াম আপগ্রেড ও পেমেন্ট ভেরিফিকেশন -->
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h3><i class="ti ti-crown" style="color:#d97706;"></i> প্রিমিয়াম আপগ্রেড ও পেমেন্ট সিস্টেম</h3>
        <span style="font-size:12px; color:#059669; font-weight:700;">ফি: ৳৩০০ / মাস</span>
      </div>
      <p style="font-size:13px; color:var(--muted); margin-bottom:12px;">
        আনলিমিটেড মেসেজ ও সুপারফাস্ট রেসপন্সের জন্য টাকা পাঠিয়ে TrxID দিন:
      </p>

      <div class="pay-methods">
        <div class="pay-badge active" id="badge-bkash" onclick="selectPay('bKash', '${bkash}')">bKash</div>
        <div class="pay-badge" id="badge-nagad" onclick="selectPay('Nagad', '${nagad}')">Nagad</div>
        <div class="pay-badge" id="badge-rocket" onclick="selectPay('Rocket', '${rocket}')">Rocket</div>
      </div>

      <div class="payment-box">
        <div style="font-size:13px; font-weight:700; color:#0f172a; margin-bottom:6px;" id="sendNumberNotice">
          👉 bKash পাঠান: <span style="color:#059669; font-size:15px;">${bkash}</span> (Send Money)
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:10px;">
          <input type="text" id="senderNumber" placeholder="যে নম্বর থেকে পাঠিয়েছেন">
          <input type="text" id="trxId" placeholder="Transaction ID (TrxID)">
        </div>
        <button onclick="submitPayment(${bot.id})" style="background:#0284c7; margin-top:10px;">
          <i class="ti ti-send"></i> ভেরিফিকেশনের জন্য জমা দিন
        </button>
      </div>
    </div>

    <!-- 🔑 নিজস্ব Gemini API Key -->
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <h3><i class="ti ti-key"></i> নিজস্ব Gemini API Key</h3>
        <span style="font-size:11px; font-weight:700; color:#059669;">
          ${bot.gemini_api_key ? '✅ নিজস্ব Key সক্রিয়' : 'ℹ️ প্ল্যাটফর্ম ডিফল্ট Key'}
        </span>
      </div>
      <div class="form-group">
        <input type="password" id="apiKeyInput" placeholder="AIzaSy..." value="${bot.gemini_api_key || ''}">
      </div>
      <button onclick="saveApiKey(${bot.id})"><i class="ti ti-device-floppy"></i> API Key সংরক্ষণ করুন</button>
    </div>

    <!-- 📜 লাইভ কনসোল লগ -->
    <div class="card">
      <h3><i class="ti ti-terminal"></i> লাইভ অ্যাক্টিভিটি টার্মিনাল</h3>
      <div class="terminal-window" id="terminalBox">
        <div class="log-line"><span class="log-time">[System]</span> টার্মিনাল প্রস্তুত...</div>
      </div>
    </div>

    <!-- 🎨 থিম কালার প্যালেট -->
    <div class="card">
      <h3><i class="ti ti-palette"></i> অ্যাকসেন্ট কালার পরিবর্তন</h3>
      <div class="color-picker">
        <div class="color-dot" style="background:#10b981;" onclick="changeTheme('#10b981')"></div>
        <div class="color-dot" style="background:#0284c7;" onclick="changeTheme('#0284c7')"></div>
        <div class="color-dot" style="background:#8b5cf6;" onclick="changeTheme('#8b5cf6')"></div>
        <div class="color-dot" style="background:#f43f5e;" onclick="changeTheme('#f43f5e')"></div>
        <div class="color-dot" style="background:#d97706;" onclick="changeTheme('#d97706')"></div>
      </div>
    </div>

    <div style="text-align:center; padding:20px; font-size:12px; color:var(--muted);">
      Platform by <b>Sojib</b> • WhatsApp: <a href="https://wa.me/8801409084819" target="_blank" style="color:#059669;">01409084819</a> • TikTok: <a href="https://tiktok.com/@sojib..music" target="_blank" style="color:#059669;">@sojib..music</a>
    </div>
  </div>

  <script>
    let currentMethod = 'bKash';
    function selectPay(method, number) {
      currentMethod = method;
      document.querySelectorAll('.pay-badge').forEach(b => b.classList.remove('active'));
      event.target.classList.add('active');
      document.getElementById('sendNumberNotice').innerHTML = '👉 ' + method + ' পাঠান: <span style="color:#059669; font-size:15px;">' + number + '</span> (Send Money)';
    }

    async function saveBotSettings(botId) {
      const data = {
        botId,
        bot_name: document.getElementById('editBotName').value.trim(),
        bot_type: document.getElementById('editBotType').value,
        system_prompt: document.getElementById('editPrompt').value.trim(),
        delivery_inside: document.getElementById('editDelIn').value,
        delivery_outside: document.getElementById('editDelOut').value
      };
      const res = await fetch('/api/user/update-bot-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const d = await res.json();
      alert(d.message);
    }

    async function submitPayment(botId) {
      const sender = document.getElementById('senderNumber').value.trim();
      const trxId = document.getElementById('trxId').value.trim();
      if(!sender || !trxId) return alert('সেন্ডার নম্বর এবং TrxID দিন!');
      const res = await fetch('/api/user/submit-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId, method: currentMethod, sender, trxId })
      });
      const data = await res.json();
      alert(data.message);
    }

    async function fetchLiveUpdates() {
      try {
        const res = await fetch('/api/user/bot-logs?botId=${bot.id}');
        const data = await res.json();
        if (data.success) {
          if (data.logs && data.logs.length > 0) {
            document.getElementById('terminalBox').innerHTML = data.logs.map(l => 
              \`<div class="log-line"><span class="log-time">[\${l.time}]</span> \${l.message}</div>\`
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
      alert(data.message);
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

    // 💬 লাইভ এআই টেস্ট চ্যাট ফাংশন
    async function sendTestChatMessage(botId) {
      const input = document.getElementById('testMsgInput');
      const text = input.value.trim();
      if(!text) return;
      const win = document.getElementById('testChatWindow');
      win.innerHTML += '<div style="margin-bottom:8px; text-align:right;"><span style="background:#059669; color:#fff; padding:6px 12px; border-radius:12px; display:inline-block;">' + text + '</span></div>';
      input.value = '';
      win.scrollTop = win.scrollHeight;

      try {
        const res = await fetch('/api/user/test-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ botId, message: text })
        });
        const d = await res.json();
        win.innerHTML += '<div style="margin-bottom:8px; text-align:left;"><span style="background:#e2e8f0; color:#0f172a; padding:6px 12px; border-radius:12px; display:inline-block;">' + (d.reply || 'কোনো উত্তর নেই') + '</span></div>';
        win.scrollTop = win.scrollHeight;
      } catch(e) {
        win.innerHTML += '<div style="color:red; font-size:12px;">এআই রেসপন্স এরর!</div>';
      }
    }

    // 🔄 ওয়েবসাইট রি-অ্যানালাইজ ফাংশন
    async function reanalyzeWebsite(botId) {
      const url = document.getElementById('editSiteUrl').value.trim();
      if(!url) return alert('ওয়েবসাইট লিংক দিন!');
      if(!confirm('এআই কি এই ওয়েবসাইটটি নতুন করে স্ক্যান করবে?')) return;

      const btn = event.target;
      btn.innerText = 'অ্যানালাইসিস হচ্ছে...';
      const res = await fetch('/api/user/reanalyze-site', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId, website_url: url })
      });
      const d = await res.json();
      alert(d.message);
      location.reload();
    }
  </script>
</body>
</html>`;
}

// ================= AI মেসেজ এক্সিকিউশন =================
async function executeGeminiForTenant(botRow, userPrompt, systemPrompt, imageBuffer = null, imageMime = 'image/jpeg') {
  const dailyLimit = botRow.rate_limit_daily || 300;
  if ((botRow.requests_today || 0) >= dailyLimit && botRow.plan !== 'premium') {
    addBotLog(botRow.id, 'warn', `⚠️ আজকের ফ্রি লিমিট (${dailyLimit} মেসেজ) শেষ!`);
    return 'ভাইয়া, আজকের জন্য আমাদের স্বয়ংক্রিয় এআই সেবার ফ্রি লিমিট শেষ হয়ে গিয়েছে। আরও আনলিমিটেড সেবার জন্য অ্যাডমিনের সাথে যোগাযোগ করুন ❤️';
  }

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
      addBotLog(botRow.id, 'warn', `ইউজার কী ব্যর্থ: ${err.message}`);
    }
  }

  if (!reply) {
    reply = await callGeminiUltraFast(userPrompt, systemPrompt, imageBuffer, imageMime);
    usedTokens = 45;
  }

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
    systemPrompt = `তুমি ${botRow.bot_name} এর অত্যন্ত বুদ্ধিমান ও মিষ্টি ব্যক্তিগত সহকারী (Personal AI Assistant)। ব্যবহারকারীর পরিচয়: ${botRow.system_prompt || 'ব্যক্তিগত ইউজার'}। কাস্টমারকে "ভাইয়া" সম্বোধন করবে। হিস্ট্রি: ${conversationHistoryText}`;
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
        addBotLog(botId, 'warn', '⚠️ সেশন ডিসকানেক্ট। রি-কানেক্টের চেষ্টা চলছে...');
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

        // 🛡️ হিউম্যান রিডিং ডিলে
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

// ১. বট ও ড্যাশবোর্ড তৈরি
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

    const botInsert = await pool.query(
      `INSERT INTO whatsapp_bots (bot_name, website_url, system_prompt, bot_type, subdomain, status, rate_limit_daily, plan)
       VALUES ($1, $2, $3, $4, $5, 'DISCONNECTED', 300, 'free') RETURNING id`,
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
       VALUES ($1, $2, $3, '#10b981')
       ON CONFLICT (subdomain, base_domain) DO UPDATE SET bot_id = $3`,
      [cleanSub, base_domain || 'sojib.de5.net', botId]
    );

    addBotLog(botId, 'info', `🚀 ড্যাশবোর্ড তৈরি সম্পন্ন!`);

    res.json({
      success: true,
      botId,
      dashboardUrl: `https://${cleanSub}.${base_domain || 'sojib.de5.net'}`
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ২. ড্যাশবোর্ডের লাইভ লগ ও স্ট্যাটস
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

// ৩. ইউজার থেকে বটের তথ্য আপডেট (Edit Bot Info)
app.post('/api/user/update-bot-settings', async (req, res) => {
  try {
    const { botId, bot_name, bot_type, system_prompt, delivery_inside, delivery_outside } = req.body;
    await pool.query(
      `UPDATE whatsapp_bots 
       SET bot_name = $1, bot_type = $2, system_prompt = $3, delivery_inside = $4, delivery_outside = $5 
       WHERE id = $6`,
      [bot_name, bot_type, system_prompt, delivery_inside || 70, delivery_outside || 130, botId]
    );
    addBotLog(botId, 'success', '⚙️ বটের তথ্য ও নির্দেশিকা সফলভাবে আপডেট হয়েছে!');
    res.json({ success: true, message: '✅ বটের তথ্য সফলভাবে আপডেট হয়েছে!' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// 🔄 ড্যাশবোর্ড থেকে ওয়েবসাইট রি-অ্যানালাইসিস API (Gemini AI Powered)
app.post('/api/user/reanalyze-site', async (req, res) => {
  try {
    const { botId, website_url } = req.body;
    const botRes = await pool.query('SELECT gemini_api_key FROM whatsapp_bots WHERE id = $1', [botId]);
    const customKey = botRes.rows[0]?.gemini_api_key || null;

    addBotLog(botId, 'info', `🌐 এআই দিয়ে ওয়েবসাইট রি-অ্যানালাইসিস শুরু হচ্ছে: ${website_url}`);
    const knowledge = await analyzeAndExtractWebsiteKnowledge(website_url, customKey);

    await pool.query(
      `UPDATE whatsapp_bots 
       SET website_url = $1, system_prompt = $2, business_type = $3 
       WHERE id = $4`,
      [website_url, knowledge.description, knowledge.businessType, botId]
    );

    // পুরনো পণ্য মুছে নতুন তথ্য যোগ
    await pool.query('DELETE FROM bot_products WHERE bot_id = $1', [botId]);
    for (const p of knowledge.products) {
      await pool.query(
        `INSERT INTO bot_products (bot_id, name, price, category, description, buy_link) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [botId, p.name, p.price, p.category, p.description, p.buy_link]
      );
    }

    addBotLog(botId, 'success', `✅ এআই ওয়েবসাইট চিনে নিয়েছে: ${knowledge.businessType}। ক্যাটালগ ও নিয়ম সেভ হয়েছে!`);
    res.json({ success: true, message: `🎉 এআই সফলভাবে ওয়েবসাইট অ্যানালাইসিস করেছে! ক্যাটাগরি: ${knowledge.businessType}` });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// 💬 ড্যাশবোর্ড থেকে লাইভ এআই টেস্ট চ্যাট API
app.post('/api/user/test-chat', async (req, res) => {
  try {
    const { botId, message } = req.body;
    const botRes = await pool.query('SELECT * FROM whatsapp_bots WHERE id = $1', [botId]);
    if (botRes.rows.length === 0) return res.status(404).json({ success: false });

    const botRow = botRes.rows[0];
    const reply = await handleDynamicCustomerMessage(botRow, 'TEST_WEB_USER', message, null);
    res.json({ success: true, reply });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ৪. ইউজার পেমেন্ট সাবমিট
app.post('/api/user/submit-payment', async (req, res) => {
  try {
    const { botId, method, sender, trxId } = req.body;
    if (!trxId || !sender) return res.status(400).json({ success: false, message: 'সব তথ্য দিন।' });

    await pool.query(
      `INSERT INTO payments (bot_id, payment_method, sender_number, trx_id, amount, status)
       VALUES ($1, $2, $3, $4, 300, 'PENDING')`,
      [botId, method, sender, trxId]
    );
    addBotLog(botId, 'info', `💳 ৳৩০০ (${method}) পেমেন্ট জমা হয়েছে (TrxID: ${trxId}) — পেন্ডিং`);
    res.json({ success: true, message: '✅ পেমেন্ট তথ্য জমা হয়েছে! অ্যাডমিন যাচাই করে প্রিমিয়াম সক্রিয় করবেন।' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ৫. API Key আপডেট
app.post('/api/user/update-api-key', async (req, res) => {
  try {
    const { botId, apiKey } = req.body;
    await pool.query('UPDATE whatsapp_bots SET gemini_api_key = $1 WHERE id = $2', [apiKey ? apiKey.trim() : null, botId]);
    addBotLog(botId, 'success', apiKey ? '🔑 নতুন Gemini API Key যুক্ত হয়েছে।' : 'ℹ️ প্ল্যাটফর্ম ডিফল্ট Key সক্রিয়।');
    res.json({ success: true, message: '✅ API Key সংরক্ষিত হয়েছে!' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ৬. পেয়ারিং কোড রিকোয়েস্ট
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
      addBotLog(botId, 'info', `📲 পেয়ারিং কোড: ${code}`);
      return res.json({ success: true, pairingCode: code });
    }
    return res.status(400).json({ success: false, message: 'বট ইতিমধ্যে সংযুক্ত রয়েছে।' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ৭. থিম কালার আপডেট
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
    const bots = await pool.query('SELECT * FROM whatsapp_bots ORDER BY id DESC');
    const servers = await pool.query('SELECT * FROM worker_servers ORDER BY id DESC');
    const payments = await pool.query('SELECT p.*, b.bot_name FROM payments p LEFT JOIN whatsapp_bots b ON p.bot_id = b.id ORDER BY p.id DESC');
    const settings = await pool.query('SELECT key, value FROM admin_settings');
    res.json({ success: true, bots: bots.rows, servers: servers.rows, payments: payments.rows, settings: settings.rows });
  } catch (e) { res.status(500).json({ success: false }); }
});

// অ্যাডমিন থেকে প্রতি সার্ভারে ম্যাক্সিমাম বটের সীমা সেট করা
app.post('/api/admin/set-max-bots-limit', async (req, res) => {
  try {
    const { limit } = req.body;
    const numLimit = parseInt(limit, 10) || 4;
    await pool.query('INSERT INTO admin_settings (key, value) VALUES (\'max_bots_per_server\', $1) ON CONFLICT (key) DO UPDATE SET value = $1', [String(numLimit)]);
    await pool.query('UPDATE worker_servers SET max_capacity = $1', [numLimit]);
    res.json({ success: true, message: `✅ সার্ভার প্রতি সর্বোচ্চ বটের ক্যাপাসিটি ${numLimit} সেট করা হয়েছে!` });
  } catch (e) { res.status(500).json({ success: false }); }
});

// অ্যাডমিন থেকে পেমেন্ট অ্যাপ্রুভ
app.post('/api/admin/approve-payment', async (req, res) => {
  try {
    const { paymentId } = req.body;
    const payRes = await pool.query('SELECT bot_id FROM payments WHERE id = $1', [paymentId]);
    if (payRes.rows.length === 0) return res.status(404).json({ success: false });
    const botId = payRes.rows[0].bot_id;

    await pool.query('UPDATE payments SET status = \'APPROVED\' WHERE id = $1', [paymentId]);
    await pool.query('UPDATE whatsapp_bots SET plan = \'premium\', rate_limit_daily = 5000 WHERE id = $1', [botId]);
    addBotLog(botId, 'success', '🎉 অভিনন্দন! অ্যাডমিন আপনার পেমেন্ট ভেরিফাই করেছেন এবং প্রিমিয়াম সক্রিয় হয়েছে!');
    res.json({ success: true, message: '✅ পেমেন্ট অ্যাপ্রুভ হয়েছে এবং প্রিমিয়াম এক্টিভ হয়েছে!' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// অ্যাডমিন থেকে ডেইলি প্রেশার লিমিট পরিবর্তন
app.post('/api/admin/update-bot-limit', async (req, res) => {
  try {
    const { botId, newLimit } = req.body;
    await pool.query('UPDATE whatsapp_bots SET rate_limit_daily = $1 WHERE id = $2', [newLimit, botId]);
    res.json({ success: true, message: '✅ লিমিট আপডেট সম্পন্ন!' });
  } catch (e) { res.status(500).json({ success: false }); }
});

// অ্যাডমিন পেমেন্ট নম্বর পরিবর্তন
app.post('/api/admin/update-payment-numbers', async (req, res) => {
  try {
    const { bkash, nagad, rocket } = req.body;
    await pool.query('INSERT INTO admin_settings (key, value) VALUES (\'bkash_no\', $1) ON CONFLICT (key) DO UPDATE SET value = $1', [bkash]);
    await pool.query('INSERT INTO admin_settings (key, value) VALUES (\'nagad_no\', $1) ON CONFLICT (key) DO UPDATE SET value = $1', [nagad]);
    await pool.query('INSERT INTO admin_settings (key, value) VALUES (\'rocket_no\', $1) ON CONFLICT (key) DO UPDATE SET value = $1', [rocket]);
    res.json({ success: true, message: '✅ পেমেন্ট নম্বর সংরক্ষিত হয়েছে!' });
  } catch (e) { res.status(500).json({ success: false }); }
});

// 🔄 সার্ভার প্রতি ডাইনামিক বটের সীমা অনুযায়ী ভাগ করে দেওয়া (Auto-Rebalance)
app.post('/api/admin/rebalance-servers', async (req, res) => {
  try {
    const servers = await pool.query('SELECT id, max_capacity FROM worker_servers WHERE is_active = TRUE ORDER BY id ASC');
    if (servers.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'কোনো ওয়ার্কার সার্ভার নেই!' });
    }
    const bots = await pool.query('SELECT id FROM whatsapp_bots ORDER BY id ASC');
    const srvIds = servers.rows.map(s => s.id);

    for (let i = 0; i < bots.rows.length; i++) {
      const assignedSrv = srvIds[i % srvIds.length];
      await pool.query('UPDATE whatsapp_bots SET server_id = $1 WHERE id = $2', [assignedSrv, bots.rows[i].id]);
    }

    res.json({ success: true, message: `🎉 মোট ${bots.rows.length} টি বট ${srvIds.length} টি সার্ভারে সমানভাবে ভাগ করা হয়েছে!` });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ⚡ স্মার্ট সিস্টেম রিসেট (জিরো ডাটা লস — কোনো লগআউট ছাড়া মেমরি ও সকেট ফ্রেশ করা)
app.post('/api/admin/smart-reset', async (req, res) => {
  try {
    console.log('[SYSTEM]: ⚡ Smart System Reset initiated by Admin...');

    for (const [botId, bObj] of activeSockets.entries()) {
      try {
        if (bObj.sock) {
          bObj.sock.ws?.close();
          bObj.sock.ev?.removeAllListeners();
        }
      } catch (_) {}
    }
    activeSockets.clear();
    botChatHistories.clear();

    for (const [botId, logs] of botLiveLogs.entries()) {
      if (logs.length > 10) logs.length = 10;
    }

    const bots = await pool.query("SELECT id FROM whatsapp_bots WHERE status = 'CONNECTED'");
    for (const row of bots.rows) {
      await delay(800);
      startTenantBot(row.id);
    }

    res.json({
      success: true,
      message: `⚡ স্মার্ট রিসেট সম্পন্ন! কোনো ডাটা বা WhatsApp সেশন নষ্ট হয়নি। মেমরি ফ্রেশ হয়েছে এবং সক্রিয় ${bots.rows.length}টি বট পুনরায় কানেক্ট হয়েছে!`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// মূল ডোমেইনে (শুধুমাত্র রুট হোস্টে) ক্রিয়েটর পেজ লোড হবে
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// সার্ভার চালু
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[INFO]: 🚀 FreeSite Master Node running on port ${PORT}`);
  try {
    await initializeDatabase();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        bot_id INT REFERENCES whatsapp_bots(id) ON DELETE CASCADE,
        payment_method VARCHAR(50),
        sender_number VARCHAR(50),
        trx_id VARCHAR(100) UNIQUE,
        amount NUMERIC(10, 2),
        status VARCHAR(30) DEFAULT 'PENDING',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS admin_settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT
      );
    `);
    await pool.query('ALTER TABLE whatsapp_bots ADD COLUMN IF NOT EXISTS rate_limit_daily INT DEFAULT 300;');
    await pool.query('ALTER TABLE whatsapp_bots ADD COLUMN IF NOT EXISTS plan VARCHAR(30) DEFAULT \'free\';');
    await pool.query('ALTER TABLE whatsapp_bots ADD COLUMN IF NOT EXISTS subdomain VARCHAR(100);');
    await pool.query('ALTER TABLE whatsapp_bots ADD COLUMN IF NOT EXISTS tokens_used INT DEFAULT 0;');
    await pool.query('ALTER TABLE whatsapp_bots ADD COLUMN IF NOT EXISTS requests_today INT DEFAULT 0;');
    await pool.query('ALTER TABLE whatsapp_bots ADD COLUMN IF NOT EXISTS gemini_api_key TEXT;');
    await pool.query('ALTER TABLE hosted_websites ADD COLUMN IF NOT EXISTS bot_id INT REFERENCES whatsapp_bots(id) ON DELETE CASCADE;');
    await pool.query('ALTER TABLE hosted_websites ADD COLUMN IF NOT EXISTS theme_color VARCHAR(30) DEFAULT \'#10b981\';');

    await pool.query(`
      INSERT INTO admin_settings (key, value) VALUES 
      ('bkash_no', '01409084819'),
      ('nagad_no', '01409084819'),
      ('rocket_no', '01409084819'),
      ('max_bots_per_server', '4')
      ON CONFLICT (key) DO NOTHING;
    `);

    const bots = await pool.query("SELECT id FROM whatsapp_bots WHERE status = 'CONNECTED'");
    for (const row of bots.rows) await startTenantBot(row.id);
  } catch (e) {}
});

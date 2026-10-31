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

// 🔄 প্রতিদিন রাত ১২:০০ টায় মেসেজ কাউন্টার ০ করা এবং মেয়াদ শেষ হওয়া বট ফ্রি প্ল্যানে নামিয়ে দেওয়া
setInterval(async () => {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0 && now.getSeconds() < 10) {
    try {
      // ১. ডেইলি কাউন্টার রিসেট
      await pool.query('UPDATE whatsapp_bots SET requests_today = 0');

      // ২. যেসব বটের মেয়াদ (expires_at) শেষ হয়ে গেছে সেগুলো স্বয়ংক্রিয়ভাবে Free হয়ে যাবে
      await pool.query(`
        UPDATE whatsapp_bots 
        SET plan = 'free', rate_limit_daily = 300, package_name = 'Expired (Free)'
        WHERE expires_at IS NOT NULL AND expires_at < NOW() AND plan != 'free'
      `);
      console.log('[SYSTEM]: 🔄 Daily request limits reset & expired plans downgraded.');
    } catch (e) {
      console.error('[RESET ERROR]:', e.message);
    }
  }
}, 10000);

const { pool, initializeDatabase } = require('./database');
const { analyzeAndExtractWebsiteKnowledge } = require('./website_analyzer');
const apiV1Router = require('./api_v1_router');
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

// 🌐 Universal Product API v1 মাউন্ট
app.use('/api/v1', apiV1Router);

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

        // 🛍️ যদি কাস্টমাররা প্রোডাক্ট দেখার জন্য /shop বা /catalog বা /products এ ঢোকে
        if (req.path === '/shop' || req.path === '/catalog' || req.path === '/products') {
          const prods = await pool.query('SELECT * FROM bot_products WHERE bot_id = $1 ORDER BY id DESC', [bot.id]);
          return res.send(generateStorefrontView(bot, prods.rows, `${cleanSub}.${detectedBase}`));
        }

        const pNumRes = await pool.query('SELECT key, value FROM admin_settings WHERE key IN (\'bkash_no\', \'nagad_no\', \'rocket_no\')');
        const payConfig = {};
        pNumRes.rows.forEach(r => payConfig[r.key] = r.value);

        // সরাসরি ইউজার ড্যাশবোর্ড রিটার্ন করবে
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

// ================= পাবলিক সাবডোমেইন ই-কমার্স শপ ভিউয়ার =================
function generateStorefrontView(bot, products, fullUrl) {
  const primaryColor = bot.theme_color || '#10b981';
  return `<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${bot.bot_name} — অফিসিয়াল শপ</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=Hind+Siliguri:wght@400;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css">
  <style>
    :root { --primary: ${primaryColor}; --bg: #f8fafc; --card: #ffffff; --border: #e2e8f0; --text: #0f172a; --muted: #64748b; }
    * { box-sizing: border-box; margin:0; padding:0; font-family: 'Plus Jakarta Sans', 'Hind Siliguri', sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 15px; }
    .store-container { max-width: 650px; margin: 0 auto; }
    .header { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 22px; text-align: center; margin-bottom: 20px; box-shadow: 0 4px 15px rgba(0,0,0,0.03); }
    .header h1 { font-size: 22px; font-weight: 800; color: #047857; margin-bottom: 6px; }
    .header p { font-size: 13px; color: var(--muted); }
    .wa-btn { display: inline-flex; align-items: center; gap: 6px; background: #25d366; color: #fff; text-decoration: none; padding: 8px 16px; border-radius: 20px; font-size: 13px; font-weight: 700; margin-top: 12px; }
    .prod-card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 16px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; }
    .p-name { font-size: 15px; font-weight: 700; color: #0f172a; margin-bottom: 4px; }
    .p-price { font-size: 16px; font-weight: 800; color: #059669; }
    .p-desc { font-size: 12px; color: var(--muted); margin-top: 4px; }
    .order-btn { background: #059669; color: #fff; text-decoration: none; padding: 8px 14px; border-radius: 8px; font-size: 12px; font-weight: 700; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; }
  </style>
</head>
<body>
  <div class="store-container">
    <div class="header">
      <h1>🛍️ ${bot.bot_name}</h1>
      <p>${bot.system_prompt ? bot.system_prompt.substring(0, 80) + '...' : 'আমাদের অনলাইন প্রোডাক্ট ক্যাটালগে আপনাকে স্বাগতম!'}</p>
      ${bot.phone_number ? `<a href="https://wa.me/${bot.phone_number}" class="wa-btn" target="_blank"><i class="ti ti-brand-whatsapp"></i> সরাসরি হোয়াটসঅ্যাপে অর্ডার করুন</a>` : ''}
    </div>

    <div style="font-size:14px; font-weight:700; color:#334155; margin-bottom:12px;">উপলব্ধ পণ্যসমূহ (${products.length}টি)</div>

    ${products.length === 0 ? '<div style="background:#fff; padding:30px; text-align:center; border-radius:12px; color:var(--muted); font-size:13px;">বর্তমানে কোনো পণ্য তালিকায় নেই।</div>' : ''}

    ${products.map(p => `
      <div class="prod-card">
        <div>
          <div class="p-name">${p.name}</div>
          <div class="p-price">৳${p.price}</div>
          <div class="p-desc">${p.category || 'General'} ${p.description ? '• ' + p.description : ''}</div>
        </div>
        <div>
          ${p.buy_link ? `<a href="${p.buy_link}" target="_blank" class="order-btn">অর্ডার লিংক 👉</a>` : 
            (bot.phone_number ? `<a href="https://wa.me/${bot.phone_number}?text=${encodeURIComponent('আমি এই প্রোডাক্টটি নিতে চাই: ' + p.name + ' (৳' + p.price + ')')}" target="_blank" class="order-btn" style="background:#25d366;"><i class="ti ti-brand-whatsapp"></i> কিনুন</a>` : '')}
        </div>
      </div>
    `).join('')}

    <div style="text-align:center; padding:20px; font-size:11px; color:var(--muted);">
      Powered by FreeSite AI • Store Domain: <b>${fullUrl}</b>
    </div>
  </div>
</body>
</html>`;
}

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
      <div class="form-group" style="background:#ecfdf5; border:1px solid #10b981; padding:12px; border-radius:10px;">
        <label style="color:#065f46; font-weight:800;"><i class="ti ti-bell-ringing"></i> অর্ডার অ্যালার্ট পাওয়ার WhatsApp নম্বর:</label>
        <input type="text" id="editAlertPhone" value="${bot.alert_phone || ''}" placeholder="যেমন: 017XXXXXXXX বা 88017XXXXXXXX">
        <small style="color:#047857; font-size:11px; display:block; margin-top:4px;">
          👉 কেউ হোয়াটসঅ্যাপে অর্ডার কনফার্ম করলে তাৎক্ষণিক এই নম্বরে বিস্তারিত নোটিফিকেশন চলে যাবে।
        </small>
      </div>
      <div class="form-group">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
          <label style="margin:0;">ওয়েবসাইট লিংক (Website URL):</label>
          <span style="font-size:11px; font-weight:700; color:#059669; background:#ecfdf5; padding:2px 8px; border-radius:10px;">
            ${bot.plan === 'premium' ? '👑 Premium Active' : (bot.plan === 'trial' ? '🎁 Trial Active' : '🔒 10 Days Trial / Premium Feature')}
          </span>
        </div>
        <div style="display:flex; gap:8px;">
          <input type="url" id="editSiteUrl" value="${bot.website_url || ''}" placeholder="https://tournament-site.com">
          <button onclick="reanalyzeWebsite(${bot.id})" style="width:auto; white-space:nowrap; background:linear-gradient(135deg, #0284c7 0%, #0369a1 100%); font-size:13px; padding:0 18px;">
            <i class="ti ti-refresh"></i> রি-অ্যানালাইজ করুন
          </button>
        </div>
      </div>

      <!-- 🎁 ১০ দিনের ট্রায়াল / প্রিমিয়াম নোটিশ বক্স (প্রয়োজনে শো করবে) -->
      <div id="trialLockBanner" style="display:none; background:rgba(238, 242, 255, 0.9); border:1px solid #c7d2fe; border-radius:12px; padding:15px; margin-bottom:14px; text-align:center;">
        <div style="font-weight:800; color:#3730a3; font-size:14px; margin-bottom:4px;">
          👑 ওয়েবসাইট এআই অ্যানালাইসিস করতে প্রিমিয়াম বা ট্রায়াল প্রয়োজন!
        </div>
        <p style="font-size:12px; color:#4f46e5; margin-bottom:10px;" id="trialLockMsg">
          আপনি এখনও ১০ দিনের ফ্রি ট্রায়াল নেননি। এখনই ট্রায়াল নিয়ে ফ্রিতে ট্রাই করুন!
        </p>
        <div style="display:flex; justify-content:center; gap:8px;" id="trialBtnGrp">
          <button onclick="claim10DaysTrial(${bot.id})" style="width:auto; background:#4f46e5; padding:8px 16px; font-size:12px;">
            🎁 ১০ দিনের ফ্রি ট্রায়াল চালু করুন
          </button>
          <button onclick="location.href='#paySection'" style="width:auto; background:#d97706; padding:8px 16px; font-size:12px;">
            👑 প্রিমিয়াম কিনুন
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

    <!-- 🛍️ সরাসরি ড্যাশবোর্ড থেকে প্রোডাক্ট ম্যানেজমেন্ট (নিজস্ব ডাটাবেজ) -->
    <div class="card" style="border-top: 4px solid #059669;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h3><i class="ti ti-box"></i> ১-ক্লিকে পণ্য যোগ ও শপ লিংক</h3>
        <a href="https://${fullUrl}/shop" target="_blank" style="font-size:12px; background:#ecfdf5; color:#047857; padding:5px 10px; border-radius:20px; font-weight:700; text-decoration:none;">
          🌐 ভিজিট শপ
        </a>
      </div>

      <!-- 🔗 ১-ক্লিকে লিংক প্রদর্শন বক্স -->
      <div id="productSuccessBox" style="display:none; background:#ecfdf5; border:1px solid #10b981; border-radius:10px; padding:12px; margin-bottom:14px; text-align:center;">
        <span style="color:#065f46; font-weight:700; font-size:13px;">🎉 প্রোডাক্ট যোগ সম্পন্ন! আপনার অনলাইন শপ লিংক:</span>
        <div style="display:flex; gap:6px; margin-top:8px;">
          <input type="text" id="storeShareLink" readonly value="https://${fullUrl}/shop" style="text-align:center; font-weight:700; background:#fff; color:#059669; padding:8px;">
          <button onclick="copyStoreUrl()" style="width:auto; padding:0 15px; background:#059669; font-size:12px;"><i class="ti ti-copy"></i> কপি</button>
        </div>
      </div>

      <!-- নতুন প্রোডাক্ট যোগ করার ফর্ম -->
      <div style="background:#f8fafc; border:1px solid var(--border); border-radius:10px; padding:14px; margin-bottom:15px;">
        <div style="font-size:13px; font-weight:700; color:#334155; margin-bottom:8px;">➕ নতুন প্রোডাক্ট যোগ করুন:</div>
        <div style="display:grid; grid-template-columns: 2fr 1fr; gap:8px; margin-bottom:8px;">
          <input type="text" id="dashPName" placeholder="পণ্যের নাম (যেমন: M10 TWS Earbuds)">
          <input type="number" id="dashPPrice" placeholder="দাম (৳)">
        </div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-bottom:8px;">
          <input type="text" id="dashPCat" placeholder="ক্যাটাগরি (যেমন: গ্যাজেট)">
          <input type="text" id="dashPLink" placeholder="বাই লিংক (অপশনাল)">
        </div>
        <textarea id="dashPDesc" rows="2" placeholder="পণ্যের বিবরণ বা ওয়ারেন্টি তথ্য" style="margin-bottom:8px;"></textarea>
        <button onclick="addNewProductDirect(${bot.id})" style="background:#059669; padding:11px;">
          <i class="ti ti-plus"></i> ১-ক্লিকে প্রোডাক্ট সেভ ও লিংক নিন
        </button>

        <!-- 📢 প্রোডাক্ট / ক্যাটালগ লিংক না থাকলে নিচের আকর্ষণীয় হেল্পার ব্যানার -->
        <div style="margin-top:12px; background:rgba(236, 253, 245, 0.9); border:1px dashed #059669; border-radius:10px; padding:10px 14px; text-align:center;">
          <span style="font-size:12px; color:#065f46; font-weight:700;">
            👉 আপনার কি কোনো ওয়েবসাইট বা ক্যাটালগ লিংক নেই?
          </span><br>
          <a href="/catalog-builder" target="_blank" style="color:#047857; font-weight:800; font-size:13px; text-decoration:underline; display:inline-block; margin-top:4px;">
            এখানে ক্লিক করে ২ মিনিটে ফ্রি ক্যাটালগ লিংক বানিয়ে নিন! 🚀
          </a>
        </div>
      </div>

      <!-- পণ্যের তালিকা টেবিল -->
      <div style="overflow-x:auto;">
        <table style="width:100%; font-size:13px; border-collapse:collapse;">
          <thead>
            <tr style="text-align:left; border-bottom:1px solid var(--border); color:var(--muted);">
              <th style="padding:8px;">পণ্য</th>
              <th style="padding:8px;">মূল্য</th>
              <th style="padding:8px;">ক্যাটাগরি</th>
              <th style="padding:8px; text-align:right;">অ্যাকশন</th>
            </tr>
          </thead>
          <tbody id="dashProductTable">
            <tr><td colspan="4" style="text-align:center; padding:12px; color:var(--muted);">পণ্য লোড হচ্ছে...</td></tr>
          </tbody>
        </table>
      </div>
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
        alert_phone: document.getElementById('editAlertPhone').value.trim(),
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

    // 🔄 ওয়েবসাইট রি-অ্যানালাইজ ফাংশন (১০ দিনের ট্রায়াল ও প্রিমিয়াম প্রটেক্টেড)
    async function reanalyzeWebsite(botId) {
      const url = document.getElementById('editSiteUrl').value.trim();
      if(!url) return alert('ওয়েবসাইট লিংক দিন!');

      const btn = event.target;
      const originalText = btn.innerHTML;
      btn.innerText = 'যাচাই হচ্ছে...';

      try {
        const res = await fetch('/api/user/reanalyze-site', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ botId, website_url: url })
        });
        const d = await res.json();

        // যদি প্রিমিয়াম বা ট্রায়াল না থাকে
        if (d.requires_upgrade) {
          document.getElementById('trialLockBanner').style.display = 'block';
          document.getElementById('trialLockMsg').innerText = d.message;
          if (d.trial_used) {
            document.getElementById('trialBtnGrp').innerHTML = '<button onclick="location.href=\\'#paySection\\'" style="width:auto; background:#d97706; padding:8px 16px; font-size:12px;">👑 প্রিমিয়াম আপগ্রেড করুন</button>';
          }
          btn.innerHTML = originalText;
          return;
        }

        if (d.success) {
          alert(d.message);
          location.reload();
        } else {
          alert('ত্রুটি: ' + d.message);
        }
      } catch (e) {
        alert('সার্ভার কানেকশন এরর!');
      } finally {
        btn.innerHTML = originalText;
      }
    }

    // 🎁 ১০ দিনের ফ্রি ট্রায়াল সক্রিয় করা
    async function claim10DaysTrial(botId) {
      if (!confirm('আপনি কি এই বটের জন্য ১০ দিনের ফ্রি ট্রায়াল চালু করতে চান?')) return;
      try {
        const res = await fetch('/api/user/claim-trial', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ botId })
        });
        const d = await res.json();
        alert(d.message);
        if (d.success) location.reload();
      } catch (e) {
        alert('কানেকশন সমস্যা!');
      }
    }

    // 📦 ড্যাশবোর্ডের নিজস্ব প্রোডাক্ট লোড করা
    async function loadDashProducts() {
      try {
        const res = await fetch('/api/user/products?botId=${bot.id}');
        const data = await res.json();
        if (data.success) {
          const tbody = document.getElementById('dashProductTable');
          if (data.products.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:14px; color:#64748b;">কোনো পণ্য যোগ করা নেই।</td></tr>';
            return;
          }
          tbody.innerHTML = data.products.map(p => \`
            <tr style="border-bottom:1px solid #f1f5f9;">
              <td style="padding:10px 8px;"><b>\${p.name}</b><br><small style="color:#64748b;">\${p.description || ''}</small></td>
              <td style="padding:10px 8px; color:#059669; font-weight:700;">৳\${p.price}</td>
              <td style="padding:10px 8px; color:#475569;">\${p.category || 'General'}</td>
              <td style="padding:10px 8px; text-align:right;">
                <button onclick="deleteDashProduct(\${p.id})" style="background:#fee2e2; color:#b91c1c; border:none; padding:4px 10px; border-radius:6px; font-size:12px; cursor:pointer; width:auto; display:inline-block;">ডিলিট</button>
              </td>
            </tr>
          \`).join('');
        }
      } catch(e) {}
    }

    // ➕ নতুন প্রোডাক্ট যুক্ত করার ফাংশন
    async function addNewProductDirect(botId) {
      const name = document.getElementById('dashPName').value.trim();
      const price = document.getElementById('dashPPrice').value.trim();
      const category = document.getElementById('dashPCat').value.trim() || 'General';
      const buy_link = document.getElementById('dashPLink').value.trim();
      const description = document.getElementById('dashPDesc').value.trim();

      if (!name || !price) return alert('পণ্যের নাম ও দাম অবশ্যই দিতে হবে!');

      const res = await fetch('/api/user/products/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId, name, price, category, buy_link, description })
      });
      const data = await res.json();
      if (data.success) {
        document.getElementById('dashPName').value = '';
        document.getElementById('dashPPrice').value = '';
        document.getElementById('dashPCat').value = '';
        document.getElementById('dashPLink').value = '';
        document.getElementById('dashPDesc').value = '';
        
        // ১-ক্লিকে লিংক বক্স সামনে নিয়ে আসা
        document.getElementById('productSuccessBox').style.display = 'block';
        loadDashProducts();
      } else {
        alert(data.message || 'ত্রুটি ঘটেছে');
      }
    }

    function copyStoreUrl() {
      const input = document.getElementById('storeShareLink');
      input.select();
      document.execCommand('copy');
      alert('শপ লিংক কপি করা হয়েছে!');
    }

    // 🗑️ প্রোডাক্ট ডিলিট ফাংশন
    async function deleteDashProduct(productId) {
      if (!confirm('আপনি কি এই পণ্যটি মুছে ফেলতে চান?')) return;
      const res = await fetch('/api/user/products/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId: ${bot.id}, productId })
      });
      const data = await res.json();
      if (data.success) {
        loadDashProducts();
      } else {
        alert('ডিলিট করা যায়নি!');
      }
    }

    loadDashProducts();
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
  // 🔒 ডাটা আইসোলেশন: business_site অথবা catalog_link যাই হোক, শুধুমাত্র এই নির্দিষ্ট bot_id-এর ডাটাই লোড হবে
  if (botRow.bot_type === 'business_site' || botRow.bot_type === 'catalog_link') {
    const productsQuery = await pool.query('SELECT * FROM bot_products WHERE bot_id = $1', [botId]);
    const cachedCatalog = productsQuery.rows.map(p => ({
      id: p.id,
      name: p.name,
      price: parseFloat(p.price || 0),
      category: p.category || '',
      in_stock: Boolean(p.in_stock),
      buy_link: p.buy_link || `${botRow.website_url || ''}`,
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
    systemPrompt = `তুমি ${botRow.bot_name} এর সেলস অ্যাসিস্ট্যান্ট। পণ্য দেখতে চাইলে নাম, দাম এবং লিংক দাও। ক্যাটালগ তালিকা:\n${catalogContext || 'কোনো নির্দিষ্ট পণ্য পাওয়া যায়নি'}\nহিস্ট্রি: ${conversationHistoryText}`;
  }

  const userPrompt = imageBuffer ? `গ্রাহক পণ্যের ছবি পাঠিয়েছেন এবং লিখেছেন: "${cleanInput}"` : `গ্রাহক: "${cleanInput}"`;
  let reply = await executeGeminiForTenant(botRow, userPrompt, systemPrompt, imageBuffer, imageMime);
  reply = reply.replace(/\*\*/g, '*');

  // 🔔 🛒 স্বয়ংক্রিয় অর্ডার ডিটেকশন এবং ওনারের নম্বরে নোটিফিকেশন প্রেরণ
  const lowerText = cleanInput.toLowerCase();
  const isOrderIntent = lowerText.includes('order') || lowerText.includes('অর্ডার') || lowerText.includes('নিতে চাই') || lowerText.includes('কনফার্ম') || lowerText.includes('ঠিকানা');
  const hasPhone = /01[3-9]\d{8}/.test(cleanInput);

  if ((isOrderIntent || hasPhone) && sock) {
    try {
      const ownerAlertNumber = botRow.alert_phone || botRow.phone_number;
      if (ownerAlertNumber) {
        let cleanOwnerPhone = String(ownerAlertNumber).replace(/[^0-9]/g, '');
        if (cleanOwnerPhone.startsWith('01') && cleanOwnerPhone.length === 11) cleanOwnerPhone = '88' + cleanOwnerPhone;
        const ownerJid = cleanOwnerPhone.includes('@s.whatsapp.net') ? cleanOwnerPhone : `${cleanOwnerPhone}@s.whatsapp.net`;

        const alertMsg = `🚨 *নতুন অর্ডার অ্যালার্ট!* 🛍️\n` +
          `━━━━━━━━━━━━━━━━━━━\n` +
          `👤 *দোকান:* ${botRow.bot_name}\n` +
          `📞 *কাস্টমার নম্বর:* +${customerPhone}\n` +
          `💬 *মেসেজ/ঠিকানা:* ${cleanInput}\n` +
          `⏰ *সময়:* ${new Date().toLocaleTimeString('bn-BD')}\n` +
          `━━━━━━━━━━━━━━━━━━━\n` +
          `👉 *কাস্টমারকে কল করতে বা চ্যাট করতে:* wa.me/${customerPhone}`;

        // ওনারের নিজস্ব বা আলাদা নম্বরে মেসেজ সেন্ড
        await sock.sendMessage(ownerJid, { text: alertMsg });
        addBotLog(botId, 'success', `🔔 নতুন অর্ডারের নোটিফিকেশন পাঠানো হয়েছে (${cleanOwnerPhone})-এ!`);

        // ডাটাবেজে সংরক্ষণ
        await pool.query(
          `INSERT INTO bot_orders (bot_id, customer_phone, product_details) VALUES ($1, $2, $3)`,
          [botId, customerPhone, cleanInput]
        );
      }
    } catch (orderErr) {
      console.error('[ORDER ALERT ERROR]:', orderErr.message);
    }
  }

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
      browser: ['Ubuntu', 'Chrome', '20.0.04'], // ✅ মোবাইল ও হোয়াটসঅ্যাপ বিজনেসের জন্য সবচেয়ে স্টেবল ক্লায়েন্ট
      syncFullHistory: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: true,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      defaultQueryTimeoutMs: 60000
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

        // 📸 কাস্টমার ছবি চাইলে সরাসরি প্রোডাক্টের ছবি সেন্ড করার বুদ্ধিমান লজিক
        const wantsPic = /ছবি|পিক|pic|image|photo|দেখাও|দেখান|দেখি/i.test(text);
        let sentWithImage = false;

        if (wantsPic) {
          try {
            // প্রোডাক্ট থেকে ম্যাচিং ছবি খোঁজা
            const matchedProd = await pool.query(
              `SELECT name, image_url, price FROM bot_products 
               WHERE bot_id = $1 AND image_url IS NOT NULL AND image_url != '' 
               ORDER BY id DESC LIMIT 1`,
              [botId]
            );

            if (matchedProd.rows.length > 0 && matchedProd.rows[0].image_url) {
              const imgData = matchedProd.rows[0];
              // যদি Base64 ইমেজ হয়
              if (imgData.image_url.startsWith('data:image')) {
                const base64Data = imgData.image_url.split(',')[1];
                const imgBuffer = Buffer.from(base64Data, 'base64');
                await sock.sendMessage(sender, { 
                  image: imgBuffer, 
                  caption: `📸 *${imgData.name}* (মূল্য: ৳${imgData.price})\n\n${reply}` 
                });
                sentWithImage = true;
              } else if (imgData.image_url.startsWith('http')) {
                await sock.sendMessage(sender, { 
                  image: { url: imgData.image_url }, 
                  caption: `📸 *${imgData.name}* (মূল্য: ৳${imgData.price})\n\n${reply}` 
                });
                sentWithImage = true;
              }
            }
          } catch (imgErr) {
            console.error('[IMAGE SEND ERROR]:', imgErr.message);
          }
        }

        // যদি ছবি পাঠানো না হয়ে থাকে, সাধারণ টেক্সট মেসেজ যাবে
        if (!sentWithImage) {
          await sock.sendMessage(sender, { text: reply });
        }

        await sock.sendPresenceUpdate('paused', sender);
        addBotLog(botId, 'success', `⚡ [এআই উত্তর পাঠানো সম্পন্ন${sentWithImage ? ' (ছবিসহ)' : ''}]`);
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

// 📦 ক্যাটালগ সেভ করার API (ছবি সাপোর্ট ও অটো সেভ)
app.post('/api/catalog/save', async (req, res) => {
  try {
    const { store_name, catalog_slug, admin_pin, items } = req.body;
    const cleanSlug = String(catalog_slug || '').toLowerCase().trim().replace(/[^a-z0-9-]/g, '');

    if (!cleanSlug) return res.status(400).json({ success: false, message: 'স্লাগ কোড দিন।' });

    await pool.query(
      `INSERT INTO store_catalogs (catalog_slug, store_name, admin_pin)
       VALUES ($1, $2, $3)
       ON CONFLICT (catalog_slug) DO UPDATE SET store_name = $2, admin_pin = COALESCE($3, store_catalogs.admin_pin)`,
      [cleanSlug, store_name, admin_pin || '1234']
    );

    // আগের আইটেম ডিলিট করে নতুন আইটেম যোগ
    await pool.query('DELETE FROM store_catalog_items WHERE catalog_slug = $1', [cleanSlug]);

    for (const item of (items || [])) {
      await pool.query(
        `INSERT INTO store_catalog_items (catalog_slug, name, price, category, image_url, description)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [cleanSlug, item.name, item.price || 0, item.category || 'General', item.image_url || '', item.description || '']
      );
    }

    // সম্পর্কিত বটের টেবিলেও সিঙ্ক করে দেওয়া (যাতে এআই সাথে সাথে ছবি পায়)
    await pool.query(`
      UPDATE bot_products bp
      SET image_url = sci.image_url
      FROM store_catalog_items sci
      WHERE bp.name = sci.name AND sci.catalog_slug = $1
    `, [cleanSlug]);

    const host = req.get('host');
    const catalogUrl = `${req.protocol}://${host}/catalog/${cleanSlug}`;

    res.json({ success: true, catalog_url: catalogUrl, slug: cleanSlug });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 🔄 ক্যাটালগ ডাটা লোড করার API (যাতে রিফ্রেশ দিলেও ডাটা ফেরত আসে)
app.get('/api/catalog/get/:slug', async (req, res) => {
  try {
    const slug = req.params.slug.toLowerCase().trim();
    const cat = await pool.query('SELECT * FROM store_catalogs WHERE catalog_slug = $1', [slug]);
    if (cat.rows.length === 0) return res.json({ success: false, message: 'নতুন ক্যাটালগ' });

    const items = await pool.query('SELECT * FROM store_catalog_items WHERE catalog_slug = $1 ORDER BY id ASC', [slug]);
    res.json({
      success: true,
      store_name: cat.rows[0].store_name,
      admin_pin: cat.rows[0].admin_pin,
      items: items.rows
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// 📖 ক্যাটালগ পেজ ভিউয়ার রাউট
app.get('/catalog-builder', (req, res) => res.sendFile(path.join(__dirname, 'public', 'catalog_builder.html')));

app.get('/catalog/:slug', async (req, res) => {
  try {
    const slug = req.params.slug.toLowerCase().trim();
    const cat = await pool.query('SELECT * FROM store_catalogs WHERE catalog_slug = $1', [slug]);
    if (cat.rows.length === 0) return res.status(404).send('<h2>ক্যাটালগ পাওয়া যায়নি!</h2>');

    const items = await pool.query('SELECT * FROM store_catalog_items WHERE catalog_slug = $1', [slug]);
    const store = cat.rows[0];

    res.send(`<!DOCTYPE html>
    <html lang="bn">
    <head>
      <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${store.store_name} — প্রোডাক্ট ক্যাটালগ</title>
      <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700&display=swap" rel="stylesheet">
      <style>
        body { font-family:'Plus Jakarta Sans',sans-serif; background:#f8fafc; padding:20px; color:#0f172a; max-width:600px; margin:0 auto; }
        .card { background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:15px; margin-bottom:10px; }
      </style>
    </head>
    <body>
      <h2 style="color:#059669; margin-bottom:15px;">🛍️ ${store.store_name}</h2>
      ${items.rows.map(i => `
        <div class="card">
          <div style="font-weight:700; font-size:16px;">${i.name}</div>
          <div style="color:#059669; font-weight:700; margin:4px 0;">মূল্য: ৳${i.price}</div>
          <div style="font-size:13px; color:#64748b;">${i.description || ''}</div>
        </div>
      `).join('')}
    </body>
    </html>`);
  } catch(e) { res.status(500).send('Error'); }
});

// ১. বট ও ড্যাশবোর্ড তৈরি (ক্যাটালগ লিংক থেকে অটো প্রোডাক্ট গ্রহণ)
app.post('/api/launch-bot-dashboard', async (req, res) => {
  try {
    const { bot_type, bot_name, website_url, catalog_url, custom_info, subdomain, base_domain } = req.body;
    const cleanSub = String(subdomain || '').toLowerCase().replace(/[^a-z0-9-]/g, '');

    if (!cleanSub) return res.status(400).json({ success: false, message: 'সঠিক সাবডোমেইন নাম দিন।' });

    let finalPrompt = custom_info || '';
    let extractedProducts = [];

    // ১. যদি ওয়েবসাইট লিংক থাকে
    if (bot_type === 'business_site' && website_url) {
      const siteKnowledge = await analyzeAndExtractWebsiteKnowledge(website_url);
      finalPrompt = siteKnowledge.description;
      extractedProducts = siteKnowledge.products || [];
    }

    // ২. যদি ওয়েবসাইট না থাকে কিন্তু ক্যাটালগ লিংক থাকে
    if (bot_type === 'catalog_link' && catalog_url) {
      const match = catalog_url.match(/\/catalog\/([a-z0-9-]+)/i);
      const slug = match ? match[1] : catalog_url.trim();

      const catItems = await pool.query('SELECT * FROM store_catalog_items WHERE catalog_slug = $1', [slug]);
      const catInfo = await pool.query('SELECT store_name FROM store_catalogs WHERE catalog_slug = $1', [slug]);

      if (catItems.rows.length > 0) {
        finalPrompt = `${catInfo.rows[0]?.store_name || bot_name}-এর অফিসিয়াল ক্যাটালগ থেকে সংগৃহীত পণ্য ও সেবা।`;
        extractedProducts = catItems.rows.map(item => ({
          name: item.name,
          price: item.price,
          category: item.category,
          description: item.description,
          buy_link: catalog_url
        }));
      }
    }

    const botInsert = await pool.query(
      `INSERT INTO whatsapp_bots (bot_name, website_url, system_prompt, bot_type, subdomain, status, rate_limit_daily, plan)
       VALUES ($1, $2, $3, $4, $5, 'DISCONNECTED', 300, 'free') RETURNING id`,
      [bot_name || 'My Bot', website_url || catalog_url || '', finalPrompt, bot_type || 'catalog_link', cleanSub]
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
    const { botId, bot_name, alert_phone, bot_type, system_prompt, delivery_inside, delivery_outside } = req.body;
    await pool.query(
      `UPDATE whatsapp_bots 
       SET bot_name = $1, alert_phone = $2, bot_type = $3, system_prompt = $4, delivery_inside = $5, delivery_outside = $6 
       WHERE id = $7`,
      [bot_name, alert_phone, bot_type, system_prompt, delivery_inside || 70, delivery_outside || 130, botId]
    );
    addBotLog(botId, 'success', '⚙️ বটের তথ্য ও নির্দেশিকা সফলভাবে আপডেট হয়েছে!');
    res.json({ success: true, message: '✅ বটের তথ্য সফলভাবে আপডেট হয়েছে!' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// 🎁 ১০ দিনের ফ্রি ট্রায়াল ক্লেইম করার API
app.post('/api/user/claim-trial', async (req, res) => {
  try {
    const { botId } = req.body;
    const check = await pool.query('SELECT trial_used, plan FROM whatsapp_bots WHERE id = $1', [botId]);
    if (check.rows.length === 0) return res.status(404).json({ success: false, message: 'বট পাওয়া যায়নি!' });

    if (check.rows[0].trial_used) {
      return res.status(400).json({ 
        success: false, 
        message: '⚠️ আপনার ১০ দিনের ফ্রি ট্রায়াল ইতিমধ্যে শেষ হয়েছে! আনলিমিটেড অ্যাক্সেসের জন্য প্রিমিয়াম আপগ্রেড করুন।' 
      });
    }

    // ১০ দিনের ট্রায়াল সেট
    await pool.query(
      `UPDATE whatsapp_bots 
       SET trial_used = TRUE, 
           plan = 'trial', 
           package_name = '10 Days Trial',
           trial_expires_at = NOW() + INTERVAL '10 days',
           rate_limit_daily = 1500 
       WHERE id = $1`,
      [botId]
    );

    addBotLog(botId, 'success', '🎉 ১০ দিনের ফ্রি ট্রায়াল সক্রিয় করা হয়েছে!');
    res.json({ success: true, message: '🎉 অভিনন্দন! আপনার ১০ দিনের ফ্রি ট্রায়াল সক্রিয় হয়েছে!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 🔄 ড্যাশবোর্ড থেকে ওয়েবসাইট রি-অ্যানালাইসিস API (Gemini AI Powered - Protected by Premium/Trial)
app.post('/api/user/reanalyze-site', async (req, res) => {
  try {
    const { botId, website_url } = req.body;
    const botRes = await pool.query('SELECT gemini_api_key, plan, trial_used, trial_expires_at, expires_at FROM whatsapp_bots WHERE id = $1', [botId]);
    if (botRes.rows.length === 0) return res.status(404).json({ success: false, message: 'বট পাওয়া যায়নি' });
    
    const bot = botRes.rows[0];

    // ট্রায়াল বা প্রিমিয়াম ভ্যালিডেশন চেক
    const isPremium = bot.plan === 'premium' && (!bot.expires_at || new Date(bot.expires_at) > new Date());
    const isTrialActive = bot.plan === 'trial' && bot.trial_expires_at && new Date(bot.trial_expires_at) > new Date();

    if (!isPremium && !isTrialActive) {
      return res.status(403).json({
        success: false,
        requires_upgrade: true,
        trial_used: bot.trial_used,
        message: bot.trial_used 
          ? '🔒 আপনার ১০ দিনের ট্রায়াল শেষ হয়েছে। লাইভ ওয়েবসাইট এআই রি-অ্যানালাইজ করতে প্রিমিয়াম আপগ্রেড করুন!' 
          : '🔒 এটি একটি প্রিমিয়াম ফিচার! ১০ দিনের ফ্রি ট্রায়াল চালু করুন অথবা প্রিমিয়াম নিন।'
      });
    }

    const customKey = bot.gemini_api_key || null;
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

// 📦 ১. ইউজারের নিজস্ব প্রোডাক্ট লিস্ট পাওয়ার API (Strict Isolation: WHERE bot_id = $1)
app.get('/api/user/products', async (req, res) => {
  try {
    const botId = Number(req.query.botId);
    const result = await pool.query('SELECT * FROM bot_products WHERE bot_id = $1 ORDER BY id DESC', [botId]);
    res.json({ success: true, products: result.rows });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ➕ ২. ড্যাশবোর্ড থেকে সরাসরি নতুন প্রোডাক্ট অ্যাড করার API
app.post('/api/user/products/add', async (req, res) => {
  try {
    const { botId, name, price, category, description, buy_link } = req.body;
    await pool.query(
      `INSERT INTO bot_products (bot_id, name, price, category, description, buy_link)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [botId, name, parseFloat(price) || 0, category || 'General', description || '', buy_link || '']
    );
    addBotLog(botId, 'success', `📦 নতুন পণ্য যোগ হয়েছে: ${name} (৳${price})`);
    res.json({ success: true, message: 'প্রোডাক্ট সফলভাবে যোগ হয়েছে!' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// 🗑️ ৩. ড্যাশবোর্ড থেকে প্রোডাক্ট ডিলিট করার API
app.post('/api/user/products/delete', async (req, res) => {
  try {
    const { botId, productId } = req.body;
    await pool.query('DELETE FROM bot_products WHERE id = $1 AND bot_id = $2', [productId, botId]);
    addBotLog(botId, 'info', `🗑️ প্রোডাক্ট মুছে ফেলা হয়েছে (ID: #${productId})`);
    res.json({ success: true, message: 'প্রোডাক্ট মুছে ফেলা হয়েছে!' });
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

// ৬. পেয়ারিং কোড রিকোয়েস্ট (Couldn't link device ফিক্স সহ)
app.post('/api/request-pairing-code', async (req, res) => {
  try {
    const { botId, phone } = req.body;
    const bId = Number(botId);
    let cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('01') && cleanPhone.length === 11) cleanPhone = '88' + cleanPhone;

    if (!cleanPhone || cleanPhone.length < 10) {
      return res.status(400).json({ success: false, message: 'সঠিক মোবাইল নম্বর দিন (যেমন: 88014...)' });
    }

    // 🧹 পুরোনো কোনো হ্যাং হওয়া সকেট বা সেশন থাকলে আগে ক্লিন করা
    let botObj = activeSockets.get(bId);
    if (botObj && botObj.sock) {
      try {
        botObj.sock.ws?.close();
        botObj.sock.ev?.removeAllListeners();
      } catch (_) {}
      activeSockets.delete(bId);
    }

    // ডাটাবেজের আনরেজিস্টার্ড সেশন ডাটা মুছে ফ্রেশ ক্রেডেনশিয়ালস সেট
    await pool.query('DELETE FROM whatsapp_sessions WHERE bot_id = $1', [bId]);
    await pool.query('UPDATE whatsapp_bots SET phone_number = $1, status = \'DISCONNECTED\' WHERE id = $2', [cleanPhone, bId]);

    // নতুন সকেট চালু
    const newSock = await startTenantBot(bId);
    await delay(3000); // সকেট স্ট্যাবল হওয়ার জন্য অপেক্ষা

    botObj = activeSockets.get(bId);
    if (botObj && botObj.sock) {
      try {
        const rawCode = await botObj.sock.requestPairingCode(cleanPhone);
        const formattedCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
        addBotLog(bId, 'info', `📲 নতুন পেয়ারিং কোড তৈরি হয়েছে: ${formattedCode}`);
        return res.json({ success: true, pairingCode: formattedCode });
      } catch (pairErr) {
        console.error('[PAIRING ERROR]:', pairErr.message);
        return res.status(500).json({ success: false, message: 'হোয়াটসঅ্যাপ থেকে কোড তৈরিতে সমস্যা: ' + pairErr.message });
      }
    }

    return res.status(500).json({ success: false, message: 'সার্ভারে সকেট স্টার্ট হতে পারেনি, আবার চেষ্টা করুন।' });
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

// অ্যাডমিন থেকে ডাইনামিক প্যাকেজ, দিন ও লিমিট দিয়ে পেমেন্ট অ্যাপ্রুভ
app.post('/api/admin/approve-payment', async (req, res) => {
  try {
    const { paymentId, days, dailyLimit, packageName, amount } = req.body;
    const payRes = await pool.query('SELECT bot_id FROM payments WHERE id = $1', [paymentId]);
    if (payRes.rows.length === 0) return res.status(404).json({ success: false });
    const botId = payRes.rows[0].bot_id;

    const validDays = parseInt(days, 10) || 30;
    const limit = parseInt(dailyLimit, 10) || 3000;
    const pkg = packageName || 'Standard Premium';

    // মেয়াদ ক্যালকুলেশন (বর্তমান সময় + নির্দিষ্ট দিন)
    await pool.query(
      `UPDATE payments 
       SET status = 'APPROVED', amount = $1, approved_days = $2, custom_limit = $3 
       WHERE id = $4`,
      [parseFloat(amount) || 300, validDays, limit, paymentId]
    );

    await pool.query(
      `UPDATE whatsapp_bots 
       SET plan = 'premium', 
           package_name = $1,
           rate_limit_daily = $2, 
           expires_at = NOW() + ($3 || ' days')::INTERVAL 
       WHERE id = $4`,
      [pkg, limit, validDays, botId]
    );

    addBotLog(botId, 'success', `🎉 অভিনন্দন! অ্যাডমিন আপনার ${validDays} দিনের প্রিমিয়াম (${pkg}) সক্রিয় করেছেন! ডেইলি লিমিট: ${limit}টি`);
    res.json({ success: true, message: `✅ সফল! বটটি ${validDays} দিন এবং ডেইলি ${limit} রিকোয়েস্টে প্রিমিয়াম করা হয়েছে!` });
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
      CREATE TABLE IF NOT EXISTS custom_catalogs (
        id SERIAL PRIMARY KEY,
        catalog_slug VARCHAR(100) UNIQUE,
        store_name VARCHAR(150),
        items_json JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
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
    await pool.query('ALTER TABLE whatsapp_bots ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;');
    await pool.query('ALTER TABLE whatsapp_bots ADD COLUMN IF NOT EXISTS package_name VARCHAR(100) DEFAULT \'Free Trial\';');
    await pool.query('ALTER TABLE whatsapp_bots ADD COLUMN IF NOT EXISTS trial_used BOOLEAN DEFAULT FALSE;');
    await pool.query('ALTER TABLE whatsapp_bots ADD COLUMN IF NOT EXISTS trial_expires_at TIMESTAMP;');
    await pool.query('ALTER TABLE payments ADD COLUMN IF NOT EXISTS approved_days INT DEFAULT 30;');
    await pool.query('ALTER TABLE payments ADD COLUMN IF NOT EXISTS custom_limit INT DEFAULT 3000;');
    await pool.query('ALTER TABLE whatsapp_bots ADD COLUMN IF NOT EXISTS subdomain VARCHAR(100);');
    await pool.query('ALTER TABLE whatsapp_bots ADD COLUMN IF NOT EXISTS tokens_used INT DEFAULT 0;');
    await pool.query('ALTER TABLE whatsapp_bots ADD COLUMN IF NOT EXISTS requests_today INT DEFAULT 0;');
    await pool.query('ALTER TABLE whatsapp_bots ADD COLUMN IF NOT EXISTS gemini_api_key TEXT;');
    await pool.query('ALTER TABLE hosted_websites ADD COLUMN IF NOT EXISTS bot_id INT REFERENCES whatsapp_bots(id) ON DELETE CASCADE;');
    await pool.query('ALTER TABLE hosted_websites ADD COLUMN IF NOT EXISTS theme_color VARCHAR(30) DEFAULT \'#10b981\';');
    
    // 🔔 অর্ডার অ্যালার্ট নম্বর এবং অর্ডার ট্র্যাকিং টেবিল
    await pool.query('ALTER TABLE whatsapp_bots ADD COLUMN IF NOT EXISTS alert_phone VARCHAR(50);');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_orders (
        id SERIAL PRIMARY KEY,
        bot_id INT REFERENCES whatsapp_bots(id) ON DELETE CASCADE,
        customer_phone VARCHAR(50),
        customer_name VARCHAR(150),
        shipping_address TEXT,
        product_details TEXT,
        status VARCHAR(50) DEFAULT 'NEW',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ক্যাটালগ টেবিল নিশ্চিত করা
    await pool.query(`
      CREATE TABLE IF NOT EXISTS store_catalogs (
        id SERIAL PRIMARY KEY,
        catalog_slug VARCHAR(100) UNIQUE NOT NULL,
        store_name VARCHAR(150) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS store_catalog_items (
        id SERIAL PRIMARY KEY,
        catalog_slug VARCHAR(100) REFERENCES store_catalogs(catalog_slug) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        price NUMERIC(10, 2) NOT NULL,
        category VARCHAR(100),
        image_url TEXT,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE store_catalog_items ADD COLUMN IF NOT EXISTS image_url TEXT;
      ALTER TABLE bot_products ADD COLUMN IF NOT EXISTS image_url TEXT;
      ALTER TABLE store_catalogs ADD COLUMN IF NOT EXISTS admin_pin VARCHAR(20) DEFAULT '1234';
    `);

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

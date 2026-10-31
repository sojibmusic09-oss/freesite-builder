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

        // 🛠️ সাবডোমেন থেকেও সরাসরি ক্যাটালগ বিল্ডার ওপেন হতে দেওয়া
        if (req.path === '/catalog-builder') {
          return res.sendFile(path.join(__dirname, 'public', 'catalog_builder.html'));
        }

        // 🛍️ যদি কাস্টমাররা প্রোডাক্ট দেখার জন্য /shop বা /catalog বা /products এ ঢোকে
        if (req.path === '/shop' || req.path === '/catalog' || req.path === '/products') {
          const prods = await pool.query('SELECT * FROM bot_products WHERE bot_id = $1 ORDER BY id DESC', [bot.id]);
          return res.send(generateStorefrontView(bot, prods.rows, `${cleanSub}.${detectedBase}`));
        }

        // 🔗 প্রতিটি পণ্যের আলাদা আলাদা ডেডিকেটেড লিংক (/p/15)
        if (req.path.startsWith('/p/')) {
          const pId = parseInt(req.path.replace('/p/', ''), 10);
          const singleP = await pool.query('SELECT * FROM bot_products WHERE id = $1 AND bot_id = $2', [pId, bot.id]);
          if (singleP.rows.length > 0) {
            const p = singleP.rows[0];
            const discount = p.regular_price && p.regular_price > p.price ? Math.round(((p.regular_price - p.price) / p.regular_price) * 100) : 0;
            return res.send(`<!DOCTYPE html>
            <html lang="bn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${p.name} — ${bot.bot_name}</title>
            <style>body{font-family:sans-serif;background:#f8fafc;padding:15px;margin:0;display:flex;justify-content:center;}
            .card{max-width:480px;width:100%;background:#fff;border-radius:18px;overflow:hidden;border:1px solid #e2e8f0;box-shadow:0 10px 25px rgba(0,0,0,0.05);margin-top:20px;}
            .img{width:100%;height:300px;object-fit:cover;background:#f1f5f9;}
            .p-20{padding:20px;}.curr{font-size:24px;font-weight:800;color:#059669;}.reg{font-size:15px;color:#94a3b8;text-decoration:line-through;margin-left:6px;}
            .btn{display:block;background:#25d366;color:#fff;text-align:center;padding:14px;border-radius:12px;font-weight:700;text-decoration:none;margin-top:16px;}
            </style></head><body>
            <div class="card">
              ${p.image_url ? `<img src="${p.image_url}" class="img">` : ''}
              <div class="p-20">
                <small style="color:#64748b;font-weight:700;">${p.category || 'General'}</small>
                <h1 style="font-size:20px;margin:6px 0;">${p.name}</h1>
                <div><span class="curr">৳${p.price}</span>${p.regular_price ? `<span class="reg">৳${p.regular_price}</span>` : ''} ${discount > 0 ? `<span style="background:#ef4444;color:#fff;font-size:11px;font-weight:800;padding:2px 6px;border-radius:6px;">${discount}% OFF</span>` : ''}</div>
                <p style="font-size:13px;color:#475569;margin-top:12px;line-height:1.5;">${p.description || 'পণ্যটি অর্ডার করতে নিচের বাটনে ক্লিক করুন।'}</p>
                <a href="https://wa.me/${bot.phone_number || ''}?text=${encodeURIComponent('আমি এই পণ্যটি অর্ডার করতে চাই: ' + p.name + ' (৳' + p.price + ')')}" class="btn">সরাসরি হোয়াটসঅ্যাপে কিনুন</a>
              </div>
            </div></body></html>`);
          }
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

// ================= পাবলিক সাবডোমেইন ই-কমার্স শপ ভিউয়ার (ফুল ফ্রস্টেড গ্লাস ডিজাইন) =================
function generateStorefrontView(bot, products, fullUrl) {
  const primaryColor = bot.theme_color || '#10b981';
  return `<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${bot.bot_name} — অফিসিয়াল ক্যাটালগ</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=Hind+Siliguri:wght@400;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css">
  <style>
    :root {
      --primary: ${primaryColor};
      --text: #0f172a;
      --muted: #64748b;
      --glass-surface: rgba(255, 255, 255, 0.68);
      --glass-border: rgba(255, 255, 255, 0.85);
      --glass-shadow: 0 16px 40px -8px rgba(15, 23, 42, 0.05);
      --glass-blur: blur(20px);
    }
    * { box-sizing: border-box; margin:0; padding:0; font-family: 'Plus Jakarta Sans', 'Hind Siliguri', sans-serif; }
    body {
      background-color: #f8fafc;
      background-image: 
        radial-gradient(circle at 10% 10%, rgba(16, 185, 129, 0.08) 0%, transparent 40%),
        radial-gradient(circle at 90% 20%, rgba(14, 165, 233, 0.08) 0%, transparent 40%);
      background-attachment: fixed;
      color: var(--text);
      padding: 35px 20px;
      min-height: 100vh;
    }
    .store-container { max-width: 860px; margin: 0 auto; }
    
    .header {
      background: var(--glass-surface);
      backdrop-filter: var(--glass-blur);
      -webkit-backdrop-filter: var(--glass-blur);
      border: 1px solid var(--glass-border);
      border-radius: 24px;
      padding: 30px;
      text-align: center;
      margin-bottom: 30px;
      box-shadow: var(--glass-shadow);
    }
    .header h1 { font-size: 26px; font-weight: 800; color: #047857; margin-bottom: 8px; }
    .header p { font-size: 14px; color: var(--muted); max-width: 500px; margin: 0 auto; }
    .wa-btn {
      display: inline-flex; align-items: center; gap: 8px;
      background: #25d366; color: #fff; text-decoration: none;
      padding: 10px 22px; border-radius: 30px; font-size: 14px; font-weight: 800;
      margin-top: 16px; box-shadow: 0 6px 20px rgba(37, 211, 102, 0.25);
      transition: transform 0.2s;
    }
    .wa-btn:hover { transform: translateY(-2px); }

    /* 💎 ফাঁকা ফাঁকা ফ্রস্টেড গ্লাস প্রোডাক্ট কার্ড গ্রিড */
    .product-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 22px;
      margin-bottom: 35px;
    }
    .prod-card {
      background: var(--glass-surface);
      backdrop-filter: var(--glass-blur);
      -webkit-backdrop-filter: var(--glass-blur);
      border: 1px solid var(--glass-border);
      border-radius: 22px;
      overflow: hidden;
      box-shadow: var(--glass-shadow);
      display: flex; flex-direction: column;
      transition: transform 0.25s ease, box-shadow 0.25s ease;
      position: relative;
    }
    .prod-card:hover {
      transform: translateY(-4px);
      box-shadow: 0 20px 48px -10px rgba(15, 23, 42, 0.1);
      border-color: #fff;
    }
    
    .prod-img-box {
      width: 100%; height: 210px; background: rgba(241, 245, 249, 0.6);
      display: flex; align-items: center; justify-content: center;
      overflow: hidden; position: relative;
    }
    .prod-img-box img { width: 100%; height: 100%; object-fit: cover; }
    .discount-badge {
      position: absolute; top: 12px; left: 12px;
      background: rgba(239, 68, 68, 0.95); backdrop-filter: blur(6px);
      color: #fff; font-size: 11px; font-weight: 800; padding: 4px 10px; border-radius: 8px;
    }
    
    .prod-body { padding: 22px; flex: 1; display: flex; flex-direction: column; justify-content: space-between; }
    .p-title { font-size: 16px; font-weight: 800; color: #0f172a; margin-bottom: 6px; }
    .p-cat { font-size: 11px; background: rgba(255, 255, 255, 0.8); color: #475569; padding: 4px 10px; border-radius: 8px; display: inline-block; margin-bottom: 12px; font-weight: 700; border: 1px solid rgba(226, 232, 240, 0.8); }
    
    .price-row { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
    .curr-price { font-size: 20px; font-weight: 800; color: #059669; }
    .reg-price { font-size: 14px; color: #94a3b8; text-decoration: line-through; }
    
    .btn-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .view-btn {
      background: rgba(255, 255, 255, 0.7); color: #334155; text-decoration: none;
      text-align: center; padding: 10px; border-radius: 10px; font-size: 13px; font-weight: 700;
      border: 1px solid rgba(226, 232, 240, 0.8); transition: background 0.2s;
    }
    .view-btn:hover { background: #fff; }
    .order-btn {
      background: linear-gradient(135deg, #25d366 0%, #15803d 100%);
      color: #fff; text-decoration: none; text-align: center;
      padding: 10px; border-radius: 10px; font-size: 13px; font-weight: 700;
      display: inline-flex; align-items: center; justify-content: center; gap: 4px;
      box-shadow: 0 4px 12px rgba(37, 211, 102, 0.25);
    }
  </style>
</head>
<body>
  <div class="store-container">
    <div class="header">
      <h1>🛍️ ${bot.bot_name}</h1>
      <p>${bot.system_prompt ? bot.system_prompt.substring(0, 90) + '...' : 'আমাদের অনলাইন প্রোডাক্ট ক্যাটালগে আপনাকে স্বাগতম!'}</p>
      ${bot.phone_number ? `<a href="https://wa.me/${bot.phone_number}" class="wa-btn" target="_blank"><i class="ti ti-brand-whatsapp"></i> সরাসরি হোয়াটসঅ্যাপে অর্ডার করুন</a>` : ''}
    </div>

    ${products.length === 0 ? '<div style="background:var(--glass-surface); backdrop-filter:var(--glass-blur); border:1px solid var(--glass-border); padding:40px; text-align:center; border-radius:24px; color:var(--muted); font-size:14px;">বর্তমানে কোনো পণ্য তালিকায় নেই।</div>' : ''}

    <div class="product-grid">
      ${products.map(p => {
        const discount = p.regular_price && p.regular_price > p.price ? Math.round(((p.regular_price - p.price) / p.regular_price) * 100) : 0;
        return `
        <div class="prod-card">
          <div class="prod-img-box">
            ${discount > 0 ? `<div class="discount-badge">${discount}% OFF</div>` : ''}
            ${p.image_url ? `<img src="${p.image_url}" alt="${p.name}">` : `<i class="ti ti-photo" style="font-size:42px; color:#cbd5e1;"></i>`}
          </div>
          <div class="prod-body">
            <div>
              <div class="p-title">${p.name}</div>
              <span class="p-cat">${p.category || 'General'}</span>
              <div class="price-row">
                <span class="curr-price">৳${p.price}</span>
                ${p.regular_price && p.regular_price > p.price ? `<span class="reg-price">৳${p.regular_price}</span>` : ''}
              </div>
            </div>
            <div class="btn-row">
              <a href="/p/${p.id}" class="view-btn">বিস্তারিত</a>
              <a href="https://wa.me/${bot.phone_number || ''}?text=${encodeURIComponent('আমি এই পণ্যটি অর্ডার করতে চাই: ' + p.name + ' (৳' + p.price + ')')}" target="_blank" class="order-btn">
                <i class="ti ti-brand-whatsapp"></i> অর্ডার
              </a>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>

    <div style="text-align:center; padding:25px; font-size:12px; color:var(--muted);">
      Powered by FreeSite AI • Store: <b>${fullUrl}</b>
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
      --text: #0f172a;
      --muted: #64748b;
      /* 💎 প্রিমিয়াম ফুললি গ্লাস কালার সিস্টেম */
      --glass-surface: rgba(255, 255, 255, 0.65);
      --glass-surface-subtle: rgba(255, 255, 255, 0.45);
      --glass-surface-focus: rgba(255, 255, 255, 0.95);
      --glass-border: rgba(255, 255, 255, 0.85);
      --glass-border-subtle: rgba(226, 232, 240, 0.7);
      --glass-shadow: 0 16px 40px -8px rgba(15, 23, 42, 0.05), 0 4px 12px -2px rgba(15, 23, 42, 0.02);
      --glass-blur: blur(20px);
    }
    
    * { 
      box-sizing: border-box; 
      margin: 0; 
      padding: 0; 
      font-family: 'Plus Jakarta Sans', 'Hind Siliguri', sans-serif; 
    }
    
    /* 🌌 এমবিয়েন্ট ব্যাকগ্রাউন্ড গ্লো যা কাঁচকে ফুটিয়ে তুলবে */
    body {
      background-color: #f8fafc;
      background-image: 
        radial-gradient(circle at 10% 10%, rgba(16, 185, 129, 0.09) 0%, transparent 40%),
        radial-gradient(circle at 90% 20%, rgba(14, 165, 233, 0.08) 0%, transparent 40%),
        radial-gradient(circle at 50% 90%, rgba(99, 102, 241, 0.06) 0%, transparent 50%);
      background-attachment: fixed;
      color: var(--text);
      padding: 35px 20px;
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }
    
    .container { 
      max-width: 900px; 
      margin: 0 auto; 
    }
    
    /* 💎 ফাঁকা ফাঁকা গ্লাস হেডার */
    .header {
      background: var(--glass-surface);
      backdrop-filter: var(--glass-blur);
      -webkit-backdrop-filter: var(--glass-blur);
      border: 1px solid var(--glass-border);
      border-radius: 24px;
      padding: 26px 32px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 28px;
      box-shadow: var(--glass-shadow);
    }
    
    .brand-title { 
      font-size: 22px; 
      font-weight: 800; 
      color: #047857; 
      display: flex; 
      align-items: center; 
      gap: 12px; 
      letter-spacing: -0.3px;
    }
    
    /* স্ট্যাটাস পিল */
    .status-badge {
      font-size: 12px;
      font-weight: 800;
      padding: 8px 18px;
      border-radius: 40px;
      backdrop-filter: blur(10px);
      letter-spacing: 0.3px;
    }
    .status-badge.connected {
      background: rgba(220, 252, 231, 0.85);
      color: #15803d;
      border: 1px solid rgba(187, 247, 208, 0.9);
      box-shadow: 0 4px 14px rgba(34, 197, 94, 0.15);
    }
    .status-badge.disconnected {
      background: rgba(254, 226, 226, 0.85);
      color: #b91c1c;
      border: 1px solid rgba(254, 202, 202, 0.9);
      box-shadow: 0 4px 14px rgba(239, 68, 68, 0.15);
    }

    /* 💎 বড় মার্জিন ও প্যাডিংসহ মডার্ন ফ্রস্টেড গ্লাস কার্ড */
    .card {
      background: var(--glass-surface);
      backdrop-filter: var(--glass-blur);
      -webkit-backdrop-filter: var(--glass-blur);
      border: 1px solid var(--glass-border);
      border-radius: 24px;
      padding: 30px;
      margin-bottom: 28px;
      box-shadow: var(--glass-shadow);
      transition: all 0.25s ease;
    }
    .card:hover {
      box-shadow: 0 20px 48px -10px rgba(15, 23, 42, 0.08);
      border-color: rgba(255, 255, 255, 1);
    }
    
    .card h3 {
      font-size: 17px;
      font-weight: 800;
      color: #065f46;
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 18px;
      letter-spacing: -0.2px;
    }

    /* 📊 স্ট্যাটাস গ্রিড (ফাঁকা ও সাজানো) */
    .stats-grid { 
      display: grid; 
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); 
      gap: 18px; 
      margin-bottom: 28px; 
    }
    
    .stat-box {
      background: var(--glass-surface-subtle);
      backdrop-filter: var(--glass-blur);
      border: 1px solid var(--glass-border);
      border-radius: 20px;
      padding: 22px 18px;
      text-align: center;
      box-shadow: 0 4px 15px rgba(0, 0, 0, 0.02);
      transition: transform 0.2s ease;
    }
    .stat-box:hover {
      transform: translateY(-2px);
      background: rgba(255, 255, 255, 0.7);
    }
    .stat-val { 
      font-size: 28px; 
      font-weight: 800; 
      color: #059669; 
      margin-top: 6px; 
      letter-spacing: -0.5px;
    }
    .stat-lbl { 
      font-size: 12px; 
      color: var(--muted); 
      font-weight: 700; 
      text-transform: uppercase; 
      letter-spacing: 0.6px; 
    }

    /* 📝 স্বচ্ছ গ্লাসি ফর্ম ইনপুট (বাতিল করা হয়েছে হিজিবিজি ভাব) */
    .form-group { 
      margin-bottom: 20px; 
    }
    label { 
      display: block; 
      font-size: 13px; 
      color: #334155; 
      margin-bottom: 8px; 
      font-weight: 700; 
      letter-spacing: 0.1px;
    }
    
    input, select, textarea {
      width: 100%;
      padding: 14px 18px;
      background: rgba(255, 255, 255, 0.6);
      backdrop-filter: blur(8px);
      border: 1px solid var(--glass-border-subtle);
      border-radius: 14px;
      font-size: 14px;
      color: #0f172a;
      outline: none;
      transition: all 0.2s ease;
      box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.015);
    }
    input:focus, select:focus, textarea:focus {
      background: var(--glass-surface-focus);
      border-color: var(--primary);
      box-shadow: 0 0 0 4px rgba(16, 185, 129, 0.14), inset 0 2px 4px rgba(0,0,0,0.01);
    }

    /* 🚀 বড় ও পরিচ্ছন্ন বাটন */
    button {
      width: 100%;
      padding: 15px 22px;
      background: linear-gradient(135deg, #059669 0%, #047857 100%);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.25);
      border-radius: 14px;
      font-weight: 800;
      cursor: pointer;
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 10px;
      font-size: 14px;
      letter-spacing: 0.2px;
      box-shadow: 0 8px 20px -3px rgba(5, 150, 105, 0.35);
      transition: all 0.2s ease;
    }
    button:hover {
      background: linear-gradient(135deg, #047857 0%, #065f46 100%);
      box-shadow: 0 12px 28px -4px rgba(5, 150, 105, 0.45);
      transform: translateY(-1px);
    }
    button:active {
      transform: translateY(1px);
    }

    /* পেয়ারিং কোড ডিসপ্লে */
    .code-box {
      background: rgba(240, 253, 244, 0.85);
      backdrop-filter: var(--glass-blur);
      border: 2px dashed #059669;
      padding: 22px;
      border-radius: 18px;
      text-align: center;
      margin-top: 18px;
      display: none;
    }
    .code-val { 
      font-size: 32px; 
      font-weight: 800; 
      letter-spacing: 8px; 
      color: #047857; 
      font-family: monospace; 
      margin: 8px 0;
    }

    /* টার্মিনাল লগ বক্স (সফট ডার্ক ব্লার) */
    .terminal-window {
      background: rgba(15, 23, 42, 0.9);
      backdrop-filter: var(--glass-blur);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 18px;
      padding: 18px 22px;
      height: 190px;
      overflow-y: auto;
      font-family: monospace;
      font-size: 13px;
      color: #f8fafc;
      box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.3);
    }
    .log-line { margin-bottom: 8px; }

    /* পেমেন্ট সেকশন */
    .payment-box {
      background: var(--glass-surface-subtle);
      border: 1px solid var(--glass-border-subtle);
      border-radius: 18px;
      padding: 22px;
      margin-top: 18px;
    }
    .pay-methods { 
      display: flex; 
      gap: 12px; 
      margin-bottom: 16px; 
    }
    .pay-badge {
      flex: 1;
      text-align: center;
      padding: 12px 8px;
      border-radius: 12px;
      font-size: 13px;
      font-weight: 700;
      border: 1px solid var(--glass-border-subtle);
      cursor: pointer;
      background: rgba(255, 255, 255, 0.65);
      backdrop-filter: blur(8px);
      transition: all 0.2s ease;
    }
    .pay-badge.active {
      background: rgba(236, 253, 245, 0.95);
      border-color: #059669;
      color: #059669;
      box-shadow: 0 4px 14px rgba(5, 150, 105, 0.15);
      transform: translateY(-1px);
    }

    .color-dot {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      cursor: pointer;
      border: 3px solid #fff;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
      transition: transform 0.2s ease;
    }
    .color-dot:hover { transform: scale(1.15); }
    .color-picker { display: flex; gap: 14px; margin-top: 12px; }
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
      <div id="testChatWindow" style="background:rgba(255,255,255,0.7); border:1px solid var(--glass-border-subtle); border-radius:14px; padding:14px; height:180px; overflow-y:auto; margin-bottom:10px; font-size:13px;">
        <div style="color:#64748b; font-style:italic;">বটের সাথে কথা বলতে নিচে মেসেজ লিখুন...</div>
      </div>
      <div style="display:flex; gap:8px;">
        <input type="text" id="testMsgInput" onkeypress="if(event.key==='Enter') sendTestChatMessage(${bot.id})" placeholder="যেমন: টুর্নামেন্টের ফি কত? অথবা হাই..." style="flex:1;">
        <button id="testSendBtn" onclick="sendTestChatMessage(${bot.id})" style="width:auto; padding:0 22px; background:#059669;">
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
          <option value="catalog_link" ${bot.bot_type === 'catalog_link' ? 'selected' : ''}>📦 ডিজিটাল ক্যাটালগ শপ</option>
          <option value="business_no_site" ${bot.bot_type === 'business_no_site' ? 'selected' : ''}>🏬 সাধারণ দোকান (ওয়েবসাইট ছাড়া)</option>
          <option value="personal" ${bot.bot_type === 'personal' ? 'selected' : ''}>👤 পার্সোনাল ইউজার (ব্যক্তিগত সহকারী)</option>
        </select>
      </div>

      <!-- 🎯 এআই কোন সোর্স থেকে তথ্য নিয়ে উত্তর দেবে তা সিলেক্ট করার ড্রপডাউন -->
      <div class="form-group" style="background:#ecfdf5; border:1px solid #10b981; padding:12px; border-radius:12px;">
        <label style="color:#065f46; font-weight:800;">🎯 এআই কোন সোর্স থেকে তথ্য নিয়ে উত্তর দেবে?</label>
        <select id="editKnowledgeSource" style="background:#fff; font-weight:700; color:#065f46;">
          <option value="catalog" ${bot.knowledge_source === 'catalog' ? 'selected' : ''}>📦 নিজস্ব ক্যাটালগ ও প্রোডাক্ট লিস্ট থেকে উত্তর দেবে (রিসার্ভড)</option>
          <option value="website" ${bot.knowledge_source === 'website' ? 'selected' : ''}>🌐 ওয়েবসাইট লিংক থেকে উত্তর দেবে</option>
        </select>
        <small style="color:#047857; font-size:11px; display:block; margin-top:4px;">
          👉 আপনার ওয়েবসাইট ও ক্যাটালগ উভয়ই থাকলে যে কোনো একটি সোর্স বেছে নিতে পারেন।
        </small>
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

    <!-- 🛍️ সরাসরি ড্যাশবোর্ড থেকে প্রোডাক্ট ও ক্যাটালগ ম্যানেজমেন্ট -->
    <div class="card" style="border-top: 4px solid #059669;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:8px;">
        <h3><i class="ti ti-box"></i> পণ্য ম্যানেজমেন্ট ও ক্যাটালগ লিংক</h3>
        <div style="display:flex; gap:6px;">
          <a href="https://${fullUrl}/shop" target="_blank" style="font-size:12px; background:#ecfdf5; color:#047857; padding:6px 14px; border-radius:20px; font-weight:700; text-decoration:none; border:1px solid #10b981;">
            🌐 শপ ভিউ
          </a>
          <a href="https://${fullUrl}/catalog-builder" target="_blank" style="font-size:12px; background:#e0f2fe; color:#0369a1; padding:6px 14px; border-radius:20px; font-weight:700; text-decoration:none; border:1px solid #38bdf8;">
            🛠️ ক্যাটালগ বিল্ডার পোর্টাল
          </a>
        </div>
      </div>

      <!-- 🔗 ১. ক্যাটালগ অ্যাডমিন লিংক (যেখান থেকে পণ্য আপলোড ও ম্যানেজ করবেন) -->
      <div style="background:rgba(224, 242, 254, 0.85); border:1px solid #38bdf8; border-radius:14px; padding:12px 14px; margin-bottom:10px;">
        <div style="font-size:12px; font-weight:800; color:#0369a1; margin-bottom:4px; display:flex; align-items:center; gap:6px;">
          <i class="ti ti-lock-access"></i> 🛠️ ক্যাটালগ অ্যাডমিন লিংক (প্রোডাক্ট আপলোড ও এডিট করার লিংক):
        </div>
        <div style="display:flex; gap:6px;">
          <input type="text" id="adminPanelLink" readonly value="https://${fullUrl}" style="font-weight:700; background:#fff; color:#0284c7; padding:8px 12px; border:1px solid #bae6fd; border-radius:8px; font-size:13px;">
          <button onclick="navigator.clipboard.writeText(document.getElementById('adminPanelLink').value); alert('ক্যাটালগ অ্যাডমিন লিংক কপি হয়েছে!');" style="width:auto; padding:0 14px; background:#0284c7; font-size:12px; border-radius:8px;"><i class="ti ti-copy"></i> কপি</button>
        </div>
      </div>

      <!-- 🔗 ২. কাস্টমার ক্যাটালগ ও শপ লিংক (যা কাস্টমারদের পাঠাবেন) -->
      <div style="background:rgba(236, 253, 245, 0.95); border:1px solid #10b981; border-radius:14px; padding:12px 14px; margin-bottom:16px;">
        <div style="font-size:12px; font-weight:800; color:#065f46; margin-bottom:4px; display:flex; align-items:center; gap:6px;">
          <i class="ti ti-building-store"></i> 🛍️ কাস্টমার শপ লিংক (পণ্য দেখার ও অর্ডার করার লিংক):
        </div>
        <div style="display:flex; gap:6px;">
          <input type="text" id="storeShareLink" readonly value="https://${fullUrl}/shop" style="font-weight:700; background:#fff; color:#059669; padding:8px 12px; border:1px solid #a7f3d0; border-radius:8px; font-size:13px;">
          <button onclick="copyStoreUrl()" style="width:auto; padding:0 14px; background:#059669; font-size:12px; border-radius:8px;"><i class="ti ti-copy"></i> কপি</button>
        </div>
      </div>

      <!-- নতুন প্রোডাক্ট যোগ ও এডিট ফর্ম -->
      <div id="dashFormBox" style="background:rgba(255,255,255,0.7); border:1px solid var(--glass-border-subtle); border-radius:16px; padding:16px; margin-bottom:18px;">
        <div id="dashFormTitle" style="font-size:14px; font-weight:800; color:#065f46; margin-bottom:10px;">➕ নতুন প্রোডাক্ট যোগ করুন:</div>
        <input type="hidden" id="dashEditProductId" value="">

        <div style="display:grid; grid-template-columns: 2fr 1fr 1fr; gap:8px; margin-bottom:8px;">
          <input type="text" id="dashPName" placeholder="পণ্যের নাম (যেমন: M10 TWS Earbuds)">
          <input type="number" id="dashPPrice" placeholder="বর্তমান মূল্য (৳)">
          <input type="number" id="dashPRegPrice" placeholder="আগের মূল্য (৳)">
        </div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-bottom:8px;">
          <div>
            <div style="display:flex; gap:6px;">
              <!-- 📋 আগের ক্যাটাগরি সিলেক্ট করার ড্রপডাউন -->
              <select id="dashCatSelect" onchange="onDashCatSelect(this)" style="display:none; max-width:50%; padding:12px; font-size:13px; background:#fff; border:1px solid var(--glass-border-subtle); border-radius:12px; font-weight:700; color:#065f46;">
                <option value="">-- ক্যাটাগরি --</option>
              </select>
              <input type="text" id="dashPCat" placeholder="ক্যাটাগরি (যেমন: গ্যাজেট)" style="flex:1;">
            </div>
          </div>
          <div>
            <input type="text" id="dashPLink" placeholder="বাই লিংক (অপশনাল)">
          </div>
        </div>

        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-bottom:10px;">
          <!-- 📸 স্লট ১: মূল ছবি -->
          <div>
            <label style="font-size:12px; font-weight:700; color:#065f46;">📸 ১. মূল ছবি (Main Pic):</label>
            <div onclick="document.getElementById('dashPImgFile').click()" style="border:2px dashed #059669; border-radius:12px; padding:10px; text-align:center; cursor:pointer; background:rgba(236,253,245,0.7); height:90px; display:flex; align-items:center; justify-content:center;">
              <span id="dashImgText" style="font-size:12px; color:#047857; font-weight:700;"><i class="ti ti-camera"></i> মূল ছবি দিন</span>
              <img id="dashImgPreview" style="display:none; max-height:75px; max-width:100%; object-fit:contain; border-radius:6px;">
            </div>
            <input type="file" id="dashPImgFile" accept="image/*" style="display:none;" onchange="handleDashImgSelect(event)">
          </div>

          <!-- 📸 স্লট ২: ডেমো ছবি -->
          <div>
            <label style="font-size:12px; font-weight:700; color:#4338ca;">📸 ২. ডেমো ছবি (Demo Pic):</label>
            <div onclick="document.getElementById('dashPDemoImgFile').click()" style="border:2px dashed #6366f1; border-radius:12px; padding:10px; text-align:center; cursor:pointer; background:rgba(238,242,255,0.7); height:90px; display:flex; align-items:center; justify-content:center;">
              <span id="dashDemoImgText" style="font-size:12px; color:#4f46e5; font-weight:700;"><i class="ti ti-photo-plus"></i> ডেমো ছবি দিন</span>
              <img id="dashDemoImgPreview" style="display:none; max-height:75px; max-width:100%; object-fit:contain; border-radius:6px;">
            </div>
            <input type="file" id="dashPDemoImgFile" accept="image/*" style="display:none;" onchange="handleDashDemoImgSelect(event)">
          </div>
        </div>

        <textarea id="dashPDesc" rows="2" placeholder="পণ্যের বিবরণ বা সাইজ/কালার" style="margin-bottom:10px;"></textarea>

        <div style="display:flex; gap:8px;">
          <button id="btnDashSave" onclick="saveOrUpdateProductDirect(${bot.id})" style="flex:1; background:#059669; padding:12px;">
            <i class="ti ti-plus"></i> ১-ক্লিকে প্রোডাক্ট সেভ ও লিংক নিন
          </button>
          <button id="btnDashCancelEdit" onclick="cancelDashEdit()" style="display:none; width:auto; background:#64748b; padding:0 18px;">
            বাতিল
          </button>
        </div>
      </div>

      <!-- পণ্যের তালিকা টেবিল (আলাদা লিংক ও এডিট বাটনসহ) -->
      <div id="dashProductTableContainer">
        <div style="text-align:center; padding:12px; color:var(--muted);">পণ্য লোড হচ্ছে...</div>
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

    <!-- 🔑 মাল্টিপল Gemini API Key (কমা দিয়ে যতখুশি বসানো যাবে) -->
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h3><i class="ti ti-key"></i> ডেডিকেটেড Gemini API Keys</h3>
        <span style="font-size:11px; font-weight:800; color:#059669; background:#ecfdf5; padding:4px 10px; border-radius:12px;">
          ${bot.gemini_api_key ? '👑 আনলিমিটেড রোটেশন সক্রিয়' : 'ℹ️ প্ল্যাটফর্ম ডিফল্ট Key'}
        </span>
      </div>
      <div class="form-group">
        <label style="font-size:12px; color:var(--muted); font-weight:700;">কমা (,) দিয়ে যতখুশি Gemini API Key বসাতে পারবেন (একটি শেষ হলে অটো অন্যটিতে চলবে):</label>
        <textarea id="apiKeyInput" rows="3" placeholder="AIzaSy1..., AIzaSy2..., AIzaSy3...">${bot.gemini_api_key || ''}</textarea>
      </div>
      <button onclick="saveApiKey(${bot.id})"><i class="ti ti-device-floppy"></i> API Key সমূহ সংরক্ষণ করুন</button>
    </div>

    <!-- 📜 লাইভ কনসোল লগ (কপি, ডিলিট ও রিফ্রেশ বাটনসহ) -->
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
        <h3 style="margin-bottom:0;"><i class="ti ti-terminal"></i> লাইভ অ্যাক্টিভিটি টার্মিনাল</h3>
        <div style="display:flex; gap:6px;">
          <button onclick="copyTerminalLogs()" style="width:auto; padding:6px 12px; font-size:11px; background:#0284c7; border-radius:8px;">
            <i class="ti ti-copy"></i> কপি
          </button>
          <button onclick="refreshTerminalLogs()" style="width:auto; padding:6px 12px; font-size:11px; background:#059669; border-radius:8px;">
            <i class="ti ti-refresh"></i> রিফ্রেশ
          </button>
          <button onclick="clearTerminalLogs(${bot.id})" style="width:auto; padding:6px 12px; font-size:11px; background:#ef4444; border-radius:8px;">
            <i class="ti ti-trash"></i> ডিলিট
          </button>
        </div>
      </div>
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
        knowledge_source: document.getElementById('editKnowledgeSource').value,
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

    // 💬 লাইভ এআই টেস্ট চ্যাট ফাংশন (টাইপিং ইনডিকেটরসহ)
    async function sendTestChatMessage(botId) {
      const input = document.getElementById('testMsgInput');
      const btn = document.getElementById('testSendBtn');
      const text = input.value.trim();
      if(!text) return;
      const win = document.getElementById('testChatWindow');
      
      // গ্রাহকের মেসেজ দেখানো
      win.innerHTML += '<div style="margin-bottom:8px; text-align:right;"><span style="background:#059669; color:#fff; padding:6px 12px; border-radius:12px; display:inline-block;">' + text + '</span></div>';
      input.value = '';

      // ✍️ টাইপিং ইনডিকেটর যোগ
      const typingId = 'typing_' + Date.now();
      win.innerHTML += '<div id="' + typingId + '" style="margin-bottom:8px; text-align:left;"><span style="background:#e2e8f0; color:#475569; padding:6px 12px; border-radius:12px; display:inline-block; font-size:12px;"><i class="ti ti-dots" style="animation:pulse 1s infinite;"></i> টাইপ করছে...</span></div>';
      win.scrollTop = win.scrollHeight;
      btn.disabled = true;

      try {
        const res = await fetch('/api/user/test-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ botId, message: text })
        });
        const d = await res.json();
        const typingEl = document.getElementById(typingId);
        if (typingEl) typingEl.remove();

        win.innerHTML += '<div style="margin-bottom:8px; text-align:left;"><span style="background:#f1f5f9; border:1px solid #cbd5e1; color:#0f172a; padding:8px 12px; border-radius:12px; display:inline-block; line-height:1.4;">' + (d.reply || 'কোনো উত্তর নেই') + '</span></div>';
        win.scrollTop = win.scrollHeight;
      } catch(e) {
        const typingEl = document.getElementById(typingId);
        if (typingEl) typingEl.remove();
        win.innerHTML += '<div style="color:red; font-size:12px; margin-bottom:8px;">⚠️ এআই রেসপন্স এরর!</div>';
      } finally {
        btn.disabled = false;
      }
    }

    // 📋 কনসোল লগ কপি
    function copyTerminalLogs() {
      const box = document.getElementById('terminalBox');
      const text = box.innerText || box.textContent;
      navigator.clipboard.writeText(text).then(() => {
        alert('📋 টার্মিনাল লগ সফলভাবে কপি করা হয়েছে!');
      }).catch(() => {
        alert('কপি ব্যর্থ হয়েছে!');
      });
    }

    // 🔄 কনসোল লগ রিফ্রেশ
    function refreshTerminalLogs() {
      fetchLiveUpdates();
    }

    // 🗑️ কনসোল লগ মুছে ফেলা (ক্লিয়ার)
    async function clearTerminalLogs(botId) {
      if(!confirm('আপনি কি টার্মিনালের সমস্ত লগ মুছে ফেলতে চান?')) return;
      document.getElementById('terminalBox').innerHTML = '<div class="log-line"><span class="log-time">[System]</span> 🧹 কনসোল পরিষ্কার করা হচ্ছে...</div>';
      try {
        await fetch('/api/user/clear-logs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ botId })
        });
        fetchLiveUpdates();
      } catch (e) {}
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

    let dashCurrentImgBase64 = '';
    let dashCurrentDemoImgBase64 = '';
    let loadedProductsList = [];

    // ১. মূল ছবি সিলেক্ট
    function handleDashImgSelect(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(evt) {
        const img = new Image();
        img.onload = function() {
          const canvas = document.createElement('canvas');
          const maxDim = 600;
          let w = img.width, h = img.height;
          if (w > h && w > maxDim) { h = Math.round((h * maxDim) / w); w = maxDim; }
          else if (h > maxDim) { w = Math.round((w * maxDim) / h); h = maxDim; }
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          dashCurrentImgBase64 = canvas.toDataURL('image/jpeg', 0.65);
          document.getElementById('dashImgPreview').src = dashCurrentImgBase64;
          document.getElementById('dashImgPreview').style.display = 'block';
          document.getElementById('dashImgText').style.display = 'none';
        };
        img.src = evt.target.result;
      };
      reader.readAsDataURL(file);
    }

    // ২. ডেমো ছবি সিলেক্ট
    function handleDashDemoImgSelect(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(evt) {
        const img = new Image();
        img.onload = function() {
          const canvas = document.createElement('canvas');
          const maxDim = 600;
          let w = img.width, h = img.height;
          if (w > h && w > maxDim) { h = Math.round((h * maxDim) / w); w = maxDim; }
          else if (h > maxDim) { w = Math.round((w * maxDim) / h); h = maxDim; }
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          dashCurrentDemoImgBase64 = canvas.toDataURL('image/jpeg', 0.65);
          document.getElementById('dashDemoImgPreview').src = dashCurrentDemoImgBase64;
          document.getElementById('dashDemoImgPreview').style.display = 'block';
          document.getElementById('dashDemoImgText').style.display = 'none';
        };
        img.src = evt.target.result;
      };
      reader.readAsDataURL(file);
    }

    // 📦 ড্যাশবোর্ডের প্রোডাক্ট লোড করা (আলাদা লিংক, ডেমো ব্যাজ ও এডিট বাটনসহ)
    async function loadDashProducts() {
      try {
        const res = await fetch('/api/user/products?botId=${bot.id}');
        const data = await res.json();
        const container = document.getElementById('dashProductTableContainer');
        if (data.success) {
          loadedProductsList = data.products || [];
          if (loadedProductsList.length === 0) {
            container.innerHTML = '<div style="text-align:center; padding:18px; color:var(--muted); font-size:13px;">বর্তমানে কোনো পণ্য তালিকায় নেই। ওপরে ফর্ম পূরণ করে যোগ করুন।</div>';
            return;
          }

          // 📋 ড্রপডাউনে আগের ক্যাটাগরিগুলো অটো আপডেট
          updateDashCategoryDropdown(loadedProductsList);

          container.innerHTML = loadedProductsList.map((p, idx) => {
            const singleLink = p.buy_link || ('https://${fullUrl}/p/' + p.id);
            return \`
            <div style="background:rgba(255,255,255,0.7); border:1px solid rgba(226,232,240,0.8); border-radius:14px; padding:14px; margin-bottom:12px; display:flex; flex-direction:column; gap:10px;">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <div style="display:flex; align-items:center; gap:12px;">
                  <div style="position:relative;">
                    \${p.image_url ? \`<img src="\${p.image_url}" style="width:55px; height:55px; border-radius:10px; object-fit:cover; border:1px solid #e2e8f0;">\` : \`<div style="width:55px; height:55px; border-radius:10px; background:#f1f5f9; display:flex; align-items:center; justify-content:center; color:#94a3b8;"><i class="ti ti-photo-off"></i></div>\`}
                    \${p.demo_images ? \`<span style="position:absolute; bottom:-3px; right:-3px; background:#4f46e5; color:#fff; font-size:9px; font-weight:800; padding:1px 4px; border-radius:4px;">ডেমো</span>\` : ''}
                  </div>
                  <div>
                    <b style="font-size:14px; color:#0f172a;">\${p.name}</b><br>
                    <span style="color:#059669; font-weight:800; font-size:15px;">৳\${p.price}</span>
                    <span style="font-size:11px; background:#ecfdf5; color:#047857; padding:2px 8px; border-radius:6px; font-weight:700;">\${p.category || 'General'}</span>
                  </div>
                </div>
                <div style="display:flex; gap:6px;">
                  <button onclick="startEditDashProduct(\${idx})" style="width:auto; padding:6px 12px; background:#e0f2fe; color:#0369a1; font-size:12px; border:none; border-radius:8px; cursor:pointer; font-weight:700;"><i class="ti ti-edit"></i> এডিট</button>
                  <button onclick="deleteDashProduct(\${p.id})" style="width:auto; padding:6px 12px; background:#fee2e2; color:#b91c1c; font-size:12px; border:none; border-radius:8px; cursor:pointer; font-weight:700;"><i class="ti ti-trash"></i> ডিলিট</button>
                </div>
              </div>

              <!-- 🔗 প্রতিটা পণ্যের আলাদা লিংক বক্স -->
              <div style="display:flex; gap:6px; background:rgba(248,250,252,0.9); padding:6px 10px; border-radius:10px; border:1px solid #e2e8f0; align-items:center;">
                <span style="font-size:11px; color:#64748b; font-weight:700; white-space:nowrap;">🔗 আলাদা লিংক:</span>
                <input type="text" readonly value="\${singleLink}" style="flex:1; padding:4px 8px; font-size:11px; background:#fff; border:1px solid #cbd5e1; border-radius:6px; color:#059669; font-weight:600;">
                <button onclick="navigator.clipboard.writeText('\${singleLink}'); alert('এই পণ্যের আলাদা লিংক কপি করা হয়েছে!');" style="width:auto; padding:4px 10px; font-size:11px; background:#059669; border-radius:6px;">কপি</button>
                <a href="\${singleLink}" target="_blank" style="padding:4px 10px; font-size:11px; background:#0284c7; color:#fff; border-radius:6px; text-decoration:none; font-weight:700;">ভিউ</a>
              </div>
            </div>\`;
          }).join('');
        }
      } catch(e) {}
    }

    // ➕ পণ্য যোগ বা এডিট আপডেট ফাংশন
    async function saveOrUpdateProductDirect(botId) {
      const editId = document.getElementById('dashEditProductId').value;
      const name = document.getElementById('dashPName').value.trim();
      const price = document.getElementById('dashPPrice').value.trim();
      const regPrice = document.getElementById('dashPRegPrice').value.trim();
      const category = document.getElementById('dashPCat').value.trim() || 'General';
      const buy_link = document.getElementById('dashPLink').value.trim();
      const description = document.getElementById('dashPDesc').value.trim();

      if (!name || !price) return alert('পণ্যের নাম ও দাম অবশ্যই দিতে হবে!');

      const url = editId ? '/api/user/products/update' : '/api/user/products/add';
      const bodyData = { 
        botId, 
        productId: editId || undefined,
        name, 
        price, 
        regular_price: regPrice || null,
        category, 
        buy_link, 
        description, 
        image_url: dashCurrentImgBase64,
        demo_images: dashCurrentDemoImgBase64
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyData)
      });
      const data = await res.json();
      if (data.success) {
        alert(data.message || 'সফল হয়েছে!');
        cancelDashEdit();
        loadDashProducts();
      } else {
        alert(data.message || 'ত্রুটি ঘটেছে');
      }
    }

    // ✏️ এডিট মোড শুরু করা
    function startEditDashProduct(idx) {
      const p = loadedProductsList[idx];
      if (!p) return;

      document.getElementById('dashEditProductId').value = p.id;
      document.getElementById('dashPName').value = p.name;
      document.getElementById('dashPPrice').value = p.price;
      document.getElementById('dashPRegPrice').value = p.regular_price || '';
      document.getElementById('dashPCat').value = p.category || 'General';
      document.getElementById('dashPLink').value = p.buy_link || '';
      document.getElementById('dashPDesc').value = p.description || '';

      dashCurrentImgBase64 = p.image_url || '';
      if (dashCurrentImgBase64) {
        document.getElementById('dashImgPreview').src = dashCurrentImgBase64;
        document.getElementById('dashImgPreview').style.display = 'block';
        document.getElementById('dashImgText').style.display = 'none';
      }

      dashCurrentDemoImgBase64 = p.demo_images || '';
      if (dashCurrentDemoImgBase64) {
        document.getElementById('dashDemoImgPreview').src = dashCurrentDemoImgBase64;
        document.getElementById('dashDemoImgPreview').style.display = 'block';
        document.getElementById('dashDemoImgText').style.display = 'none';
      }

      document.getElementById('dashFormTitle').innerHTML = '✏️ পণ্য এডিট করুন: ' + p.name;
      const btn = document.getElementById('btnDashSave');
      btn.innerHTML = '<i class="ti ti-check"></i> পণ্য আপডেট করুন';
      btn.style.background = '#d97706';
      document.getElementById('btnDashCancelEdit').style.display = 'inline-block';

      document.getElementById('dashFormBox').scrollIntoView({ behavior: 'smooth' });
    }

    function cancelDashEdit() {
      document.getElementById('dashEditProductId').value = '';
      document.getElementById('dashPName').value = '';
      document.getElementById('dashPPrice').value = '';
      document.getElementById('dashPRegPrice').value = '';
      document.getElementById('dashPCat').value = '';
      document.getElementById('dashPLink').value = '';
      document.getElementById('dashPDesc').value = '';
      document.getElementById('dashPImgFile').value = '';
      document.getElementById('dashPDemoImgFile').value = '';
      dashCurrentImgBase64 = '';
      dashCurrentDemoImgBase64 = '';
      document.getElementById('dashImgPreview').style.display = 'none';
      document.getElementById('dashImgText').style.display = 'block';
      document.getElementById('dashDemoImgPreview').style.display = 'none';
      document.getElementById('dashDemoImgText').style.display = 'block';

      document.getElementById('dashFormTitle').innerHTML = '➕ নতুন প্রোডাক্ট যোগ করুন:';
      const btn = document.getElementById('btnDashSave');
      btn.innerHTML = '<i class="ti ti-plus"></i> ১-ক্লিকে প্রোডাক্ট সেভ ও লিংক নিন';
      btn.style.background = '#059669';
      document.getElementById('btnDashCancelEdit').style.display = 'none';
    }

    // 📋 ড্যাশবোর্ড ক্যাটাগরি ড্রপডাউন অটো আপডেট ফাংশন
    function updateDashCategoryDropdown(products) {
      const catSet = new Set();
      (products || []).forEach(p => {
        if (p.category && p.category.trim() && p.category !== 'General') {
          catSet.add(p.category.trim());
        }
      });

      const select = document.getElementById('dashCatSelect');
      if (catSet.size > 0) {
        select.style.display = 'block';
        select.innerHTML = '<option value="">-- ক্যাটাগরি সিলেক্ট --</option>' +
          Array.from(catSet).map(cat => `<option value="${cat}">${cat}</option>`).join('') +
          '<option value="__NEW__">➕ নতুন লিখুন</option>';
      } else {
        select.style.display = 'none';
      }
    }

    function onDashCatSelect(el) {
      const val = el.value;
      const input = document.getElementById('dashPCat');
      if (val === '__NEW__') {
        input.value = '';
        input.focus();
      } else if (val) {
        input.value = val;
      }
    }

    function copyStoreUrl() {
      const input = document.getElementById('storeShareLink');
      input.select();
      document.execCommand('copy');
      alert('শপ লিংক কপি করা হয়েছে!');
    }

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

// ================= AI মেসেজ এক্সিকিউশন (systemInstruction ফিক্স ও কী অটো-রোটেশন) =================
async function executeGeminiForTenant(botRow, userPrompt, systemPrompt, imageBuffer = null, imageMime = 'image/jpeg') {
  const dailyLimit = botRow.rate_limit_daily || 300;
  if ((botRow.requests_today || 0) >= dailyLimit && botRow.plan !== 'premium') {
    addBotLog(botRow.id, 'warn', `⚠️ আজকের ফ্রি লিমিট (${dailyLimit} মেসেজ) শেষ!`);
    return 'ভাইয়া, আজকের জন্য আমাদের স্বয়ংক্রিয় এআই সেবার ফ্রি লিমিট শেষ হয়ে গিয়েছে। আরও আনলিমিটেড সেবার জন্য অ্যাডমিনের সাথে যোগাযোগ করুন ❤️';
  }

  let reply = '';
  let usedTokens = 0;
  const safeInstruction = typeof systemPrompt === 'string' && systemPrompt.trim() ? systemPrompt.trim() : 'তুমি একজন অমায়িক ও পেশাদার কাস্টমার সহকারী।';

  // 🔑 কমা দিয়ে আলাদা করা একাধিক কী বের করা
  const customKeys = (botRow.gemini_api_key || '')
    .split(',')
    .map(k => k.trim())
    .filter(k => k.length > 20);

  if (customKeys.length > 0) {
    for (let i = 0; i < customKeys.length; i++) {
      const activeKey = customKeys[i];
      try {
        const client = new GoogleGenAI({ apiKey: activeKey });
        const contents = [];
        if (imageBuffer) contents.push({ inlineData: { data: imageBuffer.toString('base64'), mimeType: imageMime } });
        contents.push(userPrompt);

        const response = await client.models.generateContent({
          model: GEMINI_MODEL || 'gemini-2.5-flash',
          contents,
          config: {
            systemInstruction: safeInstruction,
            temperature: 0.35,
            maxOutputTokens: 1200
          }
        });

        reply = response.text?.trim() || response.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        usedTokens = response.usageMetadata?.totalTokenCount || 50;

        if (reply) break;
      } catch (err) {
        addBotLog(botRow.id, 'warn', `⚠️ Key #${i + 1} ফেইল: ${err.message} (পরবর্তী কী দিয়ে চেষ্টা চলছে...)`);
      }
    }
  }

  // যদি ইউজারের সব কী ব্যর্থ হয়, তবে প্ল্যাটফর্ম ব্যাকআপ ইঞ্জিন চালাবে
  if (!reply) {
    try {
      reply = await callGeminiUltraFast(userPrompt, safeInstruction, imageBuffer, imageMime);
      usedTokens = 45;
    } catch (fallbackErr) {
      addBotLog(botRow.id, 'warn', `প্ল্যাটফর্ম ব্যাকআপ এরর: ${fallbackErr.message}`);
    }
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
  const source = botRow.knowledge_source || (botRow.bot_type === 'business_site' ? 'website' : 'catalog');

  // 👉 যদি ইউজার "ওয়েবসাইট" সিলেক্ট করে রাখে
  if (source === 'website' && botRow.website_url) {
    catalogContext = `আমাদের মূল ওয়েবসাইটের তথ্য ও লিংক: ${botRow.website_url}। ওয়েবসাইটের পণ্য ও নিয়মাবলী অনুযায়ী উত্তর দাও: ${botRow.system_prompt || ''}`;
  } 
  // 👉 যদি ইউজার "ক্যাটালগ" সিলেক্ট করে রাখে (ডিফল্ট ও সবচেয়ে নিখুঁত)
  else {
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
      catalogContext = searchResult.items.map(p => `• [ID:${p.id}] ${p.name} | মূল্য: ৳${p.price} | ক্যাটাগরি: ${p.category} | লিংক: ${p.buy_link}`).join('\n');
    }
  }

  const conversationHistoryText = history.length > 0 
    ? history.map(h => `${h.role === 'user' ? 'গ্রাহক' : 'অ্যাসিস্ট্যান্ট'}: ${h.text}`).join('\n')
    : 'এখনই কথোপকথন শুরু হয়েছে।';

  // 🛍️ ক্যাটালগে মোট কী কী আইটেম বা ক্যাটাগরি আছে তার সংক্ষিপ্ত সামারি
  const prodsQuery = await pool.query('SELECT name, price, category FROM bot_products WHERE bot_id = $1 LIMIT 15', [botId]);
  const availableCategories = [...new Set(prodsQuery.rows.map(p => p.category).filter(Boolean))].join(', ');
  const sampleProducts = prodsQuery.rows.map(p => p.name).slice(0, 5).join(', ');

  let systemPrompt = '';
  if (botRow.bot_type === 'personal') {
    systemPrompt = `তুমি ${botRow.bot_name} এর অত্যন্ত অমায়িক ও সাহায্যকারী ব্যক্তিগত সহকারী (Personal AI Assistant)।
ব্যবহারকারীর নিজস্ব পরিচয়/নির্দেশনা: ${botRow.system_prompt || 'ব্যক্তিগত ইউজার'}।
নিয়মাবলী:
- গ্রাহককে 'ভাইয়া' বা সম্মান দিয়ে কথা বলবে।
- গ্রাহক যা জানতে চাইবে কেবল সেটুকুর প্রাসঙ্গিক ও সংক্ষিপ্ত উত্তর দেবে। অপ্রয়োজনীয় কথা বলবে না।
কথোপকথন ইতিহাস:
${conversationHistoryText}`;
  } else {
    systemPrompt = `তুমি ${botRow.bot_name} এর একজন আসল মানুষের মতো বিনয়ী ও অমায়িক হেল্পডেস্ক/সেলস অ্যাসিস্ট্যান্ট।
ওয়েবসাইট/প্ল্যাটফর্মের মূল বিবরণ ও নির্দেশিকা:
${botRow.system_prompt || 'আমরা মানসম্মত পণ্য ও সেবা দিয়ে থাকি।'}

⛔ অতি গুরুত্বপূর্ণ কঠোর নিয়মাবলী (কখনোই ভঙ্গ করবে না):
১. সাধারণ হাই/হ্যালো/সালাম: গ্রাহক শুধু সালাম বা হাই দিলে বিনয়ের সাথে উত্তর দাও (যেমন: "ওয়ালাইকুম আসসালাম ভাইয়া! কেমন আছেন? আপনাকে কীভাবে সাহায্য করতে পারি?")। কোনো পণ্য, দাম, তালিকা বা ডেলিভারি চার্জ নিজে থেকে জোর করে চাপাবে না!
২. টুর্নামেন্ট/গেমিং/সার্ভিস সাইট হলে: যদি সাইটটি গেমিং, টুর্নামেন্ট বা কোনো সার্ভিসের হয়, তবে সাধারণ মানুষের মতো নিয়ম, রেজিস্ট্রেশন ফি ও প্রসেস সুন্দরভাবে বুঝিয়ে বলো।
৩. পণ্য জানতে চাওয়া: গ্রাহক যতক্ষণ নির্দিষ্ট কোনো পণ্য বা দাম জানতে না চাইবে অথবা কিনতে না চাইবে, ততক্ষণ নিজে থেকে "আপনি কি অর্ডার করতে চান?" বা ডেলিভারি চার্জ বলবে না।
৪. ছবি চাওয়া ও ডেমো পণ্যের নিয়ম: 
   - গ্রাহক যখন কোনো পণ্যের ছবি চাইবে বা ডেমো পণ্য দেখতে চাইবে, তখন আমাদের স্টক থেকে ৬-৭টি সেরা পণ্যের নাম, বর্তমান মূল্য, সংক্ষেপ বিবরণ এবং তার "আলাদা আলাদা ডেডিকেটেড লিংক" পয়েন্ট আকারে সুন্দর করে দেবে।
   - গ্রাহককে বিনয়ের সাথে বলবে: "ভাইয়া, নিচে আমাদের সেরা ৬-৭টি পণ্যের ডেমো তালিকা ও আলাদা আলাদা লিংক দেওয়া হলো। প্রতিটি লিংকে ক্লিক করলেই আপনি বড় ৪ কোণা কার্ডে পণ্যের আসল ছবি ও সম্পূর্ণ বিবরণ দেখতে পাবেন:"
৫. কৃত্রিম বা রোবোটিক আচরণ সম্পূর্ণ নিষিদ্ধ। আসল মানুষের মতো সহজ, সরল ও আন্তরিক ভঙ্গিতে কথা বলো।

স্টক ডাটা রেফারেন্স (প্রয়োজনে ব্যবহারের জন্য):
${catalogContext || 'কোনো নির্দিষ্ট প্রোডাক্ট খোঁজা হয়নি।'}
ডেলিভারি চার্জ (কেবলমাত্র পণ্য অর্ডার করার সময় উল্লেখ করবে): সিটির ভেতরে ৳${botRow.delivery_inside || 70}, বাইরে ৳${botRow.delivery_outside || 130}।
কথোপকথন ইতিহাস:
${conversationHistoryText}`;
  }

  let userPrompt = '';
  if (imageBuffer) {
    userPrompt = `[ছবি বিশ্লেষণ নির্দেশ]: গ্রাহক এই পণ্যের একটি ছবি পাঠিয়েছেন। ছবিটি মনোযোগ দিয়ে দেখো এবং আমাদের স্টকের পণ্যের সাথে মিলিয়ে বলো এই পণ্যটি আমাদের স্টকে আছে কি না। থাকলে তার নাম ও মূল্য জানাও। গ্রাহক ক্যাপশনে লিখেছেন: "${cleanInput || 'এই পণ্যটি কি আপনাদের কাছে আছে?'}"`;
  } else if (cleanInput) {
    userPrompt = `গ্রাহক: "${cleanInput}"`;
  } else {
    userPrompt = 'গ্রাহক একটি বার্তা পাঠিয়েছেন।';
  }

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

        // 🛡️ সিন করা ও রিয়েল-টাইম টাইপিং ইনডিকেটর চালু রাখা
        try {
          await sock.readMessages([msg.key]);
          await sock.sendPresenceUpdate('composing', sender); // ✍️ টাইপিং শুরু
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

        // 🛡️ মানুষের মতো টাইপিং বজায় রাখা
        try { await sock.sendPresenceUpdate('composing', sender); } catch (_) {}
        const typingDelay = Math.min(2500, Math.max(1000, reply.length * 15));
        await delay(typingDelay);

        // 📸 কাস্টমার ছবি চাইলে, অথবা ভয়েস/ছবি পাঠিয়ে পণ্যের সন্ধান করলে সাথে সাথে আমাদের স্টকের আসল ছবি পাঠানো
        const wantsPic = /ছবি|পিক|pic|image|photo|দেখাও|দেখান|দেখি|দেখতে চাই/i.test(text) || (isImage && !text) || (isAudio && /আছে|দাম|পণ্য/i.test(text));
        let sentWithImage = false;

        if (wantsPic) {
          try {
            // ১. কাস্টমারের টেক্সটের সাথে মিল রেখে প্রোডাক্ট খোঁজা
            const allProds = await pool.query(
              `SELECT name, image_url, price FROM bot_products 
               WHERE bot_id = $1 AND image_url IS NOT NULL AND image_url != '' 
               ORDER BY id DESC`,
              [botId]
            );

            if (allProds.rows.length > 0) {
              // কাস্টমার যে প্রোডাক্টের নাম লিখেছে সেটা আগে খোঁজা
              let targetProd = allProds.rows.find(p => text.toLowerCase().includes(p.name.toLowerCase()));
              if (!targetProd) targetProd = allProds.rows[0]; // না মিললে সর্বশেষ প্রোডাক্ট

              if (targetProd && targetProd.image_url) {
                let imgBuffer = null;
                if (targetProd.image_url.startsWith('data:image')) {
                  const base64Data = targetProd.image_url.split(',')[1];
                  imgBuffer = Buffer.from(base64Data, 'base64');
                } else if (targetProd.image_url.startsWith('http')) {
                  imgBuffer = { url: targetProd.image_url };
                }

                if (imgBuffer) {
                  await sock.sendMessage(sender, { 
                    image: imgBuffer, 
                    caption: `📸 *${targetProd.name}* — ৳${targetProd.price}\n\n${reply}` 
                  });
                  sentWithImage = true;
                  addBotLog(botId, 'success', `🖼️ কাস্টমারকে [${targetProd.name}] এর ছবি পাঠানো হয়েছে!`);
                }
              }
            }
          } catch (imgErr) {
            console.error('[IMAGE SEND ERROR]:', imgErr.message);
          }
        }

        // যদি ছবি না পাঠানো হয়, সাধারণ টেক্সট রিপ্লাই যাবে
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
        `INSERT INTO store_catalog_items (catalog_slug, name, price, category, image_url, demo_images, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [cleanSlug, item.name, item.price || 0, item.category || 'General', item.image_url || '', item.demo_images || '', item.description || '']
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

// 🔗 প্রতিটি ক্যাটালগ পণ্যের আলাদা ডেডিকেটেড লিংক ও বড় ৪ কোণা কার্ড (/c/:slug/:id)
app.get('/c/:slug/:id', async (req, res) => {
  try {
    const { slug, id } = req.params;
    const cat = await pool.query('SELECT * FROM store_catalogs WHERE catalog_slug = $1', [slug.toLowerCase().trim()]);
    if (cat.rows.length === 0) return res.status(404).send('<h2>ক্যাটালগ পাওয়া যায়নি!</h2>');
    
    const itemRes = await pool.query('SELECT * FROM store_catalog_items WHERE id = $1 AND catalog_slug = $2', [parseInt(id, 10), slug.toLowerCase().trim()]);
    if (itemRes.rows.length === 0) return res.status(404).send('<h2>পণ্যটি পাওয়া যায়নি!</h2>');

    const item = itemRes.rows[0];
    const store = cat.rows[0];
    const host = req.get('host');
    const orderWaText = encodeURIComponent(`আসসালামু আলাইকুম, আমি এই পণ্যটি অর্ডার করতে চাই:\n📦 পণ্য: ${item.name}\n💰 মূল্য: ৳${item.price}\n🔗 লিংক: ${req.protocol}://${host}/c/${slug}/${item.id}`);

    res.send(`<!DOCTYPE html>
    <html lang="bn">
    <head>
      <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${item.name} — ${store.store_name}</title>
      <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=Hind+Siliguri:wght@400;600;700&display=swap" rel="stylesheet">
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css">
      <style>
        * { box-sizing: border-box; margin:0; padding:0; font-family:'Plus Jakarta Sans','Hind Siliguri',sans-serif; }
        body {
          background-color: #f8fafc;
          background-image: radial-gradient(circle at 10% 10%, rgba(16,185,129,0.08) 0%, transparent 40%),
                            radial-gradient(circle at 90% 90%, rgba(14,165,233,0.08) 0%, transparent 40%);
          color: #0f172a; padding: 25px 15px; display: flex; justify-content: center; min-height: 100vh;
        }
        /* 💎 বড় চারকোনা প্রিমিয়াম কার্ড */
        .big-square-card {
          max-width: 500px; width: 100%;
          background: rgba(255, 255, 255, 0.78);
          backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
          border: 1px solid rgba(255, 255, 255, 0.95);
          border-radius: 28px; overflow: hidden;
          box-shadow: 0 20px 50px -10px rgba(15, 23, 42, 0.12);
          display: flex; flex-direction: column;
        }
        .big-img-box {
          width: 100%; height: 350px; background: rgba(241, 245, 249, 0.6);
          position: relative; display: flex; align-items: center; justify-content: center;
          border-bottom: 1px solid rgba(226, 232, 240, 0.8);
        }
        .big-img-box img { width: 100%; height: 100%; object-fit: contain; }
        .cat-badge {
          position: absolute; top: 16px; left: 16px;
          background: rgba(15, 23, 42, 0.75); backdrop-filter: blur(8px);
          color: #fff; font-size: 12px; font-weight: 700; padding: 5px 12px; border-radius: 20px;
        }
        .card-content { padding: 26px; flex: 1; display: flex; flex-direction: column; justify-content: space-between; }
        .prod-title { font-size: 22px; font-weight: 800; color: #0f172a; margin-bottom: 8px; line-height: 1.3; }
        .price-badge { font-size: 26px; font-weight: 800; color: #059669; margin-bottom: 14px; }
        .prod-desc { font-size: 14px; color: #475569; line-height: 1.6; margin-bottom: 22px; background: rgba(255,255,255,0.6); padding: 14px; border-radius: 14px; border: 1px solid rgba(226,232,240,0.6); }
        .action-row { display: flex; flex-direction: column; gap: 10px; }
        .order-btn {
          display: flex; align-items: center; justify-content: center; gap: 8px;
          background: linear-gradient(135deg, #25d366 0%, #15803d 100%);
          color: #fff; padding: 16px; border-radius: 16px; font-size: 15px; font-weight: 800;
          text-decoration: none; box-shadow: 0 8px 24px rgba(37, 211, 102, 0.3); transition: 0.2s;
        }
        .order-btn:hover { transform: translateY(-2px); }
        .share-btn {
          display: flex; align-items: center; justify-content: center; gap: 6px;
          background: rgba(255,255,255,0.85); color: #334155; padding: 12px;
          border-radius: 14px; font-size: 13px; font-weight: 700; border: 1px solid #cbd5e1;
          cursor: pointer; text-decoration: none;
        }
      </style>
    </head>
    <body>
      <div class="big-square-card">
        <div class="big-img-box">
          <span class="cat-badge">${item.category || 'General'}</span>
          ${item.image_url ? `<img src="${item.image_url}" alt="${item.name}">` : `<i class="ti ti-photo" style="font-size:64px; color:#cbd5e1;"></i>`}
        </div>
        <div class="card-content">
          <div>
            <div style="font-size:12px; color:#64748b; font-weight:700; margin-bottom:4px;">🏪 ${store.store_name}</div>
            <h1 class="prod-title">${item.name}</h1>
            <div class="price-badge">৳${item.price}</div>
            
            ${item.demo_images ? `
            <!-- 📸 ডেমো পিকচার প্রিভিউ স্লট -->
            <div style="margin-bottom:18px; background:rgba(238, 242, 255, 0.7); border:1px solid #c7d2fe; border-radius:16px; padding:12px;">
              <div style="font-size:12px; font-weight:800; color:#3730a3; margin-bottom:8px; display:flex; align-items:center; gap:6px;">
                <i class="ti ti-photo-star"></i> 📸 পণ্যের ডেমো পিকচার ভিউ (Demo Picture):
              </div>
              <img src="${item.demo_images}" alt="Demo Preview" style="width:100%; height:200px; object-fit:cover; border-radius:12px; border:1px solid #e0e7ff; background:#fff;">
            </div>` : ''}

            <div class="prod-desc">${item.description || 'পণ্যটির বিস্তারিত জানতে নিচে হোয়াটসঅ্যাপে যোগাযোগ করুন।'}</div>
          </div>
          <div class="action-row">
            <a href="https://wa.me/?text=${orderWaText}" target="_blank" class="order-btn">
              <i class="ti ti-brand-whatsapp" style="font-size:22px;"></i> সরাসরি হোয়াটসঅ্যাপে অর্ডার করুন
            </a>
            <button onclick="navigator.clipboard.writeText(location.href); alert('লিংক কপি করা হয়েছে!');" class="share-btn">
              <i class="ti ti-link"></i> এই পণ্যের লিংক কপি করুন
            </button>
            <a href="/catalog/${slug}" style="text-align:center; font-size:12px; color:#059669; font-weight:700; text-decoration:none; margin-top:4px;">
              👈 সব পণ্য দেখুন
            </a>
          </div>
        </div>
      </div>
    </body>
    </html>`);
  } catch(e) { res.status(500).send('Error'); }
});

// 📖 সম্পূর্ণ ক্যাটালগ ভিউয়ার (বড় ৪ কোণা কার্ড গ্রিডসহ)
app.get('/catalog/:slug', async (req, res) => {
  try {
    const slug = req.params.slug.toLowerCase().trim();
    const cat = await pool.query('SELECT * FROM store_catalogs WHERE catalog_slug = $1', [slug]);
    if (cat.rows.length === 0) return res.status(404).send('<h2>ক্যাটালগ পাওয়া যায়নি!</h2>');

    const items = await pool.query('SELECT * FROM store_catalog_items WHERE catalog_slug = $1 ORDER BY id DESC', [slug]);
    const store = cat.rows[0];
    const host = req.get('host');

    res.send(`<!DOCTYPE html>
    <html lang="bn">
    <head>
      <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${store.store_name} — প্রোডাক্ট ক্যাটালগ</title>
      <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=Hind+Siliguri:wght@400;600;700&display=swap" rel="stylesheet">
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css">
      <style>
        * { box-sizing: border-box; margin:0; padding:0; font-family:'Plus Jakarta Sans','Hind Siliguri',sans-serif; }
        body { background:#f8fafc; padding:25px 15px; color:#0f172a; min-height:100vh; }
        .catalog-container { max-width: 900px; margin: 0 auto; }
        .header { background:rgba(255,255,255,0.85); backdrop-filter:blur(16px); padding:24px; border-radius:20px; border:1px solid #e2e8f0; text-align:center; margin-bottom:25px; }
        .header h1 { font-size:24px; color:#047857; font-weight:800; }
        
        /* 💎 বড় চারকোনা কার্ড গ্রিড */
        .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap:20px; }
        .card {
          background:#fff; border:1px solid #e2e8f0; border-radius:20px; overflow:hidden;
          display:flex; flex-direction:column; box-shadow:0 8px 25px rgba(0,0,0,0.04); transition:0.2s;
        }
        .card:hover { transform:translateY(-3px); box-shadow:0 14px 35px rgba(0,0,0,0.08); }
        .img-wrap { width:100%; height:220px; background:#f1f5f9; display:flex; align-items:center; justify-content:center; }
        .img-wrap img { width:100%; height:100%; object-fit:cover; }
        .card-body { padding:18px; flex:1; display:flex; flex-direction:column; justify-content:space-between; }
        .card-title { font-size:16px; font-weight:800; margin-bottom:6px; color:#0f172a; }
        .card-price { font-size:18px; font-weight:800; color:#059669; margin-bottom:12px; }
        .card-btns { display:grid; grid-template-columns: 1fr 1fr; gap:6px; }
        .btn-view { background:#f1f5f9; color:#334155; padding:9px; border-radius:10px; font-size:12px; font-weight:700; text-align:center; text-decoration:none; }
        .btn-order { background:#25d366; color:#fff; padding:9px; border-radius:10px; font-size:12px; font-weight:700; text-align:center; text-decoration:none; }
      </style>
    </head>
    <body>
      <div class="catalog-container">
        <div class="header">
          <h1>🛍️ ${store.store_name}</h1>
          <p style="font-size:13px; color:#64748b; margin-top:4px;">আমাদের অফিসিয়াল প্রোডাক্ট ক্যাটালগ</p>
        </div>
        <div class="grid">
          ${items.rows.map(i => `
            <div class="card">
              <div class="img-wrap">
                ${i.image_url ? `<img src="${i.image_url}" alt="${i.name}">` : `<i class="ti ti-photo" style="font-size:42px; color:#cbd5e1;"></i>`}
              </div>
              <div class="card-body">
                <div>
                  <small style="color:#64748b; font-weight:700;">${i.category || 'General'}</small>
                  <div class="card-title">${i.name}</div>
                  <div class="card-price">৳${i.price}</div>
                </div>
                <div class="card-btns">
                  <a href="/c/${slug}/${i.id}" class="btn-view">বড় ছবি ও লিংক</a>
                  <a href="https://wa.me/?text=${encodeURIComponent('আমি এই পণ্যটি অর্ডার করতে চাই: ' + i.name + ' - ৳' + i.price + ' (লিংক: ' + req.protocol + '://' + host + '/c/' + slug + '/' + i.id + ')')}" target="_blank" class="btn-order">অর্ডার করুন</a>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
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

// 🗑️ কনসোল লগ ডিলিট / ক্লিয়ার API
app.post('/api/user/clear-logs', (req, res) => {
  const botId = Number(req.body.botId);
  if (botLiveLogs.has(botId)) {
    botLiveLogs.set(botId, [{ time: new Date().toLocaleTimeString('en-US', { hour12: false }), type: 'info', message: '🧹 কনসোল লগ সম্পূর্ণ পরিষ্কার করা হয়েছে।' }]);
  }
  res.json({ success: true, message: 'লগ মুছে ফেলা হয়েছে।' });
});

// ৩. ইউজার থেকে বটের তথ্য আপডেট (Edit Bot Info)
app.post('/api/user/update-bot-settings', async (req, res) => {
  try {
    const { botId, bot_name, alert_phone, knowledge_source, bot_type, system_prompt, delivery_inside, delivery_outside } = req.body;
    await pool.query(
      `UPDATE whatsapp_bots 
       SET bot_name = $1, alert_phone = $2, knowledge_source = $3, bot_type = $4, system_prompt = $5, delivery_inside = $6, delivery_outside = $7 
       WHERE id = $8`,
      [bot_name, alert_phone, knowledge_source || 'catalog', bot_type, system_prompt, delivery_inside || 70, delivery_outside || 130, botId]
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

// 📸 ImgBB অটো আপলোড ফাংশন (আপনার API Key ইন্টিগ্রেশন)
async function uploadToImgBB(base64Image) {
  try {
    const apiKey = '6d7fde81f9936bd5cdb2b515c496a4f6';
    const cleanBase64 = base64Image.replace(/^data:image\/[a-z]+;base64,/, '');
    const params = new URLSearchParams();
    params.append('image', cleanBase64);

    const response = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, {
      method: 'POST',
      body: params
    });
    const resData = await response.json();
    if (resData.success) {
      return resData.data.url;
    }
  } catch (err) {
    console.error('[IMGBB UPLOAD ERROR]:', err.message);
  }
  return base64Image;
}

// ➕ ২. ড্যাশবোর্ড থেকে সরাসরি নতুন প্রোডাক্ট অ্যাড করার API (ImgBB + ডেমো পিক + আলাদা লিংক)
app.post('/api/user/products/add', async (req, res) => {
  try {
    const { botId, name, price, regular_price, category, description, buy_link, image_url, demo_images } = req.body;
    
    let finalImgUrl = image_url || '';
    if (finalImgUrl && finalImgUrl.startsWith('data:image')) {
      finalImgUrl = await uploadToImgBB(finalImgUrl);
    }

    const botRow = await pool.query('SELECT subdomain FROM whatsapp_bots WHERE id = $1', [botId]);
    const sub = botRow.rows[0]?.subdomain || 'shop';

    const inserted = await pool.query(
      `INSERT INTO bot_products (bot_id, name, price, regular_price, category, description, buy_link, image_url, demo_images)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [botId, name, parseFloat(price) || 0, parseFloat(regular_price) || null, category || 'General', description || '', buy_link || '', finalImgUrl, demo_images || '']
    );

    const prodId = inserted.rows[0].id;
    const singleProdUrl = `https://${sub}.sojib.de5.net/p/${prodId}`;
    await pool.query('UPDATE bot_products SET buy_link = COALESCE(NULLIF($1, \'\'), $2) WHERE id = $3', [buy_link, singleProdUrl, prodId]);

    addBotLog(botId, 'success', `📦 নতুন পণ্য যোগ হয়েছে: ${name} (বর্তমান: ৳${price}, লিংক: /p/${prodId})`);
    res.json({ success: true, message: 'প্রোডাক্ট সফলভাবে যুক্ত হয়েছে!', product_url: singleProdUrl });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ✏️ প্রোডাক্ট এডিট/আপডেট API
app.post('/api/user/products/update', async (req, res) => {
  try {
    const { botId, productId, name, price, regular_price, category, description, buy_link, image_url, demo_images } = req.body;
    
    let finalImgUrl = image_url || '';
    if (finalImgUrl && finalImgUrl.startsWith('data:image')) {
      finalImgUrl = await uploadToImgBB(finalImgUrl);
    }

    await pool.query(
      `UPDATE bot_products 
       SET name = $1, price = $2, regular_price = $3, category = $4, description = $5, 
           buy_link = COALESCE(NULLIF($6, ''), buy_link),
           image_url = COALESCE(NULLIF($7, ''), image_url),
           demo_images = COALESCE(NULLIF($8, ''), demo_images)
       WHERE id = $9 AND bot_id = $10`,
      [name, parseFloat(price) || 0, parseFloat(regular_price) || null, category, description, buy_link, finalImgUrl, demo_images || '', productId, botId]
    );

    addBotLog(botId, 'success', `✏️ পণ্য আপডেট সম্পন্ন: ${name}`);
    res.json({ success: true, message: '✅ পণ্য সফলভাবে আপডেট হয়েছে!' });
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

// 🔑 অ্যাডমিন থেকে নির্দিষ্ট ইউজার/বটের জন্য আলাদা ডেডিকেটেড Gemini ও ImgBB Key অ্যাসাইন করা
app.post('/api/admin/assign-bot-keys', async (req, res) => {
  try {
    const { botId, geminiKey, imgbbKey } = req.body;
    await pool.query(
      `UPDATE whatsapp_bots 
       SET gemini_api_key = COALESCE(NULLIF($1, ''), gemini_api_key),
           imgbb_api_key = COALESCE(NULLIF($2, ''), imgbb_api_key)
       WHERE id = $3`,
      [geminiKey ? geminiKey.trim() : null, imgbbKey ? imgbbKey.trim() : null, botId]
    );

    addBotLog(botId, 'success', `👑 অ্যাডমিন এই বটের জন্য ডেডিকেটেড এআই ও ইমেজ কী অ্যাসাইন করেছেন!`);
    res.json({ success: true, message: '✅ ইউজারটির জন্য ডেডিকেটেড কী সফলভাবে সেট করা হয়েছে!' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
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
    await pool.query('ALTER TABLE whatsapp_bots ADD COLUMN IF NOT EXISTS knowledge_source VARCHAR(30) DEFAULT \'catalog\';');
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
      ALTER TABLE store_catalog_items ADD COLUMN IF NOT EXISTS demo_images TEXT;
      ALTER TABLE bot_products ADD COLUMN IF NOT EXISTS image_url TEXT;
      ALTER TABLE bot_products ADD COLUMN IF NOT EXISTS regular_price NUMERIC(10, 2);
      ALTER TABLE bot_products ADD COLUMN IF NOT EXISTS demo_images TEXT;
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

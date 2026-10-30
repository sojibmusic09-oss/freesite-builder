/**
 * TechXZone AI Engine — 100% Untouched & Verbatim
 * Models: gemini-3.5-flash, gemini-2.5-flash, gemini-3.1-flash-lite, gemini-3.6-flash, gemini-3.8-flash
 */

const { GoogleGenAI } = require('@google/genai');

// ================= ২. API KEYS ও টোকেন ট্র্যাকিং ইঞ্জিন =================
let geminiApiKeys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
  .split(/[\n,]+/)
  .map(k => k.trim())
  .filter(k => /^[\x20-\x7E]+$/.test(k) && k.length > 20); // বাংলা বা ভুল অক্ষর ফিল্টার

let currentApiKeyIndex = 0;
function getActiveGenAIClient() {
  if (geminiApiKeys.length === 0) return null;
  const key = geminiApiKeys[currentApiKeyIndex % geminiApiKeys.length];
  return new GoogleGenAI({ apiKey: key });
}

function rotateToNextApiKey() {
  if (geminiApiKeys.length > 1) {
    currentApiKeyIndex = (currentApiKeyIndex + 1) % geminiApiKeys.length;
    console.log(`[INFO]: Switched to Gemini API Key #${currentApiKeyIndex + 1}`);
  }
}

function getDhakaDateString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
}

const tokenStats = {
  totalTokensUsed: 0,
  requestsToday: 0,
  todayDate: getDhakaDateString()
};

function trackTokenUsage(tokens = 0) {
  const currentDate = getDhakaDateString();
  if (tokenStats.todayDate !== currentDate) {
    tokenStats.totalTokensUsed = 0;
    tokenStats.requestsToday = 0;
    tokenStats.todayDate = currentDate;
  }
  tokenStats.totalTokensUsed += Number(tokens) || 0;
  tokenStats.requestsToday += 1;
}

// আপনার সিস্টেমের সচল মডেল তালিকা
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const GEMINI_FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-2.5-flash,gemini-3.1-flash-lite,gemini-3.6-flash,gemini-3.8-flash')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean);

// ================= ৫. বাজেট ও ক্যাটাগরি সার্চ ইঞ্জিন =================
function parseBudgetFromText(text) {
  const bnDigits = {'০':'0','১':'1','২':'2','৩':'3','৪':'4','৫':'5','৬':'6','৭':'7','৮':'8','৯':'9'};
  const normalized = text.replace(/[০-৯]/g, d => bnDigits[d]);
  const rangeMatch = normalized.match(/(\d+)\s*(?:থেকে|to|-)\s*(\d+)/i);
  if (rangeMatch) return { min: parseInt(rangeMatch[1], 10), max: parseInt(rangeMatch[2], 10) };

  const maxMatch = normalized.match(/(?:বাজেট|budget|টাকার মধ্যে|টাকার নিচে|টাকার ভেতর|টাকার ভিতর|er moddhe|er niche|er vitor|under|moddhe|dam|দাম)\s*:?\s*(\d+)/i) ||
                   normalized.match(/(\d+)\s*(?:টাকা|টাকার|tk)?\s*(?:এর মধ্যে|এর নিচে|এর ভেতর|এর ভিতর|er moddhe|er vitor|moddhe|er)/i);
  if (maxMatch) return { min: 0, max: parseInt(maxMatch[1], 10) };
  return null;
}

function searchSmartProducts(query, cachedCatalog = []) {
  if (!cachedCatalog || cachedCatalog.length === 0) return { type: 'empty', items: [] };
  const q = query.toLowerCase().trim();
  const budget = parseBudgetFromText(q);

  const categoryKeywords = {
    fan: ['fan', 'ফ্যান', 'বাতাস', 'টেবিল ফ্যান', 'হাত ফ্যান', 'মিনি ফ্যান', 'নেক ফ্যান', 'neck fan'],
    watch: ['watch', 'ঘড়ি', 'ঘড়ি', 'স্মার্টওয়াচ', 'smartwatch', 'smart watch', 't900', 'ultra', 'হাতের ঘড়ি'],
    headphone: ['headphone', 'headset', 'earphone', 'airpod', 'earbuds', 'হেডফোন', 'ইয়ারফোন', 'টিডব্লিউএস', 'tws', 'wireless'],
    light: ['light', 'লাইট', 'ল্যাম্প', 'bulb', 'বাতি'],
    speaker: ['speaker', 'স্পিকার', 'সাউন্ড', 'bluetooth speaker'],
    charger: ['charger', 'চার্জার', 'cable', 'ক্যাবল', 'power bank', 'পাওয়ার ব্যাংক'],
    ups: ['ups', 'ইউপিএস', 'mini ups', 'router ups', 'মিনি ইউপিএস', 'রাউটার ইউপিএস']
  };

  let matchedCategory = null;
  for (const [catKey, aliases] of Object.entries(categoryKeywords)) {
    if (aliases.some(alias => q.includes(alias))) {
      matchedCategory = catKey;
      break;
    }
  }

  if (matchedCategory && budget) {
    const aliases = categoryKeywords[matchedCategory];
    const allCategoryItems = cachedCatalog.filter(p => {
      const name = p.name.toLowerCase();
      const cat = p.category.toLowerCase();
      const desc = p.description.toLowerCase();
      return aliases.some(a => name.includes(a) || cat.includes(a) || desc.includes(a));
    });

    const budgetCategoryItems = allCategoryItems.filter(p => {
      if (budget.min > 0 && p.price < budget.min) return false;
      return p.price <= budget.max;
    });

    budgetCategoryItems.sort((a, b) => b.price - a.price);

    return {
      type: 'category_budget',
      category: matchedCategory,
      budget: budget,
      items: budgetCategoryItems,
      allCategoryItems: allCategoryItems
    };
  }

  if (matchedCategory && !budget) {
    const aliases = categoryKeywords[matchedCategory];
    const catItems = cachedCatalog.filter(p => {
      const name = p.name.toLowerCase();
      const cat = p.category.toLowerCase();
      const desc = p.description.toLowerCase();
      return aliases.some(a => name.includes(a) || cat.includes(a) || desc.includes(a));
    });
    return { type: 'category', keyword: matchedCategory, items: catItems };
  }

  if (budget && !matchedCategory) {
    const budgetItems = cachedCatalog.filter(p => {
      if (budget.min > 0 && p.price < budget.min) return false;
      return p.price <= budget.max;
    });
    budgetItems.sort((a, b) => b.price - a.price);
    return { type: 'budget', budget, items: budgetItems.slice(0, 10) };
  }

  const tokens = q.split(/\s+/).filter(t => t.length > 1);
  const scored = cachedCatalog.map(p => {
    let score = 0;
    const nameLower = p.name.toLowerCase();
    if (nameLower === q) score += 100;
    if (nameLower.includes(q)) score += 50;
    tokens.forEach(tok => { if (nameLower.includes(tok)) score += 20; });
    return { product: p, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter(s => s.score > 0).slice(0, 5).map(s => s.product);
  return { type: 'general', items: top.length > 0 ? top : cachedCatalog.slice(0, 5) };
}

// ================= ৯. ভয়েস অডিও প্রসেসর (Gemini 3.5 Flash) =================
async function transcribeAudioWithGemini(audioBuffer, mimeType = 'audio/ogg') {
  if (geminiApiKeys.length === 0) return '';
  const voiceModels = ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.6-flash', 'gemini-3.8-flash'];
  const cleanMime = (mimeType || 'audio/ogg').split(';')[0].trim();
  const audioPart = {
    inlineData: {
      data: audioBuffer.toString('base64'),
      mimeType: cleanMime
    }
  };
  const prompt = 'এই ভয়েস মেসেজে গ্রাহক কী বলেছেন তা হুবহু বাংলায় বা ইংরেজিতে শুধু টেক্সট আকারে লিখুন। অতিরিক্ত কোনো ব্যাখ্যা লিখবেন না।';

  for (let attempt = 0; attempt < geminiApiKeys.length; attempt++) {
    const client = getActiveGenAIClient();
    if (!client) break;

    for (const modelId of voiceModels) {
      try {
        const response = await client.models.generateContent({
          model: modelId,
          contents: [audioPart, prompt],
          config: {
            temperature: 0.1,
            maxOutputTokens: 200,
            thinkingConfig: { thinkingBudget: 0 }
          }
        });

        const tokens = response.usageMetadata?.totalTokenCount || 0;
        if (tokens > 0) trackTokenUsage(tokens);

        const text = response.text?.trim() || response.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        if (text) {
          console.log(`[INFO]: Voice transcribed via [${modelId}]: "${text}" (Tokens: ${tokens})`);
          return text;
        }
      } catch (err) {
        console.log(`[WARN]: Voice transcribe failed on [${modelId}]: ${err.message}`);
      }
    }
    rotateToNextApiKey();
  }
  return '';
}

// ================= ১০. সুপার ফাস্ট এআই জেনারেটর (দেরি পুরোপুরি বন্ধ) =================
async function callGeminiUltraFast(prompt, systemInstruction, imageBuffer = null, imageMime = 'image/jpeg', deviceId = null) {
  if (geminiApiKeys.length === 0) throw new Error('GEMINI_API_KEY Missing');

  const models = [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS];
  const contents = [];
  if (imageBuffer) {
    contents.push({
      inlineData: {
        data: imageBuffer.toString('base64'),
        mimeType: imageMime.split(';')[0].trim()
      }
    });
  }
  contents.push(prompt);

  // সর্বোচ্চ ২টি কি-তে ট্রাই করবে, অহেতুক লুপ করে সময় নষ্ট করবে না
  for (let attempt = 0; attempt < Math.min(geminiApiKeys.length, 2); attempt++) {
    const client = getActiveGenAIClient();
    if (!client) break;

    for (const modelId of models) {
      try {
        const start = Date.now();
        const response = await client.models.generateContent({
          model: modelId,
          contents: contents,
          config: {
            systemInstruction: systemInstruction,
            temperature: 0.35,
            maxOutputTokens: 1200,
            thinkingConfig: { thinkingBudget: 0 } // সরাসরি উত্তর
          }
        });

        const text = response.text?.trim() || response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text) {
          const usedTokens = response.usageMetadata?.totalTokenCount || 0;
          trackTokenUsage(usedTokens);

          console.log(`[INFO]: ⚡ AI Replied in ${Date.now() - start}ms [${modelId}] (Tokens: ${usedTokens})`);
          return text;
        }
      } catch (err) {
        const errMsg = err.message || '';

        // যদি কোটা লিমিট (429) হয় কেবল তখনই অন্য কি-তে যাবে
        if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED')) {
          rotateToNextApiKey();
          break;
        }
        // 503 (High Demand) আসলে কি না ঘুরিয়ে সরাসরি পরবর্তী সচল মডেলে ১ সেকেন্ডে চলে যাবে
      }
    }
  }

  throw new Error('All AI Models are currently busy.');
}

module.exports = {
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
};

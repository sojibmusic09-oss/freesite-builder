/**
 * FreeSite SaaS — AI-Powered Smart Website Knowledge Engine
 * Uses Google Gemini AI to accurately analyze any Tournament, Shop, or Service Website
 */

const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

function isSafeUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const hostname = parsed.hostname.toLowerCase();
    if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(hostname)) return false;
    if (hostname.startsWith('192.168.') || hostname.startsWith('10.') || hostname.endsWith('.local')) return false;
    return true;
  } catch (e) {
    return false;
  }
}

async function analyzeAndExtractWebsiteKnowledge(siteUrl, customApiKey = null) {
  if (!siteUrl || !isSafeUrl(siteUrl)) {
    return {
      businessType: 'সাধারণ প্ল্যাটফর্ম',
      title: 'আমাদের ওয়েবসাইট',
      description: 'অফিসিয়াল সার্ভিস ও সাপোর্ট প্ল্যাটফর্ম।',
      products: []
    };
  }

  try {
    // ১. ওয়েবসাইটের আসল কন্টেন্ট সংগ্রহ
    const response = await axios.get(siteUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });

    const html = String(response.data || '');

    // অপ্রয়োজনীয় স্ক্রিপ্ট ও স্টাইল ফেলে দিয়ে পরিচ্ছন্ন টেক্সট নেওয়া
    const cleanText = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 4000); // প্রথম ৪০০০ অক্ষর

    // ২. জেমিনি এআই দিয়ে ওয়েবসাইটের আসল চরিত্র ও তথ্য বিশ্লেষণ
    const apiKey = customApiKey || process.env.GEMINI_API_KEY || (process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(',')[0].trim() : '');
    
    if (apiKey) {
      const client = new GoogleGenAI({ apiKey });
      const prompt = `তুমি একজন এক্সপার্ট ওয়েবসাইট অ্যানালাইজার। নিচে একটি ওয়েবসাইটের আসল টেক্সট দেওয়া হলো:
"${cleanText}"

এই ওয়েবসাইটটি পুঙ্খানুপুঙ্খ বিশ্লেষণ করে শুধুমাত্র একটি বৈধ JSON অবজেক্ট দাও (কোনো অতিরিক্ত ব্যাখ্যা বা মার্কডাউন ছাড়া):
{
  "businessType": "ওয়েবসাইটের সুনির্দিষ্ট ক্যাটাগরি (যেমন: ইস্পোর্টস গেমিং টুর্নামেন্ট, ডায়মন্ড টপ-আপ, সফটওয়্যার, রেস্টুরেন্ট, ইত্যাদি)",
  "title": "ওয়েবসাইট বা ব্র্যান্ডের আসল নাম",
  "description": "এই সাইটের মূল উদ্দেশ্য, অফার, টুর্নামেন্ট নিয়মাবলী বা ফি বিস্তারিত বাংলায় ৩-৪ বাক্যে লেখো",
  "items": [
    {"name": "পণ্য/সার্ভিস/টুর্নামেন্টের নাম", "price": 0, "description": "সংক্ষিপ্ত নিয়ম বা বিবরণ", "buy_link": "${siteUrl}"}
  ]
}`;

      const aiRes = await client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [prompt],
        config: { temperature: 0.2 }
      });

      let aiRaw = aiRes.text || aiRes.candidates?.[0]?.content?.parts?.[0]?.text || '';
      aiRaw = aiRaw.replace(/```json/gi, '').replace(/```/g, '').trim();

      const parsed = JSON.parse(aiRaw);
      return {
        businessType: parsed.businessType || 'অনলাইন সার্ভিস',
        title: parsed.title || 'Official Site',
        description: parsed.description || 'আমাদের প্ল্যাটফর্মে স্বাগতম।',
        products: Array.isArray(parsed.items) ? parsed.items : []
      };
    }
  } catch (err) {
    console.error('[AI ANALYZER ERROR]:', err.message);
  }

  return {
    businessType: 'অনলাইন প্ল্যাটফর্ম',
    title: 'Official Platform',
    description: 'আমাদের ওয়েবসাইট থেকে প্রয়োজনীয় সেবা গ্রহণ করতে পারেন।',
    products: []
  };
}

module.exports = {
  analyzeAndExtractWebsiteKnowledge
};

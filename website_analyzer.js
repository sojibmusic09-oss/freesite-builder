/**
 * FreeSite SaaS — Smart Website Knowledge Engine
 * Analyzes Website Content, Products, Prices & Business Type with SSRF Protection
 */

const axios = require('axios');

// প্রাইভেট আইপি ব্লক (SSRF Protection)
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

async function analyzeAndExtractWebsiteKnowledge(siteUrl) {
  if (!siteUrl || !isSafeUrl(siteUrl)) {
    return {
      businessType: 'General Store',
      title: 'Our Online Store',
      description: 'Online services and shopping',
      products: []
    };
  }

  try {
    const response = await axios.get(siteUrl, {
      timeout: 9000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FreeSiteBotAnalyzer/2.0'
      }
    });

    const html = String(response.data || '');

    // ১. সাইটের টাইটেল ও ডেসক্রিপশন উদ্ধার
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const siteTitle = titleMatch ? titleMatch[1].trim() : 'Shop';

    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
                      html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
    const siteDesc = descMatch ? descMatch[1].trim() : 'We provide high-quality products and customer service.';

    // ২. ব্যবসার ধরন নির্ধারণ (Business Category Detection)
    let detectedCategory = 'সাধারণ ই-কমার্স শপ';
    const lowerHtml = html.toLowerCase();
    if (lowerHtml.includes('gadget') || lowerHtml.includes('electronic') || lowerHtml.includes('phone') || lowerHtml.includes('headphone')) {
      detectedCategory = 'ইলেকট্রনিক্স ও গ্যাজেট শপ';
    } else if (lowerHtml.includes('cloth') || lowerHtml.includes('fashion') || lowerHtml.includes('dress') || lowerHtml.includes('শাড়ি') || lowerHtml.includes('পাঞ্জাবি')) {
      detectedCategory = 'ফ্যাশন ও ক্লোথিং শপ';
    } else if (lowerHtml.includes('food') || lowerHtml.includes('restaurant') || lowerHtml.includes('বার্গার') || lowerHtml.includes('রেস্টুরেন্ট')) {
      detectedCategory = 'রেস্টুরেন্ট ও ফুড শপ';
    } else if (lowerHtml.includes('cosmetic') || lowerHtml.includes('beauty') || lowerHtml.includes('skincare')) {
      detectedCategory = 'বিউটি ও স্কিনকেয়ার শপ';
    }

    // ৩. প্রোডাক্ট ও দাম উদ্ধার (Regex & Schema Data)
    const extractedProducts = [];
    
    // JSON-LD Schema থেকে পণ্য সন্ধান
    const jsonLdMatches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    for (const match of jsonLdMatches) {
      try {
        const parsed = JSON.parse(match[1]);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (item['@type'] === 'Product') {
            extractedProducts.push({
              name: String(item.name || '').substring(0, 100),
              price: parseFloat(item.offers?.price || item.price || 0),
              category: detectedCategory,
              description: String(item.description || '').substring(0, 150),
              buy_link: siteUrl
            });
          }
        }
      } catch (e) {}
    }

    // যদি Schema না পায়, সাধারণ HTML প্যাটার্ন থেকে সার্চ
    if (extractedProducts.length === 0) {
      const priceMatches = html.matchAll(/([^<\n]{4,60})[\s\S]{1,50}?(?:৳|Tk|BDT|\$)\s*([\d,]+)/gi);
      let count = 0;
      for (const m of priceMatches) {
        if (count >= 15) break;
        const nameClean = m[1].replace(/<[^>]*>/g, '').trim();
        const priceClean = parseFloat(m[2].replace(/,/g, ''));
        if (nameClean.length > 3 && priceClean > 0 && !nameClean.toLowerCase().includes('total')) {
          extractedProducts.push({
            name: nameClean.substring(0, 100),
            price: priceClean,
            category: detectedCategory,
            description: `${siteTitle}-এর অফিসিয়াল পণ্য।`,
            buy_link: siteUrl
          });
          count++;
        }
      }
    }

    return {
      businessType: detectedCategory,
      title: siteTitle,
      description: siteDesc,
      products: extractedProducts
    };

  } catch (err) {
    return {
      businessType: 'অনলাইন শপ',
      title: 'Online Shop',
      description: 'অফিসিয়াল কাস্টমার সাপোর্ট সার্ভিস।',
      products: []
    };
  }
}

module.exports = {
  analyzeAndExtractWebsiteKnowledge
};

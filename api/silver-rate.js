// Vercel serverless function — runs server-side, no CORS issues.
// Scrapes the Goodreturns Hyderabad silver page, extracts the per-gram rate,
// caches the result for 30 minutes, and returns JSON.
//
// GET /api/silver-rate -> { price: 235, currency: "INR", unit: "g", city: "Hyderabad", asOf: "...", source: "goodreturns.in" }

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const FETCH_TIMEOUT_MS = 10 * 1000;

let memoryCache = {
  price: null,
  asOf: null,
  fetchedAt: 0,
};

// Same shape, persisted to /tmp so warm invocations across containers share it.
const fs = require('fs');
const CACHE_FILE = '/tmp/silver-rate-cache.json';

function loadDiskCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.price === 'number' && typeof parsed.fetchedAt === 'number') {
      memoryCache = parsed;
    }
  } catch (_) { /* ignore */ }
}

function saveDiskCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(memoryCache));
  } catch (_) { /* ignore */ }
}

function isCacheFresh() {
  return memoryCache.price != null && (Date.now() - memoryCache.fetchedAt) < CACHE_TTL_MS;
}

// Strip commas, rupee signs, currency labels, surrounding whitespace.
function parsePrice(text) {
  if (!text) return null;
  // The intro on goodreturns.in is "&#x20b9;235" — the HTML entity for the rupee
  // sign contains "20" before "b9", which would mislead a naive digit extractor.
  // Decode common rupee forms and any HTML entity first.
  let cleaned = String(text)
    .replace(/&#x20b9;?/gi, '')
    .replace(/&#8377;?/g, '')
    .replace(/[₹$]/g, '')
    .replace(/Rs\.?/gi, '')
    .replace(/,/g, '')
    .trim();
  const n = parseFloat(cleaned);
  return isFinite(n) && n > 0 ? n : null;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function scrapeGoodreturns() {
  // Hyderabad page: intro says "price of silver in Hyderabad today is ₹235 per gram"
  const url = 'https://www.goodreturns.in/silver-rates/hyderabad.html';
  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-IN,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`Goodreturns responded ${res.status}`);
  const html = await res.text();

  // Strategy 1: JS state — currentSilverPrice = 235 (clean integer, most reliable)
  const jsState = html.match(/currentSilverPrice\s*=\s*([0-9]+(?:\.[0-9]+)?)/);
  if (jsState) {
    const n = parseFloat(jsState[1]);
    if (isFinite(n) && n > 0) return n;
  }

  // Strategy 2: the intro paragraph — handles both "&#x20b9;235" and "₹235" forms.
  const intro = html.match(/price of silver in Hyderabad today is\s*(?:<[^>]+>)?\s*([^\s<]+)/i)
             || html.match(/price of silver in India today is\s*(?:<[^>]+>)?\s*([^\s<]+)/i);
  if (intro) {
    const n = parsePrice(intro[1]);
    if (n) return n;
  }

  // Strategy 3: the national silver page as a last resort
  const fallback = await fetchWithTimeout('https://www.goodreturns.in/silver-rates/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html',
    },
  });
  if (!fallback.ok) throw new Error('Goodreturns fallback also failed');
  const fallbackHtml = await fallback.text();
  const js2 = fallbackHtml.match(/currentSilverPrice\s*=\s*([0-9]+(?:\.[0-9]+)?)/);
  if (js2) {
    const n = parseFloat(js2[1]);
    if (isFinite(n) && n > 0) return n;
  }
  const intro2 = fallbackHtml.match(/price of silver in India today is\s*(?:<[^>]+>)?\s*([^\s<]+)/i);
  if (intro2) {
    const n = parsePrice(intro2[1]);
    if (n) return n;
  }

  throw new Error('Could not parse silver rate from Goodreturns');
}

module.exports = async function handler(req, res) {
  // Light CORS so the API is reusable from anywhere; same-origin still works.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  loadDiskCache();

  if (!isCacheFresh()) {
    try {
      const price = await scrapeGoodreturns();
      memoryCache = {
        price,
        asOf: new Date().toISOString(),
        fetchedAt: Date.now(),
      };
      saveDiskCache();
    } catch (err) {
      // If we have a stale cache, serve it but mark it as stale.
      if (memoryCache.price != null) {
        res.status(200).json({
          price: memoryCache.price,
          currency: 'INR',
          unit: 'g',
          city: 'Hyderabad',
          asOf: memoryCache.asOf,
          source: 'goodreturns.in (stale cache)',
          stale: true,
          error: String(err && err.message || err),
        });
        return;
      }
      res.status(502).json({
        error: 'Could not fetch silver rate',
        detail: String(err && err.message || err),
      });
      return;
    }
  }

  res.status(200).json({
    price: memoryCache.price,
    currency: 'INR',
    unit: 'g',
    city: 'Hyderabad',
    asOf: memoryCache.asOf,
    source: 'goodreturns.in',
  });
};

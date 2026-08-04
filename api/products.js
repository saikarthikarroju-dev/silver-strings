// Vercel serverless function — source of truth for product data.
// Mirrors api/silver-rate.js shape: CommonJS, CORS, /tmp read-through cache.
//
// GET  /api/products            -> 200 { products: <JSON> } | 404 if file missing
// POST /api/products            -> validates password + body, then commits the
//                                  new JSON to GitHub Contents API which triggers
//                                  a Vercel redeploy. /tmp is updated so warm
//                                  reads see the new content immediately.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = '/tmp/products-cache.json';
const SHA_CACHE_FILE = '/tmp/products-sha-cache.json';
const SHA_CACHE_TTL_MS = 60 * 1000; // 1 minute
const FETCH_TIMEOUT_MS = 10 * 1000;

const PAGE_SLUGS = ['home', 'pens', 'frames', 'stands'];

// ---------------- helpers ----------------

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-password');
}

function readDiskCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function writeDiskCache(products) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(products));
  } catch (_) { /* /tmp may be read-only in some environments; non-fatal */ }
}

function readShaCache() {
  try {
    if (!fs.existsSync(SHA_CACHE_FILE)) return null;
    const raw = fs.readFileSync(SHA_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.sha || !parsed.ts) return null;
    if (Date.now() - parsed.ts > SHA_CACHE_TTL_MS) return null;
    return parsed.sha;
  } catch (_) {
    return null;
  }
}

function writeShaCache(sha) {
  try {
    fs.writeFileSync(SHA_CACHE_FILE, JSON.stringify({ sha, ts: Date.now() }));
  } catch (_) { /* non-fatal */ }
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

// Constant-time string comparison; pads the shorter one so length differences
// don't leak via timing.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  const len = Math.max(ab.length, bb.length, 1);
  const ap = Buffer.alloc(len);
  const bp = Buffer.alloc(len);
  ab.copy(ap);
  bb.copy(bp);
  return crypto.timingSafeEqual(ap, bp);
}

// ---------------- body validation ----------------

function fail(res, status, error, extra) {
  res.status(status).json({ error, ...(extra || {}) });
}

function validateProducts(products) {
  if (!products || typeof products !== 'object') {
    return { ok: false, field: 'products', detail: 'must be an object' };
  }
  if (products.version !== 1) {
    return { ok: false, field: 'version', detail: 'must be 1' };
  }
  if (!products.pages || typeof products.pages !== 'object') {
    return { ok: false, field: 'pages', detail: 'must be an object' };
  }
  for (const slug of PAGE_SLUGS) {
    const page = products.pages[slug];
    if (!page || typeof page !== 'object') {
      return { ok: false, field: `pages.${slug}`, detail: 'must be an object' };
    }
    if (page.slug !== slug) {
      return { ok: false, field: `pages.${slug}.slug`, detail: `must equal "${slug}"` };
    }
    if (typeof page.whatsappPhone !== 'string' || !/^\d{8,15}$/.test(page.whatsappPhone)) {
      return { ok: false, field: `pages.${slug}.whatsappPhone`, detail: 'must be 8–15 digits' };
    }
    if (!Array.isArray(page.products) || page.products.length < 1 || page.products.length > 10) {
      return { ok: false, field: `pages.${slug}.products`, detail: 'must be an array of 1–10 products' };
    }
    for (let i = 0; i < page.products.length; i++) {
      const p = page.products[i];
      const base = `pages.${slug}.products[${i}]`;
      if (!p || typeof p !== 'object') {
        return { ok: false, field: base, detail: 'must be an object' };
      }
      if (typeof p.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(p.id)) {
        return { ok: false, field: `${base}.id`, detail: 'must match /^[a-z0-9-]{1,32}$/' };
      }
      if (!Number.isInteger(p.order) || p.order < 0 || p.order > 99) {
        return { ok: false, field: `${base}.order`, detail: 'must be an integer 0–99' };
      }
      if (typeof p.title !== 'string' || p.title.length < 1 || p.title.length > 120) {
        return { ok: false, field: `${base}.title`, detail: 'must be a string of length 1–120' };
      }
      if (typeof p.description !== 'string' || p.description.length < 1 || p.description.length > 500) {
        return { ok: false, field: `${base}.description`, detail: 'must be a string of length 1–500' };
      }
      if (typeof p.image !== 'string' || !/^[a-z0-9._-]{1,64}$/i.test(p.image)) {
        return { ok: false, field: `${base}.image`, detail: 'must be a filename (no path)' };
      }
      if (typeof p.imageAlt !== 'string' || p.imageAlt.length < 1 || p.imageAlt.length > 120) {
        return { ok: false, field: `${base}.imageAlt`, detail: 'must be a string of length 1–120' };
      }
      if (typeof p.weight !== 'number' || !isFinite(p.weight) || p.weight <= 0 || p.weight > 5000) {
        return { ok: false, field: `${base}.weight`, detail: 'must be > 0 and ≤ 5000' };
      }
      if (typeof p.makingCharge !== 'number' || !isFinite(p.makingCharge) || p.makingCharge < 0 || p.makingCharge > 1_000_000) {
        return { ok: false, field: `${base}.makingCharge`, detail: 'must be ≥ 0 and ≤ 1,000,000' };
      }
      if (typeof p.tag !== 'string' || p.tag.length > 32) {
        return { ok: false, field: `${base}.tag`, detail: 'must be a string of length ≤ 32' };
      }
    }
  }
  return { ok: true };
}

// ---------------- GitHub Contents API ----------------

async function getRemoteSha(repo, branch, pat) {
  const cached = readShaCache();
  if (cached) return cached;
  const url = `https://api.github.com/repos/${repo}/contents/data/products.json?ref=${encodeURIComponent(branch)}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from('x-access-token:' + pat).toString('base64'),
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'silver-strings-admin',
    },
  });
  if (res.status === 404) {
    // File doesn't exist on the branch yet — Contents API treats that as a
    // create, not an update. Return null so the PUT omits `sha`.
    return null;
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GitHub GET sha failed: ${res.status} ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.sha) throw new Error('GitHub GET sha response missing sha');
  writeShaCache(data.sha);
  return data.sha;
}

async function putToGithub(repo, branch, pat, sha, products) {
  const url = `https://api.github.com/repos/${repo}/contents/data/products.json`;
  const body = {
    message: 'admin: update product data',
    content: Buffer.from(JSON.stringify(products, null, 2), 'utf8').toString('base64'),
    branch,
  };
  if (sha) body.sha = sha; // include only when updating an existing file
  const res = await fetchWithTimeout(url, {
    method: 'PUT',
    headers: {
      'Authorization': 'Basic ' + Buffer.from('x-access-token:' + pat).toString('base64'),
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'silver-strings-admin',
    },
    body: JSON.stringify(body),
  });
  return res;
}

// ---------------- handler ----------------

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // -------- GET --------
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');

    let products = readDiskCache();
    if (!products) {
      try {
        const filePath = path.join(process.cwd(), 'data', 'products.json');
        if (!fs.existsSync(filePath)) {
          return fail(res, 404, 'products-not-found', { detail: 'data/products.json is not present in this deployment.' });
        }
        const raw = fs.readFileSync(filePath, 'utf8');
        products = JSON.parse(raw);
        writeDiskCache(products);
      } catch (err) {
        return fail(res, 500, 'read-failed', { detail: String(err && err.message || err) });
      }
    }

    return res.status(200).json({ products });
  }

  // -------- POST --------
  if (req.method === 'POST') {
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected) {
      return fail(res, 503, 'admin-not-configured', { detail: 'Server is missing ADMIN_PASSWORD env var.' });
    }
    const supplied = req.headers['x-admin-password'];
    if (typeof supplied !== 'string' || !safeEqual(supplied, expected)) {
      return fail(res, 401, 'invalid-password');
    }

    const body = req.body;
    if (!body || typeof body !== 'object') {
      return fail(res, 400, 'invalid-json', { detail: 'Body must be JSON.' });
    }
    const products = body.products;
    const v = validateProducts(products);
    if (!v.ok) {
      return fail(res, 400, 'invalid-body', { field: v.field, detail: v.detail });
    }

    const pat = process.env.GITHUB_PAT;
    const repo = process.env.GITHUB_REPO || 'saikarthikarroju-dev/silver-strings';
    const branch = process.env.GITHUB_BRANCH || 'R5-M5-1.0.0';
    if (!pat) {
      return fail(res, 503, 'persistent-storage-not-configured', {
        detail: 'Server is missing GITHUB_PAT. Contact the site owner.',
      });
    }

    // Attempt the PUT up to 2 times (initial + one retry on 409 to refresh sha).
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const sha = await getRemoteSha(repo, branch, pat);
        const putRes = await putToGithub(repo, branch, pat, sha, products);
        if (putRes.ok) {
          const data = await putRes.json().catch(() => ({}));
          writeDiskCache(products);
          const newSha = data && data.content && data.content.sha;
          if (newSha) {
            writeShaCache(newSha);
          } else {
            // No sha in the response — clear cache so the next read refetches.
            try { fs.unlinkSync(SHA_CACHE_FILE); } catch (_) {}
          }
          return res.status(200).json({
            ok: true,
            sha: newSha,
            version: products.version,
            products,
          });
        }
        if (putRes.status === 409 && attempt === 0) {
          // Concurrent update — drop cached sha and retry once.
          try { fs.unlinkSync(SHA_CACHE_FILE); } catch (_) {}
          lastErr = '409 conflict';
          continue;
        }
        const detail = await putRes.text().catch(() => '');
        return fail(res, 502, 'github-write-failed', {
          status: putRes.status,
          detail: detail.slice(0, 400),
        });
      } catch (err) {
        lastErr = err;
      }
    }
    return fail(res, 502, 'github-write-failed', {
      detail: String(lastErr && lastErr.message || lastErr || 'unknown'),
    });
  }

  // -------- other --------
  res.status(405).json({ error: 'method-not-allowed' });
};

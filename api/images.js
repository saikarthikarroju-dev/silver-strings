// Vercel serverless function — same shape as api/silver-rate.js.
// Lists filenames actually present in /images so admin.html's <select>
// stays in sync without hardcoding.
//
// GET /api/images -> { images: ["images/hero.jpg", "images/p1.jpg", ...] }

const fs = require('fs');
const path = require('path');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method-not-allowed' });
    return;
  }

  try {
    const files = fs.readdirSync(path.join(process.cwd(), 'images'));
    const images = files
      .filter(f => /^[a-z0-9._-]+\.(jpg|jpeg|png|webp)$/i.test(f))
      .sort();
    res.status(200).json({ images: images.map(f => `images/${f}`) });
  } catch (err) {
    res.status(500).json({
      error: 'read-failed',
      detail: String(err && err.message || err),
    });
  }
};

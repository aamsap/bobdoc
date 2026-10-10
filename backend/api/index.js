const express   = require('express');
const rateLimit = require('express-rate-limit');
const pdf       = require('./pdf');
const docx      = require('./docx');

const app = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
// Set headers on every response. Vercel intercepts OPTIONS before Express runs,
// so we also handle it explicitly here for local dev + non-Vercel deployments.
//
// ALLOWED_ORIGINS can be set as a comma-separated env var to restrict to the
// extension's chrome-extension:// origin in production:
//   ALLOWED_ORIGINS=chrome-extension://your-id-here
// Leave unset (or set to *) to allow any origin (useful during development).

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || '*';

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allow  =
    ALLOWED_ORIGINS === '*' ||
    ALLOWED_ORIGINS.split(',').map(s => s.trim()).includes(origin)
      ? origin || '*'
      : '';

  if (allow) {
    res.setHeader('Access-Control-Allow-Origin', allow);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (allow !== '*') res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ── Body parser ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '5mb' })); // tightened from 10 MB

// ── Rate limiting ─────────────────────────────────────────────────────────────
// 30 conversion requests per IP per minute — generous for a human, blocks scripts.
const limiter = rateLimit({
  windowMs:         60 * 1000,
  max:              30,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'Too many requests. Please wait a moment and try again.' },
});

app.use('/api/convert', limiter);

// ── Request timeout ───────────────────────────────────────────────────────────
// Abort any conversion that takes longer than 55 s (Vercel's max is 60 s on Pro).
const CONVERT_TIMEOUT_MS = 55_000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Conversion timed out.')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api', (_req, res) => res.json({ status: 'ok' }));

// ── POST /api/convert/pdf ─────────────────────────────────────────────────────
app.post('/api/convert/pdf', async (req, res) => {
  const { html, title } = req.body;
  if (!html)             return res.status(400).json({ error: 'html is required' });
  if (typeof html !== 'string') return res.status(400).json({ error: 'html must be a string' });

  try {
    const buffer = await withTimeout(
      pdf.convert(html, title || 'document', {
        pageSize: req.body.pageSize,
        font:     req.body.font,
      }),
      CONVERT_TIMEOUT_MS
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitize(title)}.pdf"`);
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error('[pdf]', err.message);
    const status = err.message.includes('timed out') ? 504 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── POST /api/convert/docx ────────────────────────────────────────────────────
app.post('/api/convert/docx', async (req, res) => {
  const { html, title, sourceUrl } = req.body;
  if (!html)             return res.status(400).json({ error: 'html is required' });
  if (typeof html !== 'string') return res.status(400).json({ error: 'html must be a string' });

  try {
    const buffer = await withTimeout(
      docx.convert(html, title || 'document', sourceUrl, {
        pageSize:      req.body.pageSize,
        font:          req.body.font,
        includeImages: req.body.includeImages !== false,
      }),
      CONVERT_TIMEOUT_MS
    );
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitize(title)}.docx"`);
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error('[docx]', err.message);
    const status = err.message.includes('timed out') ? 504 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function sanitize(name) {
  return (name || 'document').replace(/[\\/:*?"<>| ]/g, '_').slice(0, 80);
}

// ── Local dev ─────────────────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
}

module.exports = app;

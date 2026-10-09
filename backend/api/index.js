const express = require('express');
const pdf     = require('./pdf');
const docx    = require('./docx');

const app = express();

// Manually set CORS headers on every response, including OPTIONS preflight.
// app.use(cors()) is not sufficient on Vercel — the serverless runtime intercepts
// OPTIONS before Express middleware runs, so the preflight never gets CORS headers.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Preflight — respond immediately with 204 No Content
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
});

app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/api', (_req, res) => res.json({ status: 'ok' }));

// POST /api/convert/pdf
// Body: { html: string, title: string }
// Returns: application/pdf binary
app.post('/api/convert/pdf', async (req, res) => {
  const { html, title } = req.body;
  if (!html) return res.status(400).json({ error: 'html is required' });

  try {
    const buffer = await pdf.convert(html, title || 'document');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitize(title)}.pdf"`);
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error('[pdf]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/convert/docx
// Body: { html: string, title: string }
// Returns: application/vnd.openxmlformats-officedocument.wordprocessingml.document
app.post('/api/convert/docx', async (req, res) => {
  const { html, title } = req.body;
  if (!html) return res.status(400).json({ error: 'html is required' });

  try {
    const buffer = await docx.convert(html, title || 'document');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitize(title)}.docx"`);
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error('[docx]', err);
    res.status(500).json({ error: err.message });
  }
});

function sanitize(name) {
  return (name || 'document').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

// For local dev
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
}

module.exports = app;

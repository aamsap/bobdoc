/**
 * pdf.js
 * Converts a clean HTML string to a proper text-based PDF using Puppeteer.
 * Uses @sparticuz/chromium-min for Vercel's serverless environment.
 */

// puppeteer-core will be imported dynamically
const https = require('https');
const http  = require('http');

const IMG_MAX_BYTES  = 2 * 1024 * 1024; // 2 MB per image
const IMG_TIMEOUT_MS = 5_000;

// On Vercel use the serverless Chromium binary; locally fall back to a system Chrome
async function getBrowser() {
  const { default: puppeteer } = await import('puppeteer-core');
  const isVercel = !!process.env.VERCEL;

  if (isVercel) {
    process.env.AWS_EXECUTION_ENV = 'AWS_Lambda_nodejs20.x';
    const chromium = require('@sparticuz/chromium-min');
    return puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(
        'https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar'
      ),
      headless: chromium.headless,
    });
  }

  // Local development — use the system Chrome
  const executablePath =
    process.env.CHROME_PATH ||
    (process.platform === 'win32'
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
      : process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : '/usr/bin/google-chrome');

  return puppeteer.launch({
    executablePath,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--block-new-web-contents',         // no popups
      '--disable-web-security',           // needed for data: URIs in local dev
    ],
  });
}

/**
 * @param {string} html       Clean article HTML (from Readability)
 * @param {string} title      Document title
 * @param {object} [opts]     { pageSize?: 'A4'|'Letter', font?: 'sans'|'serif'|'mono' }
 * @returns {Promise<Buffer>} PDF binary buffer
 */
async function convert(html, title, opts = {}) {
  // Fix 4: pre-fetch all external images and inline them as data: URIs so
  // Puppeteer never needs to make outbound network requests. This is critical
  // on Vercel's serverless runtime where egress to image CDNs is unreliable.
  const inlinedHtml = await inlineImages(html);
  const fullHtml    = buildHtml(title, inlinedHtml, opts.font || 'sans');
  const browser     = await getBrowser();

  try {
    const page = await browser.newPage();

    // All images are already inlined as data: URIs — no external network requests
    // will be made, so domcontentloaded is sufficient and avoids the 500 ms idle wait.
    await page.setContent(fullHtml, { waitUntil: 'domcontentloaded' });

    const buffer = await page.pdf({
      format: opts.pageSize === 'Letter' ? 'Letter' : 'A4',
      printBackground: false,
      margin: {
        top:    '25mm',
        bottom: '25mm',
        left:   '22mm',
        right:  '22mm',
      },
      displayHeaderFooter: true,
      headerTemplate: `
        <div style="font-size:9px;color:#aaa;width:100%;text-align:center;padding-top:6px;">
          ${escapeHtml(title)}
        </div>`,
      footerTemplate: `
        <div style="font-size:9px;color:#aaa;width:100%;text-align:center;padding-bottom:6px;">
          <span class="pageNumber"></span> / <span class="totalPages"></span>
        </div>`,
    });

    return buffer;
  } finally {
    await browser.close();
  }
}

// ─── Image inlining ───────────────────────────────────────────────────────────

/**
 * Replace every <img src="https://…"> in the HTML with a data: URI so
 * Puppeteer can render images without any outbound network access.
 * Images that fail to fetch (timeout, 4xx, too large) are silently dropped
 * — the <img> tag is removed rather than showing a broken placeholder.
 */
async function inlineImages(html) {
  // Quick exit if there are no external images
  if (!/<img/i.test(html)) return html;

  // Collect all unique http(s) src values — handle both double and single quotes.
  // Bug 6: original regex only matched double-quoted src attributes.
  const srcRegex = /<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi;
  const srcs     = new Set();
  let match;
  while ((match = srcRegex.exec(html)) !== null) srcs.add(match[1]);
  if (!srcs.size) return html;

  // Fetch all in parallel, cap each at 2 MB / 5 s
  const results = await Promise.all(
    [...srcs].map(async src => {
      try {
        const buf  = await fetchWithLimit(src, IMG_MAX_BYTES, IMG_TIMEOUT_MS);
        const mime = detectMime(buf);
        const b64  = buf.toString('base64');
        return [src, `data:${mime};base64,${b64}`];
      } catch {
        return [src, null]; // will be removed below
      }
    })
  );

  const dataMap = new Map(results);

  // Replace each src — handle both quote styles (Bug 6)
  return html.replace(/<img([^>]+)src=(["'])(https?:\/\/[^"']+)\2([^>]*)>/gi, (full, pre, quote, src, post) => {
    const dataUri = dataMap.get(src);
    if (!dataUri) return ''; // drop broken images entirely
    return `<img${pre}src="${dataUri}"${post}>`;
  });
}

function fetchWithLimit(url, maxBytes, timeoutMs, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const lib   = url.startsWith('https') ? https : http;
    const timer = setTimeout(() => { req.destroy(); reject(new Error('timeout')); }, timeoutMs);
    let received = 0;
    const chunks = [];

    const req = lib.get(url, res => {
      // Follow redirects (301, 302, 303, 307, 308)
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        clearTimeout(timer);
        const location = res.headers['location'];
        if (!location || redirectsLeft <= 0) {
          reject(new Error(`Too many redirects or missing Location for ${url}`));
          return;
        }
        // Resolve relative redirect Location against the original URL
        const next = new URL(location, url).href;
        fetchWithLimit(next, maxBytes, timeoutMs, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.on('data', chunk => {
        received += chunk.length;
        if (received > maxBytes) {
          clearTimeout(timer); res.destroy(); reject(new Error('too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end',   () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
      res.on('error', err => { clearTimeout(timer); reject(err); });
    });
    req.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

function detectMime(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  return 'image/png';
}

const FONT_STACK = {
  sans:  '"Calibri", "Arial", sans-serif',
  serif: '"Georgia", "Times New Roman", serif',
  mono:  '"Courier New", "Courier", monospace',
};

function buildHtml(title, body, font = 'sans') {
  const fontFamily = FONT_STACK[font] || FONT_STACK.sans;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${escapeHtml(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }

    body {
      font-family: ${fontFamily};
      font-size: 11.5pt;
      line-height: 1.75;
      color: #1a1a1a;
      margin: 0;
      padding: 0;
    }

    h1 { font-size: 22pt; margin: 0 0 18px; line-height: 1.25; }
    h2 { font-size: 16pt; margin: 28px 0 10px; border-bottom: 1px solid #e0e0e0; padding-bottom: 4px; }
    h3 { font-size: 13pt; margin: 22px 0 8px; }
    h4, h5, h6 { font-size: 11.5pt; margin: 18px 0 6px; }

    p  { margin: 0 0 12px; }
    a  { color: #1a56db; text-decoration: underline; }

    img {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 16px auto;
      border-radius: 3px;
    }

    ul, ol { margin: 0 0 12px 0; padding-left: 24px; }
    li { margin-bottom: 4px; }

    blockquote {
      margin: 16px 0;
      padding: 10px 16px;
      border-left: 3px solid #c0c0c0;
      color: #555;
      font-style: italic;
    }

    pre {
      background: #f5f5f5;
      padding: 12px 16px;
      border-radius: 4px;
      font-size: 9.5pt;
      overflow-wrap: break-word;
      white-space: pre-wrap;
      margin: 0 0 12px;
    }

    code {
      font-family: "Courier New", monospace;
      font-size: 9.5pt;
      background: #f0f0f0;
      padding: 1px 4px;
      border-radius: 2px;
    }

    pre code { background: none; padding: 0; }

    table {
      width: 100%;
      border-collapse: collapse;
      margin: 16px 0;
      font-size: 10.5pt;
    }

    th, td {
      border: 1px solid #ccc;
      padding: 7px 10px;
      text-align: left;
      vertical-align: top;
    }

    th {
      background: #f5f5f5;
      font-weight: 600;
    }

    figure { margin: 16px 0; }
    figcaption { font-size: 9.5pt; color: #777; text-align: center; margin-top: 6px; }

    hr { border: none; border-top: 1px solid #ddd; margin: 24px 0; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${body}
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { convert };

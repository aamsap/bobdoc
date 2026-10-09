/**
 * pdf.js
 * Converts a clean HTML string to a proper text-based PDF using Puppeteer.
 * Uses @sparticuz/chromium-min for Vercel's serverless environment.
 */

// puppeteer-core will be imported dynamically

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
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
}

/**
 * @param {string} html   Clean article HTML (from Readability)
 * @param {string} title  Document title
 * @returns {Promise<Buffer>} PDF binary buffer
 */
async function convert(html, title) {
  const fullHtml = buildHtml(title, html);
  const browser  = await getBrowser();

  try {
    const page = await browser.newPage();

    await page.setContent(fullHtml, { waitUntil: 'networkidle0' });

    const buffer = await page.pdf({
      format: 'A4',
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

function buildHtml(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${escapeHtml(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }

    body {
      font-family: "Georgia", serif;
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

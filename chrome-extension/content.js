/**
 * content.js
 * Extracts clean article content via Readability, then either:
 *  - POSTs to the backend for DOCX/PDF conversion, or
 *  - Converts in-browser to Markdown or plain text.
 *
 * Phase 3 additions:
 *  - Options forwarded from popup (pageSize, font, includeImages, selectionOnly)
 *  - Export a selection instead of the whole article
 *  - Markdown and plain text export (in-browser, no backend)
 *  - Preview extracted content before downloading
 */

const BACKEND_URL = 'https://bobdoc.vercel.app';

// ─── Content extraction ───────────────────────────────────────────────────────

// ─── Hero image detection ─────────────────────────────────────────────────────
// Returns the absolute URL of the page's hero/featured image, or null if none
// is found or if Readability already included it in the extracted content.

function detectHeroImage(extractedContent) {
  // 1. Try structured meta tags — most reliable, set explicitly by the publisher
  const metaSources = [
    'meta[property="og:image"]',
    'meta[name="twitter:image"]',
    'meta[name="twitter:image:src"]',
    'meta[itemprop="image"]',
  ];
  for (const sel of metaSources) {
    const el  = document.querySelector(sel);
    const url = el && (el.getAttribute('content') || el.getAttribute('src'));
    if (url) {
      const abs = resolveUrl(url);
      if (abs && !extractedContent.includes(abs)) return abs;
    }
  }

  // 2. Try JSON-LD structured data (schema.org Article/BlogPosting)
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(el.textContent);
      const entries = Array.isArray(data) ? data : [data];
      for (const entry of entries) {
        const img = entry.image;
        // image can be: string | ImageObject | Array<string|ImageObject>
        const first = Array.isArray(img) ? img[0] : img;
        const url = typeof first === 'string' ? first
                  : first?.url               ? first.url
                  : null;
        if (url) {
          const abs = resolveUrl(url);
          if (abs && !extractedContent.includes(abs)) return abs;
        }
      }
    } catch { /* malformed JSON-LD — skip */ }
  }

  // 3. Fall back to the first large <img> visible above the fold that
  //    Readability didn't keep (heuristic: width ≥ 400px or no explicit size).
  for (const img of document.querySelectorAll('img')) {
    const src = img.src; // browser resolves this to an absolute URL automatically
    if (!src || src.startsWith('data:')) continue;
    // Skip tiny icons / avatars
    if (img.naturalWidth  > 0 && img.naturalWidth  < 200) continue;
    if (img.naturalHeight > 0 && img.naturalHeight < 100) continue;
    // Skip if already present in Readability's output
    if (extractedContent.includes(src)) continue;
    // Only take images in the upper portion of the page
    const rect = img.getBoundingClientRect();
    if (rect.top > window.innerHeight * 2) continue;
    return src;
  }

  return null;
}

/** Resolve a possibly-relative URL against the current page origin. */
function resolveUrl(url) {
  try {
    return new URL(url, location.href).href;
  } catch {
    return null;
  }
}

/**
 * Walk all <img> tags in an HTML string and replace every src with its
 * absolute equivalent. The browser resolves img.src automatically, so
 * relative, protocol-relative, and absolute URLs all become https://… here.
 *
 * Uses a <template> element (inert, non-rendering) so the browser never
 * fires network requests for the images while we are just resolving URLs.
 */
function resolveImgSrcs(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  for (const img of tpl.content.querySelectorAll('img')) {
    // img.src on an element inside a template fragment returns the absolute URL
    // but the browser never actually loads the image.
    if (img.src) img.setAttribute('src', img.src);
  }
  // Serialize the fragment back to an HTML string via a temporary div
  const div = document.createElement('div');
  div.appendChild(tpl.content.cloneNode(true));
  return div.innerHTML;
}

function extractContent(selectionOnly = false) {
  if (!document.body) throw new UserError('This page has no content to export.');

  // Selection mode: use the highlighted text if the user asked for it
  if (selectionOnly) {
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 10) {
      const range     = sel.getRangeAt(0);
      const container = document.createElement('div');
      container.appendChild(range.cloneContents());
      return {
        title:     document.title || 'Selection',
        content:   container.innerHTML,
        sourceUrl: location.href,
      };
    }
    throw new UserError('No text is selected. Highlight text on the page first, or turn off "Selection only".');
  }

  // Full article mode via Readability
  const docClone = document.cloneNode(true);
  const reader   = new Readability(docClone);

  let article;
  try { article = reader.parse(); } catch {
    throw new UserError('This page could not be parsed. Try an article or blog post.');
  }

  if (!article || !article.content || article.content.trim().length < 50) {
    throw new UserError(
      'No article content found. Bobdoc works best on articles, blog posts, and documentation pages.'
    );
  }

  // Fix 2: resolve every <img src> in the extracted HTML to an absolute URL.
  // Readability preserves relative paths as-is; the backend can't resolve them
  // because it doesn't know the page origin. We use a temporary DOM fragment so
  // the browser does the resolution for us (img.src is always absolute).
  const resolved = resolveImgSrcs(article.content);

  // Prepend the hero image if one exists and Readability didn't include it.
  // We try, in order: og:image → twitter:image → first prominent <img> above
  // the article fold. The browser resolves relative URLs automatically via img.src.
  const heroSrc = detectHeroImage(resolved);
  const content = heroSrc
    // Bug 4: percent-encode any " in the URL so it can't break the src attribute
    ? `<figure class="bobdoc-hero"><img src="${heroSrc.replace(/"/g, '%22')}" alt="Hero image"/></figure>\n${resolved}`
    : resolved;

  return {
    title:     article.title || document.title || 'Document',
    content,
    sourceUrl: location.href,
  };
}

// ─── User-facing error ────────────────────────────────────────────────────────

class UserError extends Error {
  constructor(msg) { super(msg); this.name = 'UserError'; }
}

function friendlyError(err) {
  if (err instanceof UserError) return err.message;
  if (err.message === 'Failed to fetch' || err.name === 'TypeError')
    return 'Could not reach the Bobdoc server. Check your internet connection.';
  if (err.message.toLowerCase().includes('timeout'))
    return 'The conversion timed out. The page may be too large — try a shorter article.';
  if (err.message.includes('413') || err.message.toLowerCase().includes('too large'))
    return 'This page is too large to convert. Try a shorter article.';
  return 'Something went wrong. Please try again.';
}

// ─── Download helper ──────────────────────────────────────────────────────────

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function safeFilename(title, ext) {
  // Bug 3: also replace spaces so client-side filenames (MD, TXT) are
  // consistent with the backend sanitize() which already replaces spaces.
  return (title || 'document').replace(/[\\/:*?"<>| ]/g, '_').slice(0, 80) + '.' + ext;
}

// ─── DOCX export ──────────────────────────────────────────────────────────────

async function exportDocx(options = {}) {
  const { title, content, sourceUrl } = extractContent(options.selectionOnly);

  const res = await fetch(`${BACKEND_URL}/api/convert/docx`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      html:      content,
      title,
      sourceUrl,
      pageSize:  options.pageSize  || 'A4',
      font:      options.font      || 'sans',
      includeImages: options.includeImages !== false,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error ${res.status}`);
  }

  triggerDownload(await res.blob(), safeFilename(title, 'docx'));
}

// ─── PDF export ───────────────────────────────────────────────────────────────

async function exportPdf(options = {}) {
  const { title, content } = extractContent(options.selectionOnly);

  const res = await fetch(`${BACKEND_URL}/api/convert/pdf`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      html:     content,
      title,
      pageSize: options.pageSize || 'A4',
      font:     options.font     || 'sans',
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error ${res.status}`);
  }

  triggerDownload(await res.blob(), safeFilename(title, 'pdf'));
}

// ─── Markdown export (in-browser) ─────────────────────────────────────────────

function htmlToMarkdown(html) {
  // Parse into a DOM fragment and walk it
  const div = document.createElement('div');
  div.innerHTML = html;

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag      = node.tagName.toLowerCase();
    const children = Array.from(node.childNodes).map(walk).join('');

    switch (tag) {
      case 'h1': return `\n\n# ${children.trim()}\n\n`;
      case 'h2': return `\n\n## ${children.trim()}\n\n`;
      case 'h3': return `\n\n### ${children.trim()}\n\n`;
      case 'h4': return `\n\n#### ${children.trim()}\n\n`;
      case 'h5': return `\n\n##### ${children.trim()}\n\n`;
      case 'h6': return `\n\n###### ${children.trim()}\n\n`;
      case 'p':  return `\n\n${children.trim()}\n\n`;
      case 'br': return '  \n';
      case 'hr': return '\n\n---\n\n';
      case 'strong':
      case 'b':  return `**${children}**`;
      case 'em':
      case 'i':  return `_${children}_`;
      case 'code': return `\`${children}\``;
      case 'pre':  return `\n\n\`\`\`\n${node.textContent}\n\`\`\`\n\n`;
      case 'blockquote': return children.split('\n').map(l => `> ${l}`).join('\n');
      case 'a': {
        const href = node.getAttribute('href') || '';
        return href ? `[${children}](${href})` : children;
      }
      case 'img': {
        const src = node.getAttribute('src') || '';
        const alt = node.getAttribute('alt') || '';
        return src ? `![${alt}](${src})` : '';
      }
      case 'ul': {
        return '\n\n' + Array.from(node.querySelectorAll(':scope > li'))
          .map(li => `- ${li.textContent.trim()}`)
          .join('\n') + '\n\n';
      }
      case 'ol': {
        return '\n\n' + Array.from(node.querySelectorAll(':scope > li'))
          .map((li, i) => `${i + 1}. ${li.textContent.trim()}`)
          .join('\n') + '\n\n';
      }
      case 'table': {
        const rows = Array.from(node.querySelectorAll('tr'));
        if (!rows.length) return '';
        const toRow = cells => '| ' + cells.map(c => c.textContent.trim().replace(/\|/g, '\\|')).join(' | ') + ' |';
        const head  = rows[0];
        const headCells = Array.from(head.querySelectorAll('th, td'));
        const sep   = '| ' + headCells.map(() => '---').join(' | ') + ' |';
        const lines = [toRow(headCells), sep];
        rows.slice(1).forEach(r => lines.push(toRow(Array.from(r.querySelectorAll('td, th')))));
        return '\n\n' + lines.join('\n') + '\n\n';
      }
      default: return children;
    }
  }

  return walk(div).replace(/\n{3,}/g, '\n\n').trim();
}

async function exportMd(options = {}) {
  const { title, content } = extractContent(options.selectionOnly);
  const md   = `# ${title}\n\n` + htmlToMarkdown(content);
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  triggerDownload(blob, safeFilename(title, 'md'));
}

// ─── Plain text export (in-browser) ──────────────────────────────────────────

async function exportTxt(options = {}) {
  const { title, content } = extractContent(options.selectionOnly);
  const div = document.createElement('div');
  div.innerHTML = content;
  const text = title + '\n\n' + (div.innerText || div.textContent);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, safeFilename(title, 'txt'));
}

// ─── Preview (returns sanitised HTML snippet) ─────────────────────────────────

function getPreview(options = {}) {
  const { title, content } = extractContent(options.selectionOnly);

  // Truncate to first ~1500 chars of plain text for the preview pane
  const div = document.createElement('div');
  div.innerHTML = content;
  const plain = (div.innerText || div.textContent).slice(0, 800);

  // Return a safe minimal HTML snippet — popup renders this directly
  const escaped = plain
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<strong style="display:block;color:#e0e0e0;margin-bottom:6px;">${
    title.replace(/</g, '&lt;')
  }</strong>${escaped}${plain.length >= 800 ? '<span style="color:#555"> …</span>' : ''}`;
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    const opts = message.options || {};
    try {
      switch (message.action) {
        case 'exportDocx':  await exportDocx(opts); sendResponse({ success: true }); break;
        case 'exportPdf':   await exportPdf(opts);  sendResponse({ success: true }); break;
        case 'exportMd':    await exportMd(opts);   sendResponse({ success: true }); break;
        case 'exportTxt':   await exportTxt(opts);  sendResponse({ success: true }); break;
        case 'getPreview':
          sendResponse({ success: true, html: getPreview(opts) });
          break;
        default:
          sendResponse({ success: false, error: 'Unknown action.' });
      }
    } catch (err) {
      sendResponse({ success: false, error: friendlyError(err) });
    }
  })();

  return true;
});

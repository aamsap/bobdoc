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

  return {
    title:     article.title || document.title || 'Document',
    content:   article.content,
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
  return (title || 'document').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) + '.' + ext;
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

/**
 * content.js
 * Extracts clean article content via Readability, then POSTs it to the
 * backend API for proper DOCX/PDF conversion and triggers a download.
 */

// Backend URL — change this after you deploy to Vercel
const BACKEND_URL = 'https://bobdoc.vercel.app';

// ─── Content extraction ───────────────────────────────────────────────────────

function extractContent() {
  // Readability cannot parse browser internal pages (chrome://, about:, etc.)
  if (!document.body) {
    throw new UserError('This page has no content to export.');
  }

  const docClone = document.cloneNode(true);
  const reader   = new Readability(docClone);

  let article;
  try {
    article = reader.parse();
  } catch {
    throw new UserError('This page could not be parsed. Try an article or blog post.');
  }

  if (!article || !article.content || article.content.trim().length < 50) {
    throw new UserError(
      'No article content found on this page. Bobdoc works best on articles, blog posts, and documentation pages.'
    );
  }

  return {
    title:     article.title || document.title || 'Document',
    content:   article.content,
    sourceUrl: location.href,
  };
}

// ─── User-facing error class ──────────────────────────────────────────────────

class UserError extends Error {
  constructor(msg) { super(msg); this.name = 'UserError'; }
}

function friendlyError(err) {
  if (err instanceof UserError) return err.message;

  // Network / fetch failures
  if (err.message === 'Failed to fetch' || err.name === 'TypeError') {
    return 'Could not reach the Bobdoc server. Check your internet connection.';
  }

  // Timeout from the server
  if (err.message.toLowerCase().includes('timeout')) {
    return 'The conversion timed out. The page may be too large — try a shorter article.';
  }

  // Oversized payload
  if (err.message.includes('413') || err.message.toLowerCase().includes('too large')) {
    return 'This page is too large to convert. Try a shorter article.';
  }

  return 'Something went wrong. Please try again.';
}

// ─── Download trigger ─────────────────────────────────────────────────────────

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function safeFilename(title, ext) {
  return (title || 'document').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) + '.' + ext;
}

// ─── Export functions ─────────────────────────────────────────────────────────

async function exportDocx() {
  const { title, content, sourceUrl } = extractContent();

  const res = await fetch(`${BACKEND_URL}/api/convert/docx`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ html: content, title, sourceUrl }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error ${res.status}`);
  }

  const blob = await res.blob();
  triggerDownload(blob, safeFilename(title, 'docx'));
}

async function exportPdf() {
  const { title, content } = extractContent();

  const res = await fetch(`${BACKEND_URL}/api/convert/pdf`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ html: content, title }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error ${res.status}`);
  }

  const blob = await res.blob();
  triggerDownload(blob, safeFilename(title, 'pdf'));
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message.action === 'exportDocx') {
        await exportDocx();
        sendResponse({ success: true });
      } else if (message.action === 'exportPdf') {
        await exportPdf();
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Unknown action.' });
      }
    } catch (err) {
      sendResponse({ success: false, error: friendlyError(err) });
    }
  })();

  return true; // keep message channel open for async response
});

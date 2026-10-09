/**
 * content.js
 * Extracts clean article content via Readability, then POSTs it to the
 * backend API for proper DOCX/PDF conversion and triggers a download.
 */

// Backend URL — change this after you deploy to Vercel
const BACKEND_URL = 'https://bobdoc.vercel.app';

// ─── Content extraction ───────────────────────────────────────────────────────

function extractContent() {
  const docClone = document.cloneNode(true);
  const reader   = new Readability(docClone);
  const article  = reader.parse();

  if (!article || !article.content) {
    throw new Error('Could not extract readable content from this page.');
  }

  return {
    title:   article.title || document.title || 'Document',
    content: article.content,
  };
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
  const { title, content } = extractContent();

  const res = await fetch(`${BACKEND_URL}/api/convert/docx`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ html: content, title }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Backend error');
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
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Backend error');
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
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // keep message channel open for async response
});

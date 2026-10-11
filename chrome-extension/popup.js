// ── DOM refs ──────────────────────────────────────────────────────────────────
const btnDocx    = document.getElementById('btnDocx');
const btnPdf     = document.getElementById('btnPdf');
const btnMd      = document.getElementById('btnMd');
const btnTxt     = document.getElementById('btnTxt');
const status     = document.getElementById('status');
const previewBox = document.getElementById('previewBox');
const tabExport  = document.getElementById('tabExport');
const tabPreview = document.getElementById('tabPreview');

const optPageSize  = document.getElementById('optPageSize');
const optFont      = document.getElementById('optFont');
const optImages    = document.getElementById('optImages');
const optSelection = document.getElementById('optSelection');

// Snapshot original button HTML for restore-after-loading
const originalHtml = {
  docx: btnDocx.innerHTML,
  pdf:  btnPdf.innerHTML,
  md:   btnMd.innerHTML,
  txt:  btnTxt.innerHTML,
};

const ALL_BTNS = [btnDocx, btnPdf, btnMd, btnTxt];

// ── Persist options via chrome.storage.local ──────────────────────────────────
async function loadOptions() {
  const saved = await chrome.storage.local.get(['pageSize', 'font', 'images', 'selection']);
  if (saved.pageSize)              optPageSize.value  = saved.pageSize;
  if (saved.font)                  optFont.value      = saved.font;
  if (saved.images    !== undefined) optImages.checked    = saved.images;
  if (saved.selection !== undefined) optSelection.checked = saved.selection; // Bug 2
}

function saveOptions() {
  chrome.storage.local.set({
    pageSize:  optPageSize.value,
    font:      optFont.value,
    images:    optImages.checked,
    selection: optSelection.checked, // Bug 2: persist selectionOnly
  });
}

optPageSize.addEventListener('change', saveOptions);
optFont.addEventListener('change', saveOptions);
optImages.addEventListener('change', saveOptions);
optSelection.addEventListener('change', saveOptions); // Bug 2: save on change

loadOptions();

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(msg, type = '') {
  status.textContent = msg;
  status.className   = type;
}

function setLoading(on, activeBtn) {
  ALL_BTNS.forEach(b => { b.disabled = on; });

  if (on) {
    activeBtn.innerHTML = '<span class="spinner"></span> Exporting…';
  } else {
    // Bug 1: only restore button labels — do NOT clear status here.
    // The caller sets success/error status after the await; clearing here
    // would race against that and wipe the message before the user sees it.
    btnDocx.innerHTML = originalHtml.docx;
    btnPdf.innerHTML  = originalHtml.pdf;
    btnMd.innerHTML   = originalHtml.md;
    btnTxt.innerHTML  = originalHtml.txt;
  }
}

function getOptions() {
  return {
    pageSize:      optPageSize.value,
    font:          optFont.value,
    includeImages: optImages.checked,
    selectionOnly: optSelection.checked,
  };
}

// ── Message sender ────────────────────────────────────────────────────────────
async function sendMessage(action, btn) {
  setLoading(true, btn);
  setStatus('Extracting content…');

  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    setStatus('Could not access the current tab.', 'error');
    setLoading(false, btn);
    setTimeout(() => setStatus(''), 4000);
    return;
  }

  const tabId = tabs[0]?.id;
  if (!tabId) {
    setStatus('No active tab found.', 'error');
    setLoading(false, btn);
    setTimeout(() => setStatus(''), 4000);
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, { action, options: getOptions() });

    if (response?.success) {
      setStatus('Done! File downloaded.', 'success');
    } else {
      setStatus(response?.error || 'Something went wrong.', 'error');
    }
  } catch {
    setStatus('Cannot extract content from this page.', 'error');
  }

  setLoading(false, btn); // Bug 1: restores buttons without wiping status
  setTimeout(() => setStatus(''), 4000); // auto-clear after 4 s
}

// ── Export buttons ────────────────────────────────────────────────────────────
btnDocx.addEventListener('click', () => sendMessage('exportDocx', btnDocx));
btnPdf.addEventListener('click',  () => sendMessage('exportPdf',  btnPdf));
btnMd.addEventListener('click',   () => sendMessage('exportMd',   btnMd));
btnTxt.addEventListener('click',  () => sendMessage('exportTxt',  btnTxt));

// ── Preview tab ───────────────────────────────────────────────────────────────
tabPreview.addEventListener('click', async () => {
  tabPreview.classList.add('active');
  tabExport.classList.remove('active');
  previewBox.classList.add('visible');

  previewBox.innerHTML = '<em style="color:#555">Loading…</em>';

  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (!tabId) throw new Error('no tab');

    const response = await chrome.tabs.sendMessage(tabId, {
      action:  'getPreview',
      options: getOptions(),
    });

    if (response?.success && response.html) {
      previewBox.innerHTML = response.html;
    } else {
      previewBox.innerHTML = `<em style="color:#f87171">${response?.error || 'Could not extract content.'}</em>`;
    }
  } catch {
    previewBox.innerHTML = '<em style="color:#f87171">Cannot read this page.</em>';
  }
});

tabExport.addEventListener('click', () => {
  tabExport.classList.add('active');
  tabPreview.classList.remove('active');
  previewBox.classList.remove('visible');
});

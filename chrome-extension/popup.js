const btnDocx = document.getElementById('btnDocx');
const btnPdf  = document.getElementById('btnPdf');
const status  = document.getElementById('status');

// Store original inner HTML so we can restore it after loading
const originalHtml = {
  docx: btnDocx.innerHTML,
  pdf:  btnPdf.innerHTML,
};

const SPINNER_HTML = '<span class="spinner"></span>';

function setStatus(msg, type = '') {
  status.textContent = msg;
  status.className = type;
}

function setLoading(on, activeBtn) {
  btnDocx.disabled = on;
  btnPdf.disabled  = on;

  if (on) {
    // Show spinner only on the clicked button; grey out the other
    activeBtn.innerHTML = SPINNER_HTML + ' ' + (activeBtn === btnDocx ? 'Exporting…' : 'Exporting…');
  } else {
    // Restore both buttons
    btnDocx.innerHTML = originalHtml.docx;
    btnPdf.innerHTML  = originalHtml.pdf;
    setStatus('');
  }
}

async function sendMessage(action, btn) {
  setLoading(true, btn);
  setStatus('Extracting content…');

  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    setStatus('Could not access the current tab.', 'error');
    setLoading(false, btn);
    return;
  }

  const tabId = tabs[0]?.id;
  if (!tabId) {
    setStatus('No active tab found.', 'error');
    setLoading(false, btn);
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, { action });

    if (response?.success) {
      setStatus('Done! File downloaded.', 'success');
    } else {
      setStatus(response?.error || 'Something went wrong.', 'error');
    }
  } catch (e) {
    setStatus('Cannot extract content from this page.', 'error');
  }

  setLoading(false, btn);
}

btnDocx.addEventListener('click', () => sendMessage('exportDocx', btnDocx));
btnPdf.addEventListener('click',  () => sendMessage('exportPdf',  btnPdf));

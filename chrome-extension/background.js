/**
 * background.js — Bobdoc service worker
 *
 * Handles:
 *  - Right-click context menu items (Export as DOCX / PDF / Markdown / Text)
 *  - Keyboard shortcuts (Alt+Shift+D for DOCX, Alt+Shift+P for PDF)
 */

// ── Context menu setup ────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id:       'bobdoc-parent',
    title:    'Export with Bobdoc',
    contexts: ['page', 'selection'],
  });

  chrome.contextMenus.create({
    id:       'bobdoc-docx',
    parentId: 'bobdoc-parent',
    title:    'Download as DOCX',
    contexts: ['page', 'selection'],
  });

  chrome.contextMenus.create({
    id:       'bobdoc-pdf',
    parentId: 'bobdoc-parent',
    title:    'Download as PDF',
    contexts: ['page', 'selection'],
  });

  chrome.contextMenus.create({
    id:       'bobdoc-md',
    parentId: 'bobdoc-parent',
    title:    'Download as Markdown',
    contexts: ['page', 'selection'],
  });

  chrome.contextMenus.create({
    id:       'bobdoc-txt',
    parentId: 'bobdoc-parent',
    title:    'Download as Plain Text',
    contexts: ['page', 'selection'],
  });
});

// ── Context menu click handler ────────────────────────────────────────────────

const MENU_ACTIONS = {
  'bobdoc-docx': 'exportDocx',
  'bobdoc-pdf':  'exportPdf',
  'bobdoc-md':   'exportMd',
  'bobdoc-txt':  'exportTxt',
};

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const action = MENU_ACTIONS[info.menuItemId];
  if (!action || !tab?.id) return;

  // If text is selected, pass selectionOnly:true automatically
  const selectionOnly = !!info.selectionText;

  await sendToContentScript(tab.id, action, { selectionOnly });
});

// ── Keyboard shortcut handler ─────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab?.id) return;

  const actionMap = {
    'export-docx': 'exportDocx',
    'export-pdf':  'exportPdf',
  };

  const action = actionMap[command];
  if (!action) return;

  await sendToContentScript(tab.id, action, {});
});

// ── Helper ────────────────────────────────────────────────────────────────────

async function sendToContentScript(tabId, action, options) {
  try {
    await chrome.tabs.sendMessage(tabId, { action, options });
  } catch {
    // Content script not yet injected on this page — inject it first then retry
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files:  ['libs/Readability.js', 'content.js'],
      });
      await chrome.tabs.sendMessage(tabId, { action, options });
    } catch (err) {
      console.warn('[Bobdoc] Could not send message to tab:', err.message);
    }
  }
}

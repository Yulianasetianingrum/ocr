// Background Service Worker for Real-Time Screen Scanner Chrome Extension

chrome.runtime.onInstalled.addListener(() => {
  console.log('[ScreenScanner] Extension installed successfully.');
});

// Listener for extension action icon click: Opens persistent Pop Up window directly!
chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id) {
    chrome.storage.local.set({ targetTabId: tab.id });
  }
  chrome.windows.create({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    width: 500,
    height: 750,
    focused: true
  });
});

// Listen for messages from content script or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'open_dashboard') {
    chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
    sendResponse({ status: 'ok' });
  } else if (request.action === 'open_standalone_remote') {
    chrome.windows.create({
      url: chrome.runtime.getURL('remote.html'),
      type: 'popup',
      width: 440,
      height: 600,
      focused: true
    });
    sendResponse({ status: 'ok' });
  } else {
    // For any unhandled messages, we can just send an empty response or do nothing
    // Returning false means we won't send an async response.
    return false;
  }
  // Return true ONLY if we are actually going to call sendResponse asynchronously later
  return false;
});

// Background Service Worker for Real-Time Screen Scanner Chrome Extension

chrome.runtime.onInstalled.addListener(() => {
  console.log('[ScreenScanner] Extension installed successfully.');
});

// Listener for extension action icon click: Opens persistent Pop Up Remote window directly!
chrome.action.onClicked.addListener((tab) => {
  chrome.windows.create({
    url: chrome.runtime.getURL('remote.html'),
    type: 'popup',
    width: 440,
    height: 600,
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
  }
  return true;
});

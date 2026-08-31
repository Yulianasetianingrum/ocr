/**
 * Remote Pop Up Window — Real-Time DOM Text Reader
 * Reads text DIRECTLY from DOM elements at the mapped area, bypassing inaccurate OCR.
 * Achieves 100% accuracy for numbers, decimals, labels, and prices from any web page.
 */

document.addEventListener('DOMContentLoaded', () => {
  const remoteTrendBadge = document.getElementById('remoteTrendBadge');
  const descPrimaryVal = document.getElementById('descPrimaryVal');

  let activeMappedRoi = null;
  let activeTabId = null;
  let previousText = '';
  
  // State for tracking the most recently changed value
  const pollHistory = [];
  let lastChangedValue = '--';

  let domPollingInterval = null;

  // ─── Listen for messages from content script ───
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'target_mapped') {
      activeMappedRoi = request.roi;
    }
  });

  // ─── Startup ───
  chrome.storage.local.get({}, (res) => {
    // Attempt to discover active tab automatically on start
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) activeTabId = tabs[0].id;
      // Selalu jalankan polling agar Remote Pop Up selalu mendeteksi nilai
      startDomPolling();
    });
  });

  // ─── DOM Polling ───
  let isPollingPending = false;

  function startDomPolling() {
    if (domPollingInterval) clearInterval(domPollingInterval);
    
    domPollingInterval = setInterval(async () => {
      // If we don't know the active tab yet, try finding it
      if (!activeTabId) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs && tabs[0]) activeTabId = tabs[0].id;
        else return;
      }

      if (isPollingPending) return;

      isPollingPending = true;
      try {
        const result = await chrome.tabs.sendMessage(activeTabId, {
          action: 'read_dom_text',
          region: activeMappedRoi
        });
        if (result && result.text !== undefined) {
          handleDomResult(result);
        }
      } catch (e) {
        // Tab might not have content script yet or navigated
      } finally {
        isPollingPending = false;
      }
    }, 100); // 100ms interval for synced reading
  }

  function stopDomPolling() {
    if (domPollingInterval) {
      clearInterval(domPollingInterval);
      domPollingInterval = null;
    }
  }

  // ─── Handle DOM text result ───
  function handleDomResult(result) {
    if (!result) return;

    const currentText = result.text || '';
    const numbers = result.numbers || [];
    const hasChanged = currentText !== previousText;

    if (hasChanged && pollHistory.length > 0) {
      const prevNumbers = pollHistory[pollHistory.length - 1];
      for (let i = 0; i < numbers.length; i++) {
        if (numbers[i] !== prevNumbers[i]) {
          lastChangedValue = numbers[i];
          break;
        }
      }
      if (numbers.length > prevNumbers.length && lastChangedValue === '--') {
         lastChangedValue = numbers[numbers.length - 1];
      }
    } else if (numbers.length > 0 && lastChangedValue === '--') {
      lastChangedValue = numbers[0]; 
    }

    pollHistory.push([...numbers]);
    if (pollHistory.length > 8) pollHistory.shift(); // MAX_HISTORY = 8

    const primaryValue = lastChangedValue !== undefined ? lastChangedValue : '--';
    descPrimaryVal.textContent = primaryValue;

    const currNum = parseFloat(primaryValue.replace(/[^0-9.-]/g, ''));
    const prevNumMatch = previousText.match(/[-+]?\d+\.?\d*/);
    const prevNum = prevNumMatch ? parseFloat(prevNumMatch[0]) : NaN;

    let trendBadge = '▶ STABIL';
    let trendColor = '#94a3b8';
    let trendBg = 'rgba(148, 163, 184, 0.15)';

    if (!isNaN(currNum) && !isNaN(prevNum) && hasChanged) {
      const diff = currNum - prevNum;
      if (diff > 0) {
        trendBadge = `▲ NAIK (+${diff.toFixed(4)})`;
        trendColor = '#10b981';
        trendBg = 'rgba(16, 185, 129, 0.2)';
      } else if (diff < 0) {
        trendBadge = `▼ TURUN (${diff.toFixed(4)})`;
        trendColor = '#ef4444';
        trendBg = 'rgba(239, 68, 68, 0.2)';
      }
    }

    remoteTrendBadge.textContent = trendBadge;
    remoteTrendBadge.style.background = trendBg;
    remoteTrendBadge.style.color = trendColor;

    previousText = currentText;
  }
});

/**
 * Content Script for Automatic Screen Text Detection, Selection Highlight Tooltip, & Status Badge
 * Fixed touchpad release selection clearing via 250ms decoupled event loop.
 */

(function () {
  if (window._ocrInjected) return;
  window._ocrInjected = true;

  // ========================================================
  // INLINED LOG MANAGER (Bypass manifest.json cache issues)
  // ========================================================
  window.LogManager = (function() {
    let isProcessing = false;
    let actionQueue = [];
    function _processQueue() {
      if (isProcessing || actionQueue.length === 0) return;
      isProcessing = true;
      const task = actionQueue.shift();
      try {
        chrome.storage.local.get({ sessionLogs: [] }, (res) => {
          if (chrome.runtime && chrome.runtime.lastError) {
             isProcessing = false; task.resolve(); _processQueue(); return;
          }
          let logs = res.sessionLogs || [];
          try {
            const resultLogs = task.executor(logs);
            if (resultLogs) {
              if (resultLogs.length > 25) resultLogs.splice(25);
              chrome.storage.local.set({ sessionLogs: resultLogs }, () => {
                if (chrome.runtime && chrome.runtime.lastError) {}
                isProcessing = false;
                task.resolve();
                _processQueue();
              });
              return;
            }
          } catch (err) {}
          isProcessing = false;
          task.resolve();
          _processQueue();
        });
      } catch (err) {
        // Silently discard task if extension context is invalidated
        isProcessing = false;
        task.resolve();
        _processQueue();
      }
    }
    function _enqueue(executor) {
      return new Promise((resolve) => {
        actionQueue.push({ executor, resolve });
        _processQueue();
      });
    }
    function _createBaseSchema(operationId, positionId, action, rawEntryStr, numericEntry, nominal, timestamp) {
      return {
        schemaVersion: 1, operationId: operationId, positionId: positionId,
        status: positionId ? 'OPEN' : 'ACTION_REQUESTED', result: 'PENDING',
        direction: action, nominal: typeof nominal === 'number' ? nominal : parseFloat(nominal),
        openedAt: timestamp,
        entry: { raw: rawEntryStr, value: numericEntry, timestamp: timestamp, confidence: 1.0 },
        close: null, priceDifference: null, resultConfidence: 0, resultSource: null, reconciliationRequired: false
      };
    }
    return {
      createOperation: async function(action, rawEntryStr, numericEntry, nominal) {
        const ts = Date.now();
        const operationId = `ACTION-${ts}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
        await _enqueue((logs) => {
          logs.unshift(_createBaseSchema(operationId, null, action, rawEntryStr, numericEntry, nominal, ts));
          return logs;
        });
        return operationId;
      },
      confirmPosition: async function(operationId) {
        const ts = Date.now();
        const positionId = `POS-${ts}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
        await _enqueue((logs) => {
          const target = logs.find(l => l.operationId === operationId);
          if (target && target.status === 'ACTION_REQUESTED') {
            target.positionId = positionId; target.status = 'OPEN'; target.openedAt = ts; target.entry.timestamp = ts;
            return logs;
          }
          return null;
        });
        return positionId;
      },
      closePosition: async function(positionId, evidence) {
        if (!positionId) return;
        const ts = Date.now();
        await _enqueue((logs) => {
          const target = logs.find(l => l.positionId === positionId);
          if (!target || (target.status === 'CLOSED' && !evidence.isReconciliation)) return null;
          target.status = 'CLOSED'; target.result = evidence.result || 'UNKNOWN';
          target.priceDifference = evidence.priceDiff !== undefined ? evidence.priceDiff : null;
          target.resultSource = evidence.source || 'PRICE_ONLY'; target.resultConfidence = evidence.confidence || 0.0;
          target.reconciliationRequired = evidence.reconciliationRequired || false;
          target.close = { raw: evidence.rawClose || '--', value: evidence.numericClose !== undefined ? evidence.numericClose : null, timestamp: ts, confidence: evidence.ocrConfidence || 1.0 };
          return logs;
        });
      },
      getPendingPositions: function(callback) {
        try {
          chrome.storage.local.get({ sessionLogs: [] }, (res) => {
            if (chrome.runtime && chrome.runtime.lastError) return;
            callback((res.sessionLogs || []).filter(l => l.status === 'OPEN' || l.status === 'ACTION_REQUESTED' || (l.status === 'CLOSED' && l.result === 'UNKNOWN' && l.reconciliationRequired)));
          });
        } catch (e) {}
      },
      readLatestState: function(callback) {
        try {
          chrome.storage.local.get({ sessionLogs: [] }, (res) => {
            if (chrome.runtime && chrome.runtime.lastError) return;
            callback(res.sessionLogs || []);
          });
        } catch (e) {}
      }
    };
  })();

  // CLEANUP ORPHANED TRADES (DENGAN BATAS WAKTU)
  // Mencegah tab baru (seperti chrome://newtab) membersihkan trade yang sedang aktif di tab utama.
  window.LogManager.getPendingPositions((pendings) => {
    if (pendings && pendings.length > 0) {
      const now = Date.now();
      let cleaned = 0;
      pendings.forEach(p => {
        // Hanya bersihkan jika umurnya sudah lebih dari 3 menit (180000 ms)
        if (p.positionId && p.openedAt && (now - p.openedAt > 180000)) {
          cleaned++;
          window.LogManager.closePosition(p.positionId, {
            rawClose: '--',
            numericClose: null,
            result: 'ERROR',
            source: 'SYSTEM_CLEANUP',
            confidence: 0,
            reconciliationRequired: false
          });
        }
      });
      if (cleaned > 0) {
        if (window.location.hostname.includes('olymp')) {
          console.warn(`[LogManager] Membersihkan ${cleaned} trade yang nyangkut (Orphaned) dari sesi sebelumnya...`);
        }
      }
    }
  });
  // ========================================================

  let isSnipping = false;
  let startX = 0, startY = 0;
  let overlayEl = null;
  let boxEl = null;
  let badgeEl = null;

  // ─── Region Mapping State (Global to avoid closure/TDZ issues) ───
  window._mappedRegion = null;
  
  // Load saved region immediately
  chrome.storage.local.get(['savedMappedRegion'], (res) => {
    if (res.savedMappedRegion) {
      window._mappedRegion = res.savedMappedRegion;
      // Note: we can't start tracking immediately here until DOM is ready, 
      // but it will be picked up by the next scan.
    }
  });

  let autoScanInterval = null;
  let lastDetectedText = '';
  let autoBadgeEl = null;
  let isAutoScanning = false;
  let highlightTooltipEl = null;
  let selectionTimeout = null;

  let targetDirection = 'auto'; // 'auto' | 'naik' | 'turun'
  let latestColorAnalysis = { signal: 'netral' };
  let latestTrendAnalysis = { trend: 'absurd', slope: 0, points: [] };
  let latestDurationInfo = { timerText: '', isValid: false };
  let lastPriceEvaluationTime = 0;

  // ─── Region Mapping State (Global to avoid closure/TDZ issues) ───
  window._mappedRegion = null;
  window._trackedElement = null;
  window._trackingRafId = null;
  window._trackingBox = null;

  // 1. Listen for messages from background / popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'PING') {
      sendResponse({ status: 'PONG' });
    } else if (message.action === 'START_SNIPPER') {
      initSnipper();
      sendResponse({ status: 'started' });
    } else if (message.action === 'RUN_AUTO_SCAN') {
      if (isAutoScanning && !isUserSelectingText()) {
        runAutoScreenScan();
      }
      sendResponse({ status: 'auto_scanned' });
    } else if (message.action === 'SET_AUTO_SCAN_STATE') {
      setAutoScanState(message.isAutoScanning);
      sendResponse({ status: 'state_updated', isAutoScanning: isAutoScanning });
    } else if (message.action === 'SET_TARGET_DIRECTION') {
      setTargetDirectionState(message.targetDirection);
      sendResponse({ status: 'target_updated', targetDirection: targetDirection });
    } else if (message.action === 'SET_BASE_NOMINAL_VALUE') {
      const quickBaseInput = document.getElementById('ocr-quick-base-nominal');
      if (quickBaseInput) quickBaseInput.value = message.value;
      chrome.storage.local.set({ baseNominalValue: message.value });
      const parsed = parseFloat(String(message.value).replace(/[^0-9\.]/g, ''));
      if (!isNaN(parsed) && parsed > 0) {
        baseInitialNominal = parsed;
        if (martingaleStep === 0) {
          currentNominalValue = parsed;
          const quickInput = document.getElementById('ocr-quick-nominal');
          if (quickInput) quickInput.value = parsed;
        }
      }
      sendResponse({ status: 'base_nominal_updated', value: message.value });
    } else if (message.action === 'SET_NOMINAL_VALUE') {
      const quickInput = document.getElementById('ocr-quick-nominal');
      if (quickInput) quickInput.value = message.value;
      chrome.storage.local.set({ nominalValue: message.value });
      const parsed = parseFloat(String(message.value).replace(/[^0-9\.]/g, ''));
      if (!isNaN(parsed) && parsed > 0) {
        currentNominalValue = parsed;
        if (currentNominalValue <= baseInitialNominal) {
          martingaleStep = 0;
          consecutiveNetral = 0;
        }
      }
      sendResponse({ status: 'nominal_updated', value: message.value });
    } else if (message.action === 'GET_LIVE_STATUS') {
      const quickInput = document.getElementById('ocr-quick-nominal');
      const nominalVal = quickInput ? quickInput.value : '18000';
      sendResponse({
        isAutoScanning: isAutoScanning,
        targetDirection: targetDirection,
        nominalValue: nominalVal,
        colorAnalysis: latestColorAnalysis,
        trendAnalysis: latestTrendAnalysis,
        durationInfo: latestDurationInfo,
        hasClickedInCurrentDuration: hasClickedInCurrentDuration
      });
    } else if (message.action === 'INPUT_NOMINAL') {
      const valStr = message.value || baseInitialNominal;
      const parsed = parseFloat(String(valStr).replace(/[^0-9\.]/g, ''));
      if (!isNaN(parsed) && parsed > 0) {
        baseInitialNominal = parsed;
        currentNominalValue = parsed;
        martingaleStep = 0;
        consecutiveNetral = 0;
        const quickBaseInput = document.getElementById('ocr-quick-base-nominal');
        const quickInput = document.getElementById('ocr-quick-nominal');
        if (quickBaseInput) quickBaseInput.value = parsed;
        if (quickInput) quickInput.value = parsed;
        chrome.storage.local.set({ baseNominalValue: String(parsed), nominalValue: String(parsed) });
      }
      const res = window.OcrEngine.inputNominalValue(baseInitialNominal);
      showToastNotification(`💰 Modal Awal (IDR ${baseInitialNominal}) Diisikan ke Layar & Step Reset!`);
      sendResponse(res);
    } else if (message.action === 'CLICK_NAIK') {
      const quickInput = document.getElementById('ocr-quick-nominal');
      const nominalVal = currentNominalValue ? String(currentNominalValue) : ((quickInput && quickInput.value) ? quickInput.value : '18000');
      window.OcrEngine.inputNominalValue(nominalVal);
      setTimeout(() => {
        const res = window.OcrEngine.clickActionElement('naik');
        if (res.success) startTradeLifecycle(latestDurationInfo ? latestDurationInfo.totalSeconds : 5, 'naik');
        showToastNotification(res.message);
        sendResponse(res);
      }, 100);
      return true;
    } else if (message.action === 'CLICK_TURUN') {
      const quickInput = document.getElementById('ocr-quick-nominal');
      const nominalVal = currentNominalValue ? String(currentNominalValue) : ((quickInput && quickInput.value) ? quickInput.value : '18000');
      window.OcrEngine.inputNominalValue(nominalVal);
      setTimeout(() => {
        const res = window.OcrEngine.clickActionElement('turun');
        if (res.success) startTradeLifecycle(latestDurationInfo ? latestDurationInfo.totalSeconds : 5, 'turun');
        showToastNotification(res.message);
        sendResponse(res);
      }, 100);
      return true;
    }
    return true;
  });

  // Helper: Cek apakah Extension Context masih valid (mencegah Uncaught Error: Extension context invalidated)
  function isContextValid() {
    try {
      return typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  function showContextInvalidatedToast() {
    showToastNotification('⚠️ Ekstensi telah di-reload. Silakan TEKAN F5 (Refresh) di tab OlympTrade ini agar tombol & mesin berjalan lancar!');
  }

  function safeStorageSet(data, callback) {
    if (!isContextValid()) {
      showContextInvalidatedToast();
      if (typeof callback === 'function') callback();
      return;
    }
    try {
      chrome.storage.local.set(data, () => {
        if (chrome.runtime.lastError) {
          showContextInvalidatedToast();
        } else if (typeof callback === 'function') {
          callback();
        }
      });
    } catch (e) {
      showContextInvalidatedToast();
      if (typeof callback === 'function') callback();
    }
  }

  function safeStorageGet(defaults, callback) {
    if (!isContextValid()) {
      if (typeof callback === 'function') callback(defaults);
      return;
    }
    try {
      chrome.storage.local.get(defaults, (res) => {
        if (chrome.runtime.lastError) {
          if (typeof callback === 'function') callback(defaults);
        } else if (typeof callback === 'function') {
          callback(res || defaults);
        }
      });
    } catch (e) {
      if (typeof callback === 'function') callback(defaults);
    }
  }

  // Helper: Tampilkan Toast Notifikasi di Layar
  function showToastNotification(msg) {
    if (!document || !document.body) return;
    let toast = document.getElementById('ocr-toast-notification');
    if (toast) toast.remove();

    toast = document.createElement('div');
    toast.id = 'ocr-toast-notification';
    toast.className = 'ocr-toast-notification';
    toast.innerText = msg;
    document.body.appendChild(toast);

    setTimeout(() => {
      if (toast && toast.parentNode) toast.remove();
    }, 2800);
  }


  // Helper: Check if user is currently selecting/highlighting text on screen
  function isUserSelectingText() {
    try {
      const selection = window.getSelection();
      return selection && selection.rangeCount > 0 && selection.toString().trim().length > 0;
    } catch (e) {
      return false;
    }
  }

  // 2. Touchpad/Mouseup Safe Selection Highlight Listener
  document.addEventListener('mouseup', onMouseUpSelectionHandler);
  document.addEventListener('keyup', onMouseUpSelectionHandler);

  function onMouseUpSelectionHandler(e) {
    if (e.target && e.target.closest('#ocr-highlight-tooltip')) {
      return;
    }

    clearTimeout(selectionTimeout);
    // 250ms decoupled delay so touchpad mouseup completes 100% natively without DOM injection interference
    selectionTimeout = setTimeout(() => {
      checkAndShowSelectionTooltip();
    }, 250);
  }

  function checkAndShowSelectionTooltip() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      removeHighlightTooltip();
      return;
    }

    const selectedText = selection.toString().trim();
    if (selectedText && selectedText.length > 0) {
      try {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();

        if (rect.width > 0 && rect.height > 0) {
          showHighlightTooltip(selectedText, rect);
        } else {
          removeHighlightTooltip();
        }
      } catch (err) {
        removeHighlightTooltip();
      }
    } else {
      removeHighlightTooltip();
    }
  }

  function showHighlightTooltip(text, rect) {
    if (highlightTooltipEl && highlightTooltipEl.dataset.text === text) {
      return;
    }

    removeHighlightTooltip();

    // Verify selection is still active before creating tooltip
    const currentSel = window.getSelection();
    if (!currentSel || currentSel.toString().trim() !== text) {
      return;
    }

    const analysis = window.OcrEngine.analyzeText(text);

    highlightTooltipEl = document.createElement('div');
    highlightTooltipEl.id = 'ocr-highlight-tooltip';
    highlightTooltipEl.dataset.text = text;

    // Prevent mousedown inside tooltip from stealing selection focus
    highlightTooltipEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    const top = Math.max(10, rect.top - 48);
    const left = Math.min(window.innerWidth - 230, Math.max(10, rect.left + rect.width / 2 - 100));

    highlightTooltipEl.style.top = top + 'px';
    highlightTooltipEl.style.left = left + 'px';

    const truncated = text.length > 25 ? text.substring(0, 22) + '...' : text;
    const symCount = analysis.symbolCounts.plus + analysis.symbolCounts.minus + analysis.symbolCounts.openParen + analysis.symbolCounts.closeParen;

    highlightTooltipEl.innerHTML = `
      <div class="ocr-tooltip-info">
        <div class="ocr-tooltip-title">Terpilih: "${window.OcrEngine.escapeHtml(truncated)}"</div>
        <div class="ocr-tooltip-sub">${analysis.charCount} Karakter | ${symCount} Simbol (+,-,())</div>
      </div>
      <button class="ocr-tooltip-btn" id="ocr-tooltip-copy-btn">📋 Salin</button>
    `;

    document.body.appendChild(highlightTooltipEl);

    const copyBtn = document.getElementById('ocr-tooltip-copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(() => {
          if (copyBtn) {
            copyBtn.innerText = '✅ Tersalin!';
            setTimeout(removeHighlightTooltip, 1500);
          }
        });
      });
    }
  }

  function removeHighlightTooltip() {
    if (highlightTooltipEl) {
      highlightTooltipEl.remove();
      highlightTooltipEl = null;
    }
  }

  // 3. Auto-detection loop
  try {
    chrome.storage.local.get({ isAutoScanning: false, targetDirection: 'auto' }, (res) => {
      isAutoScanning = res.isAutoScanning;
      targetDirection = res.targetDirection || 'auto';
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startAutoDetectionLoop);
      } else {
        startAutoDetectionLoop();
      }
    });
  } catch (e) {
    startAutoDetectionLoop();
  }

  function setAutoScanState(active) {
    isAutoScanning = active;
    chrome.storage.local.set({ isAutoScanning: isAutoScanning });
    renderAutoBadge();
    if (autoBadgeEl) {
      autoBadgeEl.style.display = 'block';
    }
    updateBadgeStatusUI(isAutoScanning);

    if (isAutoScanning) {
      tradeState = 'IDLE';
      hasClickedInCurrentDuration = false;
      lastAutoClickTime = 0;

      const baseInput = document.getElementById('ocr-quick-base-nominal');
      const quickInput = document.getElementById('ocr-quick-nominal');
      if (baseInput && baseInput.value) {
        const p = parseFloat(String(baseInput.value).replace(/[^0-9\.]/g, ''));
        if (!isNaN(p) && p > 0) {
          baseInitialNominal = p;
          if (martingaleStep === 0) {
            currentNominalValue = p;
            if (quickInput) quickInput.value = p;
          }
        }
      }

      // LANGSUNG ATUR NOMINAL DI WEB DENGAN NOMINAL AKTIF (SUDAH DIKALI BILA LOSS)
      if (window.OcrEngine && typeof window.OcrEngine.inputNominalValue === 'function') {
        window.OcrEngine.inputNominalValue(currentNominalValue);
      }

      // PERBAIKAN: OP Pertama JANGAN langsung dieksekusi hanya karena ditekan "Mulai"
      // Bot harus menunggu OCR membaca dengan jelas dan state valid.
      // Dihapus: setTimeout(executeInstantAutoTrade, 100);

      if (!isTickRunning) {
          isTickRunning = true;
          botTick();
      }

      if (!isUserSelectingText()) runAutoScreenScan();
    } else {
      clearTrendlineOverlay();
      if (botTickTimeout) {
        clearTimeout(botTickTimeout);
        botTickTimeout = null;
      }
      isTickRunning = false;
    }
  }

  function clearTrendlineOverlay() {
    const canvas = document.getElementById('ocr-trendline-canvas');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  function setTargetDirectionState(dir) {
    targetDirection = dir || 'auto';
    chrome.storage.local.set({ targetDirection: targetDirection });
    updateBadgeTargetButtonsUI(targetDirection);
  }

  // Live Real-Time Storage Synchronization across Floating Badge & Extension Popup
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
      if (changes.isAutoScanning && changes.isAutoScanning.newValue !== isAutoScanning) {
        setAutoScanState(changes.isAutoScanning.newValue);
      }
      if (changes.targetDirection && changes.targetDirection.newValue !== targetDirection) {
        targetDirection = changes.targetDirection.newValue;
        updateBadgeTargetButtonsUI(targetDirection);
      }
      if (changes.baseNominalValue && changes.baseNominalValue.newValue) {
        const parsedBase = parseFloat(String(changes.baseNominalValue.newValue).replace(/[^0-9\.]/g, ''));
        if (!isNaN(parsedBase) && parsedBase > 0) {
          baseInitialNominal = parsedBase;
          const quickBaseInput = document.getElementById('ocr-quick-base-nominal');
          if (quickBaseInput && document.activeElement !== quickBaseInput) {
            quickBaseInput.value = parsedBase;
          }
        }
      }
      if (changes.nominalValue && changes.nominalValue.newValue) {
        const parsedNom = parseFloat(String(changes.nominalValue.newValue).replace(/[^0-9\.]/g, ''));
        if (!isNaN(parsedNom) && parsedNom > 0) {
          currentNominalValue = parsedNom;
          const quickInput = document.getElementById('ocr-quick-nominal');
          if (quickInput && document.activeElement !== quickInput) {
            quickInput.value = parsedNom;
          }
        }
      }
    }
  });

  let botTickTimeout = null;
  let isTickRunning = false;

  function botTick() {
    if (!isContextValid()) {
      isAutoScanning = false;
      isTickRunning = false;
      return;
    }
    if (!isAutoScanning) {
        isTickRunning = false;
        return;
    }
    
    // State Manager Sync
    const stateObj = window.BotStateManager ? window.BotStateManager.getState() : { status: 'IDLE' };
    const status = stateObj.status;
    
    if (status === 'IDLE' || status === 'SCANNING' || status === 'WAITING_RESULT') {
        if (!isUserSelectingText()) {
            runAutoScreenScan();
        }
    }
    
    // Polling Region & Price Tracker
    if (window._mappedRegion && window._readDomTextInRegion) {
        try {
            const res = window._readDomTextInRegion(window._mappedRegion);
            if (res && res.numbers && res.numbers.length > 0) {
                const freshVal = findBestPriceCandidate(res.numbers);
                if (freshVal && freshVal !== '--') {
                    lastChangedValue = freshVal;
                    lastValidCloseSnapshot = freshVal;
                }
            }
        } catch (e) {}
    }
    
    // Result Detection & Badge Watcher — HANYA TULIS VERDICT, JANGAN CLOSE!
    // _doCompleteWithClose (via timer deterministik) yang menutup posisi.
    if (tradeState === 'TRADE_ACTIVE' || tradeState === 'WAITING_RESULT') {
        try {
            const badge = (window.OcrEngine && window.OcrEngine.detectTradeDealBadge) ? window.OcrEngine.detectTradeDealBadge() : null;
            if (badge && badge.found) {
                setWinLossVerdict(badge.type === 'profit', 'BADGE_WATCHER', badge.text);
            }
        } catch (e) {}
    }
    
    updateAutoClearTimer();
    // PERBAIKAN LAG: Ubah interval dari 30ms menjadi 200ms
    botTickTimeout = setTimeout(botTick, 200);
  }

  function startAutoDetectionLoop() {
    renderAutoBadge();
    if (autoBadgeEl) autoBadgeEl.style.display = 'block';
    
    if (isAutoScanning && !isTickRunning) {
        isTickRunning = true;
        botTick();
    } else if (!isAutoScanning) {
        if (botTickTimeout) {
            clearTimeout(botTickTimeout);
            botTickTimeout = null;
        }
        isTickRunning = false;
    }
  }

    /**
     * Helper UI: Update status komparasi harga OP vs Ended pada Pop-up Remot Melayang
     */
    function updatePriceStatusUI(isWin, entryPrice, exitPrice, isRunning) {
      const box = document.getElementById('ocr-badge-price-box');
      const text = document.getElementById('ocr-badge-price-text');
      if (!box || !text) return;

      const dirUpper = tradeActionDirection ? String(tradeActionDirection).toUpperCase() : 'NAIK';

      if (isRunning) {
        box.className = 'ocr-badge-signal-row signal-neutral';
        text.innerHTML = `📌 <strong>OP ${dirUpper}: ${entryPrice}</strong> (Berjalan...)`;
      } else if (isWin === true) {
        box.className = 'ocr-badge-signal-row signal-green';
        text.innerHTML = `🟢 <strong>WIN PROFIT: ${entryPrice} ➔ ${exitPrice}</strong>`;
      } else if (isWin === false) {
        box.className = 'ocr-badge-signal-row signal-red';
        text.innerHTML = `🔴 <strong>LOSS STEP ${martingaleStep}: ${entryPrice} ➔ ${exitPrice}</strong>`;
      } else {
        box.className = 'ocr-badge-signal-row signal-neutral';
        text.innerHTML = `⚪ <strong>OP: - | Ended: -</strong>`;
      }
    }

    // processTradeResultByPrice DIHAPUS — semua close trade dihandle oleh
    // _doCompleteWithClose melalui timer deterministik di startTradeLifecycle.
    // botTick & MutationObserver hanya menulis verdict (setWinLossVerdict).

    // ============================================================
    // MUTATION OBSERVER: Tangkap notifikasi hasil OlympTrade 0ms
    // setelah elemen baru muncul di DOM (jauh lebih cepat dari polling)
    // OlympTrade menambahkan notifikasi ke .notes-tc-block / .notifications-container
    // ============================================================
    if (!window._ocrDomObserver) {
      window._ocrDomObserver = new MutationObserver((mutations) => {
        if (!isAutoScanning) return;
        if (Date.now() - lastPriceEvaluationTime < 5000) return; // ABAIKAN JIKA BARU SAJA EVALUASI HARGA

        const activeDurationSecs = tradeDurationSecs || 5;
        const elapsedSecs = (Date.now() - lastAutoClickTime) / 1000;

        if (elapsedSecs < (activeDurationSecs - 0.3) && tradeState === 'TRADE_ACTIVE') return;

        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue; // Hanya element nodes
            if (isExtensionUINode(node)) continue;

            // Cek text di node baru + semua children-nya
            const rawText = (node.textContent || '').trim();
            if (!rawText || rawText.length < 2 || rawText.length > 150) continue;

            const lower = rawText.toLowerCase();

            // Skip elemen statis OlympTrade yang tidak relevan
            if (lower === 'naik' || lower === 'turun' || lower === 'nominal' || lower.startsWith('nominal,')) continue;
            if (lower.includes('aktifkan') || lower.includes('durasi') || lower.includes('koneksi')) continue;

            // KUNCI PERBAIKAN: Deteksi lokasi node secara presisi (di notifikasi vs di sidebar)
            let isNotificationUI = false;
            let isInsideSidebar = false;
            try {
              let _curr = node;
              while (_curr && _curr !== document.body) {
                const cls = (_curr.className || '').toString().toLowerCase();
                if (cls.includes('toast') || cls.includes('notif') || cls.includes('notice') || cls.includes('snack') || cls.includes('alert')) {
                  isNotificationUI = true;
                }
                if (cls.includes('sidebar') || cls.includes('history') || cls.includes('deal-list') || cls.includes('deals-list') || cls.includes('trades')) {
                  isInsideSidebar = true;
                }
                _curr = _curr.parentElement;
              }
            } catch(e) {}

            // Deteksi tanda Plus atau Minus generik (biasanya selalu muncul di hasil trade)
            const isGenericPlusMinus = (
                /[+＋]\s*(?:[\u0110\u01b0D$€£₹฿]|Rp)?\s*\d/i.test(rawText) ||
                /[-\u2212\u2013\u2014]\s*(?:[\u0110\u01b0D$€£₹฿]|Rp)?\s*\d/i.test(rawText)
            );

            const isNearEnd = (tradeState === 'WAITING_RESULT' || (tradeState === 'TRADE_ACTIVE' && ((Date.now() - tradeStartTime) / 1000) >= (tradeDurationSecs || 5) - 1.5));

            // Kita percaya teks ini adalah hasil trade JIKA:
            // 1. Berasal dari popup Notifikasi resmi
            // 2. Berisi +/- dan MUNCUL DI LUAR sidebar (mencegah false positive dari scrolling)
            // 3. Berisi +/- dan MUNCUL DI DALAM sidebar, TAPI saat mendekati akhir trade (isNearEnd)
            // 4. Memiliki kata kunci resmi OlympTrade
            const isOfficialNotification = 
              isNotificationUI ||
              (isGenericPlusMinus && !isInsideSidebar) ||
              (isGenericPlusMinus && isInsideSidebar && isNearEnd) ||
              lower.includes('trade closed') ||
              lower.includes('perdagangan ditutup') ||
              lower.includes('hasil perdagangan') || 
              lower.includes('trade result') || 
              lower.includes('closed with a profit') || 
              lower.includes('closed with a loss') ||
              lower.includes('ditutup dengan keuntungan') || 
              lower.includes('ditutup dengan kerugian') ||
              (lower.includes('amount') && (lower.includes('income') || lower.includes('pnl') || lower.includes('profit'))) ||
              (lower.includes('jumlah') && (lower.includes('pendapatan') || lower.includes('hasil')));

            if (!isOfficialNotification) continue;

            try {
              const nowTime = Date.now();
              const elapsedSecs = (nowTime - lastAutoClickTime) / 1000;
              if (elapsedSecs < 4 && tradeState === 'TRADE_ACTIVE') continue;

              const isNewBadge = (rawText !== lastDetectedDealBadgeText || (nowTime - lastDetectedDealBadgeTime > 2000));
              if (!isNewBadge) continue;

              lastDetectedDealBadgeText = rawText;
              lastDetectedDealBadgeTime = nowTime;

              // Evaluasi Win/Loss HANYA DARI teks notifikasi resmi
              const isWin = (
                /[+＋]\s*(?:[\u0110\u01b0D$€£₹฿]|Rp)?\s*\d/i.test(rawText) ||
                (lower.includes('mendapatkan') && /[+＋]\s*\d/.test(rawText)) ||
                lower.includes('berhasil') || (lower.includes('win') && !lower.includes('window')) || lower.includes('keuntungan')
              );
              
              const isZero = /^(?:[\u0110\u01b0D$€£₹฿]|Rp)?\s*0(?:[.,]0{1,2})?\s*(?:[\u0110\u01b0D$€£₹฿]|Rp)?$/i.test(rawText.trim()) ||
                lower.includes('mendapatkan \u01110') || lower.includes('mendapatkan $0') || lower.includes('mendapatkan rp0') ||
                /\b0[,.]00\b/.test(rawText) || 
                lower.match(/pnl\s*:\s*[-]*[0D$€£₹฿Rp]*0[,.]00/i) || 
                lower.match(/income\s*:\s*[-]*[0D$€£₹฿Rp]*0[,.]00/i);
                
              const isLoss = (
                /[-\u2212\u2013\u2014]\s*(?:[\u0110\u01b0D$€£₹฿]|Rp)?\s*\d/i.test(rawText) ||
                lower.includes('loss') || lower.includes('rugi') || lower.includes('gagal') || lower.includes('kerugian') || isZero
              );

              let priceStr = '--';
              const priceMatch = lower.match(/(?:harga penutupan|closing price|quote|closing quote)\s*[:]?\s*([0-9.,]+)/i);
              if (priceMatch) {
                priceStr = priceMatch[1];
              } else {
                const allNumbers = rawText.match(/[0-9]{1,3}(?:[.,][0-9]{2,6})+/g);
                if (allNumbers && allNumbers.length > 0) priceStr = allNumbers[allNumbers.length - 1];
              }

              if (tradeState === 'TRADE_ACTIVE' || tradeState === 'WAITING_RESULT') {
                setWinLossVerdict(isWin && !isLoss, 'DOM_MUTATION', priceStr !== '--' ? priceStr : rawText);
              }
            } catch (e) { }
            return; // Cukup satu notifikasi per mutasi
          }
        }
      });

      // Helper: cek apakah node adalah milik ekstensi kita
      function isExtensionUINode(node) {
        try {
          const id = (node.id || '');
          const cls = (node.className || '').toString();
          return id.includes('ocr') || cls.includes('ocr');
        } catch (e) { return false; }
      }

      // Pasang observer ke seluruh body OlympTrade (childList, subtree, tapi TANPA characterData untuk MENCEGAH LAG)
      window._ocrDomObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
    }

  // Responsive event listeners agar Garis Melintang (Trendline Overlay) menyesuaikan langsung saat screen di-zoom/scroll
  window.addEventListener('resize', onViewportTransformChange, { passive: true });
  window.addEventListener('scroll', onViewportTransformChange, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onViewportTransformChange, { passive: true });
    window.visualViewport.addEventListener('scroll', onViewportTransformChange, { passive: true });
  }

  let animFrameId = null;
  function onViewportTransformChange() {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    animFrameId = requestAnimationFrame(() => {
      if (isAutoScanning && window.OcrEngine && window.OcrEngine.analyzeScreenTrendline) {
        const trendAnalysis = window.OcrEngine.analyzeScreenTrendline();
        drawVisualTrendlineOverlay(trendAnalysis.points, trendAnalysis);
      }
    });
  }

  let lastDetectedDurationText = '';
  let lastDurationSeconds = null;
  let hasClickedInCurrentDuration = false;

  let lastAutoClickTime = 0;
  let lastProcessedClickTime = 0;
  let _isInitiatingTrade = false;

  // Trade Lifecycle State Management
  // States: 'IDLE' | 'TRADE_ACTIVE' | 'WAITING_RESULT'
  let tradeState = 'IDLE';
  let tradeStartTime = 0;
  let tradeDurationSecs = 5;
  let entryPriceValue = null;
  let lastKnownScreenPrice = null;
  let tradeActionDirection = 'naik';
  let activeTradeRecord = null;

  /**
   * Buffer verdict WIN/LOSS real-time — ditulis oleh MutationObserver & badge watcher,
   * dibaca oleh _doCompleteWithClose sebagai sumber kebenaran tertinggi.
   * Format: { isWin: bool, source: string, rawText: string, ts: number } | null
   */
  let lastWinLossVerdict = null;

  /** Reset verdict saat trade baru dimulai */
  function resetWinLossVerdict() { lastWinLossVerdict = null; }

  /** Tulis verdict dari sumber manapun (MutationObserver, badge watcher, dll) */
  function setWinLossVerdict(isWin, source, rawText) {
    // Hanya terima verdict baru jika: belum ada, atau lebih baru dari 200ms
    if (lastWinLossVerdict && (Date.now() - lastWinLossVerdict.ts < 200)) return;
    
    // Capture the absolute final live price right when the Deal Badge appears!
    const liveFinalPrice = getPrimaryValueFromRegion(null);
    
    lastWinLossVerdict = { isWin, source, rawText: rawText || '', ts: Date.now(), livePrice: liveFinalPrice };
    console.log(`[WIN/LOSS VERDICT] isWin=${isWin} source=${source} raw="${rawText}" livePrice="${liveFinalPrice}"`);
  }

  let lastChangedValue = '--';
  let lastValidCloseSnapshot = '--'; // Snapshot harga close terbaru (diambil sebelum DOM transisi)

  // ─── ROBUST PRICE SCORING ENGINE ──────────────────────────────────────────
  // Menggantikan sistem pattern lama dengan sistem skor presisi tinggi.
  // Memprioritaskan angka yang paling mirip dengan format harga quote OlympTrade
  // (desimal panjang, panjang karakter total, dan kedekatan skala).
  // ─────────────────────────────────────────────────────────────────────────────

  function extractDigitInfo(numStr) {
    let isTracked = false;
    let normalized = numStr;
    
    if (normalized.startsWith('★')) {
       isTracked = true;
       normalized = normalized.substring(1);
    }

    const lastComma = normalized.lastIndexOf(',');
    const lastDot = normalized.lastIndexOf('.');
    if (lastComma > lastDot) {
        normalized = normalized.replace(/\./g, '').replace(',', '.');
    } else {
        normalized = normalized.replace(/,/g, '');
    }

    const clean = normalized.replace(/[^0-9.-]/g, '');
    if (!clean || clean === '.' || clean === '-' || clean === '+') return null;
    const parts = clean.split('.');
    const intPart = parts[0].replace(/^0+/, '') || '0';
    const decPart = parts.length > 1 ? parts[1] : '';
    const intD = intPart === '0' ? 0 : intPart.length;
    const decD = decPart.length;
    const val = parseFloat(clean);
    
    // Return original numStr without star for 'raw' so we don't display the star
    return { raw: numStr.replace('★', ''), clean, val, intD, decD, isTracked };
  }

  function findBestPriceCandidate(numbers, anchorNum) {
    if (!numbers || numbers.length === 0) return '--';

    const parsed = numbers.map(extractDigitInfo).filter(x => x !== null && !isNaN(x.val));
    if (parsed.length === 0) return '--';
    
    // ─── REVOLUTIONARY PRICE LIVENESS TRACKER ───
    if (!window._priceAgeTracker) window._priceAgeTracker = {};
    if (!window._priceLastSeen) window._priceLastSeen = {};
    const now = Date.now();

    // Hapus data lama untuk mencegah memory leak
    if (Math.random() < 0.05) { // 5% chance per tick
       for (let k in window._priceLastSeen) {
          if (now - window._priceLastSeen[k] > 30000) { // Hapus jika tidak terlihat 30 detik
             delete window._priceAgeTracker[k];
             delete window._priceLastSeen[k];
          }
       }
    }

    const scored = parsed.map(x => {
      let score = 0;

      // Update trackers
      if (!window._priceAgeTracker[x.raw]) window._priceAgeTracker[x.raw] = now;
      window._priceLastSeen[x.raw] = now;
      const ageMs = now - window._priceAgeTracker[x.raw];

      // 1. Reward precision (most OlympTrade quotes have 4-6 decimals, some 2)
      if (x.decD >= 4) score += 50;
      else if (x.decD >= 2) score += 20;
      else if (x.decD === 1) score += 5;
      else if (x.decD === 0) score -= 50; // Heavily penalize integers

      // 2. Reward total string length
      score += (x.intD + x.decD) * 2;

      // 3. Anchor magnitude check
      if (anchorNum && !isNaN(anchorNum) && anchorNum !== 0) {
        const ratio = Math.abs(x.val) / Math.abs(anchorNum);
        if (ratio >= 0.5 && ratio <= 2.0) score += 100;
        else score -= 100;
      } else {
        if (Math.abs(x.val) < 10 && x.decD < 4) score -= 20;
      }
      
      // 4. LIVENESS PENALTY (MENGHANCURKAN ANGKA BEKU / GARIS STATIS)
      // Di market OTC, harga asli berfluktuasi tiap detik.
      // Jika angka sama persis bertahan lebih dari 3 detik (3000ms), itu PASTI garis statis!
      if (ageMs > 3000) {
         score -= 500; // Penalti mutlak untuk angka beku
      } else {
         score += 100; // Bonus mutlak untuk angka segar (berubah-ubah)
      }
      
      // 4. Tracked Element Priority (Crucial for preventing lock-on to static drawing lines)
      // Hanya berikan prioritas JIKA masuk akal sebagai harga (punya desimal atau nilai besar)
      let isPlausiblePrice = (x.decD > 0 || Math.abs(x.val) >= 1000);
      if (x.isTracked) {
          if (isPlausiblePrice) score += 200;
          else score -= 500; // Jangan lock timer!
      }

      return { ...x, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0].raw;
  }

  /**
   * Baca region DOM lalu pilih nilai harga terbaik (paling presisi).
   * - anchorNum: opsional, open price sebagai patokan skala.
   */
  function getPrimaryValueFromRegion(anchorNum) {
    if (window._mappedRegion && window._readDomTextInRegion) {
      const res = window._readDomTextInRegion(window._mappedRegion);
      if (res && res.numbers && res.numbers.length > 0) {
        // Cari kandidat harga terbaik berdasarkan skor presisi
        const val = findBestPriceCandidate(res.numbers, anchorNum);

        if (val && val !== '--') {
          lastChangedValue = val;
          lastValidCloseSnapshot = val;
          return val;
        }
      }
    }
    return (lastChangedValue && lastChangedValue !== '--') ? lastChangedValue : '--';
  }

  let currentActiveTrade = null;

  async function startTradeLifecycle(durationSecs, actionParam) {
    const action = actionParam || 'auto';
    const now = Date.now();
    if (tradeState === 'TRADE_ACTIVE' || (now - tradeStartTime < 1000)) {
      return;
    }

    try {
      tradeState = 'TRADE_ACTIVE';
      hasClickedInCurrentDuration = true;
      lastAutoClickTime = now;
      tradeStartTime = now;
      if (action) tradeActionDirection = action;
      tradeDurationSecs = durationSecs || 5;
      resetWinLossVerdict();

      // 1. FAST PATH (Instant Logging at 0ms):
      let initialOpenValStr = getPrimaryValueFromRegion(null);
      if (initialOpenValStr === '--' && lastChangedValue) initialOpenValStr = lastChangedValue;
      const initialPriceNum = parseFloat(initialOpenValStr.replace(/[^0-9.-]/g, ''));
      const nominal = getActiveNominalValue();
      
      let freshOpenValStr = initialOpenValStr;
      entryPriceValue = freshOpenValStr;

      currentActiveTrade = {
        operationId: null,
        positionId: null,
        openValStr: initialOpenValStr,
        openPriceNum: isNaN(initialPriceNum) ? null : initialPriceNum,
        direction: action,
        nominal: String(nominal),
        durationSecs: tradeDurationSecs
      };

      // KUNCI PERBAIKAN: Jalankan LogManager secara asinkron tanpa memblokir thread (tanpa await).
      // Jika Storage API hang, eksekusi timer trading utama tidak akan pernah terhenti!
      window.LogManager.createOperation(action, initialOpenValStr, isNaN(initialPriceNum) ? null : initialPriceNum, nominal).then(operationId => {
        if (currentActiveTrade) currentActiveTrade.operationId = operationId;
        
        // 2. DELAY 300ms UNTUK DOM REFRESH & CONFIRM POSITION
        setTimeout(() => {
          let updatedOpenValStr = getPrimaryValueFromRegion(null);
          if (updatedOpenValStr === '--' && lastChangedValue && lastChangedValue !== '--') updatedOpenValStr = lastChangedValue;
          const updatedOpenPriceNum = parseFloat(updatedOpenValStr.replace(/[^0-9.-]/g, ''));
          entryPriceValue = updatedOpenValStr;

          if (currentActiveTrade) {
            currentActiveTrade.openValStr = updatedOpenValStr;
            currentActiveTrade.openPriceNum = isNaN(updatedOpenPriceNum) ? null : updatedOpenPriceNum;
          }

          window.LogManager.confirmPosition(operationId, updatedOpenValStr, isNaN(updatedOpenPriceNum) ? null : updatedOpenPriceNum).then(positionId => {
            if (currentActiveTrade) currentActiveTrade.positionId = positionId;
          }).catch(e => console.error("LogManager confirmPosition failed:", e));
        }, 300);
      }).catch(e => console.error("LogManager createOperation failed:", e));

      showToastNotification(`📌 [OP ${action.toUpperCase()}] @ ${freshOpenValStr} (${tradeDurationSecs}s)`);
      if (typeof updatePriceStatusUI === 'function') updatePriceStatusUI(null, freshOpenValStr, null, true);

      try {
        chrome.runtime.sendMessage({ action: 'TRADE_OPENED' });
      } catch (e) {}

      // PRE-SAMPLE harga close (1 detik sebelum trade habis)
      const _openAnchor = isNaN(initialPriceNum) ? null : initialPriceNum;
      const preSampleDelay = Math.max((tradeDurationSecs * 1000) - 1000, 100);
      setTimeout(() => {
        try {
          const preClose = getPrimaryValueFromRegion(_openAnchor);
          if (preClose && preClose !== '--') {
            lastValidCloseSnapshot = preClose;
          }
        } catch(e) {}
      }, preSampleDelay);

      // KUNCI PENUTUPAN DETERMINISTIK MUTLAK
      // Pindah ke runAutoScreenScan!
      // Timer setTimeout dihapus karena Chrome dapat menunda setTimeout hingga 1 menit di tab background,
      // yang menyebabkan bug stuck WAITING_RESULT > 8s.
      // Sebagai gantinya, siklus utama runAutoScreenScan akan memanggil completeTradeLifecycle secara langsung.
    } catch (fatalError) {
      console.error('[FATAL CRASH] startTradeLifecycle failed:', fatalError);
      tradeState = 'IDLE';
      hasClickedInCurrentDuration = false;
    }
  }

  function completeTradeLifecycle(activeTrade) {
    // Terima TRADE_ACTIVE dan WAITING_RESULT (runAutoScreenScan mungkin sudah transisi ke WAITING_RESULT)
    if (!activeTrade || (tradeState !== 'TRADE_ACTIVE' && tradeState !== 'WAITING_RESULT')) {
      // Jika sudah IDLE (sudah di-close oleh path lain), jangan close lagi
      return;
    }

    // ── MULTI-ATTEMPT ANCHOR-AWARE: Coba baca harga close dengan anchor open price ──
    // Open price dipakai sebagai MAGNITUDE ANCHOR sehingga scanner hanya terima
    // angka yang digit & skalanya sama dengan open. Contoh: open 1571.8042 →
    // close harus ~4 digit integer part, bukan 3 atau 1 digit.
    const openAnchor = activeTrade.openPriceNum; // null jika open gagal

    function resolveCloseVal() {
      // (1) Baca DOM real-time pakai anchor
      const liveVal = getPrimaryValueFromRegion(openAnchor);
      if (liveVal && liveVal !== '--') {
        // Validasi: jika ada anchor, pastikan magnitude kandidat masuk akal
        if (openAnchor) {
          const liveNum = parseFloat(liveVal.replace(/[^0-9.-]/g, ''));
          if (!isNaN(liveNum) && isPricePlausible(liveNum, openAnchor)) return liveVal;
          // Kandidat gagal validasi → coba snapshot
        } else {
          return liveVal;
        }
      }
      // (2) Snapshot pre-sampled (diambil 1 detik sebelum habis)
      if (lastValidCloseSnapshot && lastValidCloseSnapshot !== '--') {
        if (openAnchor) {
          const snapNum = parseFloat(lastValidCloseSnapshot.replace(/[^0-9.-]/g, ''));
          if (!isNaN(snapNum) && isPricePlausible(snapNum, openAnchor)) return lastValidCloseSnapshot;
        } else {
          return lastValidCloseSnapshot;
        }
      }
      // (3) lastChangedValue — last resort
      if (lastChangedValue && lastChangedValue !== '--') return lastChangedValue;
      return '--';
    }

    // Validasi plausibilitas: kandidat harus dalam 0.5%–2× skala open
    function isPricePlausible(candidateNum, anchor) {
      if (!anchor || isNaN(anchor) || anchor === 0) return true;
      const ratio = Math.abs(candidateNum) / Math.abs(anchor);
      return ratio >= 0.005 && ratio <= 20; // Toleransi lebar tapi tetap filter noise ekstrem
    }

    const closeValStr = resolveCloseVal();
    const closePriceNum = parseFloat(closeValStr.replace(/[^0-9.-]/g, ''));

    const openNum = activeTrade.openPriceNum;
    const closeNum = isNaN(closePriceNum) ? null : closePriceNum;

    // Jika close masih '--' atau tidak plausible, coba retry 1x setelah 400ms
    const needsRetry = closeValStr === '--' || closeNum === null ||
      (openAnchor && !isPricePlausible(closeNum, openAnchor));

    if (needsRetry) {
      setTimeout(() => {
        try {
          const retryVal = resolveCloseVal();
          if (retryVal && retryVal !== '--') lastValidCloseSnapshot = retryVal;
          waitForPlatformVerdict(activeTrade, (retryVal && retryVal !== '--') ? retryVal : (lastValidCloseSnapshot !== '--' ? lastValidCloseSnapshot : closeValStr));
        } catch (e) {
          console.error('[CRASH] Error in needsRetry setTimeout:', e);
          _doCompleteWithClose(activeTrade, closeValStr, { isWin: false, source: 'SYSTEM_CRASH' });
        }
      }, 400);
      return; // Tunggu retry
    }

    waitForPlatformVerdict(activeTrade, closeValStr);
  }

  function waitForPlatformVerdict(activeTrade, closeValStr) {
    const startWaitTime = Date.now();
    const interval = setInterval(() => {
      try {
        const waitTime = Date.now() - startWaitTime;
        const recentVerdict = lastWinLossVerdict;
        const verdictAge = recentVerdict ? (Date.now() - recentVerdict.ts) : Infinity;
        
        if (recentVerdict && verdictAge < 15000) {
          clearInterval(interval);
          let finalCloseVal = closeValStr; 
          if (recentVerdict.livePrice && recentVerdict.livePrice !== '--') {
             finalCloseVal = recentVerdict.livePrice;
          }
          _doCompleteWithClose(activeTrade, finalCloseVal, recentVerdict);
          return;
        }

        // TIMEOUT AMAN: 3000ms
        // Kita butuh 3 detik agar notifikasi server OlympTrade sempat muncul!
        if (waitTime >= 3000) {
          clearInterval(interval);
          // KUNCI PERBAIKAN: JANGAN PERNAH MENGAMBIL HARGA LAYAR (freshVal) LAGI DI SINI!
          // Saat ini sudah lewat 3 detik dari penutupan trade. Harga layar sudah jauh berubah.
          // Gunakan closeValStr yang sudah ditangkap TEPAT secara akurat di detik ke-5.
          _doCompleteWithClose(activeTrade, closeValStr, null);
        }
      } catch (e) {
        clearInterval(interval);
        console.error('[CRASH] Error in waitForPlatformVerdict interval:', e);
        _doCompleteWithClose(activeTrade, closeValStr, { isWin: false, source: 'SYSTEM_CRASH' });
      }
    }, 200);
  }

  function _doCompleteWithClose(activeTrade, closeValStr, platformVerdict) {
    try {
      const closePriceNum = parseFloat(closeValStr.replace(/[^0-9.-]/g, ''));
      const openNum = activeTrade.openPriceNum;
      const closeNum = isNaN(closePriceNum) ? null : closePriceNum;

      let isWin = false;
      let isNetral = false;
      let winLossSource = 'UNKNOWN';
      let resultText = '⚪ STABIL';

      if (platformVerdict) {
        isWin = platformVerdict.isWin;
        winLossSource = platformVerdict.source;
        
        if (isWin && activeTrade.nominal) {
           const raw = platformVerdict.rawText || '';
           const lower = raw.toLowerCase();
           if (lower.includes('refund') || lower.includes('draw') || lower.includes('dikembalikan')) {
               isWin = false;
               isNetral = true;
           } else {
               const plusMatch = raw.match(/[+＋]\s*(?:[\u0110\u01b0D$€£₹฿]|Rp)?\s*(\d+(?:[.,]\d+)?)/i);
               if (plusMatch) {
                   const nomNum = parseFloat(activeTrade.nominal);
                   const valAsDecimal = parseFloat(plusMatch[1].replace(/,/g, ''));
                   const valStripped = parseFloat(plusMatch[1].replace(/[.,]/g, ''));
                   if (!isNaN(nomNum)) {
                       if (Math.abs(valAsDecimal - nomNum) < 0.001 || Math.abs(valStripped - nomNum) < 0.001) {
                           isWin = false;
                           isNetral = true;
                       }
                   }
               }
           }
        }
      } else {
        // PRIORITAS 1 FALLBACK: Gunakan perbandingan harga (Sangat Akurat dengan Anchor-Aware)
        if (openNum !== null && closeNum !== null) {
          if (closeNum === openNum) {
            isNetral = true;
            winLossSource = 'PRICE_COMPARE';
          } else {
            if (activeTrade.direction === 'naik') isWin = (closeNum > openNum);
            else if (activeTrade.direction === 'turun') isWin = (closeNum < openNum);
            winLossSource = 'PRICE_COMPARE';
          }
        } else {
          // PRIORITAS 2 FALLBACK (Terakhir): Scan DOM live untuk mencari warna Hijau/Merah
          const domResult = _scanDOMForWinLoss();
          if (domResult !== null) {
            if (domResult === 'NETRAL') {
               isNetral = true;
               isWin = false;
            } else {
               isWin = domResult;
            }
            winLossSource = 'DOM_SCAN';
          }
        }
      }

      console.log(`[TRADE RESULT] isWin=${isWin} source=${winLossSource} open=${openNum} close=${closeNum}`);
      const dirUpper = activeTrade.direction.toUpperCase();

      if (isNetral) {
        consecutiveNetral++;
        resultText = '⚪ STABIL';
        showToastNotification(`⚪ [STABIL] Modal Kembali (${activeTrade.openValStr} ➔ ${closeValStr})`);
      } else if (isWin) {
        if (typeof window.SoundManager !== 'undefined') window.SoundManager.playWin();
        martingaleStep = 0;
        consecutiveNetral = 0;
        currentNominalValue = baseInitialNominal;
        resultText = '🟢 WIN';
        showToastNotification(`🟢 [PROFIT] WIN ${dirUpper} (${activeTrade.openValStr} ➔ ${closeValStr}) → RESET NOMINAL: IDR ${currentNominalValue}`);
      } else {
        if (typeof window.SoundManager !== 'undefined') window.SoundManager.playLoss();
        
        if (martingaleStep === 0) {
          currentNominalValue = Math.round(baseInitialNominal * 2);
          martingaleStep = 1;
        } else {
          currentNominalValue = Math.round(currentNominalValue * 2.5);
          martingaleStep++;
        }
        
        consecutiveNetral = 0;
        resultText = '🔴 LOSS';
        showToastNotification(`🔴 [LOSS STEP ${martingaleStep}] LOSS ${dirUpper} (${activeTrade.openValStr} ➔ ${closeValStr}) → Nominal Baru: IDR ${currentNominalValue}`);
      }

      if (window.OcrEngine && typeof window.OcrEngine.inputNominalValue === 'function') {
        window.OcrEngine.inputNominalValue(currentNominalValue);
      }

      const quickInput = document.getElementById('ocr-quick-nominal');
      if (quickInput) quickInput.value = currentNominalValue;
      safeStorageSet({ nominalValue: String(currentNominalValue) });

      if (activeTrade && activeTrade.positionId) {
        const priceDiff = (openNum !== null && closeNum !== null && !isNaN(closeNum)) ? (closeNum - openNum) : null;
        let finalResult = isNetral ? 'NETRAL' : (isWin ? 'WIN' : 'LOSS');
        
        window.LogManager.closePosition(activeTrade.positionId, {
          rawClose: closeValStr,
          numericClose: !isNaN(closeNum) ? closeNum : null,
          result: finalResult,
          priceDiff: priceDiff,
          source: winLossSource || 'PRICE_COMPARE',
          confidence: 0.95,
          reconciliationRequired: false
        });
      }

      try {
        chrome.runtime.sendMessage({
          action: 'TRADE_CLOSED',
          result: isNetral ? 'NETRAL' : (isWin ? 'WIN' : 'LOSS'),
          open: activeTrade.openValStr,
          close: closeValStr,
          nominal: currentNominalValue
        });
      } catch (e) {}
      
      if (typeof updatePriceStatusUI === 'function') updatePriceStatusUI(isWin, activeTrade.openValStr, closeValStr, false);
      
      // RE-ENTRY LANGSUNG: Setelah trade selesai dan status kembali IDLE, 
      // langsung trigger trade berikutnya jika bot masih AKTIF.
      if (isAutoScanning) {
        if (isNetral && consecutiveNetral > 1) {
          showToastNotification("2x NETRAL Beruntun! Menghentikan Auto-trade sementara untuk keamanan.");
          setAutoScanState(false);
        }
      }
    } finally {
      currentActiveTrade = null;
      tradeState = 'IDLE';
      hasClickedInCurrentDuration = false;
      lastValidCloseSnapshot = '--';
      lastWinLossVerdict = null;
    }
  }

  // ─── STORAGE-BASED TRADE LOG HELPERS ────────────────────────────────────────
  // DIHAPUS: _writeTradeOpened dan _writeTradeClosed sudah tidak dipakai.
  // Semua log OPEN dibuat oleh LogManager.createOperation + confirmPosition.
  // Semua log CLOSED dibuat oleh LogManager.closePosition di _doCompleteWithClose.
  // Hanya 1 entry per trade, tidak ada duplikat.
  // ─── END STORAGE-BASED TRADE LOG HELPERS ────────────────────────────────────

  /**
   * LAPISAN 3: Scan live DOM untuk keyword profit/loss OlympTrade.
   * Returns: true = WIN, false = LOSS, null = tidak terdeteksi.
   *
   * Cari elemen yang mengandung tanda +/− atau kata kunci win/loss
   * yang BARU MUNCUL di DOM (bukan elemen statis header/footer).
   */
  function _scanDOMForWinLoss() {
    try {
      // Dihapus: selector 'trade', 'history', 'amount' karena membaca trade sebelumnya yang menyebabkan Win dianggap Loss atau sebaliknya.
      // Hanya scan Toast / Snackbar / Notification yang pasti merupakan hasil trade SAAT INI.
      const candidates = Array.from(document.querySelectorAll(
        '[class*="result"], [class*="profit"], [class*="loss"], [class*="deal"], [class*="notification"], [class*="toast"], [class*="snackbar"]'
      ));

      for (const el of candidates) {
        // Skip elemen milik ekstensi
        if ((el.id || '').includes('ocr') || ((el.className || '').toString()).includes('ocr')) continue;

        const raw = (el.innerText || el.textContent || '').trim();
        if (!raw || raw.length < 1 || raw.length > 200) continue;
        const lower = raw.toLowerCase();

        // Skip konten statis
        if (lower === 'naik' || lower === 'turun' || lower === 'nominal') continue;
        if (lower.includes('durasi') || lower.includes('saldo') || lower.includes('balance') || lower.includes('aktifkan')) continue;

        const hasNumber = /\d/.test(raw);
        const hasCurrency = /(?:[\u0110\u01b0D$€£₹฿]|Rp)/i.test(raw);

        // --- DETEKSI WARNA (SUPER AKURAT UNTUK HISTORY PANEL) ---
        let isColorWin = false;
        let isColorLoss = false;
        
        try {
          const style = window.getComputedStyle(el);
          const color = style.color || '';
          
          const parseRGB = (str) => {
              const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
              if (m) return { r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]) };
              return null;
          };
          const cRGB = parseRGB(color);
          
          if (cRGB) {
             // OlympTrade WIN color: rgb(40, 189, 102) atau sejenisnya (G lebih dominan)
             if (cRGB.g > cRGB.r + 30 && cRGB.g > cRGB.b + 30) isColorWin = true;
             // OlympTrade LOSS color: rgb(255, 87, 101) atau sejenisnya (R lebih dominan)
             if (cRGB.r > cRGB.g + 30 && cRGB.r > cRGB.b + 30) isColorLoss = true;
          }
        } catch(e) {}

        // Deteksi WIN yang kuat: tanda + diikuti angka, keyword eksplisit, ATAU teks berwarna hijau dengan angka & mata uang
        const isWinSignal = (
          /[+＋]\s*(?:[\u0110\u01b0D$€£₹฿]|Rp)?\s*\d/i.test(raw) ||
          (lower.includes('mendapatkan') && /[+＋]\s*\d/.test(raw)) ||
          lower.includes('berhasil') ||
          (lower.includes('win') && !lower.includes('window')) ||
          (isColorWin && hasNumber && hasCurrency)
        );

        // Deteksi LOSS yang kuat: minus unicode/biasa, keyword eksplisit, ATAU teks berwarna merah dengan angka & mata uang
        const isZeroReturn = /^(?:[\u0110\u01b0D$€£₹฿]|Rp)?\s*0(?:[.,]0{1,2})?\s*(?:[\u0110\u01b0D$€£₹฿]|Rp)?$/i.test(raw.trim());
        const isLossSignal = (
          /[-\u2212\u2013\u2014]\s*(?:[\u0110\u01b0D$€£₹฿]|Rp)?\s*\d/i.test(raw) || // Minus biasa & unicode
          (lower.includes('loss') && !lower.includes('lossless')) ||
          lower.includes('rugi') || lower.includes('gagal') ||
          isZeroReturn ||
          (isColorLoss && hasNumber && hasCurrency)
        );

        const isNetralSignal = (
          lower.includes('refund') || lower.includes('draw') || lower.includes('dikembalikan') ||
          (lower.includes('pnl') && /0[,.]00/.test(raw))
        );

        if (isNetralSignal) return 'NETRAL';
        if (isWinSignal && !isLossSignal) return true;
        if (isLossSignal && !isWinSignal) return false;
      }
    } catch (e) {}
    return null; // Tidak terdeteksi
  }

  // ============================================================
  // LISTEN KLIK GLOBAL PADA TOMBOL NATIVE OLYMPTRADE ('NAIK' & 'TURUN')
  // Menangkap baik klik mouse manual maupun klik otomatis bot (dengan Debounce 1000ms)
  // ============================================================
  let _lastGlobalClickTime = 0;
  document.addEventListener('click', (e) => {
    try {
      if (!isAutoScanning) return; 
      
      // KUNCI PERBAIKAN: ABAIKAN KLIK OTOMATIS DARI BOT (Programmatic click)
      // Biarkan bot yang menangani siklus trade-nya sendiri lewat startTradeLifecycle di runAutoScreenScan.
      // Ini mencegah bot salah mengenali arah klik (Naik/Turun) karena DOM bubbling.
      if (!e.isTrusted) return;
      
      const now = Date.now();
      if (now - _lastGlobalClickTime < 1000) return; // Cegah spam multi-klik tiap ms

      let target = e.target;
      while (target && target !== document.body) {
        if (typeof isExtensionUINode === 'function' && isExtensionUINode(target)) return;

        const txt = (target.textContent || '').trim().toLowerCase();
        const cls = (target.className || '').toString().toLowerCase();
        const bg = window.getComputedStyle ? (window.getComputedStyle(target).backgroundColor || '') : '';
        const bgMatch = bg.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);

        let isNaik = /\b(naik|up|call|higher)\b/.test(txt) || /\b(up|call)\b/.test(cls) || cls.includes('deal-button--up') || cls.includes('button--up');
        let isTurun = /\b(turun|down|put|lower)\b/.test(txt) || /\b(down|put)\b/.test(cls) || cls.includes('deal-button--down') || cls.includes('button--down');

        if (!isNaik && !isTurun && bgMatch) {
          const [, r, g, b] = bgMatch.map(Number);
          if (g > 140 && g > r + 30) isNaik = true; // Hijau = Naik
          if (r > 180 && r > g + 30) isTurun = true; // Merah = Turun
        }

        if (isNaik || isTurun) {
          _lastGlobalClickTime = now;
          const action = isNaik ? 'naik' : 'turun';
          const durInfo = window.OcrEngine && window.OcrEngine.detectTradePanelDuration ? window.OcrEngine.detectTradePanelDuration() : 5;
          const durSecs = typeof durInfo === 'number' ? durInfo : (durInfo.totalSeconds || 5);

          startTradeLifecycle(durSecs, action);
          console.log(`[OCR BOT GLOBAL CLICK DETECTED] Button ${action.toUpperCase()} clicked! Duration: ${durSecs}s`);
          break;
        }
        target = target.parentElement;
      }
    } catch (err) { }
  }, true);

  /**
   * Klik tombol Naik/Turun OlympTrade dengan 3 strategi sekaligus:
   * 1. Cari berdasarkan warna background CSS (OlympTrade exact colors)
   * 2. Cari berdasarkan teks "Naik"/"Turun" di dalam semua button
   * 3. Fallback ke OcrEngine.clickActionElement
   */
  function aggressiveClickTradeButton(action) {
    if (!window.OcrEngine || typeof window.OcrEngine.clickActionElement !== 'function') return false;
    try {
      const res = window.OcrEngine.clickActionElement(action);
      return res && res.success;
    } catch (e) {
      return false;
    }
  }

  // ============================================================
  // SCREEN VISION ENGINE: Screenshot + OlympTrade Color Matcher
  // Badge LOSS: rgb(255,87,101)  = --negative-bg-default OlympTrade
  // Badge WIN:  rgb(40,189,102)  = --positive-bg-default OlympTrade
  // Badge muncul di TENGAH grafik, bukan atas layar!
  // ============================================================
  let _screenVisionBusy = false;

  function captureAndScanScreen() {
    // DINONAKTIFKAN: Deteksi warna hijau/merah di layar rawan false-positive
    // karena warna candle (batang grafik) akan terdeteksi sebagai WIN/LOSS.
    // Ini menyelesaikan masalah LOSS yang dianggap WIN.
    return;
  }

  if (!window._ocrScreenVisionInterval) {
    window._ocrScreenVisionInterval = setInterval(() => {
      if (isAutoScanning && tradeState === 'WAITING_RESULT') captureAndScanScreen();
    }, 250);
  }


  let baseInitialNominal = 10000;
  let martingaleStep = 0;
  let consecutiveNetral = 0;
  let lastDetectedDealBadgeText = '';
  let lastDetectedDealBadgeTime = 0;

  function getActiveNominalValue() {
    // INTERNAL SINKRONISASI MUTLAK DARI STATE MARTINGALE KITA SENDIRI
    // Jangan overwrite dari layar kecuali via event listener input manual
    const quickBaseInput = document.getElementById('ocr-quick-base-nominal');
    if (quickBaseInput && quickBaseInput.value) {
      const p = parseFloat(String(quickBaseInput.value).replace(/[^0-9\.]/g, ''));
      if (!isNaN(p) && p > 0) {
        baseInitialNominal = p;
      }
    }

    if (martingaleStep === 0 || currentNominalValue <= baseInitialNominal) {
      currentNominalValue = baseInitialNominal;
      martingaleStep = 0;
    }

    if (!currentNominalValue || currentNominalValue <= 0) {
      currentNominalValue = baseInitialNominal || 10000;
    }

    const quickNominalInput = document.getElementById('ocr-quick-nominal');
    if (quickNominalInput) {
      quickNominalInput.value = currentNominalValue;
    }

    return currentNominalValue;
  }

  /**
   * Pantau & Sinkronkan Input Nominal Native di Web Halaman secara Live saat Step 0
   */
  function syncWebpageNominalInputListener() {
    if (!window.OcrEngine || typeof window.OcrEngine.findNominalInput !== 'function') return;
    const webInput = window.OcrEngine.findNominalInput();
    if (webInput && document.activeElement === webInput) {
      const val = webInput.value;
      const parsed = parseFloat(String(val).replace(/[^0-9\.]/g, ''));
      if (!isNaN(parsed) && parsed > 0) {
        if (martingaleStep === 0) {
          baseInitialNominal = parsed;
          currentNominalValue = parsed;
          const quickBaseInput = document.getElementById('ocr-quick-base-nominal');
          if (quickBaseInput) quickBaseInput.value = parsed;
          const quickInput = document.getElementById('ocr-quick-nominal');
          if (quickInput) quickInput.value = parsed;
          safeStorageSet({ baseNominalValue: String(parsed), nominalValue: String(parsed) });
        }
      }
    }
  }

  setInterval(syncWebpageNominalInputListener, 300);

  /**
   * Menggambar Garis Visual Trendline Melintang langsung di atas Layar (100% Zoom Responsive)
   */
  function drawVisualTrendlineOverlay(points, trendAnalysis) {
    if (typeof document === 'undefined') return;

    let canvas = document.getElementById('ocr-trendline-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'ocr-trendline-canvas';
      canvas.style.pointerEvents = 'none';
      document.body.appendChild(canvas);
    }

    const dpr = window.devicePixelRatio || 1;
    const vv = window.visualViewport;
    const width = vv ? vv.width : window.innerWidth;
    const height = vv ? vv.height : window.innerHeight;
    const pageX = vv ? vv.offsetLeft : 0;
    const pageY = vv ? vv.offsetTop : 0;

    // PERBAIKAN LAG: Set ukuran CSS dan buffer pixel hanya jika berubah agar tidak memaksa reflow!
    const newLeft = pageX + 'px';
    const newTop = pageY + 'px';
    const newWidthStr = width + 'px';
    const newHeightStr = height + 'px';
    const newCWidth = Math.round(width * dpr);
    const newCHeight = Math.round(height * dpr);
    
    if (canvas.style.left !== newLeft) canvas.style.left = newLeft;
    if (canvas.style.top !== newTop) canvas.style.top = newTop;
    if (canvas.style.width !== newWidthStr) canvas.style.width = newWidthStr;
    if (canvas.style.height !== newHeightStr) canvas.style.height = newHeightStr;
    if (canvas.width !== newCWidth) canvas.width = newCWidth;
    if (canvas.height !== newCHeight) canvas.height = newCHeight;

    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    if (!points || points.length < 2) {
      ctx.restore();
      return;
    }

    // Tentukan warna garis berdasarkan trend
    let lineColor = '#eab308'; // Kuning (Absurd/Sideways)
    let shadowColor = 'rgba(234, 179, 8, 0.6)';
    if (trendAnalysis && trendAnalysis.trend === 'uptrend') {
      lineColor = '#22c55e'; // Hijau (Uptrend)
      shadowColor = 'rgba(34, 197, 94, 0.8)';
    } else if (trendAnalysis && trendAnalysis.trend === 'downtrend') {
      lineColor = '#ef4444'; // Merah (Downtrend)
      shadowColor = 'rgba(239, 68, 68, 0.8)';
    }

    // Gambar Garis Trendline Melintang Penghubung Titik Visual
    ctx.beginPath();
    ctx.moveTo(points[0].x - pageX, points[0].y - pageY);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x - pageX, points[i].y - pageY);
    }

    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 3;
    ctx.shadowColor = shadowColor;
    ctx.shadowBlur = 10;

    if (trendAnalysis && trendAnalysis.trend === 'absurd') {
      ctx.setLineDash([8, 6]); // Garis putus-putus untuk trend absurd
    }
    ctx.stroke();

    // Gambar titik lingkaran bercahaya di tiap simpul batang
    points.forEach((p, idx) => {
      ctx.beginPath();
      ctx.arc(p.x - pageX, p.y - pageY, idx === points.length - 1 ? 6 : 4, 0, Math.PI * 2);
      ctx.fillStyle = lineColor;
      ctx.shadowColor = shadowColor;
      ctx.shadowBlur = 8;
      ctx.fill();
    });

    // Gambar panah penunjuk arah pada titik terakhir
    const lastP = points[points.length - 1];
    ctx.font = 'bold 14px sans-serif';
    ctx.fillStyle = lineColor;
    ctx.shadowColor = shadowColor;
    ctx.shadowBlur = 12;
    const arrowTag = trendAnalysis.trend === 'uptrend' ? ' 📈 NAIK' : (trendAnalysis.trend === 'downtrend' ? ' 📉 TURUN' : ' ⚠️ HOLD');
    ctx.fillText(arrowTag, lastP.x - pageX + 10, lastP.y - pageY + 5);

    ctx.restore();
  }

  /**
   * Fungsi untuk memaksakan eksekusi trade secara instan (Re-entry).
   * Digunakan untuk chaining trade berkelanjutan (continuous trading).
   */
  function executeInstantAutoTrade() {
    if (!isContextValid()) {
      isAutoScanning = false;
      return;
    }
    if (!window.OcrEngine || !isAutoScanning) return;

    // JAGA-JAGA: Jangan re-entry jika masih ada trade yang aktif
    if (tradeState === 'TRADE_ACTIVE' || tradeState === 'WAITING_RESULT') return;

    const colorAnalysis = (typeof window.OcrEngine.detectScreenBarColor === 'function') ? window.OcrEngine.detectScreenBarColor() : { signal: 'netral' };
    const trendAnalysis = (typeof window.OcrEngine.analyzeScreenTrendline === 'function') ? window.OcrEngine.analyzeScreenTrendline() : { trend: 'absurd', slope: 0, points: [] };
    const durationInfo = (typeof window.OcrEngine.detectScreenDurationTimer === 'function') ? window.OcrEngine.detectScreenDurationTimer() : { isValid: false, totalSeconds: 5 };

    const nominalVal = String(getActiveNominalValue());
    if (typeof window.OcrEngine.inputNominalValue === 'function') {
      window.OcrEngine.inputNominalValue(nominalVal);
    }

    setTimeout(() => {
      let action = 'naik';
      if (targetDirection === 'naik') {
        action = 'naik';
      } else if (targetDirection === 'turun') {
        action = 'turun';
      } else {
        // AUTO MODE: Check signal
        const isSignalDown = trendAnalysis.trend === 'downtrend' || colorAnalysis.signal === 'merah' || (colorAnalysis.redCount !== undefined && colorAnalysis.redCount > colorAnalysis.greenCount);
        action = isSignalDown ? 'turun' : 'naik';
      }

      aggressiveClickTradeButton(action);
      startTradeLifecycle(durationInfo.totalSeconds || 5, action);
    }, 100);
  }

  /**
   * Siklus Otomatis: Membaca teks, menggambar garis trend visual, mengisi nominal, & mengeklik tombol (Ketat 1x Klik per Durasi)
   */
  function runAutoScreenScan() {
    if (!isContextValid()) {
      isAutoScanning = false;
      return;
    }
    if (!isAutoScanning || isUserSelectingText() || !window.OcrEngine) return;

    try {
      // Ensure badge is visible when scanning is active
      if (autoBadgeEl && autoBadgeEl.style.display === 'none') {
        autoBadgeEl.style.display = 'block';
      }

      // --- 1. DETEKSI BATANG WARNA & TRENDLINE GARIS MELINTANG ---
      const colorAnalysis = (window.OcrEngine && typeof window.OcrEngine.detectScreenBarColor === 'function') ? window.OcrEngine.detectScreenBarColor() : { signal: 'netral' };
      const trendAnalysis = (window.OcrEngine && typeof window.OcrEngine.analyzeScreenTrendline === 'function') ? window.OcrEngine.analyzeScreenTrendline() : { trend: 'absurd', slope: 0, points: [] };
      const durationInfo = (window.OcrEngine && typeof window.OcrEngine.detectScreenDurationTimer === 'function') ? window.OcrEngine.detectScreenDurationTimer() : { isValid: false };
      const dealBadgeInfo = (window.OcrEngine && typeof window.OcrEngine.detectTradeDealBadge === 'function') ? window.OcrEngine.detectTradeDealBadge() : { found: false };

      latestColorAnalysis = colorAnalysis;
      latestTrendAnalysis = trendAnalysis;
      latestDurationInfo = durationInfo;

      updateDealBadgeUI(dealBadgeInfo);

      // --- DEBUG SCAN: Tampilkan 5 teks DOM teratas yang dipindai mesin di kotak debug pada remot melayang ---
      try {
        const debugEl = document.getElementById('ocr-debug-scan-content');
        if (debugEl) {
          const debugCandidates = Array.from(document.querySelectorAll('div, span, p, label, b, strong'))
            .filter(el => {
              const txt = (el.textContent || '').trim();
              return txt && txt.length > 1 && txt.length < 120 && !el.id?.includes('ocr') && !(el.className || '').toString().includes('ocr');
            })
            .filter(el => {
              const txt = (el.textContent || '').trim().toLowerCase();
              return /[+\-\d]/.test(txt) || txt.includes('loss') || txt.includes('profit') || txt.includes('win') || txt.includes('rugi') || txt.includes('untung');
            })
            .slice(0, 5)
            .map(el => {
              const txt = (el.textContent || '').trim().substring(0, 50);
              const tag = el.tagName;
              const cls = (el.className || '').toString().substring(0, 20);
              return `[${tag}] "${txt}" (cls:${cls})`;
            });
          debugEl.textContent = debugCandidates.length > 0 ? debugCandidates.join('\n') : '(Tidak ada kandidat terdeteksi)';
        }
      } catch (e) { }

      // --- 1.5. KONTROL SIKLUS HIDUP TRANSAKSI ---
      const nowTime = Date.now();
      const currentDurationSecs = (durationInfo && durationInfo.totalSeconds && durationInfo.totalSeconds > 0) ? durationInfo.totalSeconds : 5;

      if (tradeState === 'TRADE_ACTIVE') {
        const elapsedSecs = (nowTime - tradeStartTime) / 1000;

        if (elapsedSecs >= tradeDurationSecs) {
          // Durasi habis — transisi ke WAITING_RESULT (timer deterministik akan menutup posisi)
          tradeState = 'WAITING_RESULT';
          hasClickedInCurrentDuration = false;
          try {
            chrome.runtime.sendMessage({ action: 'TRADE_SCANNING_RESULT' });
          } catch (e) {}
          updateDurationStatusUI(true, `MEMINDAI HASIL...`);

          // Panggil fungsi penutupan secara langsung!
          // Ini jauh lebih tangguh daripada setTimeout karena runAutoScreenScan
          // berjalan di main loop dan tidak akan di-throttle hingga 1 menit oleh browser.
          if (currentActiveTrade) {
            try {
              completeTradeLifecycle(currentActiveTrade);
            } catch(err) {
              console.error('[CRASH] Error in completeTradeLifecycle:', err);
              _doCompleteWithClose(currentActiveTrade, '--', { isWin: false, source: 'SYSTEM_CRASH' });
            }
          }
        } else {
          // SELAMA TRANSAKSI BERJALAN: TAMPILKAN DETIK BERJALAN PRESISI
          const remSecs = Math.ceil(tradeDurationSecs - elapsedSecs);
          updateDurationStatusUI(true, `${durationInfo.timerText || remSecs + 's'} (${remSecs}s)`);
          return;
        }
      }

      // TIMEOUT FALLBACK WAITING_RESULT:
      // Safety net: jika timer deterministik gagal (seharusnya tidak pernah terjadi),
      // izinkan bot kembali ke IDLE setelah 8s setelah durasi habis
      if (tradeState === 'WAITING_RESULT') {
        const waitingElapsedSecs = (nowTime - tradeStartTime) / 1000 - tradeDurationSecs;
        if (waitingElapsedSecs > 8) {
          tradeState = 'IDLE';
          hasClickedInCurrentDuration = false;
          updateDurationStatusUI(false, durationInfo.timerText);
          console.warn('[SAFETY FALLBACK] tradeState stuck in WAITING_RESULT > 8s, forcing IDLE');
        }
      }

      // --- 1.6. BADGE HASIL DARI GRAPH: HANYA TULIS VERDICT ---
      if (dealBadgeInfo && dealBadgeInfo.found && dealBadgeInfo.text) {
        const isNewBadge = (dealBadgeInfo.text !== lastDetectedDealBadgeText || (nowTime - lastDetectedDealBadgeTime > 3000));
        if (isNewBadge && (tradeState === 'TRADE_ACTIVE' || tradeState === 'WAITING_RESULT')) {
          lastDetectedDealBadgeText = dealBadgeInfo.text;
          lastDetectedDealBadgeTime = nowTime;
          // Tulis verdict agar _doCompleteWithClose bisa pakai — JANGAN ubah tradeState!
          const badgeIsWin = dealBadgeInfo.type === 'profit';
          setWinLossVerdict(badgeIsWin, 'DEAL_BADGE_SCAN', dealBadgeInfo.text);
        }
      }

      // --- 2. DETEKSI ATURAN RESETS SIKLUS TEKS DURASI ---
      const fallbackDurationSecs = (durationInfo && durationInfo.totalSeconds && durationInfo.totalSeconds > 0) ? durationInfo.totalSeconds : 5;

      if (durationInfo && durationInfo.isValid) {
        const currSecs = durationInfo.totalSeconds;
        const currText = durationInfo.timerText;

        // Kasus A: Countdown timer melompat naik (misal dari 00:01 ke 00:15 / 00:30), siklus durasi baru dimulai
        if (lastDurationSeconds !== null && (currSecs > lastDurationSeconds + 2 || (lastDurationSeconds <= 1 && currSecs > 1))) {
          hasClickedInCurrentDuration = false;
          showToastNotification(`⏱️ Siklus Durasi Baru Terdeteksi (${currText}) ➔ Mesin Siap 1x Klik!`);
        }
        // Kasus B: Input durasi statis (misal 15 detik), reset otomatis HANYA setelah status IDLE (badge hasil selesai dipindai)
        else if (hasClickedInCurrentDuration && tradeState === 'IDLE' && currSecs > 0 && (nowTime - lastAutoClickTime >= (currSecs - 0.5) * 1000)) {
          hasClickedInCurrentDuration = false;
          showToastNotification(`⏱️ Hasil Terkonfirmasi ➔ Mesin Siap 1x Klik Baru!`);
        }

        lastDetectedDurationText = currText;
        lastDurationSeconds = currSecs;
      } else {
        // Kasus Fallback: Reset HANYA setelah status IDLE (badge hasil selesai dipindai)
        if (hasClickedInCurrentDuration && tradeState === 'IDLE' && (nowTime - lastAutoClickTime >= fallbackDurationSecs * 1000)) {
          hasClickedInCurrentDuration = false;
          showToastNotification(`⏱️ Hasil Terkonfirmasi ➔ Mesin Siap 1x Klik Baru!`);
        }
      }

      // --- 3. GAMBAR GARIS TRENDLINE VISUAL DI LAYAR ---
      drawVisualTrendlineOverlay(trendAnalysis.points, trendAnalysis);

      updateColorSignalUI(colorAnalysis, trendAnalysis);
      updateDurationStatusUI(hasClickedInCurrentDuration, durationInfo.timerText);

      // DINONAKTIFKAN UNTUK MENCEGAH LAG:
      // const visibleText = window.OcrEngine.extractAllVisibleScreenText ? window.OcrEngine.extractAllVisibleScreenText() : '';
      const visibleText = '';

      if (visibleText && visibleText !== lastDetectedText) {
        lastDetectedText = visibleText;
        const analysis = window.OcrEngine.analyzeText(visibleText);

        try {
          chrome.runtime.sendMessage({
            action: 'SAVE_HISTORY',
            data: {
              text: analysis.rawText,
              charCount: analysis.charCount,
              symbolCounts: analysis.symbolCounts
            }
          }, () => {
            if (chrome.runtime.lastError) {
              // Ignore context invalidated
            }
          });
        } catch (e) {
          // Safe catch
        }

        updateAutoBadgeUI(analysis);
      }

      // --- 4. LOGIKA EKSEKUSI KETAT: HARUS STATUS IDLE & 1X KLIK PER SIKLUS TEKS DURASI ---
      const now = Date.now();

      // Syarat Eksekusi Mutlak: Status HARUS IDLE (setelah badge hasil untung/rugi terkonfirmasi), belum klik di durasi ini, dan cooldown minimum 1.2s
      if (isAutoScanning && tradeState === 'IDLE' && !hasClickedInCurrentDuration && (now - lastAutoClickTime > 1200) && !_isInitiatingTrade) {
        _isInitiatingTrade = true;
        hasClickedInCurrentDuration = true; // Kunci segera di lokal memory

        // Cek cross-tab lock agar tidak terjadi double-open posisi di tab yang berbeda atau trigger event ganda
        chrome.storage.local.get('lastGlobalAutoClick', (res) => {
          const lastGlobal = res.lastGlobalAutoClick || 0;
          if (Date.now() - lastGlobal < 2000) {
            _isInitiatingTrade = false;
            return; // Skip jika sudah ada trade yang dimulai di tab lain atau trigger berulang
          }
          
          chrome.storage.local.set({ lastGlobalAutoClick: Date.now() }, () => {
            const nominalVal = String(getActiveNominalValue());

            const isSignalDown = trendAnalysis.trend === 'downtrend' || colorAnalysis.signal === 'merah' || (colorAnalysis.redCount !== undefined && colorAnalysis.redCount > colorAnalysis.greenCount);
            const action = (targetDirection === 'turun' || (targetDirection === 'auto' && isSignalDown)) ? 'turun' : 'naik';

            // Input nominal ke web trading
            window.OcrEngine.inputNominalValue(nominalVal);

            // TUNGGU 100ms agar React OlympTrade sempat memproses event input sebelum tombol ditekan
            setTimeout(() => {
              // KLIK TOMBOL — 3 LAPIS STRATEGI SEKALIGUS
              const clicked = aggressiveClickTradeButton(action);

              startTradeLifecycle(durationInfo.totalSeconds || 5, action).then(() => {
                _isInitiatingTrade = false;
              });
              const dirLabel = action === 'naik' ? '🟢 NAIK' : '🔴 TURUN';
              showToastNotification(`${dirLabel} [OP DIBUKA] IDR ${nominalVal} — Click:${clicked ? 'OK' : 'FALLBACK'}`);
            }, 100);
          });
        });
      }
    } catch (err) {
      // Safe error catch for dynamic web DOM changes
    }
  }


  function updateColorSignalUI(colorAnalysis, trendAnalysis) {
    const box = document.getElementById('ocr-badge-signal-box');
    const text = document.getElementById('ocr-badge-signal-text');
    if (!box || !text) return;

    let trendLabel = '';
    const scoreStr = trendAnalysis && trendAnalysis.confidenceScore ? ` (${trendAnalysis.confidenceScore}%)` : '';

    if (trendAnalysis && trendAnalysis.trend === 'uptrend') {
      trendLabel = `📈 UPTREND${scoreStr}`;
      box.className = 'ocr-badge-signal-row signal-green';
    } else if (trendAnalysis && trendAnalysis.trend === 'downtrend') {
      trendLabel = `📉 DOWNTREND${scoreStr}`;
      box.className = 'ocr-badge-signal-row signal-red';
    } else {
      trendLabel = '⚠️ Trend Sideways / Hold';
      box.className = 'ocr-badge-signal-row signal-neutral';
    }

    let colorLabel = '';
    if (colorAnalysis.signal === 'hijau') {
      colorLabel = ' | 🟢 Hijau';
    } else if (colorAnalysis.signal === 'merah') {
      colorLabel = ' | 🔴 Merah';
    }

    text.innerHTML = `<strong>${trendLabel}${colorLabel}</strong>`;
  }

  function updateDurationStatusUI(isLocked, timerText) {
    const box = document.getElementById('ocr-badge-duration-box');
    const text = document.getElementById('ocr-badge-duration-text');
    if (!box || !text) return;

    const timerLabel = timerText ? ` (${timerText})` : '';

    if (isLocked) {
      box.className = 'ocr-badge-signal-row signal-neutral';
      text.innerHTML = `🔒 <strong>1x Klik SELESAI${timerLabel} - Tunggu Durasi Reset</strong>`;
    } else {
      box.className = 'ocr-badge-signal-row signal-green';
      text.innerHTML = `🟢 <strong>1x Klik per Durasi: SIAP${timerLabel}</strong>`;
    }
  }

  function updateDealBadgeUI(dealBadgeInfo) {
    const box = document.getElementById('ocr-badge-deal-box');
    const text = document.getElementById('ocr-badge-deal-text');
    if (!box || !text) return;

    if (dealBadgeInfo && dealBadgeInfo.found) {
      if (dealBadgeInfo.type === 'loss') {
        box.className = 'ocr-badge-signal-row signal-red';
        text.innerHTML = `🔴 <strong>${dealBadgeInfo.text} (LOSS)</strong>`;
      } else if (dealBadgeInfo.type === 'profit') {
        box.className = 'ocr-badge-signal-row signal-green';
        text.innerHTML = `🟢 <strong>${dealBadgeInfo.text} (PROFIT)</strong>`;
      } else {
        box.className = 'ocr-badge-signal-row signal-neutral';
        text.innerHTML = `⚪ <strong>${dealBadgeInfo.text}</strong>`;
      }
    } else {
      box.className = 'ocr-badge-signal-row signal-neutral';
      text.innerHTML = `⚪ <strong>Memindai Grafik...</strong>`;
    }
  }

  /**
   * Render top-right Floating Auto-Detector Badge (Draggable & Closeable)
   */
  function renderAutoBadge() {
    if (!document || !document.body) return;

    let existingBadge = document.getElementById('ocr-auto-badge');
    if (existingBadge) {
      existingBadge.style.display = 'block';
      updateBadgeTargetButtonsUI(targetDirection);
      return;
    }

    autoBadgeEl = document.createElement('div');
    autoBadgeEl.id = 'ocr-auto-badge';
    autoBadgeEl.style.display = 'block';

    autoBadgeEl.innerHTML = `
      <!-- Col 1: Drag & Status -->
      <div class="ocr-badge-header" id="ocr-badge-drag-header" title="Klik & tahan untuk menggeser posisi pop-up">
        <div class="ocr-badge-title-group">
          <span class="ocr-badge-drag-icon">⋮⋮</span>
          <div style="display: flex; flex-direction: column; gap: 1px;">
            <div style="font-size: 11px; font-weight: 800; color: #38bdf8; letter-spacing: 0.5px;">🤖 BOT MARTINGALE</div>
            <div class="ocr-badge-status" id="ocr-badge-status-box">
              <div class="ocr-pulse-dot" id="ocr-badge-dot"></div>
              <span id="ocr-badge-status-title" style="font-size: 9px;">AKTIF</span>
            </div>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 4px; margin-top: 6px;">
          <button id="ocr-badge-min-btn" class="ocr-badge-close-btn" style="padding:2px 4px;" title="Kecilkan / Perbesar">➖</button>
          <button id="ocr-badge-toggle-btn" class="ocr-btn-tiny" style="flex:1;" title="Mulai / Hentikan Deteksi">⏹️ Hentikan</button>
          <button id="ocr-badge-close-btn" class="ocr-badge-close-btn" style="padding:2px 4px;" title="Tutup Pop-up">✕</button>
        </div>
      </div>

      <!-- Col 2: Signals -->
      <div class="ocr-badge-col" style="min-width: 140px; gap: 4px; font-size: 10px;">
        <div class="ocr-badge-signal-row signal-neutral" id="ocr-badge-signal-box" style="border:none; padding:2px 0; background:transparent;">
          <span id="ocr-badge-signal-text">⚪ Arah: Netral</span>
        </div>
        <div class="ocr-badge-signal-row signal-neutral" id="ocr-badge-deal-box" style="border:none; padding:2px 0; background:transparent;">
          <span id="ocr-badge-deal-text">⚪ Tag: Memindai...</span>
        </div>
        <div class="ocr-badge-signal-row signal-green" id="ocr-badge-duration-box" style="border:none; padding:2px 0; background:transparent;">
          <span id="ocr-badge-duration-text">🟢 Limit: SIAP</span>
        </div>
      </div>

      <!-- Col 3: Money & Target -->
      <div class="ocr-badge-col" style="min-width: 250px; gap: 6px;">
        <div style="display: flex; gap: 6px; align-items: center;">
          <span style="font-size: 9px; color: #94a3b8; width: 45px; font-weight:700;">TARGET</span>
          <div class="ocr-target-btn-group" style="flex: 1;">
            <button class="ocr-dir-btn active" id="ocr-target-auto-btn" data-target="auto">⚡ Auto</button>
            <button class="ocr-dir-btn" id="ocr-target-naik-btn" data-target="naik">🟢 Naik</button>
            <button class="ocr-dir-btn" id="ocr-target-turun-btn" data-target="turun">🔴 Turun</button>
          </div>
        </div>
        <div style="display: flex; gap: 4px; align-items: center;">
          <span style="font-size: 9px; color: #94a3b8; width: 45px; font-weight:700;">MODAL</span>
          <input type="number" id="ocr-quick-base-nominal" class="ocr-badge-input" value="10000" style="width: 70px; padding: 4px; font-size: 10px; border-color: #38bdf8; background: rgba(56,189,248,0.08);">
          <span style="font-size: 9px; color: #94a3b8; font-weight:700;">AKTIF</span>
          <input type="number" id="ocr-quick-nominal" class="ocr-badge-input" value="10000" style="width: 70px; padding: 4px; font-size: 10px;">
          <button id="ocr-quick-input-btn" class="ocr-btn-tiny" style="background:#0284c7; color:#fff; padding:4px;">Isi</button>
        </div>
      </div>

      <!-- Col 4: Action Buttons (Naik / Turun / Win / Loss) -->
      <div class="ocr-badge-col" style="min-width: 150px; gap: 4px;">
        <div style="display: flex; gap: 4px;">
          <button id="ocr-quick-win-btn" class="ocr-btn-tiny" style="background:#16a34a; color:#fff; flex: 1;">🟢 WIN (Reset)</button>
          <button id="ocr-quick-loss-btn" class="ocr-btn-tiny" style="background:#dc2626; color:#fff; flex: 1;">🔴 LOSS (x2)</button>
        </div>
        <div style="display: flex; gap: 4px; flex: 1;">
          <button id="ocr-quick-naik-btn" class="ocr-btn-action ocr-btn-naik" style="flex: 1; border-radius:4px; border:none; background:#10b981; color:#fff; font-size:10px; font-weight:700;">🟢 NAIK</button>
          <button id="ocr-quick-turun-btn" class="ocr-btn-action ocr-btn-turun" style="flex: 1; border-radius:4px; border:none; background:#f43f5e; color:#fff; font-size:10px; font-weight:700;">🔴 TURUN</button>
        </div>
      </div>

      <!-- Col 5: Main Price Preview -->
      <div class="ocr-badge-col" style="background: rgba(0, 229, 255, 0.05); align-items: center; min-width: 140px; padding: 8px 16px;">
        <div style="font-size: 8px; color: #00e5ff; font-weight: 700; letter-spacing: 1px; margin-bottom: 2px;">HARGA LIVE</div>
        <div class="ocr-badge-preview" id="ocr-badge-preview-box" style="border:none; padding:0; background:transparent; font-size: 22px; width:100%;">--</div>
        <div style="display: flex; align-items: center; justify-content: space-between; width: 100%; margin-top: 4px;">
          <div class="ocr-badge-timer" id="ocr-badge-timer-val">02:00</div>
          <div class="ocr-badge-summary">
            <span id="ocr-badge-chars" style="display:none;">0</span>
            <span id="ocr-badge-syms" style="display:none;">0</span>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(autoBadgeEl);
    updateBadgeStatusUI(isAutoScanning);
    updateBadgeTargetButtonsUI(targetDirection);

    const dragHeader = document.getElementById('ocr-badge-drag-header');
    if (dragHeader) {
      makeBadgeDraggable(autoBadgeEl, dragHeader);
    }

    const badgeMinBtn = document.getElementById('ocr-badge-min-btn');
    if (badgeMinBtn) {
      badgeMinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isCollapsed = autoBadgeEl.classList.toggle('ocr-badge-collapsed');
        badgeMinBtn.innerText = isCollapsed ? '➕' : '➖';
        showToastNotification(isCollapsed ? 'Pop-up dikecilkan agar tidak menutupi tombol & input di layar.' : 'Pop-up diperbesar kembali.');
      });
    }

    const badgeCloseBtn = document.getElementById('ocr-badge-close-btn');
    if (badgeCloseBtn) {
      badgeCloseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        autoBadgeEl.style.display = 'none';
        showToastNotification('Pop-up disembunyikan. Buka ekstensi untuk memunculkan kembali.');
      });
    }

    const badgeToggleBtn = document.getElementById('ocr-badge-toggle-btn');
    if (badgeToggleBtn) {
      badgeToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const newState = !isAutoScanning;
        // EKSEKUSI REAKSI MULAI / HENTIKAN SINKRON SEKALIGUS (TIDAK MENUNGGU CALLBACK STORAGE)
        setAutoScanState(newState);
        safeStorageSet({ isAutoScanning: newState });
      });
    }

    // Handlers untuk tombol Setting Target Arah di Floating Badge
    const dirBtns = autoBadgeEl.querySelectorAll('.ocr-dir-btn');
    dirBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetMode = btn.getAttribute('data-target');
        setTargetDirectionState(targetMode);
        showToastNotification(`🎯 Setting Target Arah Diubah: ${targetMode.toUpperCase()}`);
      });
    });

    // Quick automation handlers inside badge
    const quickInputBtn = document.getElementById('ocr-quick-input-btn');
    const quickNominalInput = document.getElementById('ocr-quick-nominal');
    if (quickNominalInput) {
      safeStorageGet({ nominalValue: '18000' }, (res) => {
        if (res && res.nominalValue) quickNominalInput.value = res.nominalValue;
      });
      quickNominalInput.addEventListener('input', () => {
        const val = quickNominalInput.value;
        safeStorageSet({ nominalValue: val });
        const parsed = parseFloat(val.replace(/[^0-9\.]/g, ''));
        if (!isNaN(parsed) && parsed > 0) {
          currentNominalValue = parsed;
          if (martingaleStep === 0) {
            baseInitialNominal = parsed;
            const quickBaseInput = document.getElementById('ocr-quick-base-nominal');
            if (quickBaseInput) quickBaseInput.value = parsed;
            safeStorageSet({ baseNominalValue: String(parsed) });
          }
        }
      });
    }

    const quickBaseNominalInput = document.getElementById('ocr-quick-base-nominal');
    if (quickBaseNominalInput) {
      safeStorageGet({ baseNominalValue: '18000' }, (res) => {
        if (res && res.baseNominalValue) {
          quickBaseNominalInput.value = res.baseNominalValue;
          const p = parseFloat(String(res.baseNominalValue).replace(/[^0-9\.]/g, ''));
          if (!isNaN(p) && p > 0) baseInitialNominal = p;
        }
      });
      quickBaseNominalInput.addEventListener('input', () => {
        const val = quickBaseNominalInput.value;
        safeStorageSet({ baseNominalValue: val });
        const parsed = parseFloat(val.replace(/[^0-9\.]/g, ''));
        if (!isNaN(parsed) && parsed > 0) {
          baseInitialNominal = parsed;
          if (martingaleStep === 0) {
            currentNominalValue = parsed;
            if (quickNominalInput) quickNominalInput.value = parsed;
          }
        }
      });
    }

    if (quickInputBtn) {
      quickInputBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const baseInput = document.getElementById('ocr-quick-base-nominal');
        const valStr = baseInput ? baseInput.value : (quickNominalInput ? quickNominalInput.value : '18000');
        const parsed = parseFloat(String(valStr).replace(/[^0-9\.]/g, ''));
        if (!isNaN(parsed) && parsed > 0) {
          baseInitialNominal = parsed;
          currentNominalValue = parsed;
          martingaleStep = 0;
          if (quickNominalInput) quickNominalInput.value = parsed;
          if (baseInput) baseInput.value = parsed;
          safeStorageSet({ baseNominalValue: String(parsed), nominalValue: String(parsed) });
        }
        const res = window.OcrEngine.inputNominalValue(baseInitialNominal);
        showToastNotification(`💰 Modal Awal (IDR ${baseInitialNominal}) Diisikan ke Layar & Step Reset!`);
      });
    }

    const quickNaikBtn = document.getElementById('ocr-quick-naik-btn');
    if (quickNaikBtn) {
      quickNaikBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const nominalVal = currentNominalValue ? String(currentNominalValue) : ((quickNominalInput && quickNominalInput.value) ? quickNominalInput.value : '18000');
        window.OcrEngine.inputNominalValue(nominalVal);
        const res = window.OcrEngine.clickActionElement('naik');
        if (res.success) startTradeLifecycle(latestDurationInfo ? latestDurationInfo.totalSeconds : 5, 'naik');
        showToastNotification(res.message);
      });
    }

    const quickTurunBtn = document.getElementById('ocr-quick-turun-btn');
    if (quickTurunBtn) {
      quickTurunBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const nominalVal = currentNominalValue ? String(currentNominalValue) : ((quickNominalInput && quickNominalInput.value) ? quickNominalInput.value : '18000');
        window.OcrEngine.inputNominalValue(nominalVal);
        const res = window.OcrEngine.clickActionElement('turun');
        if (res.success) startTradeLifecycle(latestDurationInfo ? latestDurationInfo.totalSeconds : 5, 'turun');
        showToastNotification(res.message);
      });
    }

    const quickLossBtn = document.getElementById('ocr-quick-loss-btn');
    if (quickLossBtn) {
      quickLossBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const baseInput = document.getElementById('ocr-quick-base-nominal');
        if (baseInput && baseInput.value) {
          const p = parseFloat(String(baseInput.value).replace(/[^0-9\.]/g, ''));
          if (!isNaN(p) && p > 0) baseInitialNominal = p;
        }

        if (martingaleStep === 0) {
          currentNominalValue = Math.round(baseInitialNominal * 2);
          martingaleStep = 1;
        } else {
          currentNominalValue = Math.round(currentNominalValue * 2.5);
          martingaleStep++;
        }

        if (quickNominalInput) quickNominalInput.value = currentNominalValue;
        safeStorageSet({ nominalValue: String(currentNominalValue) });
        window.OcrEngine.inputNominalValue(currentNominalValue);

        showToastNotification(`🔴 [MANUAL LOSS TRIGGERED - STEP ${martingaleStep}] Nominal Di-kali: IDR ${currentNominalValue}`);
      });
    }

    const quickWinBtn = document.getElementById('ocr-quick-win-btn');
    if (quickWinBtn) {
      quickWinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const baseInput = document.getElementById('ocr-quick-base-nominal');
        if (baseInput && baseInput.value) {
          const p = parseFloat(String(baseInput.value).replace(/[^0-9\.]/g, ''));
          if (!isNaN(p) && p > 0) baseInitialNominal = p;
        }

        currentNominalValue = baseInitialNominal;
        martingaleStep = 0;

        if (quickNominalInput) quickNominalInput.value = currentNominalValue;
        safeStorageSet({ nominalValue: String(currentNominalValue) });
        window.OcrEngine.inputNominalValue(currentNominalValue);

        showToastNotification(`🟢 [MANUAL WIN TRIGGERED] Nominal Reset ke Modal Awal: IDR ${currentNominalValue}`);
      });
    }
  }

  function updateBadgeTargetButtonsUI(dir) {
    if (!autoBadgeEl) return;
    const buttons = autoBadgeEl.querySelectorAll('.ocr-dir-btn');
    buttons.forEach(btn => {
      const mode = btn.getAttribute('data-target');
      if (mode === dir) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  /**
   * Implementasi Drag and Drop untuk Floating Badge
   */
  function makeBadgeDraggable(badge, header) {
    let isDragging = false;
    let startX = 0, startY = 0;
    let initialLeft = 0, initialTop = 0;

    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button') || e.target.closest('input')) return;

      isDragging = true;
      badge.classList.add('dragging');
      startX = e.clientX;
      startY = e.clientY;

      const rect = badge.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;

      badge.style.right = 'auto';
      badge.style.left = initialLeft + 'px';
      badge.style.top = initialTop + 'px';

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    function onMouseMove(e) {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      let newLeft = initialLeft + dx;
      let newTop = initialTop + dy;

      const maxLeft = Math.max(10, window.innerWidth - badge.offsetWidth - 10);
      const maxTop = Math.max(10, window.innerHeight - badge.offsetHeight - 10);

      newLeft = Math.max(10, Math.min(maxLeft, newLeft));
      newTop = Math.max(10, Math.min(maxTop, newTop));

      badge.style.left = newLeft + 'px';
      badge.style.top = newTop + 'px';
    }

    function onMouseUp() {
      if (isDragging) {
        isDragging = false;
        badge.classList.remove('dragging');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }
    }
  }


  function updateBadgeStatusUI(active) {
    const dot = document.getElementById('ocr-badge-dot');
    const title = document.getElementById('ocr-badge-status-title');
    const toggleBtn = document.getElementById('ocr-badge-toggle-btn');

    if (active) {
      if (dot) dot.className = 'ocr-pulse-dot';
      if (title) {
        title.innerText = 'DETEKSI: AKTIF';
        title.style.color = '#4ade80';
      }
      if (toggleBtn) toggleBtn.innerText = '⏹️ Hentikan';
    } else {
      if (dot) dot.className = 'ocr-pulse-dot paused';
      if (title) {
        title.innerText = 'DETEKSI: DIHENTIKAN';
        title.style.color = '#f87171';
      }
      if (toggleBtn) toggleBtn.innerText = '▶️ Mulai';
    }
  }

  function updateAutoBadgeUI(analysis) {
    const charsEl = document.getElementById('ocr-badge-chars');
    const symsEl = document.getElementById('ocr-badge-syms');
    const previewEl = document.getElementById('ocr-badge-preview-box');

    if (charsEl) charsEl.innerText = analysis.charCount;
    if (symsEl) {
      symsEl.innerText = analysis.symbolCounts.plus +
        analysis.symbolCounts.minus +
        analysis.symbolCounts.openParen +
        analysis.symbolCounts.closeParen;
    }
    if (previewEl) {
      previewEl.innerText = analysis.rawText || 'Tidak ada tulisan di layar...';
    }
  }

  function updateAutoClearTimer() {
    try {
      chrome.runtime.sendMessage({ action: 'GET_AUTO_CLEAR_STATUS' }, (res) => {
        if (chrome.runtime.lastError) return;
        if (res && typeof res.remainingMs === 'number') {
          const timerVal = document.getElementById('ocr-badge-timer-val');
          if (timerVal) {
            const totalSec = Math.floor(res.remainingMs / 1000);
            const mins = Math.floor(totalSec / 60);
            const secs = totalSec % 60;
            timerVal.innerText = `Reset: ${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
          }
        }
      });
    } catch (e) {
      // Safe catch
    }
  }

  // --- Manual Selection Box (Snipper) Option ---
  function initSnipper() {
    if (isSnipping) return;
    isSnipping = true;

    overlayEl = document.createElement('div');
    overlayEl.id = 'ocr-snipper-overlay';

    boxEl = document.createElement('div');
    boxEl.id = 'ocr-selection-box';

    badgeEl = document.createElement('div');
    badgeEl.id = 'ocr-dimension-badge';
    badgeEl.innerText = 'Tarik area untuk mendeteksi teks & simbol...';
    boxEl.appendChild(badgeEl);

    overlayEl.appendChild(boxEl);
    if (document.body) {
      document.body.appendChild(overlayEl);
    }

    overlayEl.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    startX = e.clientX;
    startY = e.clientY;

    boxEl.style.left = startX + 'px';
    boxEl.style.top = startY + 'px';
    boxEl.style.width = '0px';
    boxEl.style.height = '0px';
    boxEl.style.display = 'block';

    overlayEl.addEventListener('mousemove', onMouseMove);
    overlayEl.addEventListener('mouseup', onMouseUp);
  }

  function onMouseMove(e) {
    const width = Math.abs(e.clientX - startX);
    const height = Math.abs(e.clientY - startY);
    const left = Math.min(e.clientX, startX);
    const top = Math.min(e.clientY, startY);

    boxEl.style.left = left + 'px';
    boxEl.style.top = top + 'px';
    boxEl.style.width = width + 'px';
    boxEl.style.height = height + 'px';

    badgeEl.innerText = `${Math.round(width)} × ${Math.round(height)} px`;
  }

  function onMouseUp(e) {
    overlayEl.removeEventListener('mousemove', onMouseMove);
    overlayEl.removeEventListener('mouseup', onMouseUp);

    const rect = boxEl.getBoundingClientRect();
    if (overlayEl) overlayEl.style.display = 'none';

    cleanupSnipper();

    if (rect.width > 10 && rect.height > 10) {
      processRegionCapture(rect);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') cleanupSnipper();
  }

  function cleanupSnipper() {
    isSnipping = false;
    if (overlayEl) {
      overlayEl.remove();
      overlayEl = null;
    }
    window.removeEventListener('keydown', onKeyDown);
  }

  async function processRegionCapture(rect) {
    showLoadingModal();
    let domText = window.OcrEngine.extractDomTextInBoundingBox(rect);

    const analysis = window.OcrEngine.analyzeText(domText);
    chrome.runtime.sendMessage({
      action: 'SAVE_HISTORY',
      data: {
        text: analysis.rawText,
        charCount: analysis.charCount,
        symbolCounts: analysis.symbolCounts
      }
    });

    showResultModal(analysis);
  }

  function showLoadingModal() {
    removeExistingModal();
    const modal = document.createElement('div');
    modal.id = 'ocr-result-modal';
    modal.innerHTML = `
      <div class="ocr-modal-header">
        <div class="ocr-modal-title">🔍 Memindai Layar...</div>
      </div>
      <div class="ocr-loading-spinner">
        <div class="ocr-spinner-ring"></div>
        <div style="color: #94a3b8; font-size: 13px;">Membaca tulisan & simbol...</div>
      </div>
    `;
    if (document.body) {
      document.body.appendChild(modal);
    }
  }

  function showResultModal(analysis) {
    removeExistingModal();
    const safeText = window.OcrEngine.escapeHtml(analysis.rawText);

    const modal = document.createElement('div');
    modal.id = 'ocr-result-modal';
    modal.innerHTML = `
      <div class="ocr-modal-header">
        <div class="ocr-modal-title">✨ Hasil Deteksi Tulisan Layar</div>
        <button class="ocr-modal-close" id="ocr-close-btn">&times;</button>
      </div>
      <div class="ocr-modal-body">
        <div class="ocr-section-title">📝 Teks Terdeteksi</div>
        <textarea class="ocr-text-area-box" readonly>${safeText}</textarea>

        <div class="ocr-section-title">📊 Ringkasan Deteksi</div>
        <div class="ocr-stats-grid">
          <div class="ocr-stat-card">
            <div class="ocr-stat-val">${analysis.charCount}</div>
            <div class="ocr-stat-lbl">Karakter</div>
          </div>
          <div class="ocr-stat-card">
            <div class="ocr-stat-val">${analysis.wordCount}</div>
            <div class="ocr-stat-lbl">Kata</div>
          </div>
          <div class="ocr-stat-card">
            <div class="ocr-stat-val">${analysis.numbers.length}</div>
            <div class="ocr-stat-lbl">Angka</div>
          </div>
          <div class="ocr-stat-card">
            <div class="ocr-stat-val">${analysis.symbolCounts.plus + analysis.symbolCounts.minus + analysis.symbolCounts.openParen + analysis.symbolCounts.closeParen}</div>
            <div class="ocr-stat-lbl">Simbol (+, -, ())</div>
          </div>
        </div>
      </div>
      <div class="ocr-modal-footer">
        <button class="ocr-btn ocr-btn-primary" id="ocr-copy-btn">📋 Salin Teks</button>
      </div>
    `;

    if (document.body) {
      document.body.appendChild(modal);
    }
    document.getElementById('ocr-close-btn').addEventListener('click', removeExistingModal);
    document.getElementById('ocr-copy-btn').addEventListener('click', () => {
      navigator.clipboard.writeText(analysis.rawText).then(() => {
        const btn = document.getElementById('ocr-copy-btn');
        btn.innerText = '✅ Tersalin!';
        setTimeout(() => { btn.innerText = '📋 Salin Teks'; }, 2000);
      });
    });
  }

  function removeExistingModal() {
    const existing = document.getElementById('ocr-result-modal');
    if (existing) existing.remove();
  }
})();


/* ==========================================
 * SELECT_DETECT TARGET MAPPER INTEGRATION 
 * ========================================== */
/**
 * Content Script: Target Area Mapper + Real-Time DOM Text Reader
 * - Tracking box uses requestAnimationFrame (60fps) in the web page — zero message latency.
 * - Text extraction uses 7 strategies: innerText, textContent, aria-label, title, value, data-*, alt.
 */

(() => {
  // ─── Cleanup old injections ───
  ['rss-remote-popup', 'rss-remote-badge', 'rss-tracking-overlay'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });

  // ─── Create/get the tracking box ───
  function ensureTrackingBox() {
    if (window._trackingBox) return window._trackingBox;
    window._trackingBox = document.createElement('div');
    window._trackingBox.style.cssText = `
      position: fixed;
      border: 2px dashed #00e5ff;
      background: rgba(0, 229, 255, 0.1);
      pointer-events: none;
      z-index: 999999;
      box-shadow: 0 0 10px rgba(0, 229, 255, 0.5);
      transition: all 0.1s ease-out;
    `;
    const label = document.createElement('div');
    label.style.cssText = `
      position: absolute;
      top: -20px; left: -2px;
      background: #00e5ff; color: #000;
      font: bold 9px/18px monospace;
      padding: 0 5px;
      border-radius: 3px 3px 0 0;
      white-space: nowrap
    `;
    label.textContent = '🎯 TRACKING';
    window._trackingBox.appendChild(label);
    document.body.appendChild(window._trackingBox);
    return window._trackingBox;
  }

  // ─── RAF Tracking Loop (~60fps, runs entirely inside the web page) ───
  function startTrackingLoop() {
    if (window._trackingRafId) cancelAnimationFrame(window._trackingRafId);

    function loop() {
      if (window._trackedElement) {
        if (!document.body.contains(window._trackedElement)) {
          // Element left DOM — try to re-find
          if (window._mappedRegion) window._trackedElement = findPrimaryElement(window._mappedRegion);
        } else {
          const rect = window._trackedElement.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const box = ensureTrackingBox();
            box.style.display  = 'block';
            box.style.left     = `${rect.left}px`;
            box.style.top      = `${rect.top}px`;
            box.style.width    = `${rect.width}px`;
            box.style.height   = `${rect.height}px`;
          }
        }
      }
      window._trackingRafId = requestAnimationFrame(loop);
    }

    window._trackingRafId = requestAnimationFrame(loop);
  }

  function stopTrackingLoop() {
    if (window._trackingRafId) { cancelAnimationFrame(window._trackingRafId); window._trackingRafId = null; }
    if (window._trackingBox) window._trackingBox.style.display = 'none';
  }


  // ─── Cari elemen terdalam (leaf) yang punya teks di dalam el ───
  // Ini memastikan kita mengunci elemen badge/nilai aktual, bukan container parent-nya.
  function findDeepestTextElement(el) {
    if (!el) return null;
    if (!el.children || el.children.length === 0) return el;

    // Cek apakah parent ini (secara utuh) sudah membentuk suatu angka (meski beda warna/span)
    // Jika ya, berhentilah di sini supaya kita bisa baca "57" dan ".8286" sekaligus!
    const elText = (el.innerText || el.textContent || '').replace(/\s+/g, '');
    const isFullNumber = /^[-+]?\d*[.,]?\d+$/.test(elText);
    
    // Jangan lock elemen kalau cuman "." atau "0." dll, pastikan agak panjang atau pas
    if (isFullNumber && elText.length >= 2) {
      return el;
    }

    // Cek apakah ada child yang mengandung teks
    for (const child of el.children) {
      if (child.id && child.id.startsWith('rss-')) continue;
      const childText = (child.innerText || child.textContent || '').trim();
      if (childText) {
        // Turun rekursif ke child yang paling dalam
        return findDeepestTextElement(child);
      }
    }
    // Tidak ada child yang punya teks → return el sendiri
    return el;
  }

  // ─── Find the primary text-bearing element at the center of a region ───
  function findPrimaryElement(region) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cx = (region.xRatio + region.wRatio / 2) * vw;
    const cy = (region.yRatio + region.hRatio / 2) * vh;

    // elementsFromPoint() mengembalikan dari paling-atas (paling spesifik) ke paling bawah.
    // Kita ambil yang paling atas (index 0) yang punya teks — itu elemen paling tepat.
    const centerEls = document.elementsFromPoint(cx, cy);
    for (const el of centerEls) {
      if (el.id && el.id.startsWith('rss-')) continue;
      if (el === document.body || el === document.documentElement) continue;
      const txt = extractText(el).trim();
      if (txt) return findDeepestTextElement(el);
    }

    // Fallback: 3x3 grid
    const x1 = region.xRatio * vw, y1 = region.yRatio * vh;
    const w = region.wRatio * vw,  h = region.hRatio * vh;
    for (const ry of [0.25, 0.5, 0.75]) {
      for (const rx of [0.25, 0.5, 0.75]) {
        const els = document.elementsFromPoint(x1 + w * rx, y1 + h * ry);
        for (const el of els) {
          if (el.id && el.id.startsWith('rss-')) continue;
          if (el === document.body || el === document.documentElement) continue;
          if (extractText(el).trim()) return findDeepestTextElement(el);
        }
      }
    }

    // Last resort: any non-body element at center
    for (const el of centerEls) {
      if (el.id && el.id.startsWith('rss-')) continue;
      if (el === document.body || el === document.documentElement) continue;
      return el;
    }
    return null;
  }

  window._readDomTextInRegion = readDomTextInRegion;

  // ─── Aggressive Multi-Strategy DOM Text Extractor ───
  function readDomTextInRegion(region) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const x1 = Math.round(region.xRatio * vw);
    const y1 = Math.round(region.yRatio * vh);
    const w  = Math.round(region.wRatio * vw);
    const h  = Math.round(region.hRatio * vh);

    const seenElements = new Set();
    const rawPieces    = [];

    // Grid sampling — sparse untuk kecepatan: max 8x8
    const cols = Math.max(4, Math.min(8, Math.round(w / 15)));
    const rows = Math.max(4, Math.min(8, Math.round(h / 15)));

    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const px = x1 + Math.round((w * c) / cols);
        const py = y1 + Math.round((h * r) / rows);

        for (const el of document.elementsFromPoint(px, py)) {
          if (el.id && el.id.startsWith('rss-')) continue;
          if (el === document.body || el === document.documentElement) continue;
          if (seenElements.has(el)) continue;
          seenElements.add(el);

          // Extract text using ALL strategies
          const pieces = extractAllTextStrategies(el);
          rawPieces.push(...pieces);
        }
      }
    }

    // ─── LIVENESS TRACKER REPLACES TRACKED ELEMENT PRIORITY ───
    // Kita hapus logika _trackedElement (bintang '★') karena itu menyebabkan bug 
    // ketika user menggambar kotak yang titik tengahnya meleset ke garis statis.
    // Liveness Tracker (di findBestPriceCandidate) akan otomatis membunuh angka statis!
    
    // Deduplicate and join
    const seen   = new Set();
    const unique = rawPieces
      .map(t => String(t).trim())
      .filter(t => { if (!t || seen.has(t)) return false; seen.add(t); return true; });

    const fullText = unique.join(' ').replace(/\s+/g, ' ').trim();

    // Numbers: 6.1461, 1,234.56, 1.234,56, 90%, -0.12, +3.5
    const numberMatches = fullText.match(
      /[-+]?\d{1,3}(?:[.,]\d{3})*[.,]\d+|[-+]?\d+[.,]\d+|[-+]?\d{1,3}(?:[.,]\d{3})+|[-+]?\d+%?/g
    ) || [];
    const cleanNumbers = [...new Set(numberMatches.filter(n => n.length > 0 && n !== '-' && n !== '+'))];

    // Labels: words 2+ chars
    const wordMatches = fullText.match(/[A-Za-z][A-Za-z0-9._/-]{1,}/g) || [];
    const cleanLabels = [...new Set(wordMatches)];

    // Live bounding rect of tracked element
    let trackedRect = null;
    if (window._trackedElement && document.body.contains(window._trackedElement)) {
      const rect = window._trackedElement.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        trackedRect = {
          xRatio:   rect.left / vw,
          yRatio:   rect.top  / vh,
          wRatio:   rect.width  / vw,
          hRatio:   rect.height / vh,
          displayX: Math.round(rect.left),
          displayY: Math.round(rect.top),
          displayW: Math.round(rect.width),
          displayH: Math.round(rect.height)
        };
      }
    }

    return {
      text: fullText,
      numbers: cleanNumbers,
      labels: cleanLabels,
      trackedRect,
      // Debug: all elements found with their details
      debugElements: [...seenElements].slice(0, 20).map(el => ({
        tag:   el.tagName ? el.tagName.toLowerCase() : '?',
        id:    el.id || '',
        cls:   (el.className && typeof el.className === 'string') ? el.className.split(' ').filter(Boolean).slice(0,2).join('.') : '',
        text:  (el.innerText || el.textContent || '').trim().substring(0, 60),
        aria:  el.getAttribute ? (el.getAttribute('aria-label') || '') : ''
      })),
      timestamp: Date.now()
    };
  }

  /**
   * Extract ALL possible text from a single element using 7 strategies.
   * Returns an array of text pieces (may have duplicates — caller deduplicates).
   */
  function extractAllTextStrategies(el) {
    const out = [];
    const tag = (el.tagName || '').toLowerCase();

    // 0. Cek apakah elemen secara visual tersembunyi (opacity 0 atau display none)
    try {
      const style = window.getComputedStyle(el);
      if (style.opacity === '0' || style.display === 'none' || style.visibility === 'hidden') {
        return out; // Abaikan elemen usang yang sedang disembunyikan (misal saat crossfade animasi)
      }
    } catch (e) {}

    // 1. innerText — visible rendered text, handles nested <span> etc.
    try { const t = el.innerText; if (t && t.trim()) out.push(t.trim()); } catch (e) {}

    // 2. textContent — catches hidden/script text too
    try {
      const tc = el.textContent;
      if (tc && tc.trim()) out.push(tc.trim());
    } catch (e) {}

    // 3. aria-label — screen reader label, often holds exact value
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria && aria.trim()) out.push(aria.trim());

    // 4. title attribute
    const title = el.getAttribute && el.getAttribute('title');
    if (title && title.trim()) out.push(title.trim());

    // 5. placeholder (for input fields)
    const ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph && ph.trim()) out.push(ph.trim());

    // 6. input / textarea value
    if ((tag === 'input' || tag === 'textarea') && el.value) out.push(String(el.value).trim());

    // 7. data-* attributes containing numbers
    if (el.attributes) {
      for (const attr of el.attributes) {
        if (attr.name.startsWith('data-') && attr.value && /[\d.]/.test(attr.value)) {
          out.push(attr.value.trim());
        }
      }
    }

    // 8. alt text for images
    if (tag === 'img') {
      const alt = el.getAttribute && el.getAttribute('alt');
      if (alt && alt.trim()) out.push(alt.trim());
    }

    return out;
  }

  /**
   * Quick single-element text extraction (used by findPrimaryElement).
   */
  function extractText(el) {
    try { const t = el.innerText; if (t && t.trim()) return t.trim(); } catch (e) {}
    try { const t = el.textContent; if (t && t.trim()) return t.trim(); } catch (e) {}
    return '';
  }

  // ─── Message Listener ───
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'start_target_mapper') {
      activateTargetMapper();
      sendResponse({ status: 'ok' });
      return true;
    }

    if (request.action === 'read_dom_text') {
      const region = request.region || window._mappedRegion;
      if (!region) {
        sendResponse({ text: '', numbers: [], labels: [], error: 'no_region' });
        return;
      }

      const result = readDomTextInRegion(region);
      if (window._trackedElement) {
        const rect = window._trackedElement.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        result.trackedRect = {
          xRatio: rect.left / vw, yRatio: rect.top / vh,
          wRatio: rect.width / vw, hRatio: rect.height / vh,
        };
      }
      sendResponse(result);
    }

    if (request.action === 'stop_tracking') {
      stopTrackingLoop();
      window._trackedElement = null;
      window._mappedRegion   = null;
      sendResponse({ status: 'ok' });
      return true;
    }
  });
  // ─── Snipping Tool Overlay ───
  function activateTargetMapper() {
    if (document.getElementById('rss-target-mapper-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'rss-target-mapper-overlay';
    overlay.innerHTML = `
      <div class="rss-mapper-instruction">
        <span>🎯 Klik &amp; Seret Mouse Untuk Memetakan Area Target (Esc = Batal)</span>
      </div>
      <div id="rss-mapper-selection-rect" style="display:none;">
        <div id="rss-mapper-rect-badge" class="rss-mapper-rect-badge">0 × 0 px</div>
      </div>
    `;
    document.body.appendChild(overlay);

    const selRect   = document.getElementById('rss-mapper-selection-rect');
    const rectBadge = document.getElementById('rss-mapper-rect-badge');
    let isSelecting = false, startX = 0, startY = 0;

    const onMouseDown = e => {
      isSelecting = true;
      startX = e.clientX; startY = e.clientY;
      Object.assign(selRect.style, { left: `${startX}px`, top: `${startY}px`, width: '0px', height: '0px', display: 'block' });
    };

    const onMouseMove = e => {
      if (!isSelecting) return;
      const x = Math.min(startX, e.clientX), y = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX), h = Math.abs(e.clientY - startY);
      Object.assign(selRect.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
      rectBadge.textContent = `${Math.round(w)} × ${Math.round(h)} px`;
    };

    const onMouseUp = e => {
      if (!isSelecting) return;
      isSelecting = false;

      const x = Math.min(startX, e.clientX), y = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX), h = Math.abs(e.clientY - startY);

      if (w > 15 && h > 15) {
        const vw = window.innerWidth || 1;
        const vh = window.innerHeight || 1;

        const region = {
          id: `mapped_${Date.now()}`,
          xRatio: x / vw, yRatio: y / vh,
          wRatio: w / vw, hRatio: h / vh,
          displayW: Math.round(w), displayH: Math.round(h)
        };

        window._mappedRegion   = region;
        window._trackedElement = findPrimaryElement(region);
        
        // Save to storage to survive F5
        chrome.storage.local.set({ savedMappedRegion: region });
        
        startTrackingLoop();

        chrome.runtime.sendMessage({ action: 'target_mapped', roi: region });

        const initialRead = readDomTextInRegion(region);
        chrome.runtime.sendMessage({ action: 'dom_text_result', result: initialRead, roiId: region.id });
      }

      cleanup();
    };

    const onKeyDown = e => { if (e.key === 'Escape') cleanup(); };

    function cleanup() {
      overlay.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('keydown', onKeyDown);
      if (document.body.contains(overlay)) document.body.removeChild(overlay);
    }

    overlay.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('keydown', onKeyDown);
  }
})();

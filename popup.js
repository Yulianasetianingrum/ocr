/**
 * Popup Script for Automatic Screen Text & Symbol Reader
 * Handles text selection highlight copying & start/stop controls.
 */

document.addEventListener('DOMContentLoaded', () => {
  const btnToggleAuto = document.getElementById('btn-toggle-auto');
  const toggleIcon = document.getElementById('toggle-icon');
  const toggleText = document.getElementById('toggle-text');
  const statusCard = document.getElementById('status-card');
  const statusPulse = document.getElementById('status-pulse');
  const statusText = document.getElementById('status-text');

  const btnClearHistory = document.getElementById('btn-clear-history');
  const historyList = document.getElementById('history-list');

  // Main Value Display Elements
  const remoteTrendBadge = document.getElementById('remoteTrendBadge');
  const descPrimaryVal = document.getElementById('descPrimaryVal');

  let isAutoScanning = false;
  let targetDirection = 'auto';
  let highlightedSelection = '';

  const targetDirBtns = document.querySelectorAll('.btn-target-dir');
  const popupNominalInput = document.getElementById('popup-nominal-input');

  const btnMapTarget = document.getElementById('btnMapTarget');
  const btnResetRoi = document.getElementById('btnResetRoi');
  const mappedAreaStatus = document.getElementById('mappedAreaStatus');
  let activeMappedRoi = null;

  // ─── Find active web tab automatically (EXACT SELECT_DETECT) ───
  async function findActiveWebTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0] && tabs[0].url && !tabs[0].url.startsWith('chrome-extension://')) {
        return tabs[0];
      }
      const allTabs = await chrome.tabs.query({ active: true });
      const webTab = allTabs.find(t => t.url && !t.url.startsWith('chrome-extension://'));
      return webTab || null;
    } catch (e) {
      return null;
    }
  }

  if (btnMapTarget) {
    btnMapTarget.addEventListener('click', async () => {
      try {
        const realTab = await findActiveWebTab();
        if (realTab && realTab.id) {
          activeTabId = realTab.id;
          chrome.storage.local.set({ targetTabId: activeTabId });

          try {
            await chrome.scripting.insertCSS({ target: { tabId: activeTabId }, files: ['content.css'] });
          } catch (e) {}
          try {
            await chrome.scripting.executeScript({
              target: { tabId: activeTabId },
              files: ['lib/change-detector.js', 'lib/ocr-engine.js', 'lib/state-manager.js', 'content.js']
            });
          } catch (e) {}

          setTimeout(() => {
            chrome.tabs.sendMessage(activeTabId, { action: 'start_target_mapper' }, () => {
              if (chrome.runtime.lastError) {}
            });
          }, 100);
        }
      } catch (e) {}
    });
  }

  if (btnResetRoi) {
    btnResetRoi.addEventListener('click', () => {
      activeMappedRoi = null;
      if (mappedAreaStatus) {
        mappedAreaStatus.innerHTML = 'Status Area: <span style="color: var(--accent-cyan); font-weight: 700;">Layar Penuh (Otomatis)</span>';
      }
      chrome.storage.local.get(['targetTabId'], (res) => {
        if (res.targetTabId) {
          chrome.tabs.sendMessage(res.targetTabId, { action: 'stop_tracking' });
        }
      });
    });
  }

  // Listen for target_mapped & dom_text_result messages from content script overlay
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'target_mapped') {
      activeMappedRoi = request.roi;
      // Reset history & tracking state so mapped area updates instantly
      pollHistory.length = 0;
      dynamicPrimaryIndex = -1;
      lastChangedValue = '--';
      previousText = '';

      if (mappedAreaStatus) {
        if (request.roi) {
          const w = request.roi.displayW || Math.round(request.roi.width || 0);
          const h = request.roi.displayH || Math.round(request.roi.height || 0);
          mappedAreaStatus.innerHTML = `Status Area: <span style="color: #10b981; font-weight: 700;">🎯 Mapped (${w}×${h} px)</span>`;
        } else {
          mappedAreaStatus.innerHTML = 'Status Area: <span style="color: var(--accent-cyan); font-weight: 700;">Layar Penuh (Otomatis)</span>';
        }
      }
      
      startDomPolling();
    }

    if (request.action === 'dom_text_result') {
      if (request.result) {
        handleDomResult(request.result);
      }
    }

    // TRADE_OPENED & TRADE_CLOSED via message: fast-path jika popup kebetulan terbuka.
    // Sumber kebenaran utama adalah storage (dihandle oleh chrome.storage.onChanged di bawah).
    if (request.action === 'TRADE_OPENED') {
      // Reload dari storage untuk sinkron (content.js sudah tulis ke storage duluan)
      loadSessionLogs();
    }

    if (request.action === 'TRADE_CLOSED') {
      // Abaikan TRADE_CLOSED kosong (tanpa closeVal) — itu bukan close sesungguhnya
      if (!request.closeTime && !request.closeVal && !request.resultText) return;
      // Reload dari storage untuk sinkron
      loadSessionLogs();
    }
    
    if (request.action === 'STATE_CHANGED') {
      const state = request.state;
      const statusTextEl = document.getElementById('status-text');
      if (statusTextEl) {
         statusTextEl.innerHTML = `System State: <strong>${state.status}</strong>`;
      }
    }
  });

  // ─── LIVE STORAGE LISTENER ───────────────────────────────────────────────────
  // Saat content.js tulis sessionLogs ke storage (bahkan saat popup tutup & buka lagi),
  // popup langsung re-render tanpa perlu mengandalkan sendMessage yang bisa hilang.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.sessionLogs) {
      sessionLogs = changes.sessionLogs.newValue || [];
      renderSessionLogs();
    }
  });



  // 1. Initialize state from storage & sync with tab
  chrome.storage.local.get({ isAutoScanning: false, targetDirection: 'auto', nominalValue: '10000', baseNominalValue: '10000', sessionLogs: [] }, (res) => {
    isAutoScanning = res.isAutoScanning;
    targetDirection = res.targetDirection || 'auto';
    if (popupNominalInput) popupNominalInput.value = res.nominalValue || '10000';
    const popupBaseNominalInput = document.getElementById('popup-base-nominal');
    if (popupBaseNominalInput) popupBaseNominalInput.value = res.baseNominalValue || '10000';
    
    // Bersihkan ghost logs (jika ada log yang nyangkut OPEN dari sesi sebelumnya)
    if (res.sessionLogs && res.sessionLogs.length > 0) {
      let modified = false;
      res.sessionLogs.forEach(log => {
        if (log.status === 'OPEN') {
          log.status = 'CLOSED';
          log.closeVal = 'Ghost Log';
          log.resultText = '⚪ DIBATALKAN';
          modified = true;
        }
      });
      if (modified) {
        sessionLogs = res.sessionLogs;
        chrome.storage.local.set({ sessionLogs: sessionLogs });
      }
    }

    updateToggleUI(isAutoScanning);
    updateTargetDirUI(targetDirection);
    if (isAutoScanning) {
      startDomPolling();
    } else {
      stopDomPolling();
    }
  });

  // Live nominal sync
  if (popupNominalInput) {
    popupNominalInput.addEventListener('input', () => {
      const val = popupNominalInput.value;
      chrome.storage.local.set({ nominalValue: val });
      sendTabAction('SET_NOMINAL_VALUE', { value: val });
    });
  }

  const popupBaseNominalInput = document.getElementById('popup-base-nominal');
  if (popupBaseNominalInput) {
    popupBaseNominalInput.addEventListener('input', () => {
      const baseVal = popupBaseNominalInput.value;
      chrome.storage.local.set({ baseNominalValue: baseVal });
      sendTabAction('INPUT_NOMINAL', { value: baseVal });
    });
  }

  // 2. Start / Stop Button Click Handler
  btnToggleAuto.addEventListener('click', () => {
    isAutoScanning = !isAutoScanning;
    chrome.storage.local.set({ isAutoScanning: isAutoScanning }, () => {
      updateToggleUI(isAutoScanning);
      notifyTabState(isAutoScanning);

      if (isAutoScanning) {
        startDomPolling();


      } else {
        stopDomPolling();
        // Log yang masih OPEN dibiarkan — _doCompleteWithClose akan update
        // dengan closeVal & WIN/LOSS asli saat timer trade habis.
        // Jangan paksa-close di sini karena akan mengisi resultText dengan
        // "DIHENTIKAN" dan mengabaikan hasil trade yang sebenarnya.
      }
    });
  });

  // Target Direction Button Handlers
  targetDirBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const dir = btn.getAttribute('data-dir');
      targetDirection = dir || 'auto';
      chrome.storage.local.set({ targetDirection: targetDirection }, () => {
        updateTargetDirUI(targetDirection);
        notifyTabTargetDirection(targetDirection);
        showFeedback(`🎯 Target Arah Diubah ke: ${targetDirection.toUpperCase()}`, '#38bdf8');
      });
    });
  });

  function updateTargetDirUI(dir) {
    targetDirBtns.forEach(btn => {
      if (btn.getAttribute('data-dir') === dir) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  function updateToggleUI(active) {
    if (active) {
      btnToggleAuto.className = 'btn-toggle btn-state-active';
      toggleIcon.innerText = '⏹️';
      toggleText.innerText = 'Hentikan Deteksi & Klik Otomatis';
      statusCard.classList.remove('paused');
      statusPulse.className = 'pulse-dot';
      statusText.innerText = 'Deteksi & Klik Otomatis: AKTIF';
    } else {
      btnToggleAuto.className = 'btn-toggle btn-state-paused';
      toggleIcon.innerText = '▶️';
      toggleText.innerText = 'Mulai Deteksi & Klik Otomatis';
      statusCard.classList.add('paused');
      statusPulse.className = 'pulse-dot paused';
      statusText.innerText = 'Deteksi & Klik Otomatis: DIHENTIKAN';
    }
  }

  const pollHistory = [];
  const MAX_HISTORY = 8;
  let dynamicPrimaryIndex = -1;
  let domPollingInterval = null;
  let previousText = '';
  let isPollingPending = false;

  // State for tracking the most recently changed value
  let lastChangedValue = '--';

  // Deteksi pindah instrumen: kalau >50% posisi nilainya berbeda sekaligus -> reset tracking
  function detectInstrumentChange(prevSnap, currSnap) {
    if (!prevSnap || prevSnap.length === 0 || currSnap.length === 0) return false;
    const compareLen = Math.min(prevSnap.length, currSnap.length);
    let diffCount = 0;
    for (let i = 0; i < compareLen; i++) {
      if (prevSnap[i] !== currSnap[i]) diffCount++;
    }
    return diffCount / compareLen > 0.5;
  }

  // Cari posisi pertama yang nilainya BERVARIASI minimal 2x di riwayat poll
  function findFirstDynamicIndex(history) {
    if (history.length < 2) return -1;
    const maxLen = Math.max(...history.map(h => h.length));
    for (let i = 0; i < maxLen; i++) {
      const vals = history.map(h => h[i]).filter(v => v !== undefined);
      const uniqueVals = new Set(vals);
      if (uniqueVals.size >= 2) return i;
    }
    return -1;
  }

  function findBestPriceCandidate(numbers) {
    if (!numbers || numbers.length === 0) return '--';
    
    let best = null;
    let maxScore = -9999;
    
    for (let numStr of numbers) {
      let normalized = numStr.replace('★', '');
      const lastComma = normalized.lastIndexOf(',');
      const lastDot = normalized.lastIndexOf('.');
      if (lastComma > lastDot) {
          normalized = normalized.replace(/\./g, '').replace(',', '.');
      } else {
          normalized = normalized.replace(/,/g, '');
      }
      const clean = normalized.replace(/[^0-9.-]/g, '');
      if (!clean || clean === '.' || clean === '-' || clean === '+') continue;
      
      const parts = clean.split('.');
      const intPart = parts[0].replace(/^0+/, '') || '0';
      const decPart = parts.length > 1 ? parts[1] : '';
      const intD = intPart === '0' ? 0 : intPart.length;
      const decD = decPart.length;
      const val = parseFloat(clean);
      if (isNaN(val)) continue;
      
      let score = 0;
      if (decD >= 4) score += 150;
      else if (decD >= 2) score += 40;
      else if (decD === 1) score += 10;
      else if (decD === 0) score -= 200; // Penalize integers heavily
      
      score += (intD + decD) * 2;
      if (Math.abs(val) < 10 && decD < 4) score -= 20;
      
      if (score > maxScore) {
        maxScore = score;
        best = numStr;
      }
    }
    
    return best || numbers[0] || '--';
  }

  // ─── Handle a DOM text result and update UI (EXACT SELECT_DETECT LOGIC) ───
  function handleDomResult(result) {
    if (!result) return;

    const currentText = result.text || '';
    let numbers = result.numbers || [];

    // Tweak: Filter noise like timers (e.g. "5") atau persentase sebelum diproses
    numbers = numbers.filter(n => {
       const clean = n.replace(/[^0-9.-]/g, '');
       const val = parseFloat(clean);
       const hasDecimals = clean.includes('.') || clean.includes(',');
       if (!hasDecimals && Math.abs(val) < 1000) return false;
       return true;
    });

    // Kalau >50% posisi berubah sekaligus -> user pindah instrumen -> reset bersih
    const lastSnap = pollHistory.length > 0 ? pollHistory[pollHistory.length - 1] : null;
    if (lastSnap && detectInstrumentChange(lastSnap, numbers)) {
      pollHistory.length = 0;
      dynamicPrimaryIndex = -1;
      if (descPrimaryVal) descPrimaryVal.textContent = '--';
    }

    pollHistory.push([...numbers]);
    if (pollHistory.length > MAX_HISTORY) pollHistory.shift();

    // Cari posisi pertama yang variasinya terdeteksi (EXACT SELECT_DETECT)
    const found = findFirstDynamicIndex(pollHistory);
    if (found >= 0) dynamicPrimaryIndex = found;

    // Tampil nilainya; filter angka desimal harga nyata (bukan badge angka single 1-9)
    const primaryValue = dynamicPrimaryIndex >= 0 && numbers[dynamicPrimaryIndex] !== undefined
      ? numbers[dynamicPrimaryIndex]
      : findBestPriceCandidate(numbers);

    lastChangedValue = primaryValue;
    if (descPrimaryVal) descPrimaryVal.textContent = primaryValue;

    // Note: Live updating of openVal was removed to prevent race conditions and Schema V1 crashes.

    const currNum = parseFloat(primaryValue.replace(/[^0-9.-]/g, ''));
    const prevNumMatch = previousText.match(/[-+]?\d+\.?\d*/);
    const prevNum = prevNumMatch ? parseFloat(prevNumMatch[0]) : NaN;

    let trendBadge = '▶ STABIL';
    let trendColor = '#94a3b8';
    let trendBg = 'rgba(148, 163, 184, 0.15)';

    const hasChanged = currentText !== previousText;
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

    if (remoteTrendBadge) {
      remoteTrendBadge.textContent = trendBadge;
      remoteTrendBadge.style.background = trendBg;
      remoteTrendBadge.style.color = trendColor;
    }

    previousText = currentText;
  }

  function startDomPolling() {
    if (domPollingInterval) clearInterval(domPollingInterval);

    domPollingInterval = setInterval(async () => {
      if (!activeMappedRoi) return; // Strict: Hanya baca jika area telah dipetakan oleh user!

      if (!activeTabId) {
        const realTab = await findActiveWebTab();
        if (realTab && realTab.id) activeTabId = realTab.id;
        else return;
      }

      if (isPollingPending) return;
      isPollingPending = true;

      try {
        const result = await chrome.tabs.sendMessage(activeTabId, {
          action: 'read_dom_text',
          region: activeMappedRoi
        });
        if (result && result.text !== undefined && !result.error) {
          handleDomResult(result);
        }
      } catch (e) {
        // Tab might have navigated or closed — ignore
      } finally {
        isPollingPending = false;
      }
    }, 30); // 30ms = ~33 reads/detik (EXACT SELECT_DETECT)
  }

  function stopDomPolling() {
    if (domPollingInterval) {
      clearInterval(domPollingInterval);
      domPollingInterval = null;
    }
    isPollingPending = false;
    // Beritahu content script bahwa deteksi dihentikan sepenuhnya
    chrome.storage.local.get(['targetTabId'], (res) => {
      if (res.targetTabId) {
        chrome.tabs.sendMessage(res.targetTabId, { action: 'SET_AUTO_SCAN_STATE', isAutoScanning: false }, () => {
          if (chrome.runtime.lastError) {}
        });
      }
    });
  }



  // Live Status Polling
  async function pollLiveStatus() {
    const tab = await findActiveWebTab();
    if (tab) {
        chrome.tabs.sendMessage(tab.id, { action: 'GET_LIVE_STATUS' }, (res) => {
          if (chrome.runtime.lastError || !res) return;

          if (typeof res.isAutoScanning === 'boolean' && res.isAutoScanning !== isAutoScanning) {
            isAutoScanning = res.isAutoScanning;
            updateToggleUI(isAutoScanning);
          }

          if (res.targetDirection && res.targetDirection !== targetDirection) {
            targetDirection = res.targetDirection;
            updateTargetDirUI(targetDirection);
          }

          if (popupNominalInput && document.activeElement !== popupNominalInput && res.nominalValue) {
            popupNominalInput.value = res.nominalValue;
          }

          const signalBox = document.getElementById('popup-signal-box');
          const signalText = document.getElementById('popup-signal-text');
          if (signalBox && signalText && res.trendAnalysis) {
            const scoreStr = res.trendAnalysis.confidenceScore ? ` (${res.trendAnalysis.confidenceScore}%)` : '';
            let trendLbl = '⚠️ Trend Sideways / Hold';
            if (res.trendAnalysis.trend === 'uptrend') {
              trendLbl = `📈 UPTREND${scoreStr}`;
              signalBox.className = 'signal-banner signal-green';
            } else if (res.trendAnalysis.trend === 'downtrend') {
              trendLbl = `📉 DOWNTREND${scoreStr}`;
              signalBox.className = 'signal-banner signal-red';
            } else {
              signalBox.className = 'signal-banner signal-neutral';
            }

            let colorLbl = '';
            if (res.colorAnalysis && res.colorAnalysis.signal === 'hijau') {
              colorLbl = ' | 🟢 Hijau';
            } else if (res.colorAnalysis && res.colorAnalysis.signal === 'merah') {
              colorLbl = ' | 🔴 Merah';
            }
            signalText.innerHTML = `<strong>${trendLbl}${colorLbl}</strong>`;
          }

          const durBox = document.getElementById('popup-duration-box');
          const durText = document.getElementById('popup-duration-text');
          if (durBox && durText && res.durationInfo) {
            const timerLbl = res.durationInfo.timerText ? ` (${res.durationInfo.timerText})` : '';
            if (res.hasClickedInCurrentDuration) {
              durBox.className = 'signal-banner signal-neutral';
              durText.innerHTML = `🔒 <strong>1x Klik SELESAI${timerLbl}</strong>`;
            } else {
              durBox.className = 'signal-banner signal-green';
              durText.innerHTML = `🟢 <strong>1x Klik per Durasi: SIAP${timerLbl}</strong>`;
            }
          }
        });
    }
  }

  pollLiveStatus();
  setInterval(pollLiveStatus, 600);

  async function notifyTabState(active) {
    const tab = await findActiveWebTab();
    if (tab) {
        chrome.tabs.sendMessage(tab.id, {
          action: 'SET_AUTO_SCAN_STATE',
          isAutoScanning: active
        }, () => {
          if (chrome.runtime.lastError) {
            // Safe catch
          }
        });
    }
  }
  function notifyTabTargetDirection(dir) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'SET_TARGET_DIRECTION',
          targetDirection: dir
        }, () => {
          if (chrome.runtime.lastError) {
            // Safe catch
          }
        });
      }
    });
  }

  // 4. Tab Navigation
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      document.getElementById(targetId).classList.add('active');

      if (targetId === 'tab-history') {
        loadHistory();
      }
    });
  });

  // 6. Text & Symbol Analysis
  function performAnalysis(targetText) {
    // Disabled since UI is removed
  }

  // 7. Buttons: Copy & Force Scan (Disabled since UI is removed)

  // 8. Load History & Clear
  function loadHistory() {
    chrome.storage.local.get({ ocrHistory: [] }, (result) => {
      const history = result.ocrHistory;
      if (!history || history.length === 0) {
        historyList.innerHTML = '<div class="empty-state">Riwayat kosong (otomatis dibersihkan setiap 2 menit agar memori tidak penuh).</div>';
        return;
      }

      historyList.innerHTML = history.map(item => `
        <div class="history-item">
          <div class="history-time">⏱️ ${item.date} ${item.timestamp} | ${item.charCount} Karakter</div>
          <div class="history-text">${window.OcrEngine.escapeHtml(item.text)}</div>
        </div>
      `).join('');
    });
  }

  btnClearHistory.addEventListener('click', () => {
    const now = Date.now();
    chrome.storage.local.set({ ocrHistory: [], lastAutoClear: now }, () => {
      loadHistory();
      highlightedSelection = '';
    });
  });

  // 9. Handlers Otomasi Transaksi & Log Position Sesi
  const btnSendNominal = document.getElementById('btn-send-nominal');
  const btnClickNaik = document.getElementById('btn-click-naik');
  const btnClickTurun = document.getElementById('btn-click-turun');
  const automationFeedback = document.getElementById('automation-feedback');

  // Session Position Log Management
  let sessionLogs = [];
  const sessionLogList = document.getElementById('session-log-list');
  const btnClearSessionLogs = document.getElementById('btn-clear-session-logs');

  function loadSessionLogs() {
    chrome.storage.local.get({ sessionLogs: [] }, (res) => {
      sessionLogs = res.sessionLogs || [];
      renderSessionLogs();
    });
  }

  function renderSessionLogs() {
    if (!sessionLogList) return;
    if (sessionLogs.length === 0) {
      sessionLogList.innerHTML = '<div class="empty-state" style="text-align: center; color: #64748b; padding: 10px;">Belum ada log posisi. Klik "Mulai Deteksi" untuk mencatat sesi.</div>';
      return;
    }

    sessionLogList.innerHTML = sessionLogs.map((item, idx) => {
      // Support backward compatibility (old logs) and new schema V1
      const isClosed = item.status === 'CLOSED';
      const isActionRequested = item.status === 'ACTION_REQUESTED';
      const isExecutionUnknown = item.status === 'EXECUTION_UNKNOWN';
      
      let statusBg = 'rgba(16, 185, 129, 0.15)';
      let statusBorder = 'rgba(16, 185, 129, 0.4)';
      let badgeText = '🟢 OPEN';
      let badgeColor = '#10b981';

      if (isClosed) {
        statusBg = 'rgba(30, 41, 59, 0.8)';
        statusBorder = 'rgba(255,255,255,0.08)';
        badgeText = 'CLOSED';
        badgeColor = '#94a3b8';
      } else if (isActionRequested) {
        statusBg = 'rgba(245, 158, 11, 0.15)';
        statusBorder = 'rgba(245, 158, 11, 0.4)';
        badgeText = '🟡 PENDING';
        badgeColor = '#f59e0b';
      } else if (isExecutionUnknown) {
        statusBg = 'rgba(239, 68, 68, 0.15)';
        statusBorder = 'rgba(239, 68, 68, 0.4)';
        badgeText = '🔴 EXEC FAILED';
        badgeColor = '#ef4444';
      }

      // Dinamis merender HTML dari Pure Data (Schema V1)
      let renderResult = item.resultText || '⚪ STABIL'; // Fallback legacy
      const safeDiff = item.priceDifference != null ? item.priceDifference : undefined;
      
      if (item.result === 'WIN') {
        const diffText = safeDiff !== undefined ? `(+${safeDiff.toFixed(4)})` : '';
        renderResult = `<strong style="color:#10b981;">🟢 WIN ${diffText}</strong>`;
      } else if (item.result === 'LOSS') {
        const diffText = safeDiff !== undefined ? `(${safeDiff.toFixed(4)})` : '';
        renderResult = `<strong style="color:#ef4444;">🔴 LOSS ${diffText}</strong>`;
      } else if (item.result === 'NETRAL') {
        renderResult = `<strong style="color:#f59e0b;">⚪ NETRAL (Draw)</strong>`;
      } else if (item.result === 'UNKNOWN' || item.reconciliationRequired) {
        renderResult = `⚪ UNKNOWN ${item.reconciliationRequired ? '<small>(RECONCILIATION REQUIRED)</small>' : ''}`;
      } else if (item.result === 'ERROR') {
        renderResult = `❌ ERROR`;
      }

      // Schema V1 fallback
      const openVal = (item.entry && item.entry.raw) || item.openVal || '--';
      const closeVal = (item.close && item.close.raw) || item.closeVal || '--';
      const openTime = item.openedAt ? new Date(item.openedAt).toTimeString().substring(0, 8) : (item.startTime || '');
      const closeTime = (item.close && item.close.timestamp) ? new Date(item.close.timestamp).toTimeString().substring(0, 8) : (item.closeTime || '');
      const displayId = item.positionId ? item.positionId.slice(-8) : (item.operationId ? item.operationId.slice(-8) : '#' + (sessionLogs.length - idx));

      return `
        <div style="background: ${statusBg}; border: 1px solid ${statusBorder}; border-radius: 6px; padding: 6px 8px; margin-bottom: 6px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <span style="font-weight: 700; color: #38bdf8; font-size: 10px;">${displayId} ${(item.direction || 'AUTO').toUpperCase()} | Rp ${item.nominal || 0}</span>
            <span style="background: rgba(0,0,0,0.3); color: ${badgeColor}; padding: 1px 6px; border-radius: 4px; font-weight: 700;">${badgeText}</span>
          </div>
          <div style="color: #cbd5e1; font-size: 10px;">
            <span>▶ <strong>Open:</strong> ${openVal} <small>(${openTime})</small></span>
            ${isClosed ? `<br><span>🏁 <strong>Close:</strong> ${closeVal} <small>(${closeTime})</small> | ${renderResult}</span>` : `<br><span>🏁 <strong>Close:</strong> ⏳ Menunggu...</span>`}
            ${item.reconciliationRequired && !isClosed ? `<br><span style="color:#fbbf24;">⚠️ Reconciliation Required</span>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  if (btnClearSessionLogs) {
    btnClearSessionLogs.addEventListener('click', () => {
      sessionLogs = [];
      chrome.storage.local.set({ sessionLogs: [] }, () => {
        renderSessionLogs();
        showFeedback('🗑️ Semua log posisi sesi berhasil dihapus!', '#ef4444');
      });
    });
  }

  loadSessionLogs();

  function sendTabAction(actionName, data = {}) {
    const executeOnTab = (tabId) => {
      chrome.tabs.sendMessage(tabId, { action: actionName, ...data }, async (response) => {
        if (chrome.runtime.lastError) {
          // Otomatis injeksi skrip jika belum terinjeksi di tab web
          try {
            await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] }).catch(() => {});
            await chrome.scripting.executeScript({
              target: { tabId },
              files: ['lib/change-detector.js', 'lib/ocr-engine.js', 'content.js']
            });
            // Coba lagi kirim perintah setelah injeksi dinamis selesai
            setTimeout(() => {
              chrome.tabs.sendMessage(tabId, { action: actionName, ...data }, (res2) => {
                if (chrome.runtime.lastError) {
                  showFeedback('⚠️ Gagal terhubung ke tab (Coba refresh halaman web)', '#f87171');
                } else if (res2 && res2.message) {
                  showFeedback(res2.message, res2.success ? '#4ade80' : '#f87171');
                } else {
                  showFeedback('✅ Perintah berhasil dikirim ke tab web!', '#4ade80');
                }
              });
            }, 120);
          } catch (e) {
            showFeedback('⚠️ Gagal terhubung ke tab web', '#f87171');
          }
          return;
        }

        if (response && response.message) {
          showFeedback(response.message, response.success ? '#4ade80' : '#f87171');
        }
      });
    };

    chrome.storage.local.get(['targetTabId'], (res) => {
      if (res.targetTabId) {
        executeOnTab(res.targetTabId);
      } else {
        chrome.tabs.query({ active: true, windowType: 'normal' }, (tabs) => {
          const t = (tabs && tabs[0]) ? tabs[0] : null;
          if (t && t.id) executeOnTab(t.id);
          else showFeedback('⚠️ Tidak ada tab aktif ditemukan', '#f87171');
        });
      }
    });
  }

  function showFeedback(msg, color = '#4ade80') {
    if (automationFeedback) {
      automationFeedback.innerText = msg;
      automationFeedback.style.color = color;
      setTimeout(() => {
        if (automationFeedback.innerText === msg) automationFeedback.innerText = '';
      }, 3500);
    }
  }

  if (btnSendNominal) {
    btnSendNominal.addEventListener('click', () => {
      const baseVal = (popupBaseNominalInput && popupBaseNominalInput.value.trim()) 
        ? popupBaseNominalInput.value.trim() 
        : (popupNominalInput ? popupNominalInput.value : '10000');

      if (popupNominalInput) popupNominalInput.value = baseVal;
      chrome.storage.local.set({ nominalValue: baseVal, baseNominalValue: baseVal });

      sendTabAction('INPUT_NOMINAL', { value: baseVal });
      showFeedback(`✏️ Nominal diisi dari Modal Awal: Rp ${baseVal}`, '#4ade80');
    });
  }

  if (btnClickNaik) {
    btnClickNaik.addEventListener('click', () => {
      sendTabAction('CLICK_NAIK');
    });
  }

  if (btnClickTurun) {
    btnClickTurun.addEventListener('click', () => {
      sendTabAction('CLICK_TURUN');
    });
  }
});


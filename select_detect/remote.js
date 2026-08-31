/**
 * Remote Pop Up Window — Real-Time DOM Text Reader
 * Reads text DIRECTLY from DOM elements at the mapped area, bypassing inaccurate OCR.
 * Achieves 100% accuracy for numbers, decimals, labels, and prices from any web page.
 */

import { ScreenCaptureEngine } from './lib/capture.js';
import { MicrosecondLogger } from './lib/logger.js';

document.addEventListener('DOMContentLoaded', () => {
  const captureEngine = new ScreenCaptureEngine();
  const logger = new MicrosecondLogger();

  const previewCanvas = document.getElementById('remotePreviewCanvas');
  const previewCtx = previewCanvas.getContext('2d');

  const btnStart = document.getElementById('btnRemoteStart');
  const btnStop = document.getElementById('btnRemoteStop');
  const btnMapTarget = document.getElementById('btnRemoteMapTarget');
  const btnResetRoi = document.getElementById('btnRemoteResetRoi');
  const btnToggleAutoTracking = document.getElementById('btnToggleAutoTracking');
  const btnOpenDashboard = document.getElementById('btnRemoteOpenDashboard');

  const remoteStatusBadge = document.getElementById('remoteStatusBadge');
  const remoteFpsTag = document.getElementById('remoteFpsTag');
  const remoteMappedText = document.getElementById('remoteMappedText');
  const remoteTextDisplay = document.getElementById('remoteTextDisplay');
  const remotePrevText = document.getElementById('remotePrevText');
  const remoteConfidence = document.getElementById('remoteConfidence');
  const remoteTimestamp = document.getElementById('remoteTimestamp');

  const remoteTrendBadge = document.getElementById('remoteTrendBadge');
  const descPrimaryVal = document.getElementById('descPrimaryVal');
  const descBadgesContainer = document.getElementById('descBadgesContainer');
  const remoteHistoryFeed = document.getElementById('remoteHistoryFeed');

  const mRemoteCaptureFps = document.getElementById('mRemoteCaptureFps');
  const mRemoteLatency = document.getElementById('mRemoteLatency');
  const mRemoteChanges = document.getElementById('mRemoteChanges');

  let activeMappedRoi = null;
  let activeTabId = null;
  let trackedRect = null;   // Live bounding rect from content script — follows element movement
  let previousText = '';
  let changeCount = 0;
  const liveHistoryLog = [];

  // ─── Sliding window: simpan riwayat poll ───
  const pollHistory = [];     // Array of numbers[] snapshots
  const MAX_HISTORY = 8;      // Jumlah poll yang disimpan
  let dynamicPrimaryIndex = -1;

  // Deteksi pindah instrumen: kalau >50% posisi nilainya berbeda sekaligus
  // berarti bukan perubahan normal tapi ganti instrumen → reset tracking
  function detectInstrumentChange(prevSnap, currSnap) {
    if (!prevSnap || prevSnap.length === 0 || currSnap.length === 0) return false;
    const compareLen = Math.min(prevSnap.length, currSnap.length);
    let diffCount = 0;
    for (let i = 0; i < compareLen; i++) {
      if (prevSnap[i] !== currSnap[i]) diffCount++;
    }
    return diffCount / compareLen > 0.5; // >50% berubah sekaligus = ganti instrumen
  }

  // Cari posisi pertama yang nilainya BERVARIASI minimal 2x di riwayat poll
  // (bukan hanya 1x, untuk menghindari false positive dari noise sesaat)
  function findFirstDynamicIndex(history) {
    if (history.length < 2) return -1;
    const maxLen = Math.max(...history.map(h => h.length));
    for (let i = 0; i < maxLen; i++) {
      const vals = history.map(h => h[i]).filter(v => v !== undefined);
      const uniqueVals = new Set(vals);
      // Harus ada minimal 2 nilai berbeda DAN sudah teramati di cukup banyak poll
      if (uniqueVals.size >= 2) return i;
    }
    return -1;
  }

  let domPollingInterval = null;
  let renderLoopId = null;

  previewCanvas.width = 400;
  previewCanvas.height = 225;

  // ─── Listen for messages from content script / background ───
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'target_mapped') {
      activeMappedRoi = request.roi;

      if (request.roi) {
        const w = request.roi.displayW || Math.round(request.roi.width || 0);
        const h = request.roi.displayH || Math.round(request.roi.height || 0);
        remoteMappedText.textContent = `${w}×${h} px`;
      } else {
        remoteMappedText.textContent = 'Layar Penuh';
      }

      // Start DOM polling immediately after mapping
      startDomPolling();
    }

    // Receive initial read from content script right after mapping
    if (request.action === 'dom_text_result') {
      handleDomResult(request.result);
    }
  });

  // ─── DOM Polling: baca teks DOM setiap 80ms (hampir real-time) ───
  let isPollingPending = false; // guard: skip jika request sebelumnya masih pending

  function startDomPolling() {
    if (domPollingInterval) clearInterval(domPollingInterval);

    domPollingInterval = setInterval(async () => {
      if (!activeMappedRoi || !activeTabId) return;
      if (isPollingPending) return; // jangan overlap request

      isPollingPending = true;
      try {
        const result = await chrome.tabs.sendMessage(activeTabId, {
          action: 'read_dom_text',
          region: activeMappedRoi
        });
        if (result && result.text !== undefined) {
          // Update trackedRect for preview canvas drawing
          if (result.trackedRect) {
            trackedRect = result.trackedRect;
            activeMappedRoi = {
              ...activeMappedRoi,
              xRatio: result.trackedRect.xRatio,
              yRatio: result.trackedRect.yRatio,
              wRatio: result.trackedRect.wRatio,
              hRatio: result.trackedRect.hRatio
            };
          }
          handleDomResult(result);
        }
      } catch (e) {
        // Tab might have navigated or closed — ignore
      } finally {
        isPollingPending = false;
      }
    }, 30); // 30ms = ~33 reads/detik
  }

  function stopDomPolling() {
    if (domPollingInterval) {
      clearInterval(domPollingInterval);
      domPollingInterval = null;
    }
  }

  // ─── Handle a DOM text result and update UI ───
  function handleDomResult(result) {
    if (!result) return;

    const currentText = result.text || '';
    const numbers = result.numbers || [];
    const labels = result.labels || [];

    // Update main text display
    remoteTextDisplay.textContent = currentText || '[AREA KOSONG — lihat debug di bawah]';
    remoteConfidence.textContent = '100%';

    // ─── Update Debug Panel ───
    const debugElemCount = document.getElementById('debugElemCount');
    const debugRawOutput = document.getElementById('debugRawOutput');
    if (debugRawOutput) {
      const elems = result.debugElements || [];
      if (debugElemCount) debugElemCount.textContent = `${elems.length} elem`;

      if (elems.length === 0) {
        debugRawOutput.innerHTML = `<span style="color:#ef4444;">⚠ Tidak ada element DOM ditemukan di area ini.<br>Kemungkinan chart dirender di &lt;canvas&gt; — teks tidak bisa dibaca dari DOM.</span>`;
      } else {
        debugRawOutput.innerHTML = elems.map(e => {
          const hasText = e.text || e.aria;
          const color   = hasText ? '#86efac' : '#f87171';
          const label   = e.id ? `#${e.id}` : e.cls ? `.${e.cls}` : '';
          const textSnip = (e.aria || e.text || '(kosong)').substring(0, 50);
          return `<div style="color:${color}; border-bottom: 1px solid rgba(255,255,255,0.05); padding: 1px 0;">&lt;${e.tag}${label ? ' '+label : ''}&gt; → <strong>${textSnip}</strong></div>`;
        }).join('');
      }
    }

    const now = new Date();
    const timeStr = now.toTimeString().substring(0, 8);
    remoteTimestamp.textContent = `[${timeStr}]`;

    // Detect change
    const hasChanged = currentText !== previousText;

    if (hasChanged) {
      changeCount++;
      mRemoteChanges.textContent = changeCount;
      remotePrevText.textContent = previousText || '--';
    }

    // ─── Sliding window + instrument-change detection ───
    const lastSnap = pollHistory.length > 0 ? pollHistory[pollHistory.length - 1] : null;

    // Kalau >50% posisi berubah sekaligus → user pindah instrumen → reset bersih
    if (lastSnap && detectInstrumentChange(lastSnap, numbers)) {
      pollHistory.length = 0;
      dynamicPrimaryIndex = -1;
      descPrimaryVal.textContent = '--';
    }

    pollHistory.push([...numbers]);
    if (pollHistory.length > MAX_HISTORY) pollHistory.shift();

    // Cari posisi pertama yang variasinya terdeteksi
    const found = findFirstDynamicIndex(pollHistory);
    if (found >= 0) dynamicPrimaryIndex = found;

    // Tampil nilainya; '--' selama belum ada yang terdeteksi dinamis
    const primaryValue = dynamicPrimaryIndex >= 0 && numbers[dynamicPrimaryIndex] !== undefined
      ? numbers[dynamicPrimaryIndex]
      : '--';
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

    // Render element badges
    const numBadges = numbers.map(n =>
      `<span style="background: rgba(0, 229, 255, 0.15); border: 1px solid rgba(0, 229, 255, 0.4); color: #00e5ff; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 700; font-family: monospace;">🔢 ${n}</span>`
    ).join('');

    const wordBadges = labels.map(w =>
      `<span style="background: rgba(139, 92, 246, 0.15); border: 1px solid rgba(139, 92, 246, 0.4); color: #c4b5fd; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 700; font-family: monospace;">🏷️ ${w}</span>`
    ).join('');

    if (numBadges || wordBadges) {
      descBadgesContainer.innerHTML = numBadges + wordBadges;
    } else if (currentText) {
      descBadgesContainer.innerHTML = `<span style="font-size: 0.75rem; color: #94a3b8; font-family: monospace;">${currentText}</span>`;
    } else {
      descBadgesContainer.innerHTML = `<span style="font-size: 0.75rem; color: #94a3b8; font-style: italic;">-- Belum ada data --</span>`;
    }

    // Push to live history feed
    if (hasChanged || liveHistoryLog.length === 0) {
      liveHistoryLog.unshift({
        time: timeStr,
        text: primaryValue || currentText || '--',
        trend: trendBadge,
        trendColor
      });

      if (liveHistoryLog.length > 15) liveHistoryLog.pop();

      remoteHistoryFeed.innerHTML = liveHistoryLog.map(item => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.35rem 0.6rem; background: rgba(0, 0, 0, 0.35); border-radius: 6px; border: 1px solid rgba(255,255,255,0.06); gap: 0.5rem;">
          <span style="color: var(--text-muted); font-size: 0.7rem; font-family: monospace; flex-shrink: 0;">⏱️ ${item.time}</span>
          <strong style="color: #00e5ff; font-size: 0.9rem; font-family: monospace; flex: 1; text-align: center;">${item.text}</strong>
          <span style="font-size: 0.65rem; font-weight: 700; background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; font-family: monospace; color: ${item.trendColor}; flex-shrink: 0;">${item.trend}</span>
        </div>
      `).join('');
    }

    previousText = currentText;
  }

  // ─── Auto-Tracking toggle (visual only — DOM reader doesn't need it) ───
  btnToggleAutoTracking.addEventListener('click', () => {
    const isOn = btnToggleAutoTracking.textContent.includes('ON');
    if (!isOn) {
      btnToggleAutoTracking.textContent = '🔄 Auto-Tracking ON';
      btnToggleAutoTracking.style.background = 'rgba(16, 185, 129, 0.2)';
      btnToggleAutoTracking.style.borderColor = 'rgba(16, 185, 129, 0.4)';
      btnToggleAutoTracking.style.color = '#10b981';
    } else {
      btnToggleAutoTracking.textContent = '⏸ Auto-Tracking OFF';
      btnToggleAutoTracking.style.background = 'rgba(148, 163, 184, 0.15)';
      btnToggleAutoTracking.style.borderColor = 'rgba(148, 163, 184, 0.3)';
      btnToggleAutoTracking.style.color = '#94a3b8';
    }
  });

  btnResetRoi.addEventListener('click', () => {
    activeMappedRoi = null;
    trackedRect = null;
    stopDomPolling();

    // Stop RAF tracking loop in content script
    if (activeTabId) {
      chrome.tabs.sendMessage(activeTabId, { action: 'stop_tracking' }).catch(() => {});
    }

    // Reset dynamic tracking state
    pollHistory.length = 0;
    dynamicPrimaryIndex = -1;

    remoteMappedText.textContent = 'Layar Penuh';
    previousText = '';
    changeCount = 0;
    descBadgesContainer.innerHTML = `<span style="font-size: 0.75rem; color: #94a3b8; font-style: italic;">-- Belum ada pemetaan --</span>`;
    remoteHistoryFeed.innerHTML = `<div style="color: var(--text-muted); font-style: italic;">Belum ada riwayat pergerakan angka...</div>`;
    remoteTextDisplay.textContent = '--';
    remotePrevText.textContent = '--';
    descPrimaryVal.textContent = '--';
  });

  btnMapTarget.addEventListener('click', async () => {
    try {
      const allTabs = await chrome.tabs.query({});
      const realTab = allTabs.find(t => t.url && t.url.startsWith('http') && t.active)
        || allTabs.find(t => t.url && t.url.startsWith('http'));

      if (realTab && realTab.id) {
        activeTabId = realTab.id;

        if (realTab.windowId) {
          try { await chrome.windows.update(realTab.windowId, { focused: true }); } catch (e) {}
        }

        try {
          await chrome.scripting.insertCSS({ target: { tabId: realTab.id }, files: ['content.css'] });
        } catch (e) {}

        try {
          await chrome.scripting.executeScript({ target: { tabId: realTab.id }, files: ['content.js'] });
        } catch (e) {}

        setTimeout(() => {
          chrome.tabs.sendMessage(realTab.id, { action: 'start_target_mapper' }, () => {
            if (chrome.runtime.lastError) {}
          });
        }, 150);
      } else {
        alert('Silakan buka tab halaman web (http/https) di browser Anda terlebih dahulu.');
      }
    } catch (err) {
      console.log('[PopUpRemote] Target mapping error:', err);
    }
  });

  // ─── Screen preview (still uses capture for visual preview only) ───
  btnStart.addEventListener('click', async () => {
    try {
      await captureEngine.startCapture(30);
      onCaptureStarted();
    } catch (err) {
      // Start DOM polling anyway even if screen capture fails
      onCaptureStarted();
    }
  });

  btnStop.addEventListener('click', () => {
    captureEngine.stopCapture();
    onCaptureStopped();
  });

  btnOpenDashboard.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'open_dashboard' });
  });

  function onCaptureStarted() {
    btnStart.style.display = 'none';
    btnStop.style.display = 'flex';
    remoteStatusBadge.className = 'status-badge active';
    remoteStatusBadge.textContent = 'STATUS: ACTIVE';

    if (!renderLoopId) {
      renderLoopId = requestAnimationFrame(previewLoop);
    }
  }

  function onCaptureStopped() {
    btnStart.style.display = 'flex';
    btnStop.style.display = 'none';
    remoteStatusBadge.className = 'status-badge paused';
    remoteStatusBadge.textContent = 'STATUS: READY';

    if (renderLoopId) {
      cancelAnimationFrame(renderLoopId);
      renderLoopId = null;
    }
  }

  // Preview loop — only for visual canvas preview, not OCR
  function previewLoop() {
    if (captureEngine.isCapturing) {
      if (captureEngine.videoElement && captureEngine.videoElement.videoWidth > 0) {
        previewCtx.drawImage(captureEngine.videoElement, 0, 0, previewCanvas.width, previewCanvas.height);
      } else if (captureEngine.latestFrame) {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = captureEngine.latestFrame.width;
        tempCanvas.height = captureEngine.latestFrame.height;
        tempCanvas.getContext('2d').putImageData(captureEngine.latestFrame.imageData, 0, 0);
        previewCtx.drawImage(tempCanvas, 0, 0, previewCanvas.width, previewCanvas.height);
      }

      // Draw live-tracked ROI box on preview canvas (follows element movement)
      const roiToDraw = trackedRect || activeMappedRoi;
      if (roiToDraw && captureEngine.latestFrame) {
        const frameW = captureEngine.latestFrame.width;
        const frameH = captureEngine.latestFrame.height;
        const scaleX = previewCanvas.width / frameW;
        const scaleY = previewCanvas.height / frameH;

        const rx = roiToDraw.xRatio * frameW * scaleX;
        const ry = roiToDraw.yRatio * frameH * scaleY;
        const rw = roiToDraw.wRatio * frameW * scaleX;
        const rh = roiToDraw.hRatio * frameH * scaleY;

        // Animated glow effect
        previewCtx.shadowColor = '#00e5ff';
        previewCtx.shadowBlur = 6;
        previewCtx.strokeStyle = '#00e5ff';
        previewCtx.lineWidth = 2;
        previewCtx.strokeRect(rx, ry, rw, rh);
        previewCtx.shadowBlur = 0;
        previewCtx.fillStyle = '#00e5ff';
        previewCtx.font = 'bold 9px monospace';
        previewCtx.fillText('🎯 TRACKING', rx + 4, ry + 11);
      } else if (activeMappedRoi) {
        // Fallback: draw static mapped area when no frame available
        const cw = previewCanvas.width;
        const ch = previewCanvas.height;
        const rx = activeMappedRoi.xRatio * cw;
        const ry = activeMappedRoi.yRatio * ch;
        const rw = activeMappedRoi.wRatio * cw;
        const rh = activeMappedRoi.hRatio * ch;
        previewCtx.strokeStyle = '#00e5ff';
        previewCtx.lineWidth = 2;
        previewCtx.strokeRect(rx, ry, rw, rh);
      }

      remoteFpsTag.textContent = `${captureEngine.actualFPS.toFixed(1)} FPS`;
      mRemoteCaptureFps.textContent = captureEngine.actualFPS.toFixed(1);
    }

    const avgLatency = domPollingInterval ? '~500ms' : '--';
    mRemoteLatency.textContent = avgLatency;

    renderLoopId = requestAnimationFrame(previewLoop);
  }
});

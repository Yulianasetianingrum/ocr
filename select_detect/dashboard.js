import { ScreenCaptureEngine } from './lib/capture.js';
import { ChangeDetector } from './lib/change-detector.js';
import { OCREngine } from './lib/ocr-engine.js';
import { MicrosecondLogger } from './lib/logger.js';
import { AcceptanceTestSuite } from './lib/test-suite.js';

document.addEventListener('DOMContentLoaded', () => {
  // Initialize Engine Components
  const captureEngine = new ScreenCaptureEngine();
  const changeDetector = new ChangeDetector();
  const ocrEngine = new OCREngine();
  const logger = new MicrosecondLogger();
  const testSuite = new AcceptanceTestSuite(captureEngine, changeDetector, ocrEngine, logger);

  // DOM Elements
  const previewCanvas = document.getElementById('previewCanvas');
  const previewCtx = previewCanvas.getContext('2d');
  
  // Buttons & Badges
  const btnStartCapture = document.getElementById('btnStartCapture');
  const btnStopCapture = document.getElementById('btnStopCapture');
  const btnOpenRemoteWindow = document.getElementById('btnOpenRemoteWindow');
  const btnExportCSV = document.getElementById('btnExportCSV');
  const btnExportJSON = document.getElementById('btnExportJSON');
  const btnClearLogs = document.getElementById('btnClearLogs');
  const systemStatusBadge = document.getElementById('systemStatusBadge');
  const textChangeBadge = document.getElementById('textChangeBadge');
  const roiModeBadge = document.getElementById('roiModeBadge');

  // ROI buttons
  const btnRoiFullScreen = document.getElementById('btnRoiFullScreen');
  const btnRoiCustom = document.getElementById('btnRoiCustom');
  const btnRoiMulti = document.getElementById('btnRoiMulti');
  const btnClearRoi = document.getElementById('btnClearRoi');

  // Telemetry metrics
  const metricCaptureFps = document.getElementById('metricCaptureFps');
  const metricFpsTarget = document.getElementById('metricFpsTarget');
  const metricTotalLatency = document.getElementById('metricTotalLatency');
  const metricLatencyStats = document.getElementById('metricLatencyStats');
  const metricChangeDetectMs = document.getElementById('metricChangeDetectMs');
  const metricOcrLatency = document.getElementById('metricOcrLatency');
  const metricDroppedFrames = document.getElementById('metricDroppedFrames');
  const metricChangesPerSec = document.getElementById('metricChangesPerSec');

  // OCR Output Elements
  const resultTextDisplay = document.getElementById('resultTextDisplay');
  const resultPrevText = document.getElementById('resultPrevText');
  const resultConfidence = document.getElementById('resultConfidence');
  const resultTimestamp = document.getElementById('resultTimestamp');
  const logTableBody = document.getElementById('logTableBody');

  // Settings
  const selectTargetFps = document.getElementById('selectTargetFps');
  const rangeDiffThreshold = document.getElementById('rangeDiffThreshold');
  const rangePixelThreshold = document.getElementById('rangePixelThreshold');
  const rangeConfidenceThreshold = document.getElementById('rangeConfidenceThreshold');
  const selectCharWhitelist = document.getElementById('selectCharWhitelist');
  const chkPreprocessing = document.getElementById('chkPreprocessing');

  // Labels
  const lblTargetFps = document.getElementById('lblTargetFps');
  const lblDiffSens = document.getElementById('lblDiffSens');
  const lblPixelSens = document.getElementById('lblPixelSens');
  const lblConfThresh = document.getElementById('lblConfThresh');

  // Test Suite Buttons & Benchmark Cards
  const btnTest1 = document.getElementById('btnTest1');
  const btnTest2 = document.getElementById('btnTest2');
  const btnTest3 = document.getElementById('btnTest3');
  const btnTest4 = document.getElementById('btnTest4');
  const btnTest5 = document.getElementById('btnTest5');
  const testStatusMessage = document.getElementById('testStatusMessage');

  const bmCaptureFps = document.getElementById('bmCaptureFps');
  const bmOcrFps = document.getElementById('bmOcrFps');
  const bmAvgOcrMs = document.getElementById('bmAvgOcrMs');
  const bmAvgEndToEndMs = document.getElementById('bmAvgEndToEndMs');
  const bmP95Ms = document.getElementById('bmP95Ms');

  // ROI State Management
  let roiMode = 'fullscreen'; // 'fullscreen' | 'custom' | 'multi'
  let activeRois = []; // Array of { id, x, y, width, height }
  let isDrawingRoi = false;
  let roiDragStart = null;
  let currentDragRect = null;

  // Consumer Pipeline Loop State
  let isConsumerProcessing = false;
  let renderLoopId = null;

  // Initialize Default Configuration
  updateConfigurationFromUI();

  // --- ROI SELECTION MOUSE DRAG HANDLERS ---
  previewCanvas.addEventListener('mousedown', (e) => {
    const rect = previewCanvas.getBoundingClientRect();
    const scaleX = previewCanvas.width / rect.width;
    const scaleY = previewCanvas.height / rect.height;

    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    isDrawingRoi = true;
    roiDragStart = { x, y };
    currentDragRect = { x, y, width: 0, height: 0 };
  });

  previewCanvas.addEventListener('mousemove', (e) => {
    if (!isDrawingRoi || !roiDragStart) return;
    const rect = previewCanvas.getBoundingClientRect();
    const scaleX = previewCanvas.width / rect.width;
    const scaleY = previewCanvas.height / rect.height;

    const currentX = (e.clientX - rect.left) * scaleX;
    const currentY = (e.clientY - rect.top) * scaleY;

    const x = Math.min(roiDragStart.x, currentX);
    const y = Math.min(roiDragStart.y, currentY);
    const width = Math.abs(currentX - roiDragStart.x);
    const height = Math.abs(currentY - roiDragStart.y);

    currentDragRect = { x, y, width, height };
  });

  previewCanvas.addEventListener('mouseup', (e) => {
    if (!isDrawingRoi) return;
    isDrawingRoi = false;

    if (currentDragRect && currentDragRect.width > 10 && currentDragRect.height > 10) {
      if (roiMode !== 'multi' || !e.shiftKey) {
        activeRois = []; // clear single custom ROI
      }
      activeRois.push({
        id: `roi_${Date.now()}_${activeRois.length + 1}`,
        ...currentDragRect
      });
      roiMode = activeRois.length > 1 ? 'multi' : 'custom';
      updateRoiBadges();
      changeDetector.resetHistory();
    }
    currentDragRect = null;
  });

  function updateRoiBadges() {
    if (roiMode === 'fullscreen' || activeRois.length === 0) {
      roiModeBadge.textContent = 'Mode: Full Screen';
    } else if (roiMode === 'multi') {
      roiModeBadge.textContent = `Mode: Multi-ROI (${activeRois.length} regions)`;
    } else {
      roiModeBadge.textContent = `Mode: Custom ROI (${Math.round(activeRois[0].width)}x${Math.round(activeRois[0].height)})`;
    }
  }

  btnRoiFullScreen.addEventListener('click', () => {
    roiMode = 'fullscreen';
    activeRois = [];
    updateRoiBadges();
    changeDetector.resetHistory();
  });

  btnRoiCustom.addEventListener('click', () => {
    roiMode = 'custom';
    updateRoiBadges();
  });

  btnRoiMulti.addEventListener('click', () => {
    roiMode = 'multi';
    updateRoiBadges();
  });

  if (btnOpenRemoteWindow) {
    btnOpenRemoteWindow.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'open_standalone_remote' });
    });
  }

  btnClearRoi.addEventListener('click', () => {
    roiMode = 'fullscreen';
    activeRois = [];
    updateRoiBadges();
    changeDetector.resetHistory();
  });

  // --- START / STOP CAPTURE HANDLERS ---
  btnStartCapture.addEventListener('click', async () => {
    try {
      const targetFPS = parseInt(selectTargetFps.value, 10);
      await captureEngine.startCapture(targetFPS);
      onCaptureStarted();
    } catch (err) {
      alert('Screen capture initialization failed or user cancelled permission: ' + err.message);
    }
  });

  btnStopCapture.addEventListener('click', () => {
    captureEngine.stopCapture();
    onCaptureStopped();
  });

  function onCaptureStarted() {
    btnStartCapture.style.display = 'none';
    btnStopCapture.style.display = 'inline-flex';
    systemStatusBadge.className = 'status-badge active';
    systemStatusBadge.textContent = 'STATUS: ACTIVE MONITORING';

    // Start Consumer Processing & Render Loop
    if (!renderLoopId) {
      renderLoopId = requestAnimationFrame(consumerLoop);
    }
  }

  function onCaptureStopped() {
    btnStartCapture.style.display = 'inline-flex';
    btnStopCapture.style.display = 'none';
    systemStatusBadge.className = 'status-badge paused';
    systemStatusBadge.textContent = 'STATUS: READY';

    if (renderLoopId) {
      cancelAnimationFrame(renderLoopId);
      renderLoopId = null;
    }
  }

  // --- PRODUCER-CONSUMER PIPELINE & RENDER LOOP ---
  async function consumerLoop() {
    if (captureEngine.isCapturing || testSuite.isRunningTest) {
      // 1. Consume latest frame from Producer buffer (stale frames auto-dropped by Producer)
      const frame = captureEngine.consumeLatestFrame();

      if (frame && !isConsumerProcessing) {
        isConsumerProcessing = true;
        await processFrameConsumer(frame);
        isConsumerProcessing = false;
      }

      // 2. Render live preview canvas overlay
      renderPreviewOverlay(captureEngine.latestFrame || frame);

      // 3. Update telemetry UI cards
      updateTelemetryUI();
    }

    renderLoopId = requestAnimationFrame(consumerLoop);
  }

  /**
   * Async Frame Consumer: Change Detection -> Sub-ROI Cropping -> Preprocessing -> OCR -> Logger
   */
  async function processFrameConsumer(frame) {
    const pipelineStartTime = performance.now();
    const frameData = frame.imageData;

    // Define effective ROIs to evaluate
    let targetRois = activeRois;
    if (roiMode === 'fullscreen' || activeRois.length === 0) {
      targetRois = [{ id: 'full', x: 0, y: 0, width: frameData.width, height: frameData.height }];
    }

    for (const roi of targetRois) {
      // Step 1: Change Detection on ROI
      const changeResult = changeDetector.detectRoiChange(frameData, roi, roi.id);

      // Requirement 2: SKIP OCR if change ratio is below threshold!
      if (!changeResult.hasChanged) {
        continue; // SKIP OCR!
      }

      // Requirement 9: Smart Difference Bounding Box OCR
      // If only a small sub-region changed, perform OCR on boundingSubBox inside ROI!
      let ocrInputImageData = changeResult.croppedImageData;
      let effectiveCropRoi = roi;

      if (changeResult.boundingSubBox && changeResult.boundingSubBox.width > 5 && changeResult.boundingSubBox.height > 5) {
        const subBox = changeResult.boundingSubBox;
        effectiveCropRoi = {
          x: roi.x + subBox.x,
          y: roi.y + subBox.y,
          width: subBox.width,
          height: subBox.height
        };
        ocrInputImageData = changeDetector.cropImageData(frameData, effectiveCropRoi);
      }

      // Step 2: Run Asynchronous Preprocessing & OCR Engine
      const ocrResult = await ocrEngine.recognize(ocrInputImageData, roi.id);

      const pipelineEndTime = performance.now();
      const totalEndToEndLatencyMs = pipelineEndTime - frame.timestamp;

      // Step 3: Log Event & Microsecond Telemetry
      const logEntry = logger.logEvent({
        roiId: roi.id,
        currentText: ocrResult.currentText,
        previousText: ocrResult.previousText,
        textChangeStatus: ocrResult.textChangeStatus,
        hasTextChanged: ocrResult.hasTextChanged,
        confidence: ocrResult.confidence,
        isLowConfidence: ocrResult.isLowConfidence,
        captureFps: captureEngine.actualFPS,
        captureLatencyMs: frame.captureLatencyMs,
        changeDetectionLatencyMs: changeResult.changeDetectionLatencyMs,
        preprocessingLatencyMs: ocrResult.preprocessingLatencyMs,
        ocrLatencyMs: ocrResult.ocrLatencyMs,
        totalLatencyMs: totalEndToEndLatencyMs
      });

      // Update OCR Result UI Card
      if (ocrResult.hasTextChanged || logEntry) {
        updateOcrResultUI(logEntry);
      }
    }
  }

  // --- RENDER LIVE PREVIEW CANVAS OVERLAY ---
  function renderPreviewOverlay(frame) {
    if (!frame || !frame.imageData) return;

    if (previewCanvas.width !== frame.width || previewCanvas.height !== frame.height) {
      previewCanvas.width = frame.width;
      previewCanvas.height = frame.height;
    }

    // Draw main screen frame
    previewCtx.putImageData(frame.imageData, 0, 0);

    // Draw Active ROI Boxes (Cyan outline)
    previewCtx.lineWidth = 3;
    if (roiMode === 'fullscreen' || activeRois.length === 0) {
      previewCtx.strokeStyle = '#00e5ff';
      previewCtx.strokeRect(0, 0, frame.width, frame.height);
    } else {
      activeRois.forEach((roi, idx) => {
        previewCtx.strokeStyle = '#00e5ff';
        previewCtx.strokeRect(roi.x, roi.y, roi.width, roi.height);
        
        // Draw ROI Label Tag
        previewCtx.fillStyle = '#00e5ff';
        previewCtx.font = '12px var(--font-mono)';
        previewCtx.fillText(`ROI #${idx + 1}`, roi.x + 5, roi.y + 15);
      });
    }

    // Draw Currently Dragged ROI box if user is selecting
    if (currentDragRect) {
      previewCtx.strokeStyle = '#8b5cf6';
      previewCtx.setLineDash([6, 6]);
      previewCtx.strokeRect(currentDragRect.x, currentDragRect.y, currentDragRect.width, currentDragRect.height);
      previewCtx.setLineDash([]);
    }
  }

  // --- TELEMETRY UI UPDATES ---
  function updateTelemetryUI() {
    const stats = logger.getStats();

    metricCaptureFps.textContent = captureEngine.actualFPS.toFixed(1);
    metricFpsTarget.textContent = `Target: ${selectTargetFps.value} FPS`;

    metricTotalLatency.textContent = `${stats.totalLatency.avg.toFixed(1)} ms`;
    metricLatencyStats.textContent = `Min: ${stats.totalLatency.min} | P95: ${stats.totalLatency.p95} ms`;

    metricChangeDetectMs.textContent = `${stats.changeDetectionLatency.avg.toFixed(1)} ms`;
    metricOcrLatency.textContent = `${stats.ocrLatency.avg.toFixed(1)} ms`;

    metricDroppedFrames.textContent = captureEngine.droppedFrameCount;
    metricChangesPerSec.textContent = stats.detectedChangesCount;

    // Benchmark cards summary update
    bmCaptureFps.textContent = `${captureEngine.actualFPS.toFixed(1)} FPS`;
    const actualOcrFps = stats.ocrLatency.avg > 0 ? (1000 / stats.ocrLatency.avg).toFixed(1) : '0';
    bmOcrFps.textContent = `${actualOcrFps} OCR/s`;
    bmAvgOcrMs.textContent = `${stats.ocrLatency.avg} ms`;
    bmAvgEndToEndMs.textContent = `${stats.totalLatency.avg} ms`;
    bmP95Ms.textContent = `${stats.totalLatency.p95} ms`;
  }

  function updateOcrResultUI(logEntry) {
    if (!logEntry) return;

    resultTextDisplay.textContent = logEntry.currentText || '[EMPTY TEXT]';
    resultPrevText.textContent = logEntry.previousText || '--';
    resultConfidence.textContent = `${logEntry.confidence}%`;
    resultTimestamp.textContent = logEntry.timestamp;

    if (logEntry.isLowConfidence) {
      systemStatusBadge.className = 'status-badge low-confidence';
      systemStatusBadge.textContent = 'STATUS: LOW CONFIDENCE';
    } else if (captureEngine.isCapturing) {
      systemStatusBadge.className = 'status-badge active';
      systemStatusBadge.textContent = 'STATUS: ACTIVE MONITORING';
    }

    if (logEntry.hasTextChanged) {
      textChangeBadge.className = 'badge';
      textChangeBadge.style.background = 'rgba(16, 185, 129, 0.2)';
      textChangeBadge.style.color = '#10b981';
      textChangeBadge.textContent = 'CHANGE DETECTED';
    } else {
      textChangeBadge.className = 'badge';
      textChangeBadge.style.background = 'rgba(148, 163, 184, 0.1)';
      textChangeBadge.style.color = '#94a3b8';
      textChangeBadge.textContent = 'NO TEXT CHANGE';
    }

    // Append entry to Change Log table UI
    appendLogTableRow(logEntry);
  }

  function appendLogTableRow(entry) {
    // Remove empty placeholder row if exists
    if (logTableBody.children.length === 1 && logTableBody.children[0].cells.length === 1) {
      logTableBody.innerHTML = '';
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="color: var(--accent-purple);">${entry.timestamp}</td>
      <td>
        <span class="log-diff-badge ${entry.hasTextChanged ? 'changed' : 'skip'}">
          ${entry.textChangeStatus}
        </span>
      </td>
      <td style="font-weight: 700;">${escapeHtml(entry.currentText)}</td>
      <td>${entry.totalLatencyMs.toFixed(1)}ms</td>
      <td style="color: ${entry.isLowConfidence ? 'var(--accent-warning)' : 'var(--accent-cyan)'}">
        ${entry.confidence}%
      </td>
    `;

    logTableBody.insertBefore(tr, logTableBody.firstChild);

    // Keep log table body clamped to 50 rows
    if (logTableBody.children.length > 50) {
      logTableBody.removeChild(logTableBody.lastChild);
    }
  }

  // --- SETTINGS UI HANDLERS ---
  function updateConfigurationFromUI() {
    const sensitivity = parseFloat(rangeDiffThreshold.value) / 100.0;
    const pixelSens = parseInt(rangePixelThreshold.value, 10);
    const confThresh = parseInt(rangeConfidenceThreshold.value, 10);
    const whitelist = selectCharWhitelist.value;
    const enablePre = chkPreprocessing.checked;

    lblDiffSens.textContent = `${rangeDiffThreshold.value}%`;
    lblPixelSens.textContent = pixelSens;
    lblConfThresh.textContent = `${confThresh}%`;

    changeDetector.setThresholds(pixelSens, sensitivity);
    ocrEngine.configure({
      confidenceThreshold: confThresh,
      charWhitelist: whitelist,
      enablePreprocessing: enablePre,
      binaryThreshold: 128
    });
  }

  rangeDiffThreshold.addEventListener('input', updateConfigurationFromUI);
  rangePixelThreshold.addEventListener('input', updateConfigurationFromUI);
  rangeConfidenceThreshold.addEventListener('input', updateConfigurationFromUI);
  selectCharWhitelist.addEventListener('change', updateConfigurationFromUI);
  chkPreprocessing.addEventListener('change', updateConfigurationFromUI);

  selectTargetFps.addEventListener('change', () => {
    lblTargetFps.textContent = `${selectTargetFps.value} FPS`;
    if (captureEngine.isCapturing) {
      captureEngine.startCapture(parseInt(selectTargetFps.value, 10));
    }
  });

  // Export Buttons
  btnExportCSV.addEventListener('click', () => logger.exportCSV());
  btnExportJSON.addEventListener('click', () => logger.exportJSON());
  btnClearLogs.addEventListener('click', () => {
    logger.clearLogs();
    logTableBody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 1rem;">
          Log cleared.
        </td>
      </tr>`;
  });

  // --- ACCEPTANCE TEST SUITE HANDLERS ---
  async function runAcceptanceTest(testId) {
    if (captureEngine.isCapturing) {
      captureEngine.stopCapture();
      onCaptureStopped();
    }

    const testCanvas = testSuite.getCanvas();
    await captureEngine.startCanvasCapture(testCanvas, parseInt(selectTargetFps.value, 10));
    onCaptureStarted();

    testSuite.runTest(
      testId,
      (statusMsg) => {
        testStatusMessage.textContent = statusMsg;
      },
      (testResult) => {
        testStatusMessage.textContent = `✅ ${testResult.testName}: ${testResult.summary}`;
        captureEngine.stopCapture();
        onCaptureStopped();
      }
    );
  }

  btnTest1.addEventListener('click', () => runAcceptanceTest(1));
  btnTest2.addEventListener('click', () => runAcceptanceTest(2));
  btnTest3.addEventListener('click', () => runAcceptanceTest(3));
  btnTest4.addEventListener('click', () => runAcceptanceTest(4));
  btnTest5.addEventListener('click', () => runAcceptanceTest(5));

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
});

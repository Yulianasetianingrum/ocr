/**
 * Ultra-Robust OCR & Symbol Detection Engine for Chrome Extension
 */
window.OcrEngine = (function () {
  function isExtensionUI(el) {
    if (!el) return true;
    try {
      if (typeof el.closest === 'function') {
        return !!(
          el.closest('#ocr-snipper-overlay') ||
          el.closest('#ocr-result-modal') ||
          el.closest('#ocr-auto-badge') ||
          el.closest('#ocr-highlight-tooltip') ||
          el.closest('#ocr-trendline-canvas') ||
          el.closest('#ocr-toast-notification') ||
          el.closest('.ocr-toast-notification') ||
          el.closest('.action-log-box')
        );
      }
    } catch (e) {}
    return false;
  }

  function computeOtsuThreshold(grayData) {
    const histogram = new Array(256).fill(0);
    for (let i = 0; i < grayData.length; i++) histogram[grayData[i]]++;
    const total = grayData.length;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * histogram[t];
    let sumB = 0, wB = 0, wF = 0, varMax = 0, threshold = 128;
    for (let t = 0; t < 256; t++) {
      wB += histogram[t];
      if (wB === 0) continue;
      wF = total - wB;
      if (wF === 0) break;
      sumB += t * histogram[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const varBetween = wB * wF * (mB - mF) * (mB - mF);
      if (varBetween > varMax) { varMax = varBetween; threshold = t; }
    }
    return threshold;
  }

  function preprocessTopological(srcCanvas) {
    const minHeight = 120;
    let scale = 1.0;
    if (srcCanvas.height < minHeight) scale = minHeight / srcCanvas.height;
    const w = Math.round(srcCanvas.width * scale);
    const h = Math.round(srcCanvas.height * scale);
    const procCanvas = document.createElement('canvas');
    procCanvas.width = w; procCanvas.height = h;
    const ctx = procCanvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(srcCanvas, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < gray.length; i++) {
      const idx = i * 4;
      gray[i] = Math.round(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
    }
    const thresh = computeOtsuThreshold(gray);
    let darkCount = 0;
    for (let i = 0; i < gray.length; i++) { if (gray[i] < thresh) darkCount++; }
    const darkBackground = darkCount > (gray.length / 2);
    for (let i = 0; i < gray.length; i++) {
      const idx = i * 4;
      let isText = darkBackground ? (gray[i] >= thresh) : (gray[i] < thresh);
      const val = isText ? 0 : 255;
      data[idx] = val; data[idx + 1] = val; data[idx + 2] = val; data[idx + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return { processedCanvas: procCanvas, imgData, width: w, height: h };
  }

  function countInternalHoles(g, data, imgW) {
    const gw = g.w, gh = g.h;
    const grid = new Uint8Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const idx = ((g.y + y) * imgW + (g.x + x)) * 4;
        grid[y * gw + x] = data[idx] === 0 ? 1 : 0;
      }
    }
    const visited = new Uint8Array(gw * gh);
    const queue = [];
    for (let x = 0; x < gw; x++) {
      if (grid[x] === 0) { visited[x] = 1; queue.push(x, 0); }
      const bIdx = (gh - 1) * gw + x;
      if (grid[bIdx] === 0 && !visited[bIdx]) { visited[bIdx] = 1; queue.push(x, gh - 1); }
    }
    for (let y = 0; y < gh; y++) {
      const lIdx = y * gw;
      if (grid[lIdx] === 0 && !visited[lIdx]) { visited[lIdx] = 1; queue.push(0, y); }
      const rIdx = y * gw + (gw - 1);
      if (grid[rIdx] === 0 && !visited[rIdx]) { visited[rIdx] = 1; queue.push(gw - 1, y); }
    }
    let head = 0;
    while (head < queue.length) {
      const cx = queue[head++], cy = queue[head++];
      const nbrs = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
      for (const [nx, ny] of nbrs) {
        if (nx >= 0 && nx < gw && ny >= 0 && ny < gh) {
          const nIdx = ny * gw + nx;
          if (grid[nIdx] === 0 && visited[nIdx] === 0) { visited[nIdx] = 1; queue.push(nx, ny); }
        }
      }
    }
    let holeComponents = 0;
    const holeVisited = new Uint8Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const idx = y * gw + x;
        if (grid[idx] === 0 && visited[idx] === 0 && holeVisited[idx] === 0) {
          holeComponents++;
          const hQueue = [x, y]; holeVisited[idx] = 1; let hHead = 0;
          while (hHead < hQueue.length) {
            const hx = hQueue[hHead++], hy = hQueue[hHead++];
            const nbrs = [[hx + 1, hy], [hx - 1, hy], [hx, hy + 1], [hx, hy - 1]];
            for (const [nx, ny] of nbrs) {
              if (nx >= 0 && nx < gw && ny >= 0 && ny < gh) {
                const nIdx = ny * gw + nx;
                if (grid[nIdx] === 0 && visited[nIdx] === 0 && holeVisited[nIdx] === 0) {
                  holeVisited[nIdx] = 1; hQueue.push(nx, ny);
                }
              }
            }
          }
        }
      }
    }
    return holeComponents;
  }

  function computeMassBalance(g, data, imgW) {
    const halfH = Math.floor(g.h / 2);
    let topPixels = 0, bottomPixels = 0;
    for (let y = 0; y < g.h; y++) {
      for (let x = 0; x < g.w; x++) {
        const idx = ((g.y + y) * imgW + (g.x + x)) * 4;
        if (data[idx] === 0) {
          if (y < halfH) topPixels++; else bottomPixels++;
        }
      }
    }
    return (topPixels + 1) / (bottomPixels + 1);
  }

  function classifyGlyphTopological(g, data, imgW) {
    const holes = countInternalHoles(g, data, imgW);
    const balance = computeMassBalance(g, data, imgW);
    const aspect = g.h / g.w;

    if (g.h < 8 && g.w < 8) return '.';
    if (g.h < 14 && g.w < 10) return ',';
    if (aspect < 0.4 && g.w > 6) return '-';
    if (aspect >= 2.3) return '1';

    if (holes >= 2) return '8';
    if (holes === 1) {
      if (balance < 0.85) return '6';
      if (balance > 1.25) return '9';
      if (aspect > 1.5) return '4';
      if (aspect < 0.95) return '%';
      return '0';
    }
    if (balance > 1.35) return '7';
    if (balance < 0.8) return '2';
    if (aspect > 1.6) return '3';
    return '5';
  }

  function findConnectedGlyphs(imgData, width, height) {
    const data = imgData.data;
    const visited = new Uint8Array(width * height);
    const glyphs = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (data[idx * 4] === 0 && !visited[idx]) {
          let minX = x, maxX = x, minY = y, maxY = y, pixelCount = 0;
          const queue = [x, y]; visited[idx] = 1; let head = 0;
          while (head < queue.length) {
            const cx = queue[head++], cy = queue[head++];
            pixelCount++;
            if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
            if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
            const nbrs = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
            for (const [nx, ny] of nbrs) {
              if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                const nIdx = ny * width + nx;
                if (data[nIdx * 4] === 0 && !visited[nIdx]) { visited[nIdx] = 1; queue.push(nx, ny); }
              }
            }
          }
          const w = maxX - minX + 1, h = maxY - minY + 1;
          if (w >= 2 && h >= 4 && pixelCount >= 6) {
            glyphs.push({ x: minX, y: minY, w, h, pixelCount });
          }
        }
      }
    }
    glyphs.sort((a, b) => a.x - b.x);
    if (glyphs.length > 0) {
      const g0 = glyphs[0];
      const density = g0.pixelCount / (g0.w * g0.h);
      const aspect = g0.h / g0.w;
      if (density > 0.65 && aspect >= 0.85 && aspect <= 1.25 && g0.w > 12 && g0.h > 12) {
        glyphs.shift();
      }
    }
    return glyphs;
  }

  function fontInvariantOCR(canvas) {
    const { processedCanvas, imgData, width, height } = preprocessTopological(canvas);
    const glyphs = findConnectedGlyphs(imgData, width, height);
    if (glyphs.length === 0) return { text: '', confidence: 0, timestamp: Date.now(), source: 'ocr', validity: 'invalid' };
    
    let resultText = '';
    const data = imgData.data;
    let confidenceSum = 0;
    
    for (const g of glyphs) {
      const char = classifyGlyphTopological(g, data, width);
      resultText += char;
      
      const aspect = g.h / g.w;
      let charConf = 90;
      if (char === '.' || char === ',') {
         charConf = (g.h < 14 && g.w < 10) ? 95 : 70;
      } else if (char === '1') {
         charConf = (aspect >= 2.3) ? 98 : 80;
      } else {
         charConf = (aspect > 0.8 && aspect < 2.2) ? 95 : 60;
      }
      confidenceSum += charConf;
    }
    
    resultText = resultText.replace(/\.\./g, '.').replace(/,,/g, ',');
    
    const avgConfidence = Math.floor(confidenceSum / glyphs.length);
    const isValid = avgConfidence > 75 ? 'valid' : 'degraded';
    
    return { 
       text: resultText, 
       confidence: avgConfidence, 
       timestamp: Date.now(),
       source: 'fontInvariantOCR',
       validity: isValid
    };
  }

  function parseTargetDescription(currentText, previousText = '') {
    if (!currentText || currentText.trim() === '') {
      return { primaryValue: '--', trend: 'STABIL', badgeText: '▶ STABIL', deltaStr: '0.0', numbers: [], rawText: currentText };
    }
    const numberMatches = currentText.match(/[-+]?\d{1,3}(?:,\d{3})*(?:\.\d+)?%?|[-+]?\d+\.?\d*%?/g) || [];
    const cleanNumbers = [...new Set(numberMatches.filter(n => n !== '.' && n !== '-'))];
    let primaryValue = cleanNumbers.length > 0 ? cleanNumbers[0] : currentText;
    let trend = 'STABIL';
    let badgeText = '▶ STABIL';
    let deltaStr = '0.0';
    const currNum = parseFloat(primaryValue.replace(/[^0-9.-]/g, ''));
    const prevNumMatches = previousText ? previousText.match(/[-+]?\d{1,3}(?:,\d{3})*(?:\.\d+)?%?|[-+]?\d+\.?\d*%?/g) || [] : [];
    const cleanPrevNumbers = prevNumMatches.filter(n => n !== '.' && n !== '-');
    const prevNum = cleanPrevNumbers.length > 0 ? parseFloat(cleanPrevNumbers[0].replace(/[^0-9.-]/g, '')) : NaN;
    
    if (!isNaN(currNum) && !isNaN(prevNum)) {
      const diff = currNum - prevNum;
      if (diff > 0) { trend = 'NAIK'; badgeText = `▲ NAIK (+${diff.toFixed(2)})`; deltaStr = `+${diff.toFixed(2)}`; } 
      else if (diff < 0) { trend = 'TURUN'; badgeText = `▼ TURUN (${diff.toFixed(2)})`; deltaStr = `${diff.toFixed(2)}`; }
    } else {
      if (/naik|up|profit|\+/i.test(currentText)) { trend = 'NAIK'; badgeText = '▲ NAIK'; }
      else if (/turun|down|loss|-/i.test(currentText)) { trend = 'TURUN'; badgeText = '▼ TURUN'; }
    }
    return { primaryValue, trend, badgeText, deltaStr, numbers: cleanNumbers, rawText: currentText };
  }

  function extractAllVisibleScreenText() {
    if (typeof document === 'undefined' || !document.body) return '';
    return document.body.innerText || '';
  }

  function analyzeText(rawText) {
    const text = rawText || '';
    const charCount = text.length;
    const words = text.trim() ? text.trim().split(/\s+/) : [];
    const wordCount = words.length;
    const numberMatches = text.match(/[-+]?\d{1,3}(?:,\d{3})*\.\d+|[-+]?\d+\.\d+|[-+]?\d{1,3}(?:,\d{3})+|[-+]?\d+%?/g) || [];
    const numbers = [...new Set(numberMatches)];
    const plusCount = (text.match(/\+/g) || []).length;
    const minusCount = (text.match(/[\-\u2212]/g) || []).length;
    const openParenCount = (text.match(/\(/g) || []).length;
    const closeParenCount = (text.match(/\)/g) || []).length;
    const multiplyCount = (text.match(/\*/g) || []).length;
    const divideCount = (text.match(/\//g) || []).length;
    const equalsCount = (text.match(/=/g) || []).length;
    const percentCount = (text.match(/%/g) || []).length;

    return {
      rawText: text, charCount, wordCount, numbers,
      symbolCounts: { plus: plusCount, minus: minusCount, openParen: openParenCount, closeParen: closeParenCount, multiply: multiplyCount, divide: divideCount, equals: equalsCount, percent: percentCount }
    };
  }

  function escapeHtml(unsafe) {
    return (unsafe || '').toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function findNominalInput() {
    let el = document.getElementById('nominal-amount');
    if (el) return el;
    const inputs = document.querySelectorAll('input[type="number"], input[type="text"]');
    for (let input of inputs) {
       if (input.className && typeof input.className === 'string' && (input.className.includes('amount') || input.className.includes('nominal') || input.className.includes('deal-form'))) {
           return input;
       }
    }
    for (let input of inputs) {
       let val = input.value;
       if (val && !isNaN(val.replace(/[^0-9]/g, '')) && val.length > 0) return input;
    }
    return null;
  }

  function setReactInputValue(element, value) {
    if (!element) return;
    
    try { element.focus(); } catch(e) {}
    
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    if (nativeInputValueSetter) {
       nativeInputValueSetter.call(element, value);
    } else {
       element.value = value;
    }
    
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', keyCode: 13 }));
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', keyCode: 13 }));
    
    try { element.blur(); } catch(e) {}
  }

  function inputNominalValue(nominalVal) {
    const el = findNominalInput();
    if (el) {
      setReactInputValue(el, nominalVal);
      return { success: true, message: `Berhasil mengisikan nominal: ${nominalVal}` };
    }
    return { success: false, message: 'Kolom input nominal tidak ditemukan.' };
  }

  function getNominalValue() {
    const el = findNominalInput();
    if (el && el.value) {
      const p = parseFloat(String(el.value).replace(/[^0-9\.]/g, ''));
      if (!isNaN(p)) return p;
    }
    return null;
  }

  function findActionElement(direction) {
    const dirLower = String(direction).toLowerCase();
    const buttons = document.querySelectorAll('button, div[role="button"]');
    for (let btn of buttons) {
      if (typeof isExtensionUI !== 'undefined' && isExtensionUI(btn)) continue;
      if (btn.id && btn.id.includes('ocr')) continue;
      const txt = (btn.innerText || btn.textContent || '').toLowerCase();
      const cls = (btn.className || '').toString().toLowerCase();
      
      const isUpButton = /\b(naik|up|call|higher)\b/.test(txt) || /\b(up|call)\b/.test(cls) || cls.includes('deal-button--up') || cls.includes('button--up');
      const isDownButton = /\b(turun|down|put|lower)\b/.test(txt) || /\b(down|put)\b/.test(cls) || cls.includes('deal-button--down') || cls.includes('button--down');
      
      if (dirLower === 'naik' && isUpButton) return btn;
      if (dirLower === 'turun' && isDownButton) return btn;
    }
    return null;
  }

  function clickActionElement(direction) {
    const el = findActionElement(direction);
    if (el) {
      // Fix double position: just use el.click() to prevent triggering mousedown and click handlers twice
      el.click();
      
      return { success: true, message: `Berhasil mengeklik tombol ${direction.toUpperCase()}` };
    }
    return { success: false, message: `Tombol ${direction.toUpperCase()} tidak ditemukan.` };
  }

  function detectLastValidNumericSpan() { return null; }
  function detectScreenPrice() { return null; }
  function detectTradeDealBadge() { return null; }
  function detectLiveTickPrice() { return null; }
  function detectEntryPriceSpan() { return null; }
  function detectLiveChartBubblePrice() { return null; }
  function detectChartPriceFromSVG() { return null; }
  function detectPriceFromTitle() { return null; }
  let trendHistory = [];
  function analyzeScreenTrendline() {
     const mockPrice = Math.random() * 100;
     trendHistory.push({ price: mockPrice, time: Date.now() });
     if (trendHistory.length > 10) trendHistory.shift();
     
     if (trendHistory.length < 2) return { points: [], trend: 'STABLE', slope: 0, confidence: 50 };
     
     const first = trendHistory[0];
     const last = trendHistory[trendHistory.length - 1];
     const slope = (last.price - first.price) / (last.time - first.time);
     
     let trend = 'STABLE';
     let conf = 80;
     if (slope > 0.05) trend = 'UP';
     else if (slope < -0.05) trend = 'DOWN';
     else conf = 60;
     
     return { points: trendHistory, trend, slope, confidence: conf, timestamp: Date.now() };
  }

  return {
    isExtensionUI,
    computeOtsuThreshold,
    preprocessTopological,
    findConnectedGlyphs,
    countInternalHoles,
    computeMassBalance,
    classifyGlyphTopological,
    fontInvariantOCR,
    parseTargetDescription,
    recognizeCanvasImage: fontInvariantOCR,
    extractAllVisibleScreenText,
    analyzeText,
    escapeHtml,
    inputNominalValue,
    getNominalValue,
    clickActionElement,
    detectLastValidNumericSpan,
    detectScreenPrice,
    detectTradeDealBadge,
    detectLiveTickPrice,
    detectEntryPriceSpan,
    detectLiveChartBubblePrice,
    detectChartPriceFromSVG,
    detectPriceFromTitle,
    analyzeScreenTrendline
  };
})();

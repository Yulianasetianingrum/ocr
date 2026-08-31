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

  // ─── State ───
  let mappedRegion   = null;   // Viewport-ratio region from user selection
  let trackedElement = null;   // Specific DOM element we're locked onto
  let trackingRafId  = null;   // requestAnimationFrame ID
  let trackingBox    = null;   // The visual cyan box on the web page

  // ─── Create/get the tracking box ───
  function ensureTrackingBox() {
    if (trackingBox && document.body.contains(trackingBox)) return trackingBox;

    trackingBox = document.createElement('div');
    trackingBox.id = 'rss-tracking-overlay';
    Object.assign(trackingBox.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '2147483646',
      border: '2px solid #00e5ff',
      borderRadius: '3px',
      boxShadow: '0 0 0 1px rgba(0,229,255,0.25), 0 0 12px rgba(0,229,255,0.5)',
      background: 'rgba(0, 229, 255, 0.03)',
      display: 'none',
      left: '0px', top: '0px', width: '0px', height: '0px'
    });

    const label = document.createElement('div');
    Object.assign(label.style, {
      position: 'absolute',
      top: '-20px', left: '0',
      background: '#00e5ff', color: '#000',
      font: 'bold 9px/18px monospace',
      padding: '0 5px',
      borderRadius: '3px 3px 0 0',
      whiteSpace: 'nowrap'
    });
    label.textContent = '🎯 TRACKING';
    trackingBox.appendChild(label);
    document.body.appendChild(trackingBox);
    return trackingBox;
  }

  // ─── RAF Tracking Loop (~60fps, runs entirely inside the web page) ───
  function startTrackingLoop() {
    if (trackingRafId) cancelAnimationFrame(trackingRafId);

    function loop() {
      if (trackedElement) {
        if (!document.body.contains(trackedElement)) {
          // Element left DOM — try to re-find
          if (mappedRegion) trackedElement = findPrimaryElement(mappedRegion);
        } else {
          const rect = trackedElement.getBoundingClientRect();
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
      trackingRafId = requestAnimationFrame(loop);
    }

    trackingRafId = requestAnimationFrame(loop);
  }

  function stopTrackingLoop() {
    if (trackingRafId) { cancelAnimationFrame(trackingRafId); trackingRafId = null; }
    if (trackingBox) trackingBox.style.display = 'none';
  }


  // ─── Cari elemen terdalam (leaf) yang punya teks di dalam el ───
  // Ini memastikan kita mengunci elemen badge/nilai aktual, bukan container parent-nya.
  function findDeepestTextElement(el) {
    if (!el) return null;
    // Kalau tidak punya children → ini leaf, langsung return
    if (!el.children || el.children.length === 0) return el;

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

    // ─── PRIORITAS: Ekstrak teks dari trackedElement secara langsung lebih dulu ───
    // Ini menjamin teks elemen target yang sedang dikunci (misal badge harga)
    // selalu terbaca secara instan, presisi 100%, dan tanpa delay sampling grid.
    if (trackedElement && document.body.contains(trackedElement)) {
      seenElements.add(trackedElement);
      const trackedPieces = extractAllTextStrategies(trackedElement);
      rawPieces.push(...trackedPieces);
    }

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

    // Deduplicate and join
    const seen   = new Set();
    const unique = rawPieces
      .map(t => t.trim())
      .filter(t => { if (!t || seen.has(t)) return false; seen.add(t); return true; });

    const fullText = unique.join(' ').replace(/\s+/g, ' ').trim();

    // Numbers: 6.1461, 1,234.56, 90%, -0.12, +3.5
    const numberMatches = fullText.match(
      /[-+]?\d{1,3}(?:,\d{3})*\.\d+|[-+]?\d+\.\d+|[-+]?\d{1,3}(?:,\d{3})+|[-+]?\d+%?/g
    ) || [];
    const cleanNumbers = [...new Set(numberMatches.filter(n => n.length > 0 && n !== '-' && n !== '+'))];

    // Labels: words 2+ chars
    const wordMatches = fullText.match(/[A-Za-z][A-Za-z0-9._/-]{1,}/g) || [];
    const cleanLabels = [...new Set(wordMatches)];

    // Live bounding rect of tracked element
    let trackedRect = null;
    if (trackedElement && document.body.contains(trackedElement)) {
      const rect = trackedElement.getBoundingClientRect();
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
    }

    if (request.action === 'read_dom_text') {
      const region = request.region || mappedRegion;
      if (!region) {
        sendResponse({ text: '', numbers: [], labels: [], error: 'no_region' });
        return true;
      }
      sendResponse(readDomTextInRegion(region));
    }

    if (request.action === 'stop_tracking') {
      stopTrackingLoop();
      trackedElement = null;
      mappedRegion   = null;
      sendResponse({ status: 'ok' });
    }

    return true;
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

        mappedRegion   = region;
        trackedElement = findPrimaryElement(region);
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

/**
 * Low-Latency Change Detector & Real-Time Dynamic Target Motion Tracker
 */
if (typeof window !== 'undefined' && !window.ChangeDetector) {
  /**
 * Low-Latency Change Detector & Real-Time Dynamic Target Motion Tracker
 * Features Sum of Absolute Differences (SAD) template matching to follow moving target objects (e.g. price badges/lines).
 */

class ChangeDetector {
  constructor(options = {}) {
    this.pixelDiffThreshold = options.pixelDiffThreshold || 25; // 0-255 grayscale diff per pixel
    this.changeSensitivityRatio = options.changeSensitivityRatio || 0.005; // min fraction of changed pixels to trigger (0.5%)
    this.previousRoiFrames = new Map(); // roiId -> ImageData
    this.trackingTemplates = new Map(); // roiId -> { width, height, data }
  }

  setThresholds(pixelDiffThreshold, changeSensitivityRatio) {
    this.pixelDiffThreshold = pixelDiffThreshold;
    this.changeSensitivityRatio = changeSensitivityRatio;
  }

  resetHistory() {
    this.previousRoiFrames.clear();
    this.trackingTemplates.clear();
  }

  cropImageData(fullImageData, roi) {
    const fullW = fullImageData.width;
    const fullH = fullImageData.height;

    const rx = Math.max(0, Math.min(Math.round(roi.x), fullW - 1));
    const ry = Math.max(0, Math.min(Math.round(roi.y), fullH - 1));
    const rw = Math.max(1, Math.min(Math.round(roi.width), fullW - rx));
    const rh = Math.max(1, Math.min(Math.round(roi.height), fullH - ry));

    const cropped = new ImageData(rw, rh);
    const src = fullImageData.data;
    const dst = cropped.data;

    for (let y = 0; y < rh; y++) {
      const srcOffset = ((ry + y) * fullW + rx) * 4;
      const dstOffset = (y * rw) * 4;
      dst.set(src.subarray(srcOffset, srcOffset + rw * 4), dstOffset);
    }

    return cropped;
  }

  /**
   * Real-time Target Motion Tracker:
   * Uses Sum of Absolute Differences (SAD) template matching across vertical search window
   * to automatically follow moving price labels/badges in real time (< 0.5ms).
   */
  trackTargetMotion(fullImageData, currentRoi, roiId = 'default', searchRangeY = 160) {
    const fullW = fullImageData.width;
    const fullH = fullImageData.height;

    // Retrieve or initialize template
    let template = this.trackingTemplates.get(roiId);
    if (!template || template.width !== Math.round(currentRoi.width) || template.height !== Math.round(currentRoi.height)) {
      const cropped = this.cropImageData(fullImageData, currentRoi);
      template = {
        width: cropped.width,
        height: cropped.height,
        data: this.toGrayscaleBuffer(cropped)
      };
      this.trackingTemplates.set(roiId, template);
      return { trackedRoi: currentRoi, shiftY: 0, hasTracked: false };
    }

    const rw = template.width;
    const rh = template.height;
    const srcData = fullImageData.data;

    let bestDy = 0;
    let minSad = Infinity;

    const startY = Math.max(0, Math.round(currentRoi.y) - searchRangeY);
    const endY = Math.min(fullH - rh, Math.round(currentRoi.y) + searchRangeY);
    const fixedX = Math.max(0, Math.min(Math.round(currentRoi.x), fullW - rw));

    // Fast step-by-2 vertical motion search
    for (let candidateY = startY; candidateY <= endY; candidateY += 2) {
      let sad = 0;

      // Sub-sample template pixels (step 3 for ultra-fast < 0.5ms search)
      for (let py = 0; py < rh; py += 3) {
        const srcRowOffset = (candidateY + py) * fullW * 4;
        const tempRowOffset = py * rw;

        for (let px = 0; px < rw; px += 3) {
          const srcIdx = srcRowOffset + (fixedX + px) * 4;
          const graySrc = (srcData[srcIdx] * 38 + srcData[srcIdx + 1] * 75 + srcData[srcIdx + 2] * 15) >> 7;
          const grayTemp = template.data[tempRowOffset + px];

          sad += Math.abs(graySrc - grayTemp);
        }
      }

      if (sad < minSad) {
        minSad = sad;
        bestDy = candidateY - Math.round(currentRoi.y);
      }
    }

    const trackedRoi = {
      ...currentRoi,
      y: Math.max(0, Math.min(fullH - rh, Math.round(currentRoi.y) + bestDy))
    };

    return {
      trackedRoi,
      shiftY: bestDy,
      hasTracked: true
    };
  }

  toGrayscaleBuffer(imageData) {
    const data = imageData.data;
    const buf = new Uint8Array(imageData.width * imageData.height);
    for (let i = 0; i < buf.length; i++) {
      const idx = i * 4;
      buf[i] = (data[idx] * 38 + data[idx + 1] * 75 + data[idx + 2] * 15) >> 7;
    }
    return buf;
  }

  detectRoiChange(fullImageData, roi, roiId = 'default') {
    const startTime = performance.now();
    const currentRoiData = this.cropImageData(fullImageData, roi);
    const prevRoiData = this.previousRoiFrames.get(roiId);

    if (!prevRoiData || prevRoiData.width !== currentRoiData.width || prevRoiData.height !== currentRoiData.height) {
      this.previousRoiFrames.set(roiId, currentRoiData);
      const endTime = performance.now();
      return {
        hasChanged: true,
        diffRatio: 1.0,
        changedPixelCount: currentRoiData.width * currentRoiData.height,
        boundingSubBox: { x: 0, y: 0, width: currentRoiData.width, height: currentRoiData.height },
        croppedImageData: currentRoiData,
        changeDetectionLatencyMs: endTime - startTime
      };
    }

    const w = currentRoiData.width;
    const h = currentRoiData.height;
    const currBuf = currentRoiData.data;
    const prevBuf = prevRoiData.data;

    let changedPixelCount = 0;
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;

    for (let i = 0; i < currBuf.length; i += 4) {
      const grayCurr = (currBuf[i] * 38 + currBuf[i + 1] * 75 + currBuf[i + 2] * 15) >> 7;
      const grayPrev = (prevBuf[i] * 38 + prevBuf[i + 1] * 75 + prevBuf[i + 2] * 15) >> 7;

      const diff = Math.abs(grayCurr - grayPrev);

      if (diff >= this.pixelDiffThreshold) {
        changedPixelCount++;
        const pixelIdx = i / 4;
        const px = pixelIdx % w;
        const py = Math.floor(pixelIdx / w);

        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    }

    const totalPixels = w * h;
    const diffRatio = changedPixelCount / totalPixels;
    const hasChanged = diffRatio >= this.changeSensitivityRatio;

    this.previousRoiFrames.set(roiId, currentRoiData);
    const endTime = performance.now();

    let boundingSubBox = null;
    if (hasChanged && maxX >= minX && maxY >= minY) {
      const pad = 4;
      const subX = Math.max(0, minX - pad);
      const subY = Math.max(0, minY - pad);
      const subW = Math.min(w - subX, (maxX - minX + 1) + pad * 2);
      const subH = Math.min(h - subY, (maxY - minY + 1) + pad * 2);

      boundingSubBox = { x: subX, y: subY, width: subW, height: subH };
    } else if (hasChanged) {
      boundingSubBox = { x: 0, y: 0, width: w, height: h };
    }

    return {
      hasChanged,
      diffRatio,
      changedPixelCount,
      boundingSubBox,
      croppedImageData: currentRoiData,
      changeDetectionLatencyMs: endTime - startTime
    };
  }
}
  window.ChangeDetector = ChangeDetector;
}
if (typeof module !== 'undefined') module.exports = { ChangeDetector: typeof window !== 'undefined' ? window.ChangeDetector : null };

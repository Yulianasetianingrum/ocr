/**
 * High-Precision Telemetry & Latency Logger
 * Handles microsecond timestamping, statistical calculations (Min, Max, Avg, P95), and CSV/JSON export.
 */

export class MicrosecondLogger {
  constructor(maxLogEntries = 1000) {
    this.maxLogEntries = maxLogEntries;
    this.logs = [];
    this.latencies = []; // array of endToEndLatencyMs
    this.ocrLatencies = [];
    this.captureLatencies = [];
    this.changeDetectionLatencies = [];
    this.detectedChangesCount = 0;
    this.startTime = performance.now();
    this.wallClockStart = new Date();
  }

  /**
   * Format high-precision timestamp string [HH:mm:ss.ffffff]
   */
  getHighPrecisionTimestamp() {
    const nowMs = performance.now();
    const elapsedMs = nowMs - this.startTime;
    const currentWall = new Date(this.wallClockStart.getTime() + elapsedMs);

    const hours = String(currentWall.getHours()).padStart(2, '0');
    const minutes = String(currentWall.getMinutes()).padStart(2, '0');
    const seconds = String(currentWall.getSeconds()).padStart(2, '0');
    const millis = String(currentWall.getMilliseconds()).padStart(3, '0');

    // Fractional microseconds from performance.now() sub-millisecond precision
    const fracMicros = String(Math.floor((nowMs % 1) * 1000)).padStart(3, '0');

    return `[${hours}:${minutes}:${seconds}.${millis}${fracMicros}]`;
  }

  /**
   * Log an OCR event entry
   */
  logEvent(data) {
    const timestamp = this.getHighPrecisionTimestamp();
    const entry = {
      id: this.logs.length + 1,
      timestamp,
      rawTimestamp: performance.now(),
      roiId: data.roiId || 'default',
      currentText: data.currentText || '',
      previousText: data.previousText || '',
      textChangeStatus: data.textChangeStatus || 'NO TEXT CHANGE',
      hasTextChanged: data.hasTextChanged || false,
      confidence: data.confidence || 0,
      isLowConfidence: data.isLowConfidence || false,
      captureFps: data.captureFps || 0,
      captureLatencyMs: data.captureLatencyMs || 0,
      changeDetectionLatencyMs: data.changeDetectionLatencyMs || 0,
      preprocessingLatencyMs: data.preprocessingLatencyMs || 0,
      ocrLatencyMs: data.ocrLatencyMs || 0,
      totalLatencyMs: data.totalLatencyMs || 0
    };

    if (entry.hasTextChanged) {
      this.detectedChangesCount++;
    }

    this.logs.unshift(entry); // newest first
    if (this.logs.length > this.maxLogEntries) {
      this.logs.pop();
    }

    // Accumulate telemetry stats
    if (data.totalLatencyMs > 0) {
      this.latencies.push(data.totalLatencyMs);
      if (this.latencies.length > 2000) this.latencies.shift();
    }
    if (data.ocrLatencyMs > 0) {
      this.ocrLatencies.push(data.ocrLatencyMs);
      if (this.ocrLatencies.length > 2000) this.ocrLatencies.shift();
    }
    if (data.captureLatencyMs > 0) {
      this.captureLatencies.push(data.captureLatencyMs);
      if (this.captureLatencies.length > 2000) this.captureLatencies.shift();
    }
    if (data.changeDetectionLatencyMs > 0) {
      this.changeDetectionLatencies.push(data.changeDetectionLatencyMs);
      if (this.changeDetectionLatencies.length > 2000) this.changeDetectionLatencies.shift();
    }

    return entry;
  }

  /**
   * Compute statistical summary (Min, Max, Avg, P95)
   */
  getStats() {
    return {
      totalLatency: this.calculateArrayStats(this.latencies),
      ocrLatency: this.calculateArrayStats(this.ocrLatencies),
      captureLatency: this.calculateArrayStats(this.captureLatencies),
      changeDetectionLatency: this.calculateArrayStats(this.changeDetectionLatencies),
      detectedChangesCount: this.detectedChangesCount,
      totalLogsCount: this.logs.length
    };
  }

  calculateArrayStats(arr) {
    if (!arr || arr.length === 0) {
      return { min: 0, max: 0, avg: 0, p95: 0 };
    }
    const sorted = [...arr].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const avg = sum / sorted.length;
    const min = sorted[0];
    const max = sorted[sorted.length - 1];

    // Calculate 95th Percentile
    const p95Idx = Math.floor(sorted.length * 0.95);
    const p95 = sorted[p95Idx] || max;

    return {
      min: Number(min.toFixed(2)),
      max: Number(max.toFixed(2)),
      avg: Number(avg.toFixed(2)),
      p95: Number(p95.toFixed(2))
    };
  }

  /**
   * Export stored logs as CSV file download
   */
  exportCSV() {
    if (this.logs.length === 0) return alert('No logs available to export.');

    const headers = [
      'Timestamp', 'ROI_ID', 'CurrentText', 'PreviousText', 'ChangeStatus',
      'Confidence', 'LowConfidence', 'CaptureFPS', 'CaptureLatencyMs',
      'ChangeDetectLatencyMs', 'OCRLatencyMs', 'TotalLatencyMs'
    ];

    const rows = this.logs.map(log => [
      `"${log.timestamp}"`,
      `"${log.roiId}"`,
      `"${log.currentText.replace(/"/g, '""')}"`,
      `"${log.previousText.replace(/"/g, '""')}"`,
      `"${log.textChangeStatus}"`,
      log.confidence,
      log.isLowConfidence,
      log.captureFps.toFixed(1),
      log.captureLatencyMs.toFixed(2),
      log.changeDetectionLatencyMs.toFixed(2),
      log.ocrLatencyMs.toFixed(2),
      log.totalLatencyMs.toFixed(2)
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    this.downloadFile(csvContent, `screen_scanner_logs_${Date.now()}.csv`, 'text/csv');
  }

  /**
   * Export stored logs as JSON file download
   */
  exportJSON() {
    if (this.logs.length === 0) return alert('No logs available to export.');
    const jsonContent = JSON.stringify({
      exportedAt: new Date().toISOString(),
      stats: this.getStats(),
      logs: this.logs
    }, null, 2);

    this.downloadFile(jsonContent, `screen_scanner_logs_${Date.now()}.json`, 'application/json');
  }

  downloadFile(content, fileName, contentType) {
    const blob = new Blob([content], { type: contentType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  clearLogs() {
    this.logs = [];
    this.latencies = [];
    this.ocrLatencies = [];
    this.captureLatencies = [];
    this.changeDetectionLatencies = [];
    this.detectedChangesCount = 0;
  }
}

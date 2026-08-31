/**
 * Real-Time Continuous Screen Capture Engine
 * Uses getDisplayMedia + requestVideoFrameCallback for hardware-accelerated frame acquisition.
 * Features bounded latest-frame buffer (producer) to eliminate frame queue backlog.
 */

export class ScreenCaptureEngine {
  constructor() {
    this.stream = null;
    this.videoElement = document.createElement('video');
    this.videoElement.autoplay = true;
    this.videoElement.playsInline = true;
    this.videoElement.muted = true;

    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    this.isCapturing = false;
    this.targetFPS = 60;
    this.actualFPS = 0;
    this.capturedFrameCount = 0;
    this.droppedFrameCount = 0;

    // Timing tracking
    this.lastFrameTime = performance.now();
    this.fpsIntervalTime = performance.now();
    this.fpsFrameCounter = 0;

    // Latest Frame Buffer (Producer-Consumer)
    this.latestFrame = null; // { imageData, timestamp, captureLatencyMs, width, height }
    this.hasUnprocessedFrame = false;

    this.vfcId = null;
    this.onFrameCallback = null;
  }

  /**
   * Start screen or window capture using navigator.mediaDevices.getDisplayMedia
   */
  async startCapture(targetFPS = 60) {
    this.targetFPS = targetFPS;
    try {
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: this.targetFPS, max: 240 },
          displaySurface: 'monitor', // or 'window' or 'browser'
        },
        audio: false
      });

      this.videoElement.srcObject = this.stream;
      await new Promise((resolve) => {
        this.videoElement.onloadedmetadata = () => {
          this.videoElement.play();
          resolve();
        };
      });

      this.canvas.width = this.videoElement.videoWidth || 1920;
      this.canvas.height = this.videoElement.videoHeight || 1080;

      this.isCapturing = true;
      this.capturedFrameCount = 0;
      this.droppedFrameCount = 0;
      this.lastFrameTime = performance.now();
      this.fpsIntervalTime = performance.now();
      this.fpsFrameCounter = 0;

      // Listen for stream stop (user clicks Chrome stop sharing)
      this.stream.getVideoTracks()[0].onended = () => {
        this.stopCapture();
      };

      // Start frame producer loop
      this.scheduleNextFrame();
      return true;
    } catch (err) {
      console.error('[ScreenCaptureEngine] Error initiating getDisplayMedia:', err);
      throw err;
    }
  }

  /**
   * Start capturing from a synthetic canvas element (used for built-in acceptance tests)
   */
  startCanvasCapture(sourceCanvas, targetFPS = 60) {
    this.targetFPS = targetFPS;
    this.stream = sourceCanvas.captureStream(this.targetFPS);
    this.videoElement.srcObject = this.stream;

    return new Promise((resolve) => {
      this.videoElement.onloadedmetadata = () => {
        this.videoElement.play();
        this.canvas.width = sourceCanvas.width;
        this.canvas.height = sourceCanvas.height;
        this.isCapturing = true;
        this.capturedFrameCount = 0;
        this.droppedFrameCount = 0;
        this.lastFrameTime = performance.now();
        this.fpsIntervalTime = performance.now();
        this.fpsFrameCounter = 0;
        this.scheduleNextFrame();
        resolve(true);
      };
    });
  }

  /**
   * Continuous non-blocking frame producer using requestVideoFrameCallback or requestAnimationFrame fallback
   */
  scheduleNextFrame() {
    if (!this.isCapturing) return;

    if ('requestVideoFrameCallback' in this.videoElement) {
      this.vfcId = this.videoElement.requestVideoFrameCallback((now, metadata) => {
        this.processCapturedFrame(now, metadata);
        this.scheduleNextFrame();
      });
    } else {
      // Fallback for animation frame
      this.vfcId = requestAnimationFrame((now) => {
        this.processCapturedFrame(now);
        this.scheduleNextFrame();
      });
    }
  }

  /**
   * Frame Producer: extract frame, update latest frame buffer, calculate actual FPS
   */
  processCapturedFrame(nowTimestamp, metadata = null) {
    const captureStart = performance.now();
    const frameTime = metadata ? metadata.expectedDisplayTime || nowTimestamp : nowTimestamp;
    const interval = captureStart - this.lastFrameTime;
    this.lastFrameTime = captureStart;

    // Draw frame to internal canvas
    const width = this.canvas.width;
    const height = this.canvas.height;
    this.ctx.drawImage(this.videoElement, 0, 0, width, height);

    // Extract raw ImageData
    const imageData = this.ctx.getImageData(0, 0, width, height);
    const captureEnd = performance.now();
    const captureLatencyMs = captureEnd - captureStart;

    // Track frame drop if previous latestFrame was not consumed yet
    if (this.hasUnprocessedFrame) {
      this.droppedFrameCount++;
    }

    // Overwrite Latest Frame Buffer (Producer-Consumer Latest-Frame Strategy)
    this.latestFrame = {
      imageData,
      width,
      height,
      timestamp: captureStart,
      interval,
      captureLatencyMs,
      frameNumber: ++this.capturedFrameCount
    };
    this.hasUnprocessedFrame = true;

    // Calculate Actual Capture FPS
    this.fpsFrameCounter++;
    const elapsedSinceFPSCheck = captureStart - this.fpsIntervalTime;
    if (elapsedSinceFPSCheck >= 500) { // update every 500ms
      this.actualFPS = (this.fpsFrameCounter / elapsedSinceFPSCheck) * 1000;
      this.fpsFrameCounter = 0;
      this.fpsIntervalTime = captureStart;
    }

    // Trigger frame consumer notification callback if registered
    if (this.onFrameCallback) {
      this.onFrameCallback(this.latestFrame);
    }
  }

  /**
   * Consumer retrieves and clears latest frame. Returns null if no new frame is present.
   */
  consumeLatestFrame() {
    if (!this.hasUnprocessedFrame || !this.latestFrame) {
      return null;
    }
    this.hasUnprocessedFrame = false;
    return this.latestFrame;
  }

  /**
   * Stop screen capture stream
   */
  stopCapture() {
    this.isCapturing = false;
    if (this.vfcId && 'cancelVideoFrameCallback' in this.videoElement) {
      this.videoElement.cancelVideoFrameCallback(this.vfcId);
    } else if (this.vfcId) {
      cancelAnimationFrame(this.vfcId);
    }

    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    this.videoElement.srcObject = null;
    this.actualFPS = 0;
    this.latestFrame = null;
    this.hasUnprocessedFrame = false;
    console.log('[ScreenCaptureEngine] Screen capture stopped.');
  }
}

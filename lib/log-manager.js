/**
 * LogManager - Forensic Trade Log Architecture
 * Handles 100% serialized, atomic log operations for OlympTrade OCR Bot.
 */

window.LogManager = (function() {
  let isProcessing = false;
  let actionQueue = [];

  // ==========================================
  // ATOMIC QUEUE ENGINE (Prevent Lost Update)
  // ==========================================
  function _processQueue() {
    if (isProcessing || actionQueue.length === 0) return;
    isProcessing = true;
    
    const task = actionQueue.shift();
    
    // Read -> Modify -> Write sequentially
    chrome.storage.local.get({ sessionLogs: [] }, (res) => {
      let logs = res.sessionLogs || [];
      
      try {
        const resultLogs = task.executor(logs);
        if (resultLogs) {
          // Enforcement: Auto-clear policy (Max 25)
          if (resultLogs.length >= 25) {
             // Hapus bersih HANYA yang sudah selesai (CLOSED), biarkan yang masih OPEN berjalan
             resultLogs = resultLogs.filter(l => l.status !== 'CLOSED');
          }
          
          chrome.storage.local.set({ sessionLogs: resultLogs }, () => {
            isProcessing = false;
            task.resolve();
            _processQueue();
          });
          return; // Wait for callback
        }
      } catch (err) {
        console.error('[LogManager] Task execution failed:', err);
      }

      isProcessing = false;
      task.resolve();
      _processQueue();
    });
  }

  function _enqueue(executor) {
    return new Promise((resolve) => {
      actionQueue.push({ executor, resolve });
      _processQueue();
    });
  }

  // ==========================================
  // SCHEMA FACTORY
  // ==========================================
  function _createBaseSchema(operationId, positionId, action, rawEntryStr, numericEntry, nominal, timestamp) {
    return {
      schemaVersion: 1,
      operationId: operationId,
      positionId: positionId, // null until confirmed
      status: positionId ? 'OPEN' : 'ACTION_REQUESTED',
      result: 'PENDING',
      direction: action,
      nominal: typeof nominal === 'number' ? nominal : parseFloat(nominal),
      openedAt: timestamp,
      entry: {
        raw: rawEntryStr,
        value: numericEntry,
        timestamp: timestamp,
        confidence: 1.0 // Future integration with OCR engine
      },
      close: null,
      priceDifference: null,
      resultConfidence: 0,
      resultSource: null,
      reconciliationRequired: false
    };
  }

  // ==========================================
  // PUBLIC API
  // ==========================================
  return {
    /**
     * Catat ketika sistem ME-REQUEST sebuah aksi klik, tanpa berasumsi posisi terbuka.
     * @returns {Promise<string>} operationId
     */
    createOperation: async function(action, rawEntryStr, numericEntry, nominal) {
      const ts = Date.now();
      const operationId = `ACTION-${ts}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
      
      await _enqueue((logs) => {
        const newLog = _createBaseSchema(operationId, null, action, rawEntryStr, numericEntry, nominal, ts);
        logs.unshift(newLog);
        return logs;
      });
      return operationId;
    },

    /**
     * Ubah status ACTION_REQUESTED menjadi OPEN ketika mendapatkan konfirmasi DOM/Jeda Waktu Aman.
     * @returns {Promise<string>} positionId (atau null jika gagal konfirmasi)
     */
    confirmPosition: async function(operationId, updatedRaw, updatedNum) {
      const ts = Date.now();
      const positionId = `POS-${ts}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;

      await _enqueue((logs) => {
        const target = logs.find(l => l.operationId === operationId);
        if (target) {
          if (target.status !== 'ACTION_REQUESTED') return logs; // Avoid duplicate confirm
          target.positionId = positionId;
          target.status = 'OPEN';
          target.openedAt = ts; // Koreksi waktu aktual posisi terbuka
          target.entry.timestamp = ts;
          
          if (updatedRaw !== undefined) target.entry.raw = updatedRaw;
          if (updatedNum !== undefined) target.entry.numeric = updatedNum;
          
          return logs;
        }
        return null;
      });
      return positionId;
    },

    /**
     * Tandai operasi gagal terkonfirmasi (hilang/jaringan mati/click gagal).
     */
    markExecutionUnknown: async function(operationId) {
      await _enqueue((logs) => {
        const target = logs.find(l => l.operationId === operationId);
        if (target && target.status === 'ACTION_REQUESTED') {
          target.status = 'EXECUTION_UNKNOWN';
          target.result = 'ERROR';
          target.reconciliationRequired = true;
          return logs;
        }
        return null;
      });
    },

    /**
     * Segel record dengan evidence, tanpa merusak data aslinya.
     * @param {Object} evidence - { rawClose, numericClose, result: "WIN"|"LOSS"|"UNKNOWN", priceDiff, source, confidence, reconciliationRequired }
     */
    closePosition: async function(positionId, evidence) {
      if (!positionId) return;
      const ts = Date.now();

      await _enqueue((logs) => {
        const target = logs.find(l => l.positionId === positionId);
        if (!target) {
          console.warn(`[LogManager] POSITION_NOT_FOUND: ${positionId}`);
          return null; // DO NOT CREATE NEW CLOSED LOG!
        }
        if (target.status === 'CLOSED') {
          console.warn(`[LogManager] DUPLICATE_CLOSE AVOIDED: ${positionId}`);
          // Update data jika ini adalah proses Reconciliation, jika bukan, biarkan.
          if (!evidence.isReconciliation) return null;
        }
        
        target.status = 'CLOSED';
        target.result = evidence.result || 'UNKNOWN';
        target.priceDifference = evidence.priceDiff !== undefined ? evidence.priceDiff : null;
        target.resultSource = evidence.source || 'PRICE_ONLY';
        target.resultConfidence = evidence.confidence || 0.0;
        target.reconciliationRequired = evidence.reconciliationRequired || false;
        
        target.close = {
          raw: evidence.rawClose || '--',
          value: evidence.numericClose !== undefined ? evidence.numericClose : null,
          timestamp: ts,
          confidence: evidence.ocrConfidence || 1.0
        };

        return logs;
      });
    },
    
    /**
     * Kembalikan semua state OPEN atau ACTION_REQUESTED yang butuh recovery saat peramban restart.
     */
    getPendingPositions: function(callback) {
      chrome.storage.local.get({ sessionLogs: [] }, (res) => {
        const logs = res.sessionLogs || [];
        const pendings = logs.filter(l => 
          l.status === 'OPEN' || 
          l.status === 'ACTION_REQUESTED' || 
          (l.status === 'CLOSED' && l.result === 'UNKNOWN' && l.reconciliationRequired)
        );
        callback(pendings);
      });
    },

    // Murni membaca history state terakhir tanpa locking (untuk Popup)
    readLatestState: function(callback) {
      chrome.storage.local.get({ sessionLogs: [] }, (res) => {
        callback(res.sessionLogs || []);
      });
    }
  };
})();

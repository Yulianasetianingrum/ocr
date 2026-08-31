/**
 * State Manager for OCR Bot
 * Acts as the single source of truth for the bot's runtime state.
 * Implements a strict state machine to prevent race conditions and duplicate executions.
 */

window.BotStateManager = (function () {
  const STATES = {
    IDLE: 'IDLE',
    SCANNING: 'SCANNING',
    READY: 'READY',
    EXECUTING: 'EXECUTING',
    WAITING_CONFIRMATION: 'WAITING_CONFIRMATION',
    POSITION_OPEN: 'POSITION_OPEN',
    WAITING_RESULT: 'WAITING_RESULT',
    RESULT_CONFIRMED: 'RESULT_CONFIRMED',
    COOLDOWN: 'COOLDOWN',
    UNKNOWN: 'UNKNOWN',
    ERROR: 'ERROR',
    DEGRADED: 'DEGRADED'
  };

  let currentState = STATES.IDLE;
  let statePayload = null;
  let lastStateChangeTime = Date.now();
  let currentOperationId = null;
  let listeners = [];
  let eventLog = [];

  let watchdogInterval = null;

  // Configurations
  const TIMEOUTS = {
    EXECUTING: 5000,
    WAITING_CONFIRMATION: 5000,
    WAITING_RESULT: 10000,
    COOLDOWN: 3000
  };

  function generateId(prefix = 'op') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
  }

  function logEvent(event, data = {}) {
    const entry = {
      timestamp: Date.now(),
      event,
      data,
      state: currentState,
      operationId: currentOperationId
    };
    eventLog.push(entry);
    if (eventLog.length > 200) eventLog.shift();
    console.log(`[STATE] ${event}`, data);
  }

  function subscribe(listener) {
    if (typeof listener === 'function') {
      listeners.push(listener);
    }
  }

  function notifyListeners(oldState) {
    const stateSnapshot = getState();
    listeners.forEach(fn => {
      try {
        fn(stateSnapshot, oldState);
      } catch (e) {
        console.error('[STATE] Listener error:', e);
      }
    });
    
    // Broadcast via chrome runtime messaging for UI (Popup/Badge)
    try {
      if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          action: 'STATE_CHANGED',
          state: stateSnapshot
        }).catch(() => {}); // Ignore errors if popup is closed
      }
    } catch (e) {}
  }

  function transitionTo(newState, payload = {}) {
    if (!STATES[newState]) {
      console.error(`[STATE] Invalid state transition: ${newState}`);
      return false;
    }

    if (currentState === newState && newState !== STATES.ERROR) {
      return true; // Already in state
    }

    const oldState = currentState;
    currentState = newState;
    statePayload = payload;
    lastStateChangeTime = Date.now();

    // Auto-generate operation ID for new executions
    if (newState === STATES.EXECUTING && !currentOperationId) {
      currentOperationId = generateId('trade');
    }
    
    // Clear operation ID when returning to IDLE or ERROR
    if (newState === STATES.IDLE || newState === STATES.ERROR) {
      currentOperationId = null;
    }

    logEvent(`TRANSITION_${newState}`, payload);
    notifyListeners(oldState);
    return true;
  }

  function getState() {
    return {
      status: currentState,
      payload: statePayload,
      since: lastStateChangeTime,
      operationId: currentOperationId
    };
  }

  function startWatchdog() {
    if (watchdogInterval) clearInterval(watchdogInterval);
    watchdogInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = now - lastStateChangeTime;

      if (currentState === STATES.EXECUTING && elapsed > TIMEOUTS.EXECUTING) {
        logEvent('WATCHDOG_TIMEOUT', { reason: 'Stuck in EXECUTING' });
        transitionTo(STATES.ERROR, { message: 'Execution timed out' });
      }
      else if (currentState === STATES.WAITING_CONFIRMATION && elapsed > TIMEOUTS.WAITING_CONFIRMATION) {
        logEvent('WATCHDOG_TIMEOUT', { reason: 'Stuck in WAITING_CONFIRMATION' });
        transitionTo(STATES.UNKNOWN, { message: 'Confirmation timed out' });
      }
      else if (currentState === STATES.WAITING_RESULT && elapsed > TIMEOUTS.WAITING_RESULT) {
        logEvent('WATCHDOG_TIMEOUT', { reason: 'Stuck in WAITING_RESULT' });
        transitionTo(STATES.UNKNOWN, { message: 'Result detection timed out' });
      }
      else if (currentState === STATES.COOLDOWN && elapsed > TIMEOUTS.COOLDOWN) {
        transitionTo(STATES.IDLE);
      }
    }, 1000);
  }

  function getEventLog() {
    return [...eventLog];
  }
  
  function getStates() {
      return STATES;
  }

  startWatchdog();

  return {
    STATES,
    getStates,
    transitionTo,
    getState,
    subscribe,
    generateId,
    logEvent,
    getEventLog
  };
})();

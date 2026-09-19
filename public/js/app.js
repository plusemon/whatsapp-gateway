/**
 * Botla WhatsApp Gateway - Application Entrypoint (ES Module)
 * Orchestrates module registration, window exports, and initial boot cycles.
 */

// Import UI utilities
import {
  checkHealth,
  copyWebhookUrl,
  escapeHtml,
  formatBytes,
  getRelativeTime,
  showToast,
  switchMobileTab,
  switchTab,
} from './modules/ui.js';

// Import Sessions management
import {
  closePurgeModal,
  closeQrModal,
  copyPairCode,
  executePurgeSession,
  fetchAndDisplayQr,
  fillSender,
  initSession,
  loadSessions,
  openPurgeModal,
  openQrModal,
  purgeSession,
  refreshQrSession,
  requestPairingCode,
  selectSessionForSend,
  setSessionInput,
  switchPairingTab,
  viewQr,
} from './modules/sessions.js';

// Import Console dispatcher
import {
  handleQuickSendMessage,
  handleSendMedia,
  handleSendMessage,
  setQuickSendTemplate,
  setSendTemplate,
  switchSendTab,
  toggleMediaFields,
} from './modules/console.js';

// Import Diagnostics & Logs
import {
  formatLogTimestamp,
  formatLogViewerLine,
  getLogLevelBadgeInfo,
  parsePinoJsonLine,
} from './components/logViewerModal.js';
import {
  clearEventFeed,
  clearLogFeed,
  closeClearLogModal,
  closeLogViewer,
  confirmClearAllLogs,
  confirmClearCurrentLogFile,
  confirmClearSingleLogFile,
  copyEventPayload,
  copyLogMeta,
  copyLogViewerContent,
  downloadCurrentLogViewerFile,
  downloadLogFile,
  executeClearLogFile,
  executeConfirmedLogClear,
  fetchEvents,
  fetchLogFiles,
  filterLogsChanged,
  initLogStreamSSE,
  loadLogViewerContent,
  openClearLogModal,
  openLogViewer,
  refreshLogViewerContent,
  renderEvents,
  renderLogs,
  renderLogViewerTerminal,
  scrollLogViewerToBottom,
  scrollLogViewerToTop,
  setEventFilter,
  setLogLevelFilter,
  setLogViewerLines,
  switchStreamTab,
  toggleLogStreamPause,
  toggleStreamPause,
  triggerLogCleanup,
  triggerMediaCleanup,
  updateLinesPillState,
} from './modules/logs.js';

// Global refresh trigger
export async function manualRefreshAll() {
  const icon = document.getElementById('manual-refresh-icon');
  if (icon) icon.classList.add('animate-spin');
  try {
    await Promise.all([
      checkHealth(),
      loadSessions(),
      fetchEvents(),
      fetchLogFiles(),
    ]);
    showToast('Telemetry and sessions refreshed');
  } finally {
    if (icon) setTimeout(() => icon.classList.remove('animate-spin'), 500);
  }
}

// Bind all interactive handlers to the window object for HTML event attributes
Object.assign(window, {
  // UI & General
  showToast,
  switchTab,
  switchMobileTab,
  copyWebhookUrl,
  manualRefreshAll,
  getRelativeTime,
  escapeHtml,
  formatBytes,

  // Sessions
  loadSessions,
  setSessionInput,
  initSession,
  fillSender,
  selectSessionForSend,
  openPurgeModal,
  closePurgeModal,
  executePurgeSession,
  purgeSession,
  openQrModal,
  closeQrModal,
  switchPairingTab,
  viewQr,
  fetchAndDisplayQr,
  refreshQrSession,
  requestPairingCode,
  copyPairCode,

  // Console / Message Sender
  switchSendTab,
  toggleMediaFields,
  setSendTemplate,
  setQuickSendTemplate,
  handleSendMessage,
  handleQuickSendMessage,
  handleSendMedia,

  // Logs & Diagnostics
  switchStreamTab,
  initLogStreamSSE,
  setLogLevelFilter,
  filterLogsChanged,
  toggleLogStreamPause,
  clearLogFeed,
  renderLogs,
  copyLogMeta,
  fetchLogFiles,
  openLogViewer,
  closeLogViewer,
  setLogViewerLines,
  updateLinesPillState,
  refreshLogViewerContent,
  loadLogViewerContent,
  renderLogViewerTerminal,
  scrollLogViewerToTop,
  scrollLogViewerToBottom,
  copyLogViewerContent,
  downloadLogFile,
  downloadCurrentLogViewerFile,
  confirmClearCurrentLogFile,
  confirmClearSingleLogFile,
  confirmClearAllLogs,
  openClearLogModal,
  closeClearLogModal,
  executeConfirmedLogClear,
  executeClearLogFile,
  triggerLogCleanup,
  triggerMediaCleanup,
  toggleStreamPause,
  clearEventFeed,
  setEventFilter,
  fetchEvents,
  renderEvents,
  copyEventPayload,
  formatLogViewerLine,
  parsePinoJsonLine,
  formatLogTimestamp,
  getLogLevelBadgeInfo,
});

/**
 * Main DOM Initialization
 */
document.addEventListener('DOMContentLoaded', () => {
  // Bind form submissions
  const quickSendForm = document.getElementById('quick-send-form');
  if (quickSendForm) {
    quickSendForm.addEventListener('submit', handleQuickSendMessage);
  }

  const sendForm = document.getElementById('send-form');
  if (sendForm) {
    sendForm.addEventListener('submit', handleSendMessage);
  }

  const sendMediaForm = document.getElementById('send-media-form');
  if (sendMediaForm) {
    sendMediaForm.addEventListener('submit', handleSendMedia);
  }

  // Bind modal buttons explicitly
  const btnLogViewerClear = document.getElementById('btn-log-viewer-clear');
  if (btnLogViewerClear) {
    btnLogViewerClear.addEventListener('click', (e) => {
      e.preventDefault();
      confirmClearCurrentLogFile();
    });
  }

  const btnLogViewerClose = document.getElementById('btn-log-viewer-close');
  if (btnLogViewerClose) {
    btnLogViewerClose.addEventListener('click', (e) => {
      e.preventDefault();
      closeLogViewer();
    });
  }

  const btnLogViewerRefresh = document.getElementById('btn-log-viewer-refresh');
  if (btnLogViewerRefresh) {
    btnLogViewerRefresh.addEventListener('click', (e) => {
      e.preventDefault();
      refreshLogViewerContent();
    });
  }

  const btnLogViewerCopy = document.getElementById('btn-log-viewer-copy');
  if (btnLogViewerCopy) {
    btnLogViewerCopy.addEventListener('click', (e) => {
      e.preventDefault();
      copyLogViewerContent();
    });
  }

  const btnLogViewerDownload = document.getElementById('btn-log-viewer-download');
  if (btnLogViewerDownload) {
    btnLogViewerDownload.addEventListener('click', (e) => {
      e.preventDefault();
      downloadCurrentLogViewerFile();
    });
  }

  // Bind modal backdrop clicks & keyboard shortcuts
  const purgeModal = document.getElementById('purge-modal');
  if (purgeModal) {
    purgeModal.addEventListener('click', (e) => {
      if (e.target === purgeModal) closePurgeModal();
    });
  }

  const qrModal = document.getElementById('qr-modal');
  if (qrModal) {
    qrModal.addEventListener('click', (e) => {
      if (e.target === qrModal) closeQrModal();
    });
  }

  const logViewerModal = document.getElementById('log-viewer-modal');
  if (logViewerModal) {
    logViewerModal.addEventListener('click', (e) => {
      if (e.target === logViewerModal) closeLogViewer();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePurgeModal();
      closeQrModal();
      closeLogViewer();
    }
  });

  // Initial System Boot
  checkHealth();
  loadSessions();
  fetchEvents();
  initLogStreamSSE();
  fetchLogFiles();

  // Background Polling
  setInterval(fetchEvents, 3000);
  setInterval(checkHealth, 10000);
  setInterval(loadSessions, 15000);
});

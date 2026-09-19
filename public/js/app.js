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
  stopQrPolling,
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
  clearEventFeed,
  clearLogFeed,
  copyEventPayload,
  copyLogMeta,
  fetchEvents,
  filterLogsChanged,
  initLogStreamSSE,
  renderEvents,
  renderLogs,
  setEventFilter,
  setLogLevelFilter,
  switchStreamTab,
  toggleLogStreamPause,
  toggleStreamPause,
  triggerMediaCleanup,
} from './modules/logs.js';

// Import Webhook Settings
import {
  loadWebhookSettings,
  openWebhookSettingsModal,
  closeWebhookSettingsModal,
  toggleWebhookSecretVisibility,
  saveWebhookSettings,
  testWebhookPing,
} from './modules/webhook.js';

// Global refresh trigger
export async function manualRefreshAll() {
  const icon = document.getElementById('manual-refresh-icon');
  if (icon) icon.classList.add('animate-spin');
  try {
    await Promise.all([
      checkHealth(),
      loadSessions(),
      fetchEvents(),
      loadWebhookSettings(),
    ]);
    showToast('Telemetry, sessions and webhook status refreshed');
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
  stopQrPolling,
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
  triggerMediaCleanup,
  toggleStreamPause,
  clearEventFeed,
  setEventFilter,
  fetchEvents,
  renderEvents,
  copyEventPayload,

  // Webhook Settings
  loadWebhookSettings,
  openWebhookSettingsModal,
  closeWebhookSettingsModal,
  toggleWebhookSecretVisibility,
  saveWebhookSettings,
  testWebhookPing,
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

  const webhookSettingsModal = document.getElementById('webhook-settings-modal');
  if (webhookSettingsModal) {
    webhookSettingsModal.addEventListener('click', (e) => {
      if (e.target === webhookSettingsModal) closeWebhookSettingsModal();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePurgeModal();
      closeQrModal();
      closeWebhookSettingsModal();
    }
  });

  // Initial System Boot
  checkHealth();
  loadSessions();
  fetchEvents();
  initLogStreamSSE();
  loadWebhookSettings();

  // Background Polling
  setInterval(fetchEvents, 3000);
  setInterval(checkHealth, 10000);
  setInterval(loadSessions, 15000);
});

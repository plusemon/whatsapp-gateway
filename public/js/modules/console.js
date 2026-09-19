/**
 * Botla WhatsApp Gateway - Outbound Dispatcher & Console Module
 * Handles text & media message submission with presence simulation.
 */
import { MessageApi } from '../api.js';
import { showToast } from './ui.js';

/**
 * Switches between Text and Media message forms.
 * @param {'text'|'media'} tab 
 */
export function switchSendTab(tab) {
  const textForm = document.getElementById('send-form');
  const mediaForm = document.getElementById('send-media-form');
  const btnText = document.getElementById('tab-btn-text');
  const btnMedia = document.getElementById('tab-btn-media');

  if (tab === 'text') {
    if (textForm) textForm.classList.remove('hidden');
    if (mediaForm) mediaForm.classList.add('hidden');
    if (btnText) btnText.className = 'px-3.5 py-2 rounded-xl text-xs font-semibold bg-zinc-800 text-white cursor-pointer transition active:scale-95 flex items-center gap-1.5';
    if (btnMedia) btnMedia.className = 'px-3.5 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white cursor-pointer transition active:scale-95 flex items-center gap-1.5';
  } else {
    if (textForm) textForm.classList.add('hidden');
    if (mediaForm) mediaForm.classList.remove('hidden');
    if (btnMedia) btnMedia.className = 'px-3.5 py-2 rounded-xl text-xs font-semibold bg-zinc-800 text-white cursor-pointer transition active:scale-95 flex items-center gap-1.5';
    if (btnText) btnText.className = 'px-3.5 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white cursor-pointer transition active:scale-95 flex items-center gap-1.5';
  }
}

/**
 * Toggles visibility of media-specific input fields (caption, filename, PTT).
 */
export function toggleMediaFields() {
  const typeSelect = document.getElementById('media-type');
  const type = typeSelect ? typeSelect.value : 'image';
  const pttContainer = document.getElementById('ptt-container');
  const captionContainer = document.getElementById('caption-container');
  const filenameContainer = document.getElementById('filename-container');

  if (type === 'audio') {
    if (pttContainer) pttContainer.classList.remove('hidden');
    if (captionContainer) captionContainer.classList.add('hidden');
    if (filenameContainer) filenameContainer.classList.add('hidden');
  } else if (type === 'document') {
    if (pttContainer) pttContainer.classList.add('hidden');
    if (captionContainer) captionContainer.classList.remove('hidden');
    if (filenameContainer) filenameContainer.classList.remove('hidden');
  } else {
    // image
    if (pttContainer) pttContainer.classList.add('hidden');
    if (captionContainer) captionContainer.classList.remove('hidden');
    if (filenameContainer) filenameContainer.classList.add('hidden');
  }
}

/**
 * Sets quick preset message text into the textarea.
 * @param {string} text 
 */
export function setSendTemplate(text) {
  const area = document.getElementById('send-text');
  if (area) area.value = text;
}

/**
 * Handles Outbound Text Message form submission.
 * @param {Event} e 
 */
export async function handleSendMessage(e) {
  if (e) e.preventDefault();
  const sessionId = document.getElementById('send-session-id')?.value.trim();
  const jid = document.getElementById('send-jid')?.value.trim();
  const text = document.getElementById('send-text')?.value.trim();
  const statusSpan = document.getElementById('send-status');
  const btn = document.getElementById('btn-send');

  if (!sessionId || !jid || !text) {
    showToast('Please fill in Session ID, JID, and Message text', 'warn');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `
      <svg class="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
      <span>Simulating Presence...</span>
    `;
  }
  if (statusSpan) {
    statusSpan.textContent = 'Simulating composing presence (600-1400ms)...';
    statusSpan.className = 'text-xs text-amber-400';
  }

  try {
    const data = await MessageApi.sendTextMessage(sessionId, jid, text);

    if (data && data.success) {
      if (statusSpan) {
        statusSpan.textContent = '✓ Message dispatched! ID: ' + (data.messageId || 'ok');
        statusSpan.className = 'text-xs text-emerald-400';
      }
      showToast('Message dispatched via WhatsApp socket');
      const textInput = document.getElementById('send-text');
      if (textInput) textInput.value = '';
    } else {
      if (statusSpan) {
        statusSpan.textContent = 'Error: ' + (data?.message || 'Failed to send');
        statusSpan.className = 'text-xs text-rose-400';
      }
      showToast(data?.message || 'Failed to send message', 'error');
    }
  } catch (err) {
    if (statusSpan) {
      statusSpan.textContent = 'Request failed: ' + err.message;
      statusSpan.className = 'text-xs text-rose-400';
    }
    showToast('Send error: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"></path></svg>
        <span>Send via Gateway</span>
      `;
    }
  }
}

/**
 * Handles Outbound Media Message form submission.
 * @param {Event} e 
 */
export async function handleSendMedia(e) {
  if (e) e.preventDefault();
  const sessionId = document.getElementById('media-session-id')?.value.trim();
  const jid = document.getElementById('media-jid')?.value.trim();
  const type = document.getElementById('media-type')?.value;
  const url = document.getElementById('media-url')?.value.trim();
  const caption = document.getElementById('media-caption')?.value.trim();
  const filename = document.getElementById('media-filename')?.value.trim();
  const ptt = document.getElementById('media-ptt')?.checked;
  const statusSpan = document.getElementById('send-media-status');
  const btn = document.getElementById('btn-send-media');

  if (!sessionId || !jid || !url) {
    showToast('Please fill in Session ID, Target JID, and Media URL', 'warn');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `
      <svg class="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
      <span>Dispatching Media...</span>
    `;
  }
  if (statusSpan) {
    statusSpan.textContent = `Simulating ${type === 'audio' && ptt ? 'recording' : 'composing'} presence & dispatching...`;
    statusSpan.className = 'text-xs text-amber-400';
  }

  try {
    const payload = {
      jid,
      type,
      url,
      caption: caption || undefined,
      filename: filename || undefined,
      ptt: !!ptt,
    };

    const data = await MessageApi.sendMediaMessage(sessionId, payload);

    if (data && data.success) {
      if (statusSpan) {
        statusSpan.textContent = `✓ Media (${type}) dispatched! ID: ${data.messageId}`;
        statusSpan.className = 'text-xs text-emerald-400';
      }
      showToast(`Media (${type}) dispatched successfully!`);
    } else {
      if (statusSpan) {
        statusSpan.textContent = 'Error: ' + (data?.error || data?.message || 'Failed to dispatch media');
        statusSpan.className = 'text-xs text-rose-400';
      }
      showToast(data?.error || data?.message || 'Media dispatch failed', 'error');
    }
  } catch (err) {
    if (statusSpan) {
      statusSpan.textContent = 'Request failed: ' + err.message;
      statusSpan.className = 'text-xs text-rose-400';
    }
    showToast('Request failed: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg>
        <span>Dispatch Media</span>
      `;
    }
  }
}

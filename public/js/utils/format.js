/**
 * Botla WhatsApp Gateway - Formatting & Sanitization Utilities
 */

/**
 * Clean phone JID formatter function.
 * Cleans multi-device Baileys JIDs (e.g., 8801995329555:13@s.whatsapp.net)
 * into a clean, formatted international phone number (+880 1995-329555).
 *
 * @param {string|Object|null} jid
 * @returns {string}
 */
export function formatDisplayPhone(jid) {
  if (!jid) return 'Awaiting authentication';
  const raw = typeof jid === 'object' ? (jid.id || jid.jid || jid.phone || jid.name || '') : String(jid);
  if (!raw) return 'Awaiting authentication';
  const cleanNumber = raw.split('@')[0].split(':')[0].replace(/\D/g, '');
  if (!cleanNumber) return raw;
  return `+${cleanNumber.slice(0, 3)} ${cleanNumber.slice(3, 7)}-${cleanNumber.slice(7)}`;
}

/**
 * Returns formatted target user identity including formatted phone and optional pushName.
 *
 * @param {Object|string|null} user
 * @returns {string}
 */
export function formatSessionTarget(user) {
  if (!user) return 'Awaiting authentication';
  if (typeof user === 'string') {
    return formatDisplayPhone(user);
  }
  const phone = formatDisplayPhone(user.id || user.jid || user.phone);
  const pushName = user.name || user.pushName || user.notify;
  if (pushName && phone !== 'Awaiting authentication' && !phone.includes(pushName)) {
    return `${phone} (${pushName})`;
  }
  if (pushName && phone === 'Awaiting authentication') {
    return pushName;
  }
  return phone;
}

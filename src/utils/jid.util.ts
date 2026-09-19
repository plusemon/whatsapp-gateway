/**
 * WhatsApp JID and Phone Number Formatting Utilities
 */

/**
 * Normalizes a raw phone number or JID into a valid WhatsApp JID.
 */
export function normalizeJid(jid: string): string {
  if (!jid) return '';
  const trimmed = jid.trim();

  // Already formatted with standard domain
  if (trimmed.includes('@')) {
    return trimmed;
  }

  // Clean numbers only and append standard domain
  const digits = trimmed.replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

/**
 * Strips non-digit characters from a phone number string.
 */
export function sanitizePhoneNumber(phone: string): string {
  return (phone || '').replace(/\D/g, '');
}

/**
 * Formats an 8-character pairing code with a hyphen (e.g., ABCD-1234).
 */
export function formatPairingCode(rawCode: string): string {
  if (!rawCode) return '';
  const cleanCode = rawCode.replace(/[^A-Za-z0-9]/g, '');
  if (cleanCode.length === 8) {
    return `${cleanCode.slice(0, 4)}-${cleanCode.slice(4)}`;
  }
  if (rawCode.includes('-')) {
    return rawCode;
  }
  const chunks = rawCode.match(/.{1,4}/g);
  return chunks ? chunks.join('-') : rawCode;
}

/**
 * Extracts the raw phone number from a WhatsApp JID.
 */
export function extractPhoneFromJid(jid: string): string {
  if (!jid) return '';
  return jid.split('@')[0].replace(/\D/g, '');
}

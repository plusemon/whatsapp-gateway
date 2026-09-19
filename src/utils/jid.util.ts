/**
 * WhatsApp JID and Phone Number Formatting Utilities
 */

/**
 * Strips device tags from multi-device WhatsApp JIDs.
 * Example: 8801995329555:13@s.whatsapp.net -> 8801995329555@s.whatsapp.net
 */
export function stripDeviceTag(jid: string): string {
  if (!jid) return '';
  if (!jid.includes(':')) return jid;
  const [userWithDevice, domain] = jid.split('@');
  const user = userWithDevice.split(':')[0];
  return domain ? `${user}@${domain}` : user;
}

/**
 * Checks if a JID is a WhatsApp Group JID (@g.us).
 */
export function isGroupJid(jid: string): boolean {
  return Boolean(jid && jid.trim().endsWith('@g.us'));
}

/**
 * Checks if a JID is a WhatsApp LID JID (@lid).
 */
export function isLidJid(jid: string): boolean {
  return Boolean(jid && jid.trim().endsWith('@lid'));
}

/**
 * Normalizes a raw phone number or JID into a valid WhatsApp JID.
 * - Strips multi-device tags (:13)
 * - Normalizes local 11-digit numbers starting with 01 to 8801...
 * - Preserves group JIDs (@g.us)
 * - Preserves LID JIDs (@lid)
 */
export function normalizeJid(jid: string, defaultCountryCode = '88'): string {
  if (!jid) return '';
  const trimmed = jid.trim();
  if (!trimmed) return '';

  // Handle existing domain-formatted JIDs
  if (trimmed.includes('@')) {
    const [userWithDevice, domain] = trimmed.split('@');
    const user = userWithDevice.split(':')[0];

    // Group JID: preserve user and domain
    if (domain === 'g.us') {
      return `${user}@g.us`;
    }

    // LID JID: preserve LID identifier
    if (domain === 'lid') {
      return `${user}@lid`;
    }

    // Phone JID (e.g. s.whatsapp.net)
    let digits = user.replace(/\D/g, '');
    if (digits.startsWith('01') && digits.length === 11) {
      digits = `${defaultCountryCode}${digits}`;
    }
    return `${digits}@${domain}`;
  }

  // Handle raw phone number strings
  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('01') && digits.length === 11) {
    digits = `${defaultCountryCode}${digits}`;
  }
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
 * Extracts the raw phone number / numeric user ID from a WhatsApp JID
 * (handles standard JID, multi-device tags, and LID formats).
 */
export function extractPhoneFromJid(jid: string): string {
  if (!jid) return '';
  const userPart = jid.split('@')[0].split(':')[0];
  return userPart.replace(/\D/g, '');
}

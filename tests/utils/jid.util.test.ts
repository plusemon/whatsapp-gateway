import { describe, it, expect } from 'vitest';
import {
  normalizeJid,
  stripDeviceTag,
  isGroupJid,
  isLidJid,
  sanitizePhoneNumber,
  formatPairingCode,
  extractPhoneFromJid,
} from '../../src/utils/jid.util.js';

describe('JID Formatting & Parsing Utilities (jid.util.ts)', () => {
  describe('normalizeJid', () => {
    it('should normalize international format with leading plus (+8801995329555) to standard WhatsApp JID', () => {
      const result = normalizeJid('+8801995329555');
      expect(result).toBe('8801995329555@s.whatsapp.net');
    });

    it('should normalize local 11-digit Bangladeshi format (01995329555) to standard WhatsApp JID', () => {
      const result = normalizeJid('01995329555');
      expect(result).toBe('8801995329555@s.whatsapp.net');
    });

    it('should normalize international raw numeric format (8801995329555) to standard WhatsApp JID', () => {
      const result = normalizeJid('8801995329555');
      expect(result).toBe('8801995329555@s.whatsapp.net');
    });

    it('should strip multi-device tags (:13) from JIDs: 8801995329555:13@s.whatsapp.net -> 8801995329555@s.whatsapp.net', () => {
      const result = normalizeJid('8801995329555:13@s.whatsapp.net');
      expect(result).toBe('8801995329555@s.whatsapp.net');
    });

    it('should strip various device IDs like :1 or :99', () => {
      expect(normalizeJid('8801712345678:1@s.whatsapp.net')).toBe('8801712345678@s.whatsapp.net');
      expect(normalizeJid('8801712345678:99@s.whatsapp.net')).toBe('8801712345678@s.whatsapp.net');
    });

    it('should preserve group JIDs ending in @g.us without breaking', () => {
      const groupJid = '120363023456789012@g.us';
      const result = normalizeJid(groupJid);
      expect(result).toBe(groupJid);

      const legacyGroupJid = '8801995329555-1612345678@g.us';
      expect(normalizeJid(legacyGroupJid)).toBe(legacyGroupJid);
    });

    it('should preserve LID formatted JIDs ending in @lid', () => {
      const lidJid = '237894561230@lid';
      const result = normalizeJid(lidJid);
      expect(result).toBe(lidJid);
    });

    it('should return an empty string for null, undefined, or empty inputs', () => {
      expect(normalizeJid('')).toBe('');
      expect(normalizeJid('   ')).toBe('');
      expect(normalizeJid(null as any)).toBe('');
      expect(normalizeJid(undefined as any)).toBe('');
    });
  });

  describe('stripDeviceTag', () => {
    it('should strip device tag before domain', () => {
      expect(stripDeviceTag('8801995329555:13@s.whatsapp.net')).toBe('8801995329555@s.whatsapp.net');
      expect(stripDeviceTag('8801711112222:2@s.whatsapp.net')).toBe('8801711112222@s.whatsapp.net');
    });

    it('should leave non-device JIDs unchanged', () => {
      expect(stripDeviceTag('8801995329555@s.whatsapp.net')).toBe('8801995329555@s.whatsapp.net');
      expect(stripDeviceTag('120363023456789012@g.us')).toBe('120363023456789012@g.us');
    });
  });

  describe('isGroupJid & isLidJid', () => {
    it('should identify group JIDs correctly', () => {
      expect(isGroupJid('120363023456789012@g.us')).toBe(true);
      expect(isGroupJid('8801995329555@s.whatsapp.net')).toBe(false);
      expect(isGroupJid('123456@lid')).toBe(false);
      expect(isGroupJid('')).toBe(false);
    });

    it('should identify LID JIDs correctly', () => {
      expect(isLidJid('237894561230@lid')).toBe(true);
      expect(isLidJid('8801995329555@s.whatsapp.net')).toBe(false);
      expect(isLidJid('120363023456789012@g.us')).toBe(false);
      expect(isLidJid('')).toBe(false);
    });
  });

  describe('extractPhoneFromJid', () => {
    it('should extract numeric phone number from standard JID', () => {
      expect(extractPhoneFromJid('8801995329555@s.whatsapp.net')).toBe('8801995329555');
    });

    it('should extract numeric phone number and ignore device tag', () => {
      expect(extractPhoneFromJid('8801995329555:13@s.whatsapp.net')).toBe('8801995329555');
    });

    it('should safely extract pure numeric identifier from LID JID', () => {
      expect(extractPhoneFromJid('237894561230@lid')).toBe('237894561230');
    });

    it('should handle empty or malformed JIDs gracefully', () => {
      expect(extractPhoneFromJid('')).toBe('');
      expect(extractPhoneFromJid(null as any)).toBe('');
    });
  });

  describe('sanitizePhoneNumber & formatPairingCode', () => {
    it('should strip non-digits from phone number strings', () => {
      expect(sanitizePhoneNumber('+880 1995-329555')).toBe('8801995329555');
      expect(sanitizePhoneNumber('(880) 171-22-33-44')).toBe('880171223344');
    });

    it('should format 8-character pairing codes with a hyphen', () => {
      expect(formatPairingCode('ABCD1234')).toBe('ABCD-1234');
      expect(formatPairingCode('ABCD-1234')).toBe('ABCD-1234');
    });
  });
});

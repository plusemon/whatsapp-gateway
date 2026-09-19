import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebhookService } from '../../src/services/webhook.service.js';

describe('Webhook HMAC Signature & Payload Integrity (webhook.service.ts)', () => {
  const secretKey = 'test-botla-super-secret-key-12345';
  const samplePayload = {
    event: 'message.inbound',
    sessionId: 'tenant-demo-1',
    timestamp: '2026-09-19T10:00:00.000Z',
    data: {
      from: '8801995329555@s.whatsapp.net',
      text: 'Hello from Botla Gateway test',
    },
  };
  const jsonPayloadString = JSON.stringify(samplePayload);

  describe('generateSignature', () => {
    it('should generate an HMAC-SHA256 signature matching crypto.createHmac', () => {
      const generated = WebhookService.generateSignature(jsonPayloadString, secretKey);
      const expected = crypto
        .createHmac('sha256', secretKey)
        .update(jsonPayloadString)
        .digest('hex');

      expect(generated).toBe(expected);
      expect(generated).toHaveLength(64); // 256 bits in hex
    });

    it('should accept object payloads and serialize them automatically', () => {
      const fromObj = WebhookService.generateSignature(samplePayload, secretKey);
      const fromStr = WebhookService.generateSignature(jsonPayloadString, secretKey);

      expect(fromObj).toBe(fromStr);
    });
  });

  describe('verifySignature', () => {
    it('should verify matching payload and secret produce a valid signature check', () => {
      const sig = WebhookService.generateSignature(samplePayload, secretKey);

      // Raw hex
      expect(WebhookService.verifySignature(samplePayload, secretKey, sig)).toBe(true);

      // Prefixed format: sha256=...
      expect(WebhookService.verifySignature(samplePayload, secretKey, `sha256=${sig}`)).toBe(true);
    });

    it('should fail verification if the payload is mutated', () => {
      const sig = WebhookService.generateSignature(samplePayload, secretKey);

      const mutatedPayload = {
        ...samplePayload,
        data: {
          ...samplePayload.data,
          text: 'Tampered message text',
        },
      };

      expect(WebhookService.verifySignature(mutatedPayload, secretKey, sig)).toBe(false);
    });

    it('should fail verification if the secret key is different', () => {
      const sig = WebhookService.generateSignature(samplePayload, secretKey);
      const wrongSecret = 'wrong-secret-key';

      expect(WebhookService.verifySignature(samplePayload, wrongSecret, sig)).toBe(false);
    });

    it('should fail verification on empty signature or empty secret', () => {
      expect(WebhookService.verifySignature(samplePayload, '', 'some-sig')).toBe(false);
      expect(WebhookService.verifySignature(samplePayload, secretKey, '')).toBe(false);
    });
  });

  describe('dispatch abort on webhook disabled', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should gracefully abort dispatch when webhook is disabled', async () => {
      // Mock resolveWebhook to return enabled: false
      const resolveSpy = vi.spyOn(WebhookService, 'resolveWebhook').mockResolvedValue({
        url: 'https://core.botla.ai/api/webhooks/whatsapp',
        secret: secretKey,
        token: 'token-abc',
        enabled: false, // explicitly disabled
        events: { inbound: true, ack: true, status: true },
        retryStats: {
          totalSent: 0,
          successCount: 0,
          failCount: 0,
          lastAttempt: null,
          lastSuccess: null,
          lastError: null,
        },
        source: 'env',
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const dispatched = await WebhookService.dispatch(samplePayload);

      expect(dispatched).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(resolveSpy).toHaveBeenCalled();
    });

    it('should proceed to fetch when webhook is enabled and url is provided', async () => {
      vi.spyOn(WebhookService, 'resolveWebhook').mockResolvedValue({
        url: 'https://core.botla.ai/api/webhooks/whatsapp',
        secret: secretKey,
        token: 'token-abc',
        enabled: true,
        events: { inbound: true, ack: true, status: true },
        retryStats: {
          totalSent: 0,
          successCount: 0,
          failCount: 0,
          lastAttempt: null,
          lastSuccess: null,
          lastError: null,
        },
        source: 'env',
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
      } as any);

      const dispatched = await WebhookService.dispatch(samplePayload);

      expect(dispatched).toBe(true);
      expect(fetchSpy).toHaveBeenCalled();
      const [calledUrl, requestInit] = fetchSpy.mock.calls[0];
      expect(calledUrl).toBe('https://core.botla.ai/api/webhooks/whatsapp');

      const headers = (requestInit as RequestInit).headers as Record<string, string>;
      expect(headers['X-Botla-Signature']).toContain('sha256=');
      expect(headers['Authorization']).toBe('Bearer token-abc');
    });
  });
});

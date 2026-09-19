import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to ensure mock references are available to hoisted vi.mock calls
const { socketEventListeners, mockSocketEv, mockWASocket, dummyRedis } = vi.hoisted(() => {
  const socketEventListeners: Record<string, ((...args: any[]) => void)[]> = {};

  const mockSocketEv = {
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (!socketEventListeners[event]) {
        socketEventListeners[event] = [];
      }
      socketEventListeners[event].push(handler);
    }),
    emit: (event: string, data: any) => {
      const handlers = socketEventListeners[event] || [];
      for (const h of handlers) {
        h(data);
      }
    },
  };

  const mockWASocket = {
    ev: mockSocketEv,
    ws: { readyState: 1, close: vi.fn() },
    end: vi.fn(),
    logout: vi.fn(),
    requestPairingCode: vi.fn().mockResolvedValue('ABCD1234'),
    user: { id: '8801995329555:1@s.whatsapp.net', name: 'Botla Test' },
    authState: { creds: { registered: false } },
  };

  const dummyRedis = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    keys: vi.fn().mockResolvedValue([]),
  };

  return {
    socketEventListeners,
    mockSocketEv,
    mockWASocket,
    dummyRedis,
  };
});

// Mock Baileys
vi.mock('@whiskeysockets/baileys', async () => {
  const actual = await vi.importActual<any>('@whiskeysockets/baileys');
  return {
    ...actual,
    default: vi.fn(() => mockWASocket),
    makeWASocket: vi.fn(() => mockWASocket),
    Browsers: {
      ubuntu: vi.fn(() => ['Ubuntu', 'Chrome', '20.0.04']),
    },
    DisconnectReason: {
      loggedOut: 401,
      timedOut: 408,
      restartRequired: 515,
      connectionClosed: 428,
      connectionLost: 408,
      badSession: 500,
      unavailableService: 503,
      multideviceMismatch: 411,
    },
  };
});

// Mock Redis adapter & state
vi.mock('../../src/adapters/redisAuthState.js', () => ({
  useRedisAuthState: vi.fn().mockResolvedValue({
    state: { creds: {}, keys: {} },
    saveCreds: vi.fn().mockResolvedValue(undefined),
  }),
  clearRedisSession: vi.fn().mockResolvedValue(5),
}));

// Mock versionGuard
vi.mock('../../src/utils/versionGuard.js', () => ({
  getWhatsAppVersion: vi.fn().mockResolvedValue({
    version: [2, 3000, 1000],
    isLatest: true,
    source: 'mock',
    fetchedAt: Date.now(),
  }),
}));

// Mock Redis Client
vi.mock('../../src/config/redis.js', () => ({
  getRedisClient: vi.fn().mockResolvedValue(dummyRedis),
  disconnectRedisClient: vi.fn(),
}));

// Import SessionService after mocks are hoisted & registered
import { SessionService } from '../../src/services/session.service.js';

describe('Session State Guard & Anti-Overwrite (session.service.ts)', () => {
  let sessionService: SessionService;

  beforeEach(() => {
    // Reset event listeners and mocks
    for (const key of Object.keys(socketEventListeners)) {
      delete socketEventListeners[key];
    }
    vi.clearAllMocks();
    sessionService = new SessionService();
  });

  describe('Pairing Code Guard State', () => {
    it('should register session into pairing guard registry when initialized with authMode: pairing_code', async () => {
      const sessionId = 'session-pair-guard-1';

      const meta = await sessionService.initSession(sessionId, 'pairing_code');

      expect(meta.authMode).toBe('pairing_code');
      expect(sessionService.isPairingMode(sessionId)).toBe(true);

      const retrievedMeta = sessionService.getSession(sessionId);
      expect(retrievedMeta).not.toBeNull();
      expect(retrievedMeta?.authMode).toBe('pairing_code');
    });

    it('should suppress QR code events and NOT overwrite active pairing state when Baileys emits QR', async () => {
      const sessionId = 'session-pair-guard-2';

      await sessionService.initSession(sessionId, 'pairing_code');
      expect(sessionService.isPairingMode(sessionId)).toBe(true);

      // Simulate Baileys socket emitting a QR code update
      mockSocketEv.emit('connection.update', {
        qr: '2@FakeQRCodeDataStringFromWhatsApp123456789==,ABCDEF,1,1',
      });

      // Assert QR was suppressed and not stored
      const currentMeta = sessionService.getSession(sessionId);
      expect(currentMeta?.qr).toBeNull();
      expect(currentMeta?.status).not.toBe('qr_ready');
      expect(currentMeta?.authMode).toBe('pairing_code');

      // getQR should return null for pairing_code mode
      const qrValue = await sessionService.getQR(sessionId);
      expect(qrValue).toBeNull();

      // Ensure isPairingMode remained true
      expect(sessionService.isPairingMode(sessionId)).toBe(true);
    });

    it('should allow QR code generation when session is explicitly in qr authMode', async () => {
      const sessionId = 'session-qr-mode-1';

      await sessionService.initSession(sessionId, 'qr');
      expect(sessionService.isPairingMode(sessionId)).toBe(false);

      // Simulate Baileys socket emitting QR code update
      const sampleQr = '2@ValidQRCodeString==,ABC,1,1';
      mockSocketEv.emit('connection.update', {
        qr: sampleQr,
      });

      const currentMeta = sessionService.getSession(sessionId);
      expect(currentMeta?.qr).toBe(sampleQr);
      expect(currentMeta?.status).toBe('qr_ready');
      expect(currentMeta?.authMode).toBe('qr');

      const qrValue = await sessionService.getQR(sessionId);
      expect(qrValue).toBe(sampleQr);
    });
  });

  describe('Purge & Terminating Session Guard', () => {
    it('should suppress auto-reconnect flow when session is marked in terminatingSessions', async () => {
      const sessionId = 'session-term-guard-1';

      await sessionService.initSession(sessionId, 'qr');
      expect(sessionService.getSession(sessionId)).not.toBeNull();

      // Mark session as terminating
      sessionService.markTerminating(sessionId);
      expect(sessionService.isTerminating(sessionId)).toBe(true);

      // Simulate Baileys connection.update with a socket close / disconnect
      mockSocketEv.emit('connection.update', {
        connection: 'close',
        lastDisconnect: {
          error: {
            message: 'Connection Lost',
            output: { statusCode: 408 },
          },
        },
      });

      // Connection update handler should immediately abort, removing socket and meta without reconnecting
      expect(sessionService.getSession(sessionId)).toBeNull();

      // isPairingMode on terminating session returns false
      expect(sessionService.isPairingMode(sessionId)).toBe(false);
    });
  });
});

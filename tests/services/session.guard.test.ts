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
    user: { id: '8801995329555:1@s.whatsapp.net', name: 'Gateway Test' },
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
      connectionReplaced: 440,
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

  describe('Dual-Mode Authentication & Natural QR Emission', () => {
    it('should naturally capture and emit QR code updates for any initialized session', async () => {
      const sessionId = 'session-dual-auth-1';

      const meta = await sessionService.initSession(sessionId);
      expect(meta).not.toBeNull();

      // Simulate Baileys socket emitting a natural QR code update
      const sampleQr = '2@NaturalBaileysQRString123456789==,ABCDEF,1,1';
      mockSocketEv.emit('connection.update', {
        qr: sampleQr,
      });

      // Assert QR was captured in qrCodes and metadata
      expect(sessionService.qrCodes.get(sessionId)).toBe(sampleQr);
      const currentMeta = sessionService.getSession(sessionId);
      expect(currentMeta?.qr).toBe(sampleQr);
      expect(currentMeta?.status).toBe('qr_ready');

      // getQR retrieves the natural QR code
      const qrValue = await sessionService.getQR(sessionId);
      expect(qrValue).toBe(sampleQr);
    });

    it('should request pairing code on-demand from the active socket', async () => {
      const sessionId = 'session-dual-auth-2';

      await sessionService.initSession(sessionId);
      const session = sessionService.getSession(sessionId);
      expect(session?.sock).toBeDefined();

      const pairingCode = await sessionService.requestPairingCode(sessionId, '8801712345678');
      expect(pairingCode).toBeDefined();
      expect(pairingCode.length).toBeGreaterThan(0);
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

    it('should safely handle Stream Errored (conflict) without purging Redis session keys', async () => {
      const sessionId = 'session-conflict-guard-1';

      await sessionService.initSession(sessionId, 'qr');
      expect(sessionService.getSession(sessionId)).not.toBeNull();

      // Simulate Baileys Stream Errored conflict
      mockSocketEv.emit('connection.update', {
        connection: 'close',
        lastDisconnect: {
          error: {
            message: 'Stream Errored (conflict)',
            output: { statusCode: 401 },
          },
        },
      });

      const session = sessionService.getSession(sessionId);
      expect(session?.status).toBe('disconnected');
      expect(session?.sock).toBeUndefined();
      // Verify Redis session clear was not called as a true permanent logout
      const { clearRedisSession } = await import('../../src/adapters/redisAuthState.js');
      expect(clearRedisSession).not.toHaveBeenCalled();
    });
  });
});

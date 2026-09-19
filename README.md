# WhatsApp Gateway Microservice

<p align="center">
  <img src="https://raw.githubusercontent.com/tandpfun/skill-icons/main/icons/TypeScript.svg" width="45" height="45" alt="TypeScript" />
  &nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/tandpfun/skill-icons/main/icons/NodeJS-Dark.svg" width="45" height="45" alt="Node.js" />
  &nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/devicons/devicon/master/icons/fastify/fastify-plain.svg" width="45" height="45" alt="Fastify" />
  &nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/tandpfun/skill-icons/main/icons/Redis-Dark.svg" width="45" height="45" alt="Redis" />
  &nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/tandpfun/skill-icons/main/icons/TailwindCSS-Dark.svg" width="45" height="45" alt="Tailwind CSS" />
</p>

<p align="center">
  <strong>High-performance, decoupled, multi-tenant WhatsApp Web microservice engineered for enterprise SaaS, CRM, and AI orchestration backends.</strong>
</p>

<p align="center">
  <a href="#architecture"><img src="https://img.shields.io/badge/Architecture-Decoupled%20Microservice-blue?style=flat-square" alt="Architecture" /></a>
  <a href="#core-features"><img src="https://img.shields.io/badge/Engine-%40whiskeysockets%2Fbaileys-green?style=flat-square" alt="Baileys Engine" /></a>
  <a href="#anti-ban-guardrails"><img src="https://img.shields.io/badge/Anti--Ban-Human%20Emulation-orange?style=flat-square" alt="Anti-Ban" /></a>
  <a href="#redis-persistence"><img src="https://img.shields.io/badge/Persistence-Redis%20Multi--Tenant-red?style=flat-square" alt="Redis" /></a>
  <a href="#license"><img src="https://img.shields.io/badge/License-MIT-purple?style=flat-square" alt="License" /></a>
</p>

---

## 1. Overview & Value Proposition

**WhatsApp Gateway Microservice** is an enterprise-grade WhatsApp Web communication microservice built on top of Node.js 20+, TypeScript, Fastify, and [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys). It acts as a real-time messaging gateway that bridges multi-tenant WhatsApp interactions directly to downstream AI conversational pipelines, webhooks, and backend systems.

### Key Capabilities
* **Zero Chromium Overhead:** Operates entirely over native binary WebSockets using WhatsApp's Noise Protocol. Zero Puppeteer, zero Playwright, and zero headless browser memory bloat (~35MB RAM footprint vs ~600MB+ per browser session).
* **Multi-Tenant State Segregation:** Isolate multiple tenant WhatsApp numbers within a single daemon. Each tenant maintains isolated cryptographic keys persisted in Redis under the `wa:session:${sessionId}:*` namespace (configurable via `REDIS_PREFIX`).
* **Anti-Ban Guardrails:** Built-in human emulation layer triggers WhatsApp typing indicators (`composing`), randomizes execution jitter (600ms–1400ms), and toggles `paused` state before message dispatch.
* **Carrier-Grade Ingress & Egress:** Inbound messages (text, ephemeral messages, buttons, interactive lists, polls, voice notes, images, PDFs) are normalized, buffered to local media storage, and dispatched to downstream webhooks via asynchronous HTTP POST signed with HMAC-SHA256 (`X-Gateway-Signature-256` / `X-Hub-Signature-256`).

---

## 2. Architecture Diagram

```text
 ┌────────────────┐              ┌────────────────────────────────────────────────────────┐
 │                │              │              WHATSAPP GATEWAY MICROSERVICE             │
 │  WhatsApp Web  │  TLS/Noise   │                                                        │
 │    Servers     │◄────────────►│  ┌──────────────────────────────────────────────────┐  │
 │                │   WebSocket  │  │        Baileys Multi-Tenant Socket Pool          │  │
 └────────────────┘              │  │  [Session 1]        [Session 2]     [Session N]  │  │
                                 │  └────────┬─────────────────┬───────────────┬───────┘  │
                                 │           │                 │               │          │
                                 │           ▼                 ▼               ▼          │
                                 │  ┌──────────────────────────────────────────────────┐  │
                                 │  │   Session Manager (Anti-Ban Jitter & Lifecycle)   │  │
                                 │  └───────┬──────────────────────────┬───────────────┘  │
                                 │          │                          │                  │
                                 │          ▼                          ▼                  │
                                 │  ┌───────────────┐          ┌───────────────┐          │
                                 │  │ Custom Redis  │          │ Inbound Media │          │
                                 │  │ Auth Adapter  │          │ Local Buffer  │          │
                                 │  └───────┬───────┘          └───────┬───────┘          │
                                 │          │                          │                  │
                                 │          ▼                          ▼                  │
                                 │  ┌───────────────┐          ┌───────────────┐          │
                                 │  │ Fastify REST  │          │ Webhook Relayer│          │
                                 │  │  API Engine   │          │ (HMAC-SHA256) │          │
                                 │  └───────┬───────┘          └───────┬───────┘          │
                                 └──────────┼──────────────────────────┼──────────────────┘
                                            │                          │
                 REST Command Calls         │                          │ Signed Webhooks
         (Init, Send, Media, Delete)        │                          │ (X-Gateway-Signature-256)
                                            ▼                          ▼
                                 ┌─────────────────────────────────────────────┐
                                 │         DOWNSTREAM APP / BACKEND            │
                                 │       Webhook Receivers & AI Agents         │
                                 └──────────────────────┬──────────────────────┘
                                                        │
                                                        ▼
                                 ┌─────────────────────────────────────────────┐
                                 │         Distributed Redis Instance          │
                                 │      (wa:session:<tenantId>:creds)          │
                                 └─────────────────────────────────────────────┘
```

---

## 3. Core Features

### 🏢 Multi-Tenant Socket Pool
* Manages an in-memory pool of Baileys `WASocket` connections indexed by `sessionId`.
* Dynamic lifecycle handling: initialization, pairing, reconnection backoff, keep-alive, and explicit eviction.

### 🛡️ Anti-Ban Engine & Human Presence
* Automatic dispatch of WhatsApp presence updates: `composing` for text, `recording` for voice notes (`ptt`).
* Configurable randomized delay curve (600ms – 1400ms) prevents machine-like delivery cadence.
* Graceful `paused` state emission prior to actual packet delivery.

### 🔑 Dual Pairing Mechanisms
* **Real-time QR Code:** Emits raw QR strings, cached in Redis with a 60-second TTL, and accessible as base64 Data URLs via REST API.
* **8-Digit Pairing Code:** Phone number pairing (`ABCD-1234`) for headless devices without access to a camera or QR scanner.

### 💾 Redis Auth Persistence & Resilience
* **Custom `useRedisAuthState`:** High-performance adapter storing credentials, pre-keys, sender keys, and app sync state in Redis using `BufferJSON` serialization.
* **Key Hierarchy:** `${REDIS_PREFIX}${sessionId}:creds` and `${REDIS_PREFIX}${sessionId}:${category}:${id}` (default prefix `wa:session:`).
* **Auto-Reconnection on Boot:** Scans `wa:session:*:creds` on server startup and restores all active sockets in the background without blocking HTTP traffic.
* **Development Fallback:** Seamless in-memory `ioredis-mock` adapter engages automatically if no Redis server is available.

### 📦 Media Processing Pipeline
* Automatically intercepts inbound images, voice notes (`audio/ogg; codecs=opus`), documents, and video.
* Decrypts and buffers media to `./storage/media/`, assigning predictable static URLs accessible via `@fastify/static`.
* Outbound media handler supports remote URLs as well as binary fallback uploads.

### 🔒 Cryptographic Webhooks
* Inbound WhatsApp messages are posted asynchronously to your configured webhook URL.
* Every HTTP POST contains `X-Gateway-Signature-256` (hex HMAC-SHA256) and `X-Hub-Signature-256` (`sha256=<hex>`) computed using `WEBHOOK_SECRET`.

### 📱 Developer Diagnostic Console
* Bundled single-page dashboard styled with Tailwind CSS.
* Real-time tenant switcher, QR code modal, pairing code generator, message sender, and live streaming event monitor.

---

## 4. Project Structure

```text
.
├── storage/
│   └── media/                   # Static binary cache for inbound/outbound media
├── src/
│   ├── auth/
│   │   └── redisAuthState.ts    # Custom Baileys Redis adapter (BufferJSON reviver/replacer)
│   ├── manager/
│   │   └── sessionManager.ts    # Multi-tenant WASocket pool, anti-ban jitter, webhook dispatcher
│   ├── routes/
│   │   ├── api.routes.ts        # REST API endpoints (/sessions, /messages, /system, etc.)
│   │   ├── sessionRoutes.ts     # Session endpoints (/init, /qr, /pair-code, /send, /purge)
│   │   └── ui.routes.ts         # Dashboard UI server
│   ├── types/
│   │   └── index.ts             # TypeScript types, payloads, and response interfaces
│   ├── views/
│   │   └── dashboard.html       # Diagnostic operations console (Tailwind CSS)
│   ├── config/
│   │   ├── env.ts               # Environment schema and config parser
│   │   └── redis.ts             # Redis client and mock connection
│   └── server.ts                # Fastify bootstrap, static file serving, and graceful shutdown
├── .env.example                 # Environment configuration template
├── package.json                 # Project manifest & dependencies
├── tsconfig.json                # TypeScript compiler configuration
└── README.md                    # Technical documentation
```

---

## 5. Prerequisites & Quickstart

### Prerequisites
* **Node.js:** `v20.x` or `v22.x` (LTS recommended)
* **Package Manager:** `npm` (v10+), `pnpm` (v9+), or `bun`
* **Redis:** `v6.2+` or `v7.x` (Standalone or AWS ElastiCache / Redis Cloud)

### Step-by-Step Installation

1. **Clone the Repository:**
   ```bash
   git clone https://github.com/your-org/whatsapp-gateway.git
   cd whatsapp-gateway
   ```

2. **Install Dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your favorite editor
   nano .env
   ```

4. **Run in Development Mode:**
   ```bash
   npm run dev
   ```
   *The gateway will boot on `http://0.0.0.0:3000` with hot-reload enabled via `tsx`.*

5. **Build for Production:**
   ```bash
   npm run build
   npm start
   ```

---

## 6. Environment Variables

All configuration is parsed in `src/config/env.ts` with strict validation:

| Variable | Type | Default | Description |
| :--- | :---: | :--- | :--- |
| `PORT` | `number` | `3000` | Port for the Fastify HTTP gateway server. |
| `HOST` | `string` | `0.0.0.0` | Network binding host address (`0.0.0.0` for Docker/K8s). |
| `PUBLIC_URL` | `string` | `http://127.0.0.1:3000` | Canonical external URL used when constructing media download links. |
| `GATEWAY_API_KEY` | `string` | `gateway-secret-token` | Master API Key for authenticated REST API calls (`X-API-Key` or Bearer token). |
| `REDIS_URL` | `string` | `redis://127.0.0.1:6379` | Connection URI for the Redis persistence cluster. |
| `REDIS_PREFIX` | `string` | `wa:session:` | Key prefix for session storage in Redis. |
| `USE_MOCK_REDIS` | `boolean` | `false` | When set to `true`, forces in-memory Redis mock (useful for sandboxes/CI). |
| `WEBHOOK_URL` | `string` | `http://127.0.0.1:8000/api/whatsapp/webhook` | Downstream endpoint for inbound message forwarding. |
| `WEBHOOK_SECRET` | `string` | `your_hmac_secret_here` | Shared secret used to sign inbound webhook dispatches with HMAC-SHA256. |
| `LOG_LEVEL` | `string` | `info` | Pino logging level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`). |

---

## 7. REST API Reference

All REST endpoints reside under the `/api` prefix and return JSON.

### 7.1 Health & Diagnostics
#### `GET /api/health`
Returns service uptime, Redis operational status, and active session count.

```bash
curl -X GET http://localhost:3000/api/health
```

**Response (`200 OK`):**
```json
{
  "status": "ok",
  "service": "whatsapp-gateway",
  "version": "1.0.0",
  "uptimeSeconds": 3412,
  "timestamp": "2026-09-18T16:20:00.000Z",
  "publicBaseUrl": "http://127.0.0.1:3000",
  "redis": "connected-redis",
  "webhookUrl": "http://127.0.0.1:8000/api/whatsapp/webhook",
  "activeSessions": 3
}
```

---

### 7.2 Session Lifecycle

#### `POST /api/sessions/:id/init`
Initializes a new or restores an existing WhatsApp socket for the given tenant `:id`.

```bash
curl -X POST http://localhost:3000/api/sessions/tenant-001/init \
  -H "X-API-Key: gateway-secret-token"
```

**Response (`200 OK`):**
```json
{
  "success": true,
  "sessionId": "tenant-001",
  "status": "qr_ready",
  "message": "Session socket initialized; waiting for QR scan or connection",
  "qr": "2@4hG8...==,WkL...==,..."
}
```

---

#### `GET /api/sessions/:id/qr`
Retrieves the raw QR code string and rendered base64 PNG data URL for scanning.

```bash
curl -X GET http://localhost:3000/api/sessions/tenant-001/qr \
  -H "X-API-Key: gateway-secret-token"
```

**Response (`200 OK`):**
```json
{
  "sessionId": "tenant-001",
  "qr": "2@4hG8...==",
  "status": "qr_ready",
  "qrDataUrl": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
  "message": "Scan this QR code with WhatsApp"
}
```

---

#### `POST /api/sessions/:id/pair-code`
Generates an 8-character pairing code for linking a WhatsApp device via telephone number.

```bash
curl -X POST http://localhost:3000/api/sessions/tenant-001/pair-code \
  -H "Content-Type: application/json" \
  -H "X-API-Key: gateway-secret-token" \
  -d '{
    "phoneNumber": "8801712345678"
  }'
```

**Response (`200 OK`):**
```json
{
  "success": true,
  "sessionId": "tenant-001",
  "code": "CC4X-89AB",
  "message": "Pairing code generated. Enter this code in WhatsApp > Linked Devices > Link with phone number."
}
```

---

#### `DELETE /api/sessions/:id`
Terminates the active socket, removes it from memory, and completely purges all associated keys (`wa:session:tenant-001:*`) from Redis.

```bash
curl -X DELETE http://localhost:3000/api/sessions/tenant-001 \
  -H "X-API-Key: gateway-secret-token"
```

**Response (`200 OK`):**
```json
{
  "success": true,
  "sessionId": "tenant-001",
  "message": "Session 'tenant-001' disconnected and purged from Redis and memory."
}
```

---

### 7.3 Message Dispatch (Outbound)

#### `POST /api/sessions/:id/send`
Dispatches an outbound text message with anti-ban human presence simulation.

```bash
curl -X POST http://localhost:3000/api/sessions/tenant-001/send \
  -H "Content-Type: application/json" \
  -H "X-API-Key: gateway-secret-token" \
  -d '{
    "jid": "1234567890@s.whatsapp.net",
    "text": "Hello from WhatsApp Gateway! How can we assist you today?"
  }'
```

**Response (`200 OK`):**
```json
{
  "success": true,
  "sessionId": "tenant-001",
  "jid": "1234567890@s.whatsapp.net",
  "messageId": "3EB0B3F11C82D3D09F1A",
  "timestamp": 1789771200000
}
```

---

#### `POST /api/sessions/:id/send-media`
Dispatches images, documents, audio clips, or voice notes (`ptt`).

```bash
curl -X POST http://localhost:3000/api/sessions/tenant-001/send-media \
  -H "Content-Type: application/json" \
  -H "X-API-Key: gateway-secret-token" \
  -d '{
    "jid": "1234567890@s.whatsapp.net",
    "type": "image",
    "url": "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe",
    "caption": "Your monthly analytics summary"
  }'
```

**Response (`200 OK`):**
```json
{
  "success": true,
  "sessionId": "tenant-001",
  "jid": "1234567890@s.whatsapp.net",
  "type": "image",
  "messageId": "3EB01B05AE5417032D55",
  "timestamp": 1789771204000
}
```

---

## 8. Webhook Specification & HMAC Verification

When an inbound message is received, the gateway compiles a standardized payload and sends an asynchronous HTTP POST request to `WEBHOOK_URL`.

### Inbound Payload Schema

```json
{
  "sessionId": "tenant-001",
  "message": {
    "key": {
      "remoteJid": "1234567890@s.whatsapp.net",
      "fromMe": false,
      "id": "3EB060A1F67AA227BBE1"
    },
    "pushName": "John Doe",
    "text": "Please book an appointment for tomorrow at 3pm",
    "media": {
      "type": "image",
      "mimetype": "image/jpeg",
      "fileSize": 245190,
      "caption": "Referral letter scan",
      "filename": "scan_104.jpg",
      "url": "http://127.0.0.1:3000/media/tenant-001_3EB060A1F67AA227BBE1.jpg"
    },
    "raw": {
      "key": { "...": "..." },
      "messageTimestamp": 1789771100
    }
  }
}
```

### Signature Headers Sent
* `X-Gateway-Signature-256`: Raw hex-encoded HMAC-SHA256 digest of the request body.
* `X-Hub-Signature-256`: `sha256=<hex_digest>` (standard webhook convention).

---

### Verification Code Samples

#### Node.js / Express Receiver

```typescript
import crypto from 'crypto';
import express from 'express';

const app = express();
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'your_hmac_secret_here';

app.post(
  '/api/whatsapp/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const signature = req.headers['x-gateway-signature-256'] as string;
    const rawBody = req.body.toString('utf-8');

    const expected = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature || '', 'hex'), Buffer.from(expected, 'hex'))) {
      return res.status(401).json({ error: 'Signature mismatch' });
    }

    const payload = JSON.parse(rawBody);
    console.log(`[Gateway] Inbound message from tenant: ${payload.sessionId}`);
    
    return res.status(200).json({ success: true });
  }
);
```

#### PHP Receiver

```php
<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpKernel\Exception\UnauthorizedHttpException;

class VerifyWhatsAppGatewaySignature
{
    public function handle(Request $request, Closure $next)
    {
        $signature = $request->header('X-Gateway-Signature-256');
        $secret = config('services.whatsapp_gateway.secret');

        if (!$signature || !$secret) {
            throw new UnauthorizedHttpException('Missing signature or gateway secret');
        }

        $computed = hash_hmac('sha256', $request->getContent(), $secret);

        if (!hash_equals($computed, $signature)) {
            throw new UnauthorizedHttpException('Invalid HMAC signature');
        }

        return $next($request);
    }
}
```

---

## 9. Production Deployment & PM2

### ⚠️ Critical Concurrency Notice: Single-Instance Worker
> **DO NOT deploy this service in PM2 Cluster Mode (`-i max`) or multi-replica auto-scaling groups without tenant sticky routing.**
>
> WhatsApp Web uses a stateful, cryptographic handshake (Noise Protocol) with strict sequence ordering. If two processes attempt to read or write to the same `wa:session:${sessionId}:*` Redis keys simultaneously, WhatsApp will invalidate the encryption keys, resulting in **Error 401: Logged Out** or immediate tenant number bans.
>
> **Recommended Architecture:** Run as a dedicated single-instance process (`-i 1`) with vertical scaling. A single Node.js process comfortably handles 150+ concurrent active WhatsApp sockets.

### PM2 Configuration (`ecosystem.config.cjs`)

```javascript
module.exports = {
  apps: [
    {
      name: 'whatsapp-gateway',
      script: './dist/server.cjs',
      instances: 1,              // MUST BE 1 to avoid socket collisions
      exec_mode: 'fork',         // Single fork mode
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOST: '0.0.0.0',
        LOG_LEVEL: 'info',
      },
    },
  ],
};
```

**Starting PM2 in Production:**
```bash
# 1. Compile the production bundle
npm run build

# 2. Launch single-process worker
pm2 start ecosystem.config.cjs --env production

# 3. Persist across server reboots
pm2 save
pm2 startup
```

### Docker Deployment

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src
COPY public/ ./public
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/views ./src/views
RUN mkdir -p storage/media

EXPOSE 3000
CMD ["node", "dist/server.cjs"]
```

---

## 10. Troubleshooting & FAQ

### Q: Why did the session status change to `logged_out` (401)?
* The user opened WhatsApp on their phone and manually unlinked the device under **Linked Devices**.
* Another instance or script attempted to connect using the same credentials simultaneously.
* *Remedy:* Call `DELETE /api/sessions/:id` to flush stale keys, then call `POST /api/sessions/:id/init` to generate a fresh QR or pairing code.

### Q: Why did my message fail to send?
* Ensure the target `jid` is properly formatted (e.g., `8801712345678@s.whatsapp.net`). The gateway automatically appends `@s.whatsapp.net` if omitted.
* Check if the session status is `connected`. If the phone is powered off or disconnected from the internet, Baileys will buffer packets until connection is re-established.

### Q: How are ephemeral and view-once messages handled?
* The gateway's `detectInboundMedia` recursively unwraps `ephemeralMessage`, `viewOnceMessage`, `viewOnceMessageV2`, and `documentWithCaptionMessage` envelopes, ensuring zero dropped media payloads.

---

## 11. Disclaimer & Compliance

* **WhatsApp TOS Compliance:** This software is an independent engineering project and is not affiliated, associated, authorized, endorsed by, or in any way officially connected with WhatsApp Inc., Meta Platforms, Inc., or any of their subsidiaries or affiliates.
* **Intended Use:** This microservice is engineered for legitimate customer support, business operational notifications, and conversational AI automation. Automated mass spamming, unsolicited promotional broadcasts, or harassment strictly violates WhatsApp's Terms of Service and will result in permanent telephone number bans.
* **Security:** Cryptographic keys stored in Redis give full access to read and send messages from the connected WhatsApp account. Ensure your Redis cluster is secured inside a private VPC with strong authentication credentials enabled.

---

## 12. License

This project is licensed under the [MIT License](LICENSE).
Copyright (c) 2026 WhatsApp Gateway Contributors. All rights reserved.

import Schema from '@deepseek-ai/schemastery'
import {
  DEFAULT_HEADERS_TIMEOUT_MS,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
} from './limits.ts'

export {
  DEFAULT_HEADERS_TIMEOUT_MS,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
} from './limits.ts'

/** Public Schemastery schema for the reverse-proxy plugin. */
export const Config = Schema.object({
  listenHost: Schema.string().default('127.0.0.1').description('Default bind address. 0.0.0.0 / :: bind every interface but are not copyable destinations — the panel reports a reachable address separately. Prefer a concrete LAN IP for phone-on-WiFi. The UI can override this at runtime.'),
  listenPort: Schema.number().min(0).max(65535).default(3081).description('Default local tunnel target port; 0 chooses a free port; the UI can override it at runtime.'),
  backendHost: Schema.string().default('127.0.0.1').description('DeepSeek Harness Web backend host. Must be a loopback address, not a wildcard (0.0.0.0 / ::). TCP connects here; Host/Origin rewrite always uses 127.0.0.1 regardless.'),
  backendPort: Schema.number().min(0).max(65535).default(0).description('DeepSeek Harness Web backend port; 0 follows webServer.port.'),
  cloudflaredPath: Schema.string().default('').description('Optional explicit path to a cloudflared binary for the one-click quick tunnel. When empty the tunnel resolves the binary via PATH, then a pinned, SHA256-verified download cache under the state file directory.'),
  stateFile: Schema.string().default('').description('Durable state file; empty uses $DSH_HOME/reverse-proxy.json.'),
  autoRestore: Schema.boolean().default(true).description('Restore the last enabled state after DeepSeek Harness restarts.'),
  maxRequestBytes: Schema.number().min(1024).default(DEFAULT_MAX_REQUEST_BYTES).description('Maximum request body size. Default 160 MiB matches the Harness /api bridge so remote vision image RPCs (DeepSeek-V4-Flash-Vision-Exp) are not 413d before the backend.'),
  upstreamTimeoutMs: Schema.number().min(1000).default(DEFAULT_UPSTREAM_TIMEOUT_MS).description('Timeout while connecting TCP to the DeepSeek Harness backend, and (for POST/PUT/etc.) waiting for the first response byte after the client finishes sending the body. Does not cover body transfer itself, and is not applied to GET/HEAD (SSE).'),
  sessionMaxAgeSeconds: Schema.number().min(60).default(30 * 24 * 3600).description('Absolute lifetime of a device session from creation (and legacy idle window when sessionIdleSeconds is 0).'),
  sessionIdleSeconds: Schema.number().min(0).default(0).description('Inactivity timeout in seconds (0 = disabled; uses lastSeenAt). When set, sessions expire after this idle window independently of sessionMaxAgeSeconds.'),
  cookieName: Schema.string().default('dsh_reverse_proxy_session').description('Authentication session cookie name.'),
  maxHeaderSizeBytes: Schema.number().min(1024).default(16 * 1024).description('Maximum HTTP header size accepted by the proxy.'),
  headersTimeoutMs: Schema.number().min(1000).default(DEFAULT_HEADERS_TIMEOUT_MS).description('Timeout for a client to send a complete request head. Must not exceed requestTimeoutMs.'),
  requestTimeoutMs: Schema.number().min(1000).default(DEFAULT_REQUEST_TIMEOUT_MS).description('Timeout for a complete request (headers plus body) accepted by the proxy. The effective request timeout is at least headersTimeoutMs. Default 5 minutes covers large remote vision uploads.'),
  keepAliveTimeoutMs: Schema.number().min(1000).default(5_000).description('Keep-alive timeout for idle proxy connections.'),
  loginDelayMs: Schema.number().min(0).max(10_000).default(250).description('Fixed delay after a failed login, slowing token guessing.'),
  loginMaxAttempts: Schema.number().min(1).default(5).description('Failed login attempts per remote IP before that IP is locked out.'),
  loginLockoutSeconds: Schema.number().min(10).default(300).description('Lockout duration for a remote IP that exceeded loginMaxAttempts.'),
  upgradeMaxAttempts: Schema.number().min(1).default(10).description('Failed WebSocket upgrade attempts per remote IP before that IP is locked out.'),
  upgradeLockoutSeconds: Schema.number().min(10).default(300).description('Lockout duration for a remote IP that exceeded upgradeMaxAttempts.'),
  approvalMode: Schema.boolean().default(false).description('Require local approval for every new device before it can reach DeepSeek Harness.'),
  maxSessions: Schema.number().min(1).max(64).default(16).description('Maximum concurrent device sessions; the stalest session is evicted past this cap.'),
  logRequests: Schema.boolean().default(false).description('Log every proxied request at debug level.'),
  auditLog: Schema.boolean().default(true).description('Append structured JSONL audit events (login, approve, revoke, rotate, token reveal) next to the state file.'),
  auditLogFile: Schema.string().default('').description('Audit JSONL path; empty uses <stateFile without .json>.audit.jsonl.'),
  allowedCidrs: Schema.array(Schema.string()).default([]).description('Optional remote IP allowlist (CIDR or bare IP). Empty = allow all authenticated clients. Loopback is always allowed.'),
  allowTokenRead: Schema.boolean().default(false).description('When true, GET /token reveals the standing access token over loopback. Keep false unless local tooling requires token re-read; rotate-token always returns the replacement token.'),
  tlsCertFile: Schema.string().default('').description('Optional PEM certificate path for local TLS on the proxy listen port (pair with tlsKeyFile). Empty = plain HTTP.'),
  tlsKeyFile: Schema.string().default('').description('Optional PEM private key path for local TLS (pair with tlsCertFile).'),
  trustForwardedProto: Schema.boolean().default(false).description('When true, trust inbound X-Forwarded-Proto from a reverse-edge for Secure cookies and upstream proto. Leave false unless a trusted TLS terminator sits in front.'),
  trustForwardedFor: Schema.boolean().default(false).description('When true and the direct peer is loopback, derive the remote client IP for CIDR / rate limiting / audit from the rightmost X-Forwarded-For value (loopback and malformed values are never trusted). Only enable behind a trusted local tunnel/edge that appends this header; do not enable for LAN direct access.'),
  trustCloudflareConnectingIp: Schema.boolean().default(false).description('When true and the direct peer is loopback, also trust Cloudflare\'s CF-Connecting-IP header. Enable only for a local Cloudflare connector; other tunnels can relay a client-supplied CF header unchanged.'),
  compressResponses: Schema.boolean().default(true).description('When true, gzip compressible HTTP responses (HTML/JS/CSS/JSON/SVG) for clients that send Accept-Encoding: gzip. SSE, WebSocket, fonts, already-encoded bodies, and responses under 1 KB are not compressed.'),
  cacheHashedAssets: Schema.boolean().default(true).description('When true, add Cache-Control: public, max-age=31536000, immutable on successful hashed /assets/* responses that have no upstream cache header. index.html and /api are never cached.'),
})

/** Validated plugin config: every field carries its Schema default. */
export type RuntimeConfig = ReturnType<typeof Config>

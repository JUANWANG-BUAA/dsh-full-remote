/**
 * Proxy transport defaults aligned with DeepSeek Harness Web `/api`.
 *
 * The reverse proxy sits in front of the connection bridge, which buffers
 * each RPC body in memory. Harness sizes that cap for the default 100 MiB
 * aggregate image limit after base64 expansion plus envelope headroom
 * (`DEFAULT_MAX_REQUEST_BODY_BYTES` = 160 MiB in
 * `@deepseek-ai/dsh-client-connection`). A tighter plugin cap 413s remote
 * `session.prompt` bodies that carry DeepSeek-V4-Flash-Vision-Exp images
 * before Harness ever sees them.
 */

/** Match the Harness `/api` bridge default (160 MiB). */
export const DEFAULT_MAX_REQUEST_BYTES = 160 * 1024 * 1024

/**
 * Time for a remote client to finish sending headers plus body.
 * Node 18+ uses five minutes; vision RPCs over a phone tunnel need that
 * window more than the previous 120 s default.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000

/** TCP connect, and first POST byte after the client finishes sending. */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 15_000

/** Time for a client to finish sending the request head. */
export const DEFAULT_HEADERS_TIMEOUT_MS = 15_000

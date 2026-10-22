import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { describe, it, type TestContext } from 'node:test'
import { listenProxy } from '../src/proxy.ts'
import { createSessionStore, encodeSessionCookie } from '../src/sessions.ts'

/** Collect before waiting so handshake heads and immediately forwarded bytes cannot race assertions. */
function observe(stream: IncomingMessage | Duplex) {
  const events = new EventEmitter()
  let text = ''
  let closed = stream.destroyed
  stream.on('data', (chunk: Buffer) => { text += chunk.toString(); events.emit('change') })
  stream.on('close', () => { closed = true; events.emit('change') })
  stream.on('error', () => {})
  const until = (predicate: () => boolean) => new Promise<void>((resolve, reject) => {
    const done = () => {
      if (!predicate()) return
      clearTimeout(timer)
      events.off('change', done)
      resolve()
    }
    const timer = setTimeout(() => {
      events.off('change', done)
      reject(new Error('stream observation timed out: ' + text))
    }, 2500)
    events.on('change', done)
    done()
  })
  return { text: () => text, contains: (value: string) => until(() => text.includes(value)), closed: () => until(() => closed) }
}

async function fixture(t: TestContext, options: { maxAgeSeconds?: number, upgradeHead?: string } = {}) {
  let at = 0
  let response: ServerResponse | undefined
  let responseObservation: ReturnType<typeof observe> | undefined
  let peer: Duplex | undefined
  let peerObservation: ReturnType<typeof observe> | undefined
  const clients = new Set<Socket | IncomingMessage>()
  const backendSockets = new Set<Socket>()
  const store = createSessionStore({ maxAgeSeconds: options.maxAgeSeconds ?? 60, idleSeconds: 1, now: () => at })
  const session = store.login({ userAgent: 'StreamTest' })
  const cookieValue = encodeSessionCookie(session.id, session.secret)
  const cookie = 'session=' + cookieValue
  const backend = createServer((_req, res) => {
    response = res
    assert.ok(res.socket)
    responseObservation = observe(res.socket)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    res.write('data: initial\n\n')
  })
  backend.on('connection', socket => {
    backendSockets.add(socket)
    socket.on('close', () => backendSockets.delete(socket))
  })
  backend.on('upgrade', (_req, socket, head) => {
    peer = socket
    peerObservation = observe(socket)
    // Upgraded server sockets are half-open: finish the peer after proxy FIN.
    socket.once('end', () => socket.end())
    // A coalesced inbound handshake body is already consumed from the stream.
    if (head.length > 0) socket.emit('data', head)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n' + (options.upgradeHead ?? ''))
  })
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
  const address = backend.address()
  assert.ok(address && typeof address !== 'string')
  t.after(async () => {
    for (const client of clients) client.destroy()
    for (const socket of backendSockets) socket.destroy()
    backend.closeAllConnections()
    await new Promise<void>(resolve => backend.close(() => resolve()))
  })
  const proxy = await listenProxy({
    listenHost: '127.0.0.1', listenPort: 0, backendHost: '127.0.0.1', backendPort: address.port,
    accessToken: 'x'.repeat(32), cookieName: 'session', controlPrefix: '/control',
    maxRequestBytes: 1024, upstreamTimeoutMs: 2000, sessionStore: store,
    cacheHashedAssets: false, compressResponses: false,
  })
  t.after(proxy.close)
  return {
    store, session, proxy, cookieValue,
    advance(value: number) { at = value },
    emit(value: string) { assert.ok(response); response.write('data: ' + value + '\n\n') },
    httpPeerObservation() { assert.ok(responseObservation); return responseObservation },
    peer() { assert.ok(peer); return peer },
    peerObservation() { assert.ok(peerObservation); return peerObservation },
    async sse() {
      const req = request({ hostname: '127.0.0.1', port: proxy.port, path: '/events', headers: { cookie } })
      req.on('error', () => {})
      const res = await new Promise<IncomingMessage>((resolve, reject) => {
        req.once('response', resolve)
        req.once('error', reject)
        req.end()
      })
      clients.add(res)
      const observation = observe(res)
      await observation.contains('data: initial')
      return observation
    },
    async ws(head = '') {
      const socket = connect(proxy.port, '127.0.0.1')
      clients.add(socket)
      const observation = observe(socket)
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
      socket.write('GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: ' + cookie + '\r\n\r\n' + head)
      await observation.contains('101 Switching Protocols')
      return { socket, observation }
    },
  }
}

describe('proxy stream session activity', { timeout: 10000 }, () => {
  it('keeps SSE byte activity alive through repeated idle windows and persistence sweeps', async t => {
    const h = await fixture(t)
    const stream = await h.sse()
    for (const at of [800, 1600, 2400]) {
      h.advance(at)
      h.emit(String(at))
      await stream.contains('data: ' + at)
      assert.equal(h.store.list()[0].lastSeenAt, at)
      assert.equal(h.store.serialize()[0].lastSeenAt, at)
    }
  })

  it('closes quiet SSE on the expiry timer without manufacturing activity', async t => {
    const h = await fixture(t)
    const stream = await h.sse()
    h.advance(1001)
    await Promise.all([stream.closed(), h.httpPeerObservation().closed()])
    assert.equal(h.store.isActive(h.cookieValue), false)
  })

  it('rejects an SSE byte immediately beyond absolute TTL despite recent activity', async t => {
    const h = await fixture(t, { maxAgeSeconds: 2 })
    const stream = await h.sse()
    for (const at of [800, 1600]) {
      h.advance(at); h.emit(String(at)); await stream.contains('data: ' + at)
    }
    h.advance(2001); h.emit('expired')
    await stream.closed()
    assert.equal(stream.text().includes('data: expired'), false)
    assert.equal(h.store.isActive(h.cookieValue), false)
  })

  it('does not let SSE bytes reuse a rotated credential generation', async t => {
    const h = await fixture(t)
    const stream = await h.sse()
    h.store.reissue(h.session.id)
    h.emit('old-secret')
    await stream.closed()
    assert.equal(stream.text().includes('old-secret'), false)
  })

  it('tears down a revoked SSE session explicitly', async t => {
    const h = await fixture(t)
    const stream = await h.sse()
    h.store.revoke(h.session.id)
    h.proxy.closeSession(h.session.id)
    await stream.closed()
  })

  it('counts client-to-upstream WS bytes as activity across idle windows', async t => {
    const h = await fixture(t)
    const { socket } = await h.ws()
    for (const at of [800, 1600, 2400]) {
      h.advance(at); socket.write('client-' + at)
      await h.peerObservation().contains('client-' + at)
      assert.equal(h.store.serialize()[0].lastSeenAt, at)
    }
  })

  it('counts upstream-to-client WS bytes as activity across idle windows', async t => {
    const h = await fixture(t)
    const { observation } = await h.ws()
    for (const at of [800, 1600, 2400]) {
      h.advance(at); h.peer().write('server-' + at)
      await observation.contains('server-' + at)
      assert.equal(h.store.serialize()[0].lastSeenAt, at)
    }
  })

  it('forwards coalesced WS handshake heads in both directions', async t => {
    const h = await fixture(t, { upgradeHead: 'upstream-head' })
    const { observation } = await h.ws('client-head')
    await observation.contains('upstream-head')
    await h.peerObservation().contains('client-head')
    assert.equal(h.store.isActive(h.cookieValue), true)
  })

  it('closes the detached upstream WS socket when its device is revoked', async t => {
    const h = await fixture(t)
    const { observation } = await h.ws()
    h.store.revoke(h.session.id)
    h.proxy.closeSession(h.session.id)
    await Promise.all([observation.closed(), h.peerObservation().closed()])
    assert.equal(h.peer().destroyed, true)
  })

  it('expires a quiet WS on the timer and closes both ends', async t => {
    const h = await fixture(t)
    const { observation } = await h.ws()
    h.advance(1001)
    await Promise.all([observation.closed(), h.peerObservation().closed()])
    assert.equal(h.store.isActive(h.cookieValue), false)
  })
})

// Plan 11.1.4 (spec §10.2–10.7): the protocol client as a state machine
// over a scripted socket — no DOM, no browser, no host. Each test is a
// wire transcript: what the client sends, what the host answers, what
// the client reports. The socket is a fake with the four methods the
// client uses, so the tests pin the PROTOCOL, not a WebSocket library.

import { describe, expect, it } from 'vitest'
import { CabraClient, type SocketFactory, type SocketLike } from './client'

class FakeSocket implements SocketLike {
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((text: string) => void) | null = null
  onclose: (() => void) | null = null
  closed = false
  send(text: string) {
    this.sent.push(text)
  }
  close() {
    this.closed = true
    this.onclose?.()
  }
  // Test side.
  open() {
    this.onopen?.()
  }
  reply(obj: unknown) {
    this.onmessage?.(JSON.stringify(obj))
  }
  drop() {
    this.closed = true
    this.onclose?.()
  }
  last(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1]) as Record<string, unknown>
  }
  lastOp(op: string): Record<string, unknown> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const o = JSON.parse(this.sent[i]) as Record<string, unknown>
      if (o.op === op) return o
    }
    return undefined
  }
}

function harness(opts: { reconnectDelayMs?: number } = {}) {
  const sockets: FakeSocket[] = []
  const factory: SocketFactory = () => {
    const s = new FakeSocket()
    sockets.push(s)
    return s
  }
  const client = new CabraClient({
    url: 'ws://127.0.0.1:8850/ws',
    token: 'sesame',
    socketFactory: factory,
    reconnectDelayMs: opts.reconnectDelayMs ?? 0,
  })
  return { client, sockets, sock: () => sockets[sockets.length - 1] }
}

async function tick() {
  await new Promise((r) => setTimeout(r, 0))
}

describe('connect + auth', () => {
  it('sends auth first and nothing else until authed (§10.3, §5.5.1)', async () => {
    const h = harness()
    const p = h.client.connect()
    h.sock().open()
    expect(h.sock().sent.length).toBe(1)
    expect(h.sock().last()).toEqual({ op: 'auth', token: 'sesame' })
    h.sock().reply({ authed: true })
    await p
    expect(h.client.state).toBe('ready')
  })

  it('reports a rejected token as rejected, not as a connection failure', async () => {
    const h = harness()
    const p = h.client.connect()
    h.sock().open()
    // The host closes an unauthed connection before any answer (7.1.4).
    h.sock().drop()
    await expect(p).rejects.toThrow(/token/)
    expect(h.client.state).toBe('rejected')
  })

  it('no host at the address is its own message, not a token rejection', async () => {
    const h = harness()
    const p = h.client.connect()
    h.sock().drop() // never opened
    await expect(p).rejects.toThrow(/no host/)
  })
})

describe('sessions and turns', () => {
  async function ready() {
    const h = harness()
    const p = h.client.connect()
    h.sock().open()
    h.sock().reply({ authed: true })
    await p
    return h
  }

  it('opens a session, then streams chunks and done with usage', async () => {
    const h = await ready()
    const sp = h.client.openSession()
    const openReq = h.sock().last()
    expect(openReq.op).toBe('open')
    h.sock().reply({ id: openReq.id, session: 42 })
    expect(await sp).toBe(42)

    const chunks: string[] = []
    let finish = ''
    let usage: unknown = null
    const turn = h.client.chat(42, [{ role: 'user', content: 'hi' }], { temp: 0, n: 8 }, {
      onChunk: (t) => chunks.push(t),
      onDone: (f, u) => {
        finish = f
        usage = u
      },
      onError: () => {},
      onDiag: () => {},
    })
    const req = h.sock().last()
    expect(req.op).toBe('chat')
    expect(req.session).toBe(42)
    expect(req.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(req.temp).toBe(0)
    expect(req.n).toBe(8)
    expect(req.diag).toBeUndefined()
    h.sock().reply({ id: turn.id, chunk: 'hel' })
    h.sock().reply({ id: turn.id, chunk: 'lo' })
    h.sock().reply({
      id: turn.id,
      done: true,
      finish: 'eos',
      usage: { prompt_tokens: 3, gen_tokens: 2, prefill_ms: 1, decode_ms: 2 },
    })
    expect(chunks).toEqual(['hel', 'lo'])
    expect(finish).toBe('eos')
    expect(usage).toEqual({ prompt_tokens: 3, gen_tokens: 2, prefill_ms: 1, decode_ms: 2 })
    expect(turn.done).toBe(true)
  })

  it('keeps two sessions on one socket apart by id (§10.7)', async () => {
    const h = await ready()
    const a: string[] = []
    const b: string[] = []
    const ta = h.client.chat(1, [{ role: 'user', content: 'a' }], {}, {
      onChunk: (t) => a.push(t),
      onDone: () => {},
      onError: () => {},
      onDiag: () => {},
    })
    const tb = h.client.chat(2, [{ role: 'user', content: 'b' }], {}, {
      onChunk: (t) => b.push(t),
      onDone: () => {},
      onError: () => {},
      onDiag: () => {},
    })
    expect(ta.id).not.toBe(tb.id)
    h.sock().reply({ id: tb.id, chunk: 'B1' })
    h.sock().reply({ id: ta.id, chunk: 'A1' })
    h.sock().reply({ id: tb.id, chunk: 'B2' })
    expect(a).toEqual(['A1'])
    expect(b).toEqual(['B1', 'B2'])
  })

  it('cancel sends the op and the turn ends with finish cancel (§10.5)', async () => {
    const h = await ready()
    let finish = ''
    const t = h.client.chat(1, [{ role: 'user', content: 'x' }], {}, {
      onChunk: () => {},
      onDone: (f) => {
        finish = f
      },
      onError: () => {},
      onDiag: () => {},
    })
    h.sock().reply({ id: t.id, chunk: 'par' })
    t.cancel()
    expect(h.sock().last()).toEqual({ op: 'cancel', id: t.id })
    h.sock().reply({ id: t.id, done: true, finish: 'cancel', usage: { gen_tokens: 1 } })
    expect(finish).toBe('cancel')
  })

  it('an error before any chunk is an error; after chunks it is a terminating finish (§4.4)', async () => {
    const h = await ready()
    let err = ''
    let finish = ''
    const t = h.client.chat(1, [{ role: 'user', content: 'x' }], {}, {
      onChunk: () => {},
      onDone: (f) => {
        finish = f
      },
      onError: (m) => {
        err = m
      },
      onDiag: () => {},
    })
    h.sock().reply({ id: t.id, error: 'this model ships no chat template', kind: 'bad_request' })
    expect(err).toMatch(/template/)
    expect(t.done).toBe(true)
    const t2 = h.client.chat(1, [{ role: 'user', content: 'y' }], {}, {
      onChunk: () => {},
      onDone: (f) => {
        finish = f
      },
      onError: () => {},
      onDiag: () => {},
    })
    h.sock().reply({ id: t2.id, chunk: 'half' })
    h.sock().reply({ id: t2.id, done: true, finish: 'error' })
    expect(finish).toBe('error')
  })

  it('asks for diag only when told to, and routes diag lines to the turn (§10.9)', async () => {
    const h = await ready()
    const diags: unknown[] = []
    const t = h.client.chat(1, [{ role: 'user', content: 'x' }], { diag: true }, {
      onChunk: () => {},
      onDone: () => {},
      onError: () => {},
      onDiag: (d) => diags.push(d),
    })
    expect(h.sock().last().diag).toBe(true)
    h.sock().reply({ id: t.id, diag: { cat: 'route', name: 'layer', text: 'route: ...', v: [0, 1, 2, 3, 4, 5] } })
    expect(diags).toEqual([{ cat: 'route', name: 'layer', text: 'route: ...', v: [0, 1, 2, 3, 4, 5] }])
  })
})

describe('reconnect and resume (§10.6)', () => {
  it('re-dials after a drop, re-auths, and continues on the same session id', async () => {
    const h = harness()
    const p = h.client.connect()
    h.sock().open()
    h.sock().reply({ authed: true })
    await p
    const first = h.sock()
    const states: string[] = []
    h.client.onState = (s) => states.push(s)
    first.drop()
    await tick()
    expect(h.sockets.length).toBe(2)
    const second = h.sock()
    second.open()
    expect(second.last()).toEqual({ op: 'auth', token: 'sesame' })
    second.reply({ authed: true })
    await tick()
    expect(h.client.state).toBe('ready')
    expect(states).toContain('reconnecting')
    // The next turn names the session it already held — no re-open.
    const t = h.client.chat(42, [{ role: 'user', content: 'again' }], {}, {
      onChunk: () => {},
      onDone: () => {},
      onError: () => {},
      onDiag: () => {},
    })
    expect(second.last().session).toBe(42)
    expect(second.last().id).toBe(t.id)
    expect(second.lastOp('open')).toBeUndefined()
  })

  it('keeps redialing while the host is down (a restart reloads the model), then resumes', async () => {
    const h = harness()
    const p = h.client.connect()
    h.sock().open()
    h.sock().reply({ authed: true })
    await p
    h.sock().drop()
    await tick()
    expect(h.sockets.length).toBe(2)
    h.sock().drop() // host not up yet: never opened
    await tick()
    expect(h.sockets.length).toBe(3)
    expect(h.client.state).toBe('reconnecting')
    h.sock().open()
    h.sock().reply({ authed: true })
    expect(h.client.state).toBe('ready')
  })

  it('a turn in flight when the socket drops ends with finish "disconnected", never hangs', async () => {
    const h = harness()
    const p = h.client.connect()
    h.sock().open()
    h.sock().reply({ authed: true })
    await p
    let finish = ''
    h.client.chat(1, [{ role: 'user', content: 'x' }], {}, {
      onChunk: () => {},
      onDone: (f) => {
        finish = f
      },
      onError: () => {},
      onDiag: () => {},
    })
    h.sock().drop()
    expect(finish).toBe('disconnected')
  })

  it('session_gone opens a new session and resubmits the whole conversation, with a notice (§5.2.8)', async () => {
    const h = harness()
    const p = h.client.connect()
    h.sock().open()
    h.sock().reply({ authed: true })
    await p
    const notices: string[] = []
    let newSession = -1
    const chunks: string[] = []
    const msgs = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'one' },
      { role: 'user', content: 'second' },
    ]
    const t = h.client.chat(42, msgs, { n: 4 }, {
      onChunk: (c) => chunks.push(c),
      onDone: () => {},
      onError: () => {},
      onDiag: () => {},
      onSessionReplaced: (s, why) => {
        newSession = s
        notices.push(why)
      },
    })
    h.sock().reply({
      id: t.id,
      error: 'session expired or closed - open a new one and resend context',
      kind: 'session_gone',
      session_ended: true,
    })
    // Client opens a fresh session...
    const openReq = h.sock().last()
    expect(openReq.op).toBe('open')
    h.sock().reply({ id: openReq.id, session: 77 })
    await tick()
    // ...and resubmits the SAME messages on it, under the same turn.
    const re = h.sock().last()
    expect(re.op).toBe('chat')
    expect(re.session).toBe(77)
    expect(re.messages).toEqual(msgs)
    expect(re.n).toBe(4)
    expect(newSession).toBe(77)
    expect(notices.length).toBe(1)
    h.sock().reply({ id: re.id, chunk: 'ok' })
    expect(chunks).toEqual(['ok'])
  })
})

describe('health', () => {
  it('asks and reports state + model (§10.8)', async () => {
    const h = harness()
    const p = h.client.connect()
    h.sock().open()
    h.sock().reply({ authed: true })
    await p
    const hp = h.client.health()
    const req = h.sock().last()
    expect(req.op).toBe('health')
    h.sock().reply({ id: req.id, state: 'ready', model: '/m/x.gguf' })
    expect(await hp).toEqual({ state: 'ready', model: '/m/x.gguf' })
  })
})

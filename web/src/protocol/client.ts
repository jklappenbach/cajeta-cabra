// The cabra protocol client (spec §10): the §3 op set over a WebSocket,
// as a state machine with no DOM in it. Everything the browser client
// needs from the host goes through here — auth, sessions, streaming
// turns, cancel, diag lines, reconnect + resume, and the §5.2.8 story
// when a session is gone. The socket is injected, so the tests drive it
// with a scripted fake and the UI drives it with the browser's.

export interface SocketLike {
  onopen: (() => void) | null
  onmessage: ((text: string) => void) | null
  onclose: (() => void) | null
  send(text: string): void
  close(): void
}

export type SocketFactory = (url: string) => SocketLike

export type ClientState =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'rejected'
  | 'closed'

export interface Message {
  role: 'system' | 'user' | 'assistant' | string
  content: string
}

/** Sampling parameters, in the wire's names (§3.2). Absent = the
 *  model-appropriate default. */
export interface TurnParams {
  temp?: number
  n?: number
  top_k?: number
  top_p?: number
  repeat_penalty?: number
  seed?: number
  stop?: string[]
  /** §10.9: ask for this turn's diagnostic records. */
  diag?: boolean
}

export interface Usage {
  prompt_tokens?: number
  gen_tokens?: number
  prefill_ms?: number
  decode_ms?: number
}

export interface DiagLine {
  cat: string
  name: string
  text: string
  v: number[]
}

export interface TurnHandlers {
  onChunk: (text: string) => void
  /** finish: eos | stop | budget | cancel | error | disconnected */
  onDone: (finish: string, usage: Usage | null) => void
  /** An error BEFORE any chunk (§4.4); the turn is over. */
  onError: (message: string, kind: string) => void
  onDiag: (line: DiagLine) => void
  /** §10.6: the host said the session was gone; the client opened
   *  `newSession` and resubmitted this turn's whole conversation on it.
   *  Absent, a gone session is reported through onError instead. */
  onSessionReplaced?: (newSession: number, why: string) => void
}

export interface Turn {
  readonly id: number
  readonly done: boolean
  cancel(): void
}

export interface Health {
  state: string
  model: string
}

interface TurnRec {
  id: number
  session: number
  messages: Message[]
  params: TurnParams
  h: TurnHandlers
  chunks: number
  done: boolean
}

interface Pending<T> {
  resolve: (v: T) => void
  reject: (e: Error) => void
}

export interface ClientOptions {
  url: string
  token: string
  socketFactory?: SocketFactory
  /** Delay before re-dialing after a drop; grows per attempt. */
  reconnectDelayMs?: number
}

function browserSocket(url: string): SocketLike {
  const ws = new WebSocket(url)
  const wrap: SocketLike = {
    onopen: null,
    onmessage: null,
    onclose: null,
    send: (t) => ws.send(t),
    close: () => ws.close(),
  }
  ws.onopen = () => wrap.onopen?.()
  ws.onmessage = (ev) => wrap.onmessage?.(String(ev.data))
  ws.onclose = () => wrap.onclose?.()
  ws.onerror = () => {
    /* the close that follows carries the news */
  }
  return wrap
}

export class CabraClient {
  state: ClientState = 'idle'
  onState: ((s: ClientState) => void) | null = null

  private readonly url: string
  private readonly token: string
  private readonly factory: SocketFactory
  private readonly reconnectDelayMs: number
  private sock: SocketLike | null = null
  private authed = false
  private nextId = 1
  private turns = new Map<number, TurnRec>()
  private opens = new Map<number, Pending<number>>()
  private healths = new Map<number, Pending<Health>>()
  private connectWaiters: Pending<void>[] = []
  private attempts = 0
  private wantOpen = false
  private opened = false

  constructor(opts: ClientOptions) {
    this.url = opts.url
    this.token = opts.token
    this.factory = opts.socketFactory ?? browserSocket
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 500
  }

  /** Dial, present the token, resolve when the host says authed.
   *  Rejects with a token message when the host closes first (the
   *  §5.5.1 refusal is a close before any answer). */
  connect(): Promise<void> {
    this.wantOpen = true
    return new Promise<void>((resolve, reject) => {
      this.connectWaiters.push({ resolve, reject })
      this.dial()
    })
  }

  close(): void {
    this.wantOpen = false
    this.setState('closed')
    this.sock?.close()
    this.sock = null
  }

  private setState(s: ClientState) {
    if (this.state === s) return
    this.state = s
    this.onState?.(s)
  }

  private dial() {
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting')
    this.authed = false
    this.opened = false
    const s = this.factory(this.url)
    this.sock = s
    s.onopen = () => {
      this.opened = true
      s.send(JSON.stringify({ op: 'auth', token: this.token }))
    }
    s.onmessage = (text) => this.onLine(text)
    s.onclose = () => this.onClosed(s)
  }

  private onClosed(s: SocketLike) {
    if (this.sock !== s) return
    this.sock = null
    if (!this.authed) {
      if (this.opened) {
        // Opened, then closed before any answer: the host refused the
        // token (7.1.4). The caller cannot proceed.
        this.setState('rejected')
        this.failWaiters(new Error('token rejected by host'))
        this.wantOpen = false
        return
      }
      // Never opened: no host at the address right now. On a first
      // connect that is the answer; on a reconnect the host may be
      // restarting (it reloads its model), so keep trying.
      if (this.attempts === 0 && this.connectWaiters.length > 0) {
        this.setState('rejected')
        this.failWaiters(new Error('no host at this address'))
        this.wantOpen = false
        return
      }
      this.scheduleRedial()
      return
    }
    // A live connection dropped: every turn in flight ends now (§10.6
    // — the host may still be running it, but its output is gone and
    // the conversation is client-side, so the user resubmits).
    for (const t of Array.from(this.turns.values())) {
      this.finishTurn(t, 'disconnected', null)
    }
    for (const p of this.opens.values()) p.reject(new Error('disconnected'))
    this.opens.clear()
    for (const p of this.healths.values()) p.reject(new Error('disconnected'))
    this.healths.clear()
    this.scheduleRedial()
  }

  private scheduleRedial() {
    if (!this.wantOpen) return
    this.attempts += 1
    this.setState('reconnecting')
    const delay = Math.min(this.reconnectDelayMs * this.attempts, 10000)
    setTimeout(() => {
      if (this.wantOpen && this.sock === null) this.dial()
    }, delay)
  }

  private failWaiters(err: Error) {
    const ws = this.connectWaiters
    this.connectWaiters = []
    for (const w of ws) w.reject(err)
  }

  private onLine(text: string) {
    let o: Record<string, unknown>
    try {
      o = JSON.parse(text) as Record<string, unknown>
    } catch {
      return
    }
    if (!this.authed) {
      if (o.authed === true) {
        this.authed = true
        this.attempts = 0
        this.setState('ready')
        const ws = this.connectWaiters
        this.connectWaiters = []
        for (const w of ws) w.resolve()
      }
      return
    }
    const id = typeof o.id === 'number' ? o.id : null
    if (id === null) return
    const open = this.opens.get(id)
    if (open) {
      this.opens.delete(id)
      if (typeof o.session === 'number') open.resolve(o.session)
      else open.reject(new Error(String(o.error ?? 'open failed')))
      return
    }
    const hp = this.healths.get(id)
    if (hp) {
      this.healths.delete(id)
      if (typeof o.state === 'string')
        hp.resolve({ state: o.state, model: String(o.model ?? '') })
      else hp.reject(new Error(String(o.error ?? 'health failed')))
      return
    }
    const t = this.turns.get(id)
    if (!t) return
    if (typeof o.chunk === 'string') {
      t.chunks += 1
      t.h.onChunk(o.chunk)
      return
    }
    if (o.diag && typeof o.diag === 'object') {
      const d = o.diag as Record<string, unknown>
      t.h.onDiag({
        cat: String(d.cat ?? ''),
        name: String(d.name ?? ''),
        text: String(d.text ?? ''),
        v: Array.isArray(d.v) ? (d.v as number[]) : [],
      })
      return
    }
    if (o.done === true) {
      this.finishTurn(t, String(o.finish ?? 'eos'), (o.usage as Usage) ?? null)
      return
    }
    if (typeof o.error === 'string') {
      const kind = String(o.kind ?? 'internal')
      if (kind === 'session_gone' && t.h.onSessionReplaced) {
        this.replaceSession(t, o.error)
        return
      }
      // A cancel refusal ("too late") is not the turn's failure: the
      // done line is on its way. Anything else ends the turn.
      if (t.done) return
      t.done = true
      this.turns.delete(id)
      t.h.onError(o.error, kind)
    }
  }

  private finishTurn(t: TurnRec, finish: string, usage: Usage | null) {
    if (t.done) return
    t.done = true
    this.turns.delete(t.id)
    t.h.onDone(finish, usage)
  }

  /** §5.2.8 made visible: open a fresh session and resubmit the SAME
   *  conversation under the same turn, telling the UI why. */
  private replaceSession(t: TurnRec, why: string) {
    this.openSession().then(
      (sid) => {
        if (t.done) return
        t.session = sid
        t.h.onSessionReplaced?.(sid, why)
        this.sendTurn(t)
      },
      (e: Error) => {
        if (t.done) return
        t.done = true
        this.turns.delete(t.id)
        t.h.onError(`session gone and no new one could be opened: ${e.message}`, 'capacity')
      },
    )
  }

  private send(o: Record<string, unknown>) {
    if (!this.sock) throw new Error('not connected')
    this.sock.send(JSON.stringify(o))
  }

  openSession(): Promise<number> {
    const id = this.nextId++
    return new Promise<number>((resolve, reject) => {
      this.opens.set(id, { resolve, reject })
      try {
        this.send({ op: 'open', id })
      } catch (e) {
        this.opens.delete(id)
        reject(e as Error)
      }
    })
  }

  closeSession(session: number): void {
    const id = this.nextId++
    try {
      this.send({ op: 'close', id, session })
    } catch {
      /* already gone */
    }
  }

  health(): Promise<Health> {
    const id = this.nextId++
    return new Promise<Health>((resolve, reject) => {
      this.healths.set(id, { resolve, reject })
      try {
        this.send({ op: 'health', id })
      } catch (e) {
        this.healths.delete(id)
        reject(e as Error)
      }
    })
  }

  private sendTurn(t: TurnRec) {
    const o: Record<string, unknown> = {
      op: 'chat',
      id: t.id,
      session: t.session,
      messages: t.messages,
    }
    const p = t.params
    if (p.temp !== undefined) o.temp = p.temp
    if (p.n !== undefined) o.n = p.n
    if (p.top_k !== undefined) o.top_k = p.top_k
    if (p.top_p !== undefined) o.top_p = p.top_p
    if (p.repeat_penalty !== undefined) o.repeat_penalty = p.repeat_penalty
    if (p.seed !== undefined) o.seed = p.seed
    if (p.stop !== undefined && p.stop.length > 0) o.stop = p.stop
    if (p.diag === true) o.diag = true
    this.send(o)
  }

  /** One turn: the whole conversation (state is client-side, §5.2.8)
   *  rendered by the host's chat template. Returns immediately; the
   *  handlers carry the stream. */
  chat(session: number, messages: Message[], params: TurnParams, h: TurnHandlers): Turn {
    const id = this.nextId++
    const rec: TurnRec = {
      id,
      session,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      params: { ...params },
      h,
      chunks: 0,
      done: false,
    }
    this.turns.set(id, rec)
    const self = this
    const turn: Turn = {
      id,
      get done() {
        return rec.done
      },
      cancel() {
        if (rec.done) return
        try {
          self.send({ op: 'cancel', id })
        } catch {
          self.finishTurn(rec, 'disconnected', null)
        }
      },
    }
    try {
      this.sendTurn(rec)
    } catch (e) {
      rec.done = true
      this.turns.delete(id)
      h.onError((e as Error).message, 'internal')
    }
    return turn
  }
}

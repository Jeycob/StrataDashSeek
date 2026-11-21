/** FIFO ownership for complete agent turns, including their delegated children. */
export class TurnQueue {
  constructor(onChange = () => {}) {
    this.owner = null;
    this.active = new Map();
    this.waiting = [];
    this.closed = false;
    this.onChange = onChange;
    this.sequence = 0;
  }

  key(sessionId, turn) { return JSON.stringify([sessionId, turn]); }

  enter({ rootId, sessionId, turn, signal }) {
    if (this.closed) return Promise.reject(new Error('Turn queue is closed'));
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Turn cancelled'));
    const key = this.key(sessionId, turn);
    const held = this.active.get(key);
    if (held) return Promise.resolve(held.receipt);
    const pending = this.waiting.find(x => x.key === key);
    if (pending) return pending.promise;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const ticket = { rootId, sessionId, turn, signal, key, promise, resolve, reject,
      sequence: ++this.sequence, queuedAt: Date.now() };
    ticket.onAbort = () => {
      const at = this.waiting.indexOf(ticket);
      if (at < 0) return;
      this.waiting.splice(at, 1);
      signal?.removeEventListener('abort', ticket.onAbort);
      reject(signal?.reason ?? new Error('Turn cancelled while queued'));
      this.changed('cancelled', ticket);
      this.pump();
    };
    signal?.addEventListener('abort', ticket.onAbort, { once: true });
    this.waiting.push(ticket);
    this.changed('queued', ticket);
    this.pump();
    return promise;
  }

  pump() {
    if (this.closed) return;
    if (this.owner === null && this.waiting.length) this.owner = this.waiting[0].rootId;
    if (this.owner === null) return;
    for (const ticket of [...this.waiting]) {
      if (ticket.rootId !== this.owner) continue;
      this.waiting.splice(this.waiting.indexOf(ticket), 1);
      ticket.signal?.removeEventListener('abort', ticket.onAbort);
      if (ticket.signal?.aborted) {
        ticket.reject(ticket.signal.reason ?? new Error('Turn cancelled'));
        continue;
      }
      ticket.admittedAt = Date.now();
      ticket.receipt = Object.freeze({ rootId: ticket.rootId, sessionId: ticket.sessionId,
        turn: ticket.turn, waitMilliseconds: ticket.admittedAt - ticket.queuedAt });
      this.active.set(ticket.key, ticket);
      ticket.resolve(ticket.receipt);
      this.changed('admitted', ticket);
    }
    if (!this.active.size) {
      this.owner = null;
      if (this.waiting.length) this.pump();
    }
  }

  end(sessionId, turn) {
    const matches = x => x.sessionId === sessionId && (turn === undefined || x.turn === turn);
    const released = [];
    for (const ticket of [...this.waiting]) if (matches(ticket)) {
      this.waiting.splice(this.waiting.indexOf(ticket), 1);
      ticket.signal?.removeEventListener('abort', ticket.onAbort);
      ticket.reject(new Error('Turn ended before admission'));
    }
    for (const [key, ticket] of this.active) if (matches(ticket)) {
      this.active.delete(key);
      released.push(ticket);
    }
    if (!this.active.size) this.owner = null;
    this.pump();
    for (const ticket of released) this.changed('released', ticket);
    this.changed('state');
  }

  close() {
    this.closed = true;
    for (const ticket of this.waiting) {
      ticket.signal?.removeEventListener('abort', ticket.onAbort);
      ticket.reject(new Error('Turn queue unloaded'));
    }
    this.waiting.length = 0;
    this.active.clear();
    this.owner = null;
    this.changed('closed');
  }

  snapshot() {
    const publicTicket = x => ({ rootId: x.rootId, sessionId: x.sessionId, turn: x.turn,
      sequence: x.sequence, queuedAt: x.queuedAt, admittedAt: x.admittedAt ?? null });
    return { version: 1, updatedAt: new Date().toISOString(), closed: this.closed,
      owner: this.owner, active: [...this.active.values()].map(publicTicket),
      waiting: this.waiting.map(publicTicket) };
  }

  changed(event, ticket) {
    try { this.onChange(event, this.snapshot(), ticket?.receipt ?? (ticket && {
      rootId: ticket.rootId, sessionId: ticket.sessionId, turn: ticket.turn })); }
    catch { /* Diagnostic I/O must never fail or release the scheduling lock. */ }
  }
}

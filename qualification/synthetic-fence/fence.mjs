// A model for synthetic tests only, not a process or isolation boundary.
export class SyntheticFence {
  #phase = null;
  #poison = null;
  #nextId = 0;

  get poisoned() { return this.#poison !== null; }

  #fail(reason) {
    this.#poison ??= reason;
    throw new Error(this.#poison);
  }

  start(identity) {
    if (this.#poison) throw new Error(this.#poison);
    if (this.#phase) return this.#fail('phase already active');
    if (typeof identity !== 'string' || !identity) return this.#fail('missing phase identity');
    const token = Object.freeze({ id: ++this.#nextId, identity });
    this.#phase = { token, accepting: true, pending: new Set(), failed: false };
    return token;
  }

  dispatch(token, operation) {
    const phase = this.#phase;
    if (this.#poison || !phase || phase.token !== token || !phase.accepting) {
      return this.#fail('late or invalid dispatch');
    }
    if (typeof operation !== 'function') return this.#fail('invalid host operation');
    // Registration is synchronous and precedes calling the handler.
    const tracked = Promise.resolve().then(operation);
    phase.pending.add(tracked);
    tracked.then(
      () => phase.pending.delete(tracked),
      () => { phase.pending.delete(tracked); phase.failed = true; this.#poison ??= 'host operation failed'; },
    );
    return tracked;
  }

  async finish(token, options) {
    const phase = this.#phase;
    if (this.#poison || !phase || phase.token !== token || !phase.accepting) {
      return this.#fail('invalid finish');
    }
    phase.accepting = false;
    if (!options || typeof options !== 'object') return this.#fail('invalid finish options');
    const { command, closedAndDrained, timeoutMs } = options;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return this.#fail('invalid timeout');
    let timer;
    try {
      await Promise.race([
        (async () => {
          const [commandOk, drained] = await Promise.all([command, closedAndDrained]);
          if (commandOk !== true) throw new Error('command failed');
          if (drained !== true) throw new Error('worker not closed and drained');
          await Promise.all([...phase.pending]);
          if (phase.failed || this.#poison) throw new Error('host operation failed');
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('phase timeout')), timeoutMs); }),
      ]);
      if (this.#poison) throw new Error(this.#poison);
      this.#phase = null;
    } catch (error) {
      if (!this.#poison) {
        this.#poison = 'phase failed';
        try {
          if (typeof error?.message === 'string') this.#poison = `phase failed: ${error.message}`;
        } catch { /* Keep the fence poisoned if the rejection cannot be inspected. */ }
      }
      throw new Error(this.#poison);
    } finally {
      clearTimeout(timer);
    }
  }
}

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SyntheticFence } from './fence.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const finish = (fence, token, overrides = {}) => fence.finish(token, {
  command: Promise.resolve(true), closedAndDrained: Promise.resolve(true), timeoutMs: 1000, ...overrides,
});

test('a delayed host operation settles before the next phase', async () => {
  const fence = new SyntheticFence();
  const first = fence.start('candidate');
  const gate = deferred();
  const journal = [];
  const operation = fence.dispatch(first, async () => { await gate.promise; journal.push('effect'); });
  let finished = false;
  const ending = finish(fence, first).then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  gate.resolve();
  await operation;
  await ending;
  assert.deepEqual(journal, ['effect']);
  assert.equal(fence.start('old').identity, 'old');
});

test('timeout permanently poisons even if the late effect settles', async () => {
  const fence = new SyntheticFence();
  const phase = fence.start('candidate');
  const gate = deferred();
  const op = fence.dispatch(phase, () => gate.promise);
  await assert.rejects(finish(fence, phase, { timeoutMs: 5 }), /timeout/);
  gate.resolve();
  await op;
  assert.throws(() => fence.start('old'), /timeout/);
});

test('crash, failed drain, rejected operation and late request prevent handover', async () => {
  for (const makeOverride of [
    () => ({ command: Promise.resolve(false) }),
    () => ({ closedAndDrained: Promise.resolve(false) }),
    () => ({ closedAndDrained: Promise.reject(new Error('crash')) }),
  ]) {
    const fence = new SyntheticFence();
    const phase = fence.start('candidate');
    await assert.rejects(finish(fence, phase, makeOverride()));
    assert.throws(() => fence.start('old'));
  }
  const fence = new SyntheticFence();
  const phase = fence.start('candidate');
  await assert.rejects(fence.dispatch(phase, () => { throw new Error('handler'); }));
  await assert.rejects(finish(fence, phase));
  assert.throws(() => fence.start('old'));

  const other = new SyntheticFence();
  const old = other.start('candidate');
  const close = deferred();
  const ending = finish(other, old, { closedAndDrained: close.promise });
  assert.throws(() => other.dispatch(old, () => {}), /late/);
  close.resolve(true);
  await assert.rejects(ending);
  assert.throws(() => other.start('old'));
});

test('an already-started operation is refused and permanently poisons the sequence', async () => {
  const fence = new SyntheticFence();
  const phase = fence.start('candidate');
  const gate = deferred();
  assert.throws(() => fence.dispatch(phase, gate.promise), /invalid host operation/);
  assert.equal(fence.poisoned, true);
  await assert.rejects(finish(fence, phase));
  assert.throws(() => fence.start('old'));
  gate.resolve();
});

test('arbitrary command and drain rejection values permanently poison the sequence', async () => {
  const hostile = { get message() { throw new Error('unreadable'); } };
  for (const field of ['command', 'closedAndDrained']) {
    for (const reason of [null, undefined, hostile]) {
      const fence = new SyntheticFence();
      const phase = fence.start('candidate');
      await assert.rejects(finish(fence, phase, { [field]: Promise.reject(reason) }), /phase failed/);
      assert.equal(fence.poisoned, true);
      assert.throws(() => fence.start('old'), /phase failed/);
    }
  }
});

test('missing finish options permanently poison the sequence', async () => {
  const fence = new SyntheticFence();
  const phase = fence.start('candidate');
  await assert.rejects(fence.finish(phase), /invalid finish options/);
  assert.throws(() => fence.start('old'), /invalid finish options/);
});

test('overlapping phase and stale token poison the sequence', async () => {
  const fence = new SyntheticFence();
  const phase = fence.start('candidate');
  await finish(fence, phase);
  fence.start('old');
  assert.throws(() => fence.dispatch(phase, () => {}), /invalid/);
  assert.throws(() => fence.start('candidate'));
  const other = new SyntheticFence();
  other.start('candidate');
  assert.throws(() => other.start('old'), /active/);
});

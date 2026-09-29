'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const probe = { discover: require('../douyin-web-enhancer.user.js').discoverNativeNavigation };

function fixture() {
  let now = 0;
  let timer = null;
  const listeners = new Map();
  const logs = [];
  const forbidden = () => { throw Error('must not invoke navigation or disabled predicate'); };
  const card = { getAttribute: () => '1234567890123456789' };
  const el = { contains: node => node === card };
  const feed = { contains: node => node === el, querySelectorAll: () => [card] };
  const swiper = { el, activeIndex: 0, data: [{ awemeId: '1234567890123456789' }],
    emit: forbidden, slideNext: forbidden, isDisabled: forbidden, touchData: { animating: false } };
  const top = { stateNode: {} };
  top.stateNode.current = top;
  const fiber = { memoizedProps: { item: { awemeId: '1234567890123456789' }, isActive: true, swiper, playNextFunc: forbidden }, return: top };
  card.__reactFiber$fixture = fiber;
  const doc = { visibilityState: 'visible', querySelector: () => null, querySelectorAll: () => [feed],
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: (type, callback) => { if (listeners.get(type) === callback) listeners.delete(type); } };
  const root = { document: doc, location: { href: 'https://www.douyin.com/?recommend=1&dwe_native_probe=inspect' },
    performance: { now: () => now }, console: { info: (...args) => logs.push(args) },
    history: { replaceState(_state, _title, path) { root.location.href = new URL(path, root.location.href).href; } },
    setTimeout(callback, delay) { timer = { callback, at: now + delay }; return 1; }, clearTimeout() { timer = null; } };
  return { root, doc, card, feed, fiber, top, swiper, listeners, logs,
    advance(ms) { const end = now + ms; while (timer && timer.at <= end) { const pending = timer; timer = null; now = pending.at; pending.callback(); } now = end; },
    get pending() { return timer; } };
}

test('discovery identifies one current, scoped, identity-matched instance without invoking any method', () => {
  const f = fixture();
  const report = probe.discover(f.card, f.feed);
  assert.equal(report.outcome, 'candidate-observed');
  assert.equal(report.candidates, 1);
  assert.equal(report.matches[0].hasPlayNextFunc, true);
  assert.doesNotMatch(JSON.stringify(report), /1234567890123456789|awemeId|https:/);
});

test('discovery rejects stale trees, foreign roots, mismatched identities and destroyed instances', () => {
  for (const reason of ['stale', 'foreign', 'identity', 'destroyed']) {
    const f = fixture();
    if (reason === 'stale') f.top.stateNode.current = {};
    if (reason === 'foreign') f.swiper.el = { contains: () => true };
    if (reason === 'identity') f.swiper.data[0].awemeId = '2222222222222222222';
    if (reason === 'destroyed') f.swiper.destroyed = true;
    assert.notEqual(probe.discover(f.card, f.feed).outcome, 'candidate-observed');
  }
});

test('discovery does not invoke getters and bounds cycles and depth', () => {
  const f = fixture();
  Object.defineProperty(f.fiber.memoizedProps, 'swiper', { get() { throw Error('private getter'); } });
  assert.equal(probe.discover(f.card, f.feed).outcome, 'candidate-count-mismatch');
  f.fiber.return = f.fiber;
  assert.equal(probe.discover(f.card, f.feed).outcome, 'fiber-cycle');
  let chain = f.fiber;
  for (let index = 0; index < 130; index += 1) { chain.return = {}; chain = chain.return; }
  const result = probe.discover(f.card, f.feed);
  assert.equal(result.outcome, 'depth-limit');
  assert.equal(result.visited, 128);
});

test('deep trees reach the current root and incomplete walks retain unverified candidates', () => {
  const f = fixture();
  let chain = f.fiber;
  for (let index = 0; index < 70; index += 1) { chain.return = {}; chain = chain.return; }
  chain.return = f.top;
  assert.equal(probe.discover(f.card, f.feed).outcome, 'candidate-observed');
  for (let index = 0; index < 70; index += 1) { chain.return = {}; chain = chain.return; }
  chain.return = f.top;
  const result = probe.discover(f.card, f.feed);
  assert.equal(result.outcome, 'depth-limit');
  assert.equal(result.candidates, 1);
  assert.equal(result.currentTree, false);
  assert.equal(result.matches[0].indexMatches, true);
});

test('duplicate instance is deduplicated but distinct candidates are rejected', () => {
  const f = fixture();
  const parent = { memoizedProps: { ...f.fiber.memoizedProps }, return: f.top };
  f.fiber.return = parent;
  assert.equal(probe.discover(f.card, f.feed).candidates, 1);
  parent.memoizedProps.swiper = { ...f.swiper };
  assert.equal(probe.discover(f.card, f.feed).outcome, 'candidate-count-mismatch');
});

function alternateFixture() {
  const f = fixture();
  const currentFiber = { stateNode: f.card, memoizedProps: { ...f.fiber.memoizedProps } };
  const currentRoot = { stateNode: f.top.stateNode, child: currentFiber };
  f.top.alternate = currentRoot;
  f.fiber.alternate = currentFiber;
  f.top.stateNode.current = currentRoot;
  return { ...f, currentRoot, currentFiber };
}

test('alternate resolution reads only the branch owned by the current root', () => {
  const f = alternateFixture();
  f.fiber.memoizedProps = { ...f.fiber.memoizedProps, swiper: { ...f.swiper, destroyed: true } };
  const result = probe.discover(f.card, f.feed);
  assert.equal(result.outcome, 'candidate-observed');
  assert.equal(result.resolvedAlternate, true);
  assert.equal(result.matches[0].destroyed, false);
  f.currentFiber.memoizedProps = {};
  assert.equal(probe.discover(f.card, f.feed).outcome, 'candidate-count-mismatch');
});

test('current paths fail closed on missing, ambiguous, cyclic, excessive or wrong-host branches', () => {
  for (const reason of ['current-path-missing', 'ambiguous-current-path', 'current-path-cycle', 'current-path-limit', 'current-path-changed']) {
    const f = alternateFixture();
    if (reason === 'current-path-missing') f.currentRoot.child = {};
    if (reason === 'ambiguous-current-path') f.currentFiber.sibling = f.fiber;
    if (reason === 'current-path-cycle') f.currentFiber.sibling = f.currentFiber;
    if (reason === 'current-path-changed') f.currentFiber.stateNode = {};
    if (reason === 'current-path-limit') {
      let sibling = f.currentFiber;
      for (let index = 0; index < 130; index += 1) { sibling.sibling = {}; sibling = sibling.sibling; }
    }
    const result = probe.discover(f.card, f.feed);
    assert.equal(result.outcome, reason);
    assert.equal(result.currentTree, false);
    assert.equal(result.candidates, 0);
  }
});

test('a shared child bailout is accepted only when current parent actually owns the host fiber', () => {
  const f = alternateFixture();
  f.fiber.stateNode = f.card;
  f.currentRoot.child = f.fiber;
  assert.equal(probe.discover(f.card, f.feed).outcome, 'candidate-observed');
});

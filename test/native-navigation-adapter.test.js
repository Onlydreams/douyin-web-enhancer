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
      for (let index = 0; index < 512; index += 1) { sibling.sibling = {}; sibling = sibling.sibling; }
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

test('wide alternate paths preserve identity checks and the 512 sibling and 2048 total budgets', () => {
  const inspectors = [probe.discover, require('../tools/native-navigation-probe.user.js').discover];
  for (const inspect of inspectors) {
    for (const reason of ['valid', 'siblings', 'identity', 'foreign', 'total']) {
      const f = alternateFixture();
      let child = f.currentFiber;
      const prefixCount = reason === 'siblings' ? 512 : reason === 'valid' ? 511 : 140;
      for (let index = 0; index < prefixCount; index += 1) child = { sibling: child };
      f.currentRoot.child = child;
      if (reason === 'identity') f.currentFiber.memoizedProps.item = { awemeId: '2222222222222222222' };
      if (reason === 'foreign') f.swiper.el = { contains: () => true };
      if (reason === 'total') {
        let oldChild = f.fiber;
        let currentChild = f.currentFiber;
        for (let depth = 0; depth < 5; depth += 1) {
          let currentHead = currentChild;
          for (let index = 0; index < 500; index += 1) currentHead = { sibling: currentHead };
          const currentParent = { child: currentHead };
          const oldParent = { alternate: currentParent };
          oldChild.return = oldParent;
          oldChild = oldParent;
          currentChild = currentParent;
        }
        oldChild.return = f.top;
        f.currentRoot.child = currentChild;
      }
      const report = inspect(f.card, f.feed);
      assert.equal(report.outcome === 'candidate-observed', reason === 'valid', reason);
      if (reason === 'siblings' || reason === 'total') assert.equal(report.outcome, 'current-path-limit');
      if (reason === 'identity') assert.equal(report.candidates, 0);
      if (reason === 'foreign') assert.equal(report.matches[0].scoped, false);
    }
  }
});

test('the one-shot console inspection reuses product discovery without invoking or modifying page state', () => {
  const vm = require('node:vm');
  const { createInspectionSource } = require('../tools/create-reentry-inspection.js');
  const enhancer = require('../douyin-web-enhancer.user.js');
  for (const stale of [false, true]) {
    const f = fixture();
    if (stale) f.top.stateNode.current = {};
    const cardAttributes = f.card.getAttribute;
    f.card.getAttribute = name => name === enhancer.VIDEO_STATE_ATTRIBUTE ? 'bypass' : cardAttributes(name);
    f.feed.contains = node => node === f.card || node === f.swiper.el;
    const cardBefore = Object.getOwnPropertyDescriptors(f.card);
    const swiperBefore = Object.getOwnPropertyDescriptors(f.swiper);
    const messages = [];
    vm.runInNewContext(createInspectionSource(), {
      document: { querySelectorAll(selector) {
        if (selector === enhancer.PAGE_SELECTORS.feedRoot) return [f.feed];
        if (selector === enhancer.PAGE_SELECTORS.activeCard) return [f.card];
        throw Error('unexpected page query');
      } },
      console: { info(message) { messages.push(message); } },
    });
    assert.equal(messages.length, 1);
    const report = JSON.parse(messages[0].slice('[DWE reentry inspection] '.length));
    assert.deepEqual(report.discovery, probe.discover(f.card, f.feed));
    assert.equal(report.state, 'bypass');
    assert.equal(report.discovery.outcome, stale ? 'stale-tree' : 'candidate-observed');
    assert.doesNotMatch(messages[0], /1234567890123456789|awemeId|https:/u);
    assert.deepEqual(Object.getOwnPropertyDescriptors(f.card), cardBefore);
    assert.deepEqual(Object.getOwnPropertyDescriptors(f.swiper), swiperBefore);
  }
});

test('the one-shot console inspection refuses nonunique feed or active-card scopes', () => {
  const vm = require('node:vm');
  const { createInspectionSource } = require('../tools/create-reentry-inspection.js');
  const enhancer = require('../douyin-web-enhancer.user.js');
  for (const [rootCount, cardCount] of [[0, 1], [2, 1], [1, 0], [1, 2]]) {
    const messages = [];
    vm.runInNewContext(createInspectionSource(), {
      document: { querySelectorAll(selector) {
        return Array.from({ length: selector === enhancer.PAGE_SELECTORS.feedRoot ? rootCount : cardCount }, () => ({}));
      } },
      console: { info(message) { messages.push(message); } },
    });
    const report = JSON.parse(messages[0].slice('[DWE reentry inspection] '.length));
    assert.equal(report.roots, rootCount);
    assert.equal(report.activeCards, cardCount);
    assert.equal(report.discovery, undefined);
  }
});

function createConsoleWatchHarness() {
  const vm = require('node:vm');
  const { createInspectionSource } = require('../tools/create-reentry-inspection.js');
  const enhancer = require('../douyin-web-enhancer.user.js');
  const f = fixture();
  const h = { ...f, messages: [], timers: new Map(), listeners: new Map(),
    documentQueries: [], feedQueries: [], roots: [f.feed], cards: [f.card] };
  let nextId = 1;
  let now = 0;
  f.feed.isConnected = true;
  f.feed.matches = selector => selector === enhancer.PAGE_SELECTORS.feedRoot;
  f.feed.contains = node => node === f.card || node === f.swiper.el;
  f.feed.querySelectorAll = selector => { h.feedQueries.push(selector); return h.cards; };
  f.card.nodeType = 1;
  f.card.matches = selector => selector === enhancer.PAGE_SELECTORS.activeCard;
  f.card.contains = node => node === f.card;
  h.document = {
    visibilityState: 'visible',
    querySelectorAll(selector) {
      h.documentQueries.push(selector);
      return selector === enhancer.PAGE_SELECTORS.feedRoot ? h.roots : h.cards;
    },
    addEventListener(type, listener) { h.listeners.set(type, listener); },
    removeEventListener(type, listener) { if (h.listeners.get(type) === listener) h.listeners.delete(type); },
  };
  vm.runInNewContext(createInspectionSource({ watch: true }), {
    document: h.document,
    console: { info(message) { h.messages.push(message); } },
    performance: { now: () => now },
    setTimeout(callback, delay) { const id = nextId++; h.timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { h.timers.delete(id); },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.disconnected = false; h.observer = this; }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
  });
  h.advance = ms => {
    const end = now + ms;
    while (h.timers.size) {
      const [id, timer] = [...h.timers].sort((left, right) => left[1].at - right[1].at)[0];
      if (timer.at > end) break;
      h.timers.delete(id); now = timer.at; timer.callback();
    }
    now = end;
  };
  h.report = () => JSON.parse(h.messages.at(-1).slice('[DWE reentry watch] '.length));
  return h;
}

test('the short console watch records transient discovery changes and completely cleans up', () => {
  for (const stopReason of ['completed', 'document-hidden', 'root-changed', 'root-selector-changed',
    'inspection-error', 'mutation-error', 'report-limit']) {
    const h = createConsoleWatchHarness();
    h.advance(25);
    assert.equal(h.messages.length, 1, 'unchanged samples must be quiet');
    h.fiber.memoizedProps.isActive = false;
    h.observer.callback([]);
    h.advance(25);
    assert.equal(h.report().discovery.outcome, 'candidate-count-mismatch');
    h.fiber.memoizedProps.isActive = true;
    h.advance(25);
    assert.equal(h.report().discovery.outcome, 'candidate-observed');
    if (stopReason === 'completed') h.advance(120000);
    if (stopReason === 'document-hidden') {
      h.document.visibilityState = 'hidden'; h.listeners.get('visibilitychange')();
    }
    if (stopReason === 'root-changed') { h.feed.isConnected = false; h.advance(25); }
    if (stopReason === 'root-selector-changed') { h.feed.matches = () => false; h.advance(25); }
    if (stopReason === 'inspection-error') {
      h.card.getAttribute = () => { throw Error('private error text must not be logged'); };
      h.advance(25);
    }
    if (stopReason === 'mutation-error') {
      const node = { nodeType: 1, contains() { throw Error('private error text must not be logged'); } };
      h.observer.callback([{ type: 'childList', target: h.feed, addedNodes: [node], removedNodes: [] }]);
    }
    if (stopReason === 'report-limit') {
      for (let index = 0; index < 100; index += 1) {
        h.fiber.memoizedProps.isActive = index % 2 === 1;
        h.advance(25);
      }
    }
    const expectedReason = stopReason === 'mutation-error' ? 'inspection-error'
      : stopReason === 'root-selector-changed' ? 'root-changed' : stopReason;
    assert.equal(h.messages.at(-1), '[DWE reentry watch] ' + JSON.stringify({ stopped: expectedReason }));
    assert.equal(h.timers.size, 0);
    assert.equal(h.listeners.size, 0);
    assert.equal(h.observer.disconnected, true);
    assert.doesNotMatch(JSON.stringify(h.messages), /1234567890123456789|awemeId|private error|https:/u);
  }
});

test('console watch ignores unrelated mutations and coalesces active-card changes without global rescans', () => {
  const enhancer = require('../douyin-web-enhancer.user.js');
  const h = createConsoleWatchHarness();
  assert.deepEqual(h.documentQueries, [enhancer.PAGE_SELECTORS.feedRoot]);
  assert.deepEqual(h.feedQueries, [enhancer.PAGE_SELECTORS.activeCard]);
  const unrelated = { nodeType: 1, matches: () => false, contains: () => false, querySelector: () => null };
  for (let index = 0; index < 1000; index += 1) {
    h.observer.callback([{ type: 'childList', target: h.feed, addedNodes: [unrelated], removedNodes: [] }]);
  }
  h.advance(25);
  assert.equal(h.documentQueries.length, 1);
  assert.equal(h.feedQueries.length, 1, 'unrelated changes must not invalidate the active-card cache');
  for (let index = 0; index < 1000; index += 1) {
    h.observer.callback([{ type: 'attributes', attributeName: 'data-e2e', target: h.card }]);
  }
  assert.equal(h.documentQueries.length, 1, 'observer must not query the document');
  assert.equal(h.feedQueries.length, 1, 'observer must not rescan the feed');
  assert.equal(h.timers.size, 2, 'mutation batches must share the existing sampling timer');
  h.advance(25);
  assert.equal(h.feedQueries.length, 2, 'related changes share one scoped query');
  assert.equal(h.messages.length, 1, 'unchanged samples must remain quiet');
});

test('console watch checks root uniqueness at most once per second and cleans up before another report', () => {
  const h = createConsoleWatchHarness();
  h.advance(975);
  assert.equal(h.documentQueries.length, 1);
  assert.equal(h.feedQueries.length, 1);
  h.roots.push({});
  h.fiber.memoizedProps.isActive = false;
  h.advance(25);
  assert.equal(h.documentQueries.length, 2);
  assert.deepEqual(h.report(), { stopped: 'root-changed' });
  assert.equal(h.messages.length, 2, 'a nonunique root must not produce a discovery report');
  assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.observer.disconnected, true);
});

test('console watch refreshes active cards after removal, nested insertion and attribute promotion', () => {
  const h = createConsoleWatchHarness();
  h.card.matches = () => false;
  h.cards = [];
  h.observer.callback([{ type: 'childList', target: h.feed, addedNodes: [], removedNodes: [h.card] }]);
  h.advance(25);
  assert.equal(h.report().activeCards, 0);
  assert.equal(h.report().discovery, undefined);

  h.card.matches = () => true;
  h.cards = [h.card];
  const wrapper = { nodeType: 1, matches: () => false, contains: () => false, querySelector: () => h.card };
  h.observer.callback([{ type: 'childList', target: h.feed, addedNodes: [wrapper], removedNodes: [] }]);
  h.advance(25);
  assert.equal(h.report().discovery.outcome, 'candidate-observed');

  const promoted = { nodeType: 1, matches: () => true };
  h.cards.push(promoted);
  h.observer.callback([{ type: 'attributes', attributeName: 'data-e2e', target: promoted }]);
  h.advance(25);
  assert.equal(h.report().activeCards, 2);
  assert.equal(h.report().discovery, undefined);
  assert.equal(h.feedQueries.length, 4);

  h.cards = [h.card];
  h.observer.callback([{ type: 'attributes', attributeName: 'data-e2e-vid', target: promoted }]);
  h.advance(25);
  assert.equal(h.report().activeCards, 1);
  assert.equal(h.report().discovery.outcome, 'candidate-observed');
  assert.equal(h.feedQueries.length, 5);
});

test('console inspection observes the verified alternate beyond 128 siblings without navigation', () => {
  const vm = require('node:vm');
  const { createInspectionSource } = require('../tools/create-reentry-inspection.js');
  const enhancer = require('../douyin-web-enhancer.user.js');
  const f = alternateFixture();
  let sibling = f.currentFiber;
  for (let index = 0; index < 140; index += 1) { sibling.sibling = {}; sibling = sibling.sibling; }
  f.feed.contains = node => node === f.card || node === f.swiper.el;
  const messages = [];
  vm.runInNewContext(createInspectionSource(), {
    document: { querySelectorAll: selector => selector === enhancer.PAGE_SELECTORS.feedRoot ? [f.feed] : [f.card] },
    console: { info(message) { messages.push(message); } },
  });
  const report = JSON.parse(messages[0].slice('[DWE reentry inspection] '.length));
  assert.equal(report.discovery.outcome, 'candidate-observed');
  assert.equal(report.discovery.resolvedAlternate, true);
  assert.doesNotMatch(messages[0], /1234567890123456789|awemeId|https:/u);
});

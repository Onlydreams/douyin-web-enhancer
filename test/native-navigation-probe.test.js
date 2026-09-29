'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const probe = require('../tools/native-navigation-probe.user.js');

test('repeated readiness checks leave room for the queue-ready navigation record', () => {
  let time = 0;
  const swiper = { data: [{}], activeIndex: 0, touchData: { animating: false },
    isDisabled() { return false; }, slideNext() {}, slidePrev() {}, slideTo() {}, emit() {} };
  const trace = probe.createNavigationTrace(swiper, () => time, true);
  for (let i = 0; i < 50; i += 1) { time += 50; swiper.isDisabled(); }
  swiper.data.push({});
  swiper.isDisabled();
  swiper.emit('changeNext');
  trace.stop();
  const report = trace.snapshot();
  assert.equal(report.disabledChecks, 51);
  assert.equal(report.records.find(r => r.method === 'emit').before.remaining, 1);
  assert.ok(report.records.length < 8);
});

test('manual observation arms on a bypass card and does not dispatch navigation itself', () => {
  const f = fixture();
  f.card.getAttribute = key => key === 'data-dwe-video-state' ? 'bypass' : '1234567890123456789';
  let calls = 0;
  f.swiper.slidePrev = () => {};
  f.swiper.emit = () => { calls += 1; };
  const api = probe.observeProduct(f.root, false, true);
  f.advance(100);
  assert.equal(calls, 0);
  f.swiper.emit('changeNext');
  f.advance(4000);
  assert.equal(api.snapshot().trace.nextEmits, 1);
  assert.equal(api.snapshot().trace.cleanup, 'restored');
  assert.equal(api.snapshot().mode, 'observe-manual');
});

function seriesFixture() {
  const f = actionFixture();
  f.root.location.href = f.root.location.href.replace('=next', '=series-next');
  f.swiper.data = Array.from({ length: 4 }, (_, index) => ({ awemeId: String(1234567890123456789n + BigInt(index)) }));
  f.card.getAttribute = () => f.swiper.data[f.swiper.activeIndex].awemeId;
  f.swiper.slideNext = function () {
    this.activeIndex += 1;
    f.fiber.memoizedProps.item = this.data[this.activeIndex];
  };
  f.swiper.emit = function () { f.calls.push(this.activeIndex); this.slideNext(); };
  return f;
}

test('series confirms three distinct cards in one document and restores each round', () => {
  const f = seriesFixture(); const original = f.swiper.slideNext;
  const api = probe.bootstrap(f.root); f.advance(25_000);
  const report = api.snapshot();
  assert.equal(report.outcome, 'three-changes-confirmed');
  assert.deepEqual(f.calls, [0, 1, 2]);
  assert.equal(report.navigationCalls, 3);
  assert.equal(report.rounds.length, 3);
  assert.deepEqual(report.rounds.map(round => round.identityChanges), [1, 1, 1]);
  assert.equal(report.rounds.every(round => round.trace.cleanup === 'restored'), true);
  assert.equal(f.swiper.slideNext, original);
  assert.equal(f.pending, null);
  assert.equal(f.listeners.size, 0);
  assert.doesNotMatch(JSON.stringify(report), /123456789012345/);
});

test('series stops on second-card failure without retrying or advancing to a third call', () => {
  const f = seriesFixture();
  f.swiper.emit = function () { f.calls.push(this.activeIndex); if (this.activeIndex === 0) this.slideNext(); };
  const api = probe.bootstrap(f.root); f.advance(25_000);
  const report = api.snapshot();
  assert.equal(report.outcome, 'not-confirmed');
  assert.deepEqual(f.calls, [0, 1]);
  assert.deepEqual(report.rounds.map(round => round.trace.slideNextCalls), [1, 0]);
  assert.equal(f.listeners.size, 0);
});

test('series stops for inter-round drift, root replacement, editable focus or background', () => {
  for (const reason of ['between-round-drift', 'root-changed', 'editable-focus', 'background']) {
    const f = seriesFixture(); const api = probe.bootstrap(f.root); f.advance(6_000);
    if (reason === 'between-round-drift') f.swiper.activeIndex = 2;
    if (reason === 'root-changed') f.doc.querySelectorAll = () => [{}];
    if (reason === 'editable-focus') f.doc.activeElement = { closest: () => ({}) };
    if (reason === 'background') f.doc.visibilityState = 'hidden';
    f.advance(20_000);
    assert.equal(api.snapshot().outcome, reason);
    assert.equal(f.calls.length, 1);
    assert.equal(f.pending, null);
  }
});

test('series does not revisit a previously attempted identity or overwrite a later method owner', () => {
  for (const laterOwner of [false, true]) {
    const f = seriesFixture();
    if (!laterOwner) f.swiper.data[2].awemeId = f.swiper.data[0].awemeId;
    const api = probe.bootstrap(f.root); f.advance(1_000);
    const replacement = () => {};
    if (laterOwner) f.swiper.slideNext = replacement;
    f.advance(25_000);
    assert.equal(api.snapshot().outcome, laterOwner ? 'trace-cleanup-incomplete' : 'already-attempted-card');
    assert.equal(f.calls.length, laterOwner ? 1 : 2);
    if (laterOwner) assert.equal(f.swiper.slideNext, replacement);
  }
});

test('series reacquires the active candidate and refuses a disabled second card', () => {
  const f = seriesFixture(); const api = probe.bootstrap(f.root); f.advance(6_000);
  f.swiper.isDisabled = () => true;
  f.advance(20_000);
  assert.equal(api.snapshot().outcome, 'navigation-disabled');
  assert.equal(f.calls.length, 1);
  assert.equal(api.snapshot().rounds.length, 1);
});

test('trace preserves receiver, arguments, return identity and records actual disabled checks', () => {
  const sentinel = Promise.resolve('result');
  const receiver = {};
  const input = {};
  const swiper = { activeIndex: 0, touchData: { animating: false },
    isDisabled() { assert.equal(this, swiper); return false; },
    slideNext(arg) { assert.equal(this, receiver); assert.equal(arg, input); swiper.isDisabled(); swiper.activeIndex = 1; return sentinel; } };
  const descriptor = Object.getOwnPropertyDescriptor(swiper, 'slideNext');
  const trace = probe.createNavigationTrace(swiper, () => 100);
  assert.equal(swiper.slideNext.call(receiver, input), sentinel);
  trace.stop();
  assert.deepEqual(Object.getOwnPropertyDescriptor(swiper, 'slideNext'), descriptor);
  const snapshot = trace.snapshot();
  assert.equal(snapshot.slideNextCalls, 1);
  assert.equal(snapshot.disabledChecks, 1);
  assert.equal(snapshot.records[0].after.index, 1);
  assert.equal(snapshot.records[0].before.dataLength, null);
  assert.equal(snapshot.records[1].returnedDisabled, false);
  assert.equal(snapshot.cleanup, 'restored');
});

test('paired observation compares the same target after exit and reentry without dispatching navigation', () => {
  const f = fixture();
  const target = '1234567890123456789';
  const other = '2222222222222222222';
  let id = target;
  let ready = false;
  let calls = 0;
  f.card.getAttribute = key => key === 'data-dwe-video-state' ? 'block' : id;
  f.swiper.slidePrev = () => {};
  f.swiper.slideTo = function (index) {
    this.activeIndex = index;
    id = this.data[index].awemeId;
    f.fiber.memoizedProps.item = this.data[index];
  };
  f.swiper.slideNext = function () { calls += 1; if (ready) this.slideTo(1); };
  f.swiper.emit = function () { this.slideNext(); };
  const original = f.swiper.slideTo;
  const api = probe.observeProduct(f.root, true);
  f.advance(100);
  assert.equal(calls, 0);
  f.swiper.emit('changeNext');
  f.advance(3_600);
  assert.equal(api.snapshot(), null);
  assert.equal(f.swiper.slideTo, original);
  f.advance(4_000);
  assert.equal(calls, 1);
  f.swiper.data.push({ awemeId: other });
  f.swiper.slideTo(1);
  f.advance(100);
  f.swiper.slideTo(0);
  ready = true;
  f.advance(100);
  f.swiper.emit('changeNext');
  f.advance(3_600);
  const result = api.snapshot();
  assert.equal(result.outcome, 'pair-observed');
  assert.deepEqual(result.rounds.map(r => r.outcome), ['not-confirmed', 'identity-change-observed']);
  assert.deepEqual(result.rounds.map(r => r.trace.slideToCalls), [0, 1]);
  assert.deepEqual(result.rounds.map(r => r.trace.records[0].before.remaining), [0, 1]);
  assert.equal(calls, 2);
  assert.equal(f.swiper.slideTo, original);
  assert.equal(f.pending, null);
  assert.equal(f.listeners.size, 0);
  assert.doesNotMatch(JSON.stringify(result), /1234567890123456789|2222222222222222222/);
});

test('paired observation tolerates missing standard cards but restores on background or root replacement', () => {
  for (const reason of ['background', 'root-changed']) {
    const f = fixture();
    f.card.getAttribute = key => key === 'data-dwe-video-state' ? 'block' : '1234567890123456789';
    f.swiper.slidePrev = () => {};
    const original = f.swiper.emit;
    const api = probe.observeProduct(f.root, true);
    f.advance(100);
    f.feed.querySelectorAll = () => [];
    f.advance(1_000);
    assert.equal(api.snapshot(), null);
    if (reason === 'background') f.doc.visibilityState = 'hidden';
    else f.doc.querySelectorAll = () => [{}];
    f.advance(100);
    assert.equal(api.snapshot().outcome, reason);
    assert.equal(f.swiper.emit, original);
    assert.equal(f.pending, null);
    assert.equal(f.listeners.size, 0);
  }
});

test('paired observation rejects manual navigation during a measured round', () => {
  const f = fixture();
  f.card.getAttribute = key => key === 'data-dwe-video-state' ? 'block' : '1234567890123456789';
  f.swiper.slidePrev = () => {};
  const original = f.swiper.emit;
  const api = probe.observeProduct(f.root, true);
  f.advance(100);
  f.listeners.get('keydown')({ isTrusted: true });
  assert.equal(api.snapshot().outcome, 'user-input-during-observation');
  assert.equal(f.swiper.emit, original);
  assert.equal(f.pending, null);
  assert.equal(f.listeners.size, 0);
});

test('observation deadline expires even while waiting in a hidden tab', () => {
  const f = fixture();
  f.doc.visibilityState = 'hidden';
  const api = probe.observeProduct(f.root, true);
  f.advance(300_100);
  assert.equal(api.snapshot().outcome, 'session-timeout');
  assert.equal(f.pending, null);
  assert.equal(f.listeners.size, 0);
});

test('pair launcher is inert until clicked and can restart on the same page with full cleanup', () => {
  const f = fixture();
  f.root.location.href = f.root.location.href.replace('=inspect', '=observe-pair');
  let click;
  let removed = false;
  const button = { style: {}, setAttribute() {},
    addEventListener(_type, fn) { click = fn; },
    removeEventListener() { click = null; }, remove() { removed = true; } };
  f.doc.createElement = () => button;
  f.doc.documentElement = { appendChild(value) { assert.equal(value, button); } };
  f.card.getAttribute = key => key === 'data-dwe-video-state' ? 'block' : '1234567890123456789';
  f.swiper.slidePrev = () => {};
  const original = f.swiper.emit;
  const api = probe.bootstrap(f.root);
  f.advance(400_000);
  assert.equal(api.snapshot(), null);
  assert.equal(f.pending, null);
  click({ isTrusted: false });
  assert.equal(f.pending, null);
  click({ isTrusted: true });
  f.advance(100);
  assert.notEqual(f.swiper.emit, original);
  click({ isTrusted: true });
  f.advance(100);
  assert.notEqual(f.swiper.emit, original);
  f.card.getAttribute = key => key === 'data-dwe-video-state' ? 'bypass' : '1234567890123456789';
  click({ isTrusted: true, shiftKey: true });
  f.advance(100);
  assert.notEqual(f.swiper.emit, original);
  f.advance(4000);
  assert.equal(api.snapshot().mode, 'observe-manual');
  api.stop();
  assert.equal(f.swiper.emit, original);
  assert.equal(f.pending, null);
  assert.equal(removed, true);
  assert.equal(click, null);
});

test('product observation records a single real navigation without emitting or exposing card IDs', () => {
  const f = fixture();
  f.root.location.href = f.root.location.href.replace('=inspect', '=observe-product');
  let activeId = '1234567890123456789';
  f.card.getAttribute = key => key === 'data-dwe-video-state' ? 'block' : activeId;
  f.swiper.slidePrev = function () { throw Error('unexpected reverse navigation'); };
  f.swiper.isDisabled = () => false;
  f.swiper.emit = function (type) {
    assert.equal(type, 'changeNext');
    this.slideNext();
  };
  f.swiper.slideNext = function () {
    this.isDisabled();
    this.activeIndex = 1;
    activeId = '2222222222222222222';
    this.data.push({ awemeId: activeId });
    f.fiber.memoizedProps.item = this.data[1];
  };
  const originalEmit = f.swiper.emit;
  const originalSlide = f.swiper.slideNext;
  const api = probe.bootstrap(f.root);
  f.advance(100);
  assert.equal(api.snapshot(), null);
  assert.equal(f.swiper.emit('changeNext', { from: 'keyboard' }), undefined);
  f.advance(4_000);
  const report = api.snapshot();
  assert.equal(report.outcome, 'one-change-observed');
  assert.equal(report.trace.nextEmits, 1);
  assert.equal(report.trace.prevEmits, 0);
  assert.equal(report.trace.slideNextCalls, 1);
  assert.equal(report.trace.slidePrevCalls, 0);
  assert.equal(report.trace.disabledChecks, 1);
  assert.equal(report.trace.records.find(record => record.method === 'emit').before.dataLength, 1);
  assert.equal(report.trace.records.find(record => record.method === 'emit').before.remaining, 0);
  assert.equal(report.trace.cleanup, 'restored');
  assert.equal(f.swiper.emit, originalEmit);
  assert.equal(f.swiper.slideNext, originalSlide);
  assert.equal(f.pending, null);
  assert.equal(f.listeners.size, 0);
  assert.doesNotMatch(JSON.stringify(report), /1234567890123456789|2222222222222222222/);
});

test('product observation distinguishes event without slide and restores on background', () => {
  for (const background of [false, true]) {
    const f = fixture();
    f.root.location.href = f.root.location.href.replace('=inspect', '=observe-product');
    f.card.getAttribute = key => key === 'data-dwe-video-state' ? 'block' : '1234567890123456789';
    f.swiper.slidePrev = () => {};
    f.swiper.emit = () => {};
    const originalEmit = f.swiper.emit;
    const api = probe.bootstrap(f.root);
    f.advance(100);
    f.swiper.emit('changePrev', { from: 'keyboard' });
    if (background) {
      f.doc.visibilityState = 'hidden';
      f.listeners.get('visibilitychange')();
    }
    f.advance(4_000);
    assert.equal(api.snapshot().outcome, background ? 'background' : 'not-confirmed');
    assert.equal(api.snapshot().trace.prevEmits, 1);
    assert.equal(api.snapshot().trace.slidePrevCalls, 0);
    assert.equal(f.swiper.emit, originalEmit);
    assert.equal(f.pending, null);
    assert.equal(f.listeners.size, 0);
  }
});

test('product observation waits through a background menu edit before arming', () => {
  const f = fixture();
  f.root.location.href = f.root.location.href.replace('=inspect', '=observe-product');
  let blocked = false;
  f.card.getAttribute = key => key === 'data-dwe-video-state'
    ? (blocked ? 'block' : 'allow') : '1234567890123456789';
  f.swiper.slidePrev = () => {};
  const originalEmit = f.swiper.emit;
  const api = probe.bootstrap(f.root);
  f.doc.visibilityState = 'hidden';
  f.listeners.get('visibilitychange')();
  f.advance(31_000);
  assert.equal(api.snapshot(), null);
  assert.equal(f.swiper.emit, originalEmit);
  blocked = true;
  f.doc.visibilityState = 'visible';
  f.listeners.get('visibilitychange')();
  f.advance(100);
  assert.notEqual(f.swiper.emit, originalEmit);
  api.stop();
  assert.equal(f.swiper.emit, originalEmit);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.pending, null);
});

test('trace propagates original exceptions and bounds stored observations', () => {
  const failure = Error('private detail');
  const swiper = { slideNext() { throw failure; }, isDisabled: () => true };
  const trace = probe.createNavigationTrace(swiper, () => 0);
  assert.throws(() => swiper.slideNext(), error => error === failure);
  for (let index = 0; index < 50; index += 1) { swiper.activeIndex = index; swiper.isDisabled(); }
  trace.stop();
  assert.equal(trace.snapshot().records.length, 32);
  assert.equal(trace.snapshot().disabledChecks, 50);
  assert.equal(trace.snapshot().records[0].threw, true);
  assert.doesNotMatch(JSON.stringify(trace.snapshot()), /private detail/);
});

test('trace rolls back partial installation and does not overwrite later owners', () => {
  const original = () => {};
  const swiper = { slideNext: original };
  Object.defineProperty(swiper, 'isDisabled', { value: () => false });
  assert.equal(probe.createNavigationTrace(swiper, () => 0), null);
  assert.equal(swiper.slideNext, original);
  const other = { slideNext: original, isDisabled: () => false };
  const trace = probe.createNavigationTrace(other, () => 0);
  const captured = other.slideNext;
  const replacement = () => {};
  other.slideNext = replacement;
  trace.stop();
  captured();
  assert.equal(other.slideNext, replacement);
  assert.equal(trace.snapshot().slideNextCalls, 0);
  assert.equal(trace.snapshot().cleanup, 'later-owner-preserved');
});

test('trace-next differentiates an unreached slide method from an invoked one and restores on all exits', () => {
  for (const outcome of ['not-confirmed', 'one-change-observed', 'background', 'probe-error']) {
    const f = actionFixture();
    f.root.location.href = f.root.location.href.replace('=next', '=trace-next');
    const original = function () { this.isDisabled(); this.activeIndex += 1; f.card.getAttribute = () => '2222222222222222222'; };
    f.swiper.slideNext = original;
    if (outcome === 'one-change-observed') f.swiper.emit = () => f.swiper.slideNext();
    if (outcome === 'probe-error') f.swiper.emit = () => { throw Error('private'); };
    const api = probe.bootstrap(f.root); f.advance(1_000);
    if (outcome === 'background') { f.doc.visibilityState = 'hidden'; f.listeners.get('visibilitychange')(); }
    f.advance(6_000);
    const report = api.snapshot();
    assert.equal(report.outcome, outcome);
    assert.equal(report.trace.slideNextCalls, outcome === 'one-change-observed' ? 1 : 0);
    assert.equal(report.trace.cleanup, 'restored');
    assert.equal(f.swiper.slideNext, original);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.pending, null);
  }
});

test('trace-next refuses to navigate if tracing cannot be installed', () => {
  const f = actionFixture();
  f.root.location.href = f.root.location.href.replace('=next', '=trace-next');
  Object.defineProperty(f.swiper, 'slideNext', { configurable: false });
  const api = probe.bootstrap(f.root); f.advance(2_000);
  assert.equal(api.snapshot().outcome, 'trace-unavailable');
  assert.equal(api.snapshot().navigationCalls, 0);
  assert.equal(f.calls.length, 0);
});

function actionFixture() {
  const f = fixture();
  f.root.location.href = f.root.location.href.replace('=inspect', '=next');
  f.video = { paused: false, ended: false, readyState: 4, currentTime: 2, duration: 100, playbackRate: 1 };
  f.card.querySelectorAll = () => [f.video];
  f.doc.querySelectorAll = selector => selector === 'video' ? [f.video] : [f.feed];
  f.swiper.isDisabled = () => false;
  f.calls = [];
  f.swiper.emit = function (...args) { f.calls.push({ receiver: this === f.swiper, args }); };
  return f;
}

test('next mode emits once with the original receiver and observes exactly one identity change', () => {
  const f = actionFixture(); const api = probe.bootstrap(f.root);
  f.advance(1_000);
  assert.deepEqual(f.calls, [{ receiver: true, args: ['changeNext', { from: 'keyboard' }] }]);
  f.card.getAttribute = () => '2222222222222222222';
  f.advance(9_000);
  const report = api.snapshot();
  assert.equal(report.outcome, 'one-change-observed');
  assert.equal(report.navigationCalls, 1);
  assert.equal(report.firstChangeMs, 100);
  assert.equal(report.afterMedia.otherPlaying, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.pending, null);
  assert.doesNotMatch(JSON.stringify(f.logs), /2222222222222222222|1234567890123456789/);
});

test('next mode never retries a failed switch or hides multiple changes', () => {
  for (const multiple of [false, true]) {
    const f = actionFixture(); const api = probe.bootstrap(f.root); f.advance(1_000);
    if (multiple) {
      f.card.getAttribute = () => '2222222222222222222'; f.advance(100);
      f.card.getAttribute = () => '3333333333333333333';
    }
    f.advance(10_000);
    assert.equal(api.snapshot().outcome, multiple ? 'multiple-changes' : 'not-confirmed');
    assert.equal(f.calls.length, 1);
  }
});

test('next mode blocks unsafe preconditions before emission', () => {
  for (const reason of ['media-not-ready', 'near-video-end', 'animation-not-ready', 'navigation-disabled', 'editable-focus']) {
    const f = actionFixture();
    if (reason === 'media-not-ready') f.video.paused = true;
    if (reason === 'near-video-end') { f.video.currentTime = 85; f.video.playbackRate = 2; }
    if (reason === 'animation-not-ready') f.swiper.touchData.animating = true;
    if (reason === 'navigation-disabled') f.swiper.isDisabled = () => true;
    if (reason === 'editable-focus') f.doc.activeElement = { closest: () => ({}) };
    const api = probe.bootstrap(f.root); f.advance(10_000);
    assert.equal(api.snapshot().outcome, reason);
    assert.equal(f.calls.length, 0);
    assert.equal(f.listeners.size, 0);
  }
});

test('next mode rechecks state after the site disabled predicate and honors reentrant stop', () => {
  for (const reason of ['root-changed', 'candidate-changed', 'stopped']) {
    const f = actionFixture(); let api;
    f.swiper.isDisabled = () => {
      if (reason === 'root-changed') f.doc.querySelectorAll = () => [{}];
      if (reason === 'candidate-changed') f.fiber.memoizedProps.swiper = { ...f.swiper };
      if (reason === 'stopped') api.stop();
      return false;
    };
    api = probe.bootstrap(f.root); f.advance(5_000);
    assert.equal(api.snapshot().outcome, reason);
    assert.equal(f.calls.length, 0);
    assert.equal(f.pending, null);
  }
});

test('next mode cancels observation on background or user input and sanitizes emitter errors', () => {
  for (const reason of ['background', 'user-input', 'probe-error']) {
    const f = actionFixture();
    if (reason === 'probe-error') f.swiper.emit = () => { throw Error('private-site-value'); };
    const api = probe.bootstrap(f.root); f.advance(1_000);
    if (reason === 'background') { f.doc.visibilityState = 'hidden'; f.listeners.get('visibilitychange')(); }
    if (reason === 'user-input') f.listeners.get('wheel')({ isTrusted: true });
    f.advance(10_000);
    assert.equal(api.snapshot().outcome, reason);
    assert.equal(api.snapshot().navigationCalls, 1);
    assert.equal(f.pending, null);
    assert.equal(f.listeners.size, 0);
    assert.doesNotMatch(JSON.stringify(f.logs), /private-site-value/);
  }
});

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
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: (type, callback) => { if (listeners.get(type) === callback) listeners.delete(type); },
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

test('unsupported URLs are inert', () => {
  for (const href of ['https://www.douyin.com/?recommend=1', 'https://example.com/?recommend=1&dwe_native_probe=inspect',
    'https://www.douyin.com/follow?recommend=1&dwe_native_probe=inspect']) {
    const f = fixture(); f.root.location.href = href;
    assert.equal(probe.bootstrap(f.root), null);
    assert.equal(f.pending, null);
    assert.equal(f.listeners.size, 0);
  }
});

test('one-shot opt-in consumes parameter, blocks duplicates and cleans all work', () => {
  const f = fixture(); const api = probe.bootstrap(f.root);
  assert.doesNotMatch(f.root.location.href, /dwe_native_probe/);
  assert.equal(probe.bootstrap(f.root), null);
  f.advance(20_000);
  assert.equal(api.snapshot().outcome, 'candidate-observed');
  assert.equal(api.snapshot().navigationCalls, 0);
  assert.equal(f.logs.length, 1);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.pending, null);
});

test('stop and background retire pending callbacks', () => {
  for (const reason of ['stopped', 'background', 'user-input']) {
    const f = fixture(); const api = probe.bootstrap(f.root); const pending = f.pending.callback;
    if (reason === 'stopped') api.stop();
    if (reason === 'background') { f.doc.visibilityState = 'hidden'; f.listeners.get('visibilitychange')(); }
    if (reason === 'user-input') f.listeners.get('keydown')({ isTrusted: true });
    pending(); f.advance(20_000);
    assert.equal(api.snapshot().outcome, reason);
    assert.equal(f.logs.length, 1);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.pending, null);
  }
});

test('route, modal and active enhancer prevent discovery', () => {
  for (const reason of ['route-changed', 'dialog-open', 'enhancer-active']) {
    const f = fixture(); const api = probe.bootstrap(f.root);
    if (reason === 'route-changed') f.root.location.href += '&changed=1';
    else f.doc.querySelector = selector => selector.includes(reason === 'dialog-open' ? 'dialog' : 'data-dwe-video-state') ? {} : null;
    f.advance(1_000);
    assert.equal(api.snapshot().outcome, reason);
    assert.equal(f.listeners.size, 0);
  }
});

test('missing fiber times out and root replacement cancels', () => {
  for (const replace of [false, true]) {
    const f = fixture(); delete f.card.__reactFiber$fixture;
    const api = probe.bootstrap(f.root); f.advance(1_000);
    if (replace) f.doc.querySelectorAll = () => [{}];
    f.advance(20_000);
    assert.equal(api.snapshot().outcome, replace ? 'root-changed' : 'not-ready');
    assert.equal(f.pending, null);
    assert.equal(f.listeners.size, 0);
  }
});

test('history failure remains inert and unexpected discovery errors are sanitized', () => {
  const f = fixture(); f.root.history.replaceState = () => { throw Error('private'); };
  assert.equal(probe.bootstrap(f.root), null);
  assert.equal(f.listeners.size, 0);
  const other = fixture(); other.card.getAttribute = () => { throw Error('private'); };
  const api = probe.bootstrap(other.root); other.advance(1_000);
  assert.equal(api.snapshot().outcome, 'probe-error');
  assert.doesNotMatch(JSON.stringify(other.logs), /private/);
});

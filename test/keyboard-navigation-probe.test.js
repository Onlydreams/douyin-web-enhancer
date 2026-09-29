'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const probeModule = require('../tools/keyboard-navigation-probe.user.js');

function nextCardEnvironment() {
  const env = environment('focus-pair');
  env.root.location.href += '&dwe_keyboard_wait=next-card';
  return env;
}

const trustedDown = { type: 'keydown', key: 'ArrowDown', isTrusted: true };

test('next-card waits for explicit navigation and starts stability timing on the new card', () => {
  const env = nextCardEnvironment();
  const probe = probeModule.bootstrap(env.root);
  assert.doesNotMatch(env.root.location.href, /dwe_keyboard/);
  env.advance(10_000);
  env.changeId('2222222222222222222'); // 自动连播不得启动实验。
  env.advance(1_000);
  assert.equal(env.events.length, 0);
  env.listeners.get('keydown')(trustedDown);
  env.changeId('3333333333333333333');
  env.advance(1_000);
  assert.equal(env.events.length, 0);
  env.advance(100);
  assert.equal(env.events.length, 2);
  env.changeId('4444444444444444444');
  env.advance(5_000);
  const report = probe.snapshot();
  assert.equal(report.outcome, 'one-change-observed');
  assert.equal(report.identityChanges, 1);
  assert.equal(report.dispatchElapsedMs - report.activationElapsedMs, 1_000);
  assert.equal(report.waitForNextCard, true);
  assert.equal(env.listeners.size, 0);
  assert.equal(env.timers.size, 0);
  assert.doesNotMatch(JSON.stringify(report), /2222222222222222222|3333333333333333333/);
});

test('next-card has a bounded idle wait and never dispatches without activation', () => {
  const env = nextCardEnvironment();
  const probe = probeModule.bootstrap(env.root);
  env.advance(35_000);
  assert.equal(probe.snapshot().outcome, 'activation-timeout');
  assert.equal(env.events.length, 0);
  assert.equal(env.listeners.size, 0);
  assert.equal(env.timers.size, 0);
});

test('next-card rejects navigation that did not change the active identity', () => {
  const env = nextCardEnvironment();
  const probe = probeModule.bootstrap(env.root);
  env.advance(1_000);
  env.listeners.get('keydown')(trustedDown);
  env.advance(3_000);
  assert.equal(probe.snapshot().outcome, 'activation-not-confirmed');
  assert.equal(env.events.length, 0);
});

test('next-card excludes repeat, modified and additional trusted inputs', () => {
  for (const input of [{ ...trustedDown, repeat: true }, { ...trustedDown, ctrlKey: true },
    { type: 'pointerdown', isTrusted: true }, trustedDown]) {
    const env = nextCardEnvironment();
    const probe = probeModule.bootstrap(env.root);
    if (input === trustedDown) env.listeners.get('keydown')(trustedDown);
    env.listeners.get(input.type)(input);
    env.advance(10_000);
    assert.equal(probe.snapshot().outcome, 'user-input');
    assert.equal(env.events.length, 0);
    assert.equal(env.listeners.size, 0);
  }
});

test('next-card preserves root, background and editable-focus cancellation', () => {
  for (const reason of ['root-changed', 'background', 'editable-focus']) {
    const env = nextCardEnvironment();
    const probe = probeModule.bootstrap(env.root);
    env.listeners.get('keydown')(trustedDown);
    if (reason === 'root-changed') env.replaceRoot();
    if (reason === 'background') env.doc.visibilityState = 'hidden';
    if (reason === 'editable-focus') env.doc.activeElement = { closest: () => true };
    env.changeId('2222222222222222222');
    env.advance(10_000);
    assert.equal(probe.snapshot().outcome, reason);
    assert.equal(env.events.length, 0);
    assert.equal(env.timers.size, 0);
  }
});

function environment(mode = 'body-down') {
  let now = 0;
  let timerId = 0;
  let id = '1234567890123456789';
  const timers = new Map();
  const listeners = new Map();
  const events = [];
  const logs = [];
  let timeOffset = 10;
  const video = {
    paused: false, ended: false, duration: 100, playbackRate: 1, readyState: 4,
    get currentTime() { return timeOffset + (this.paused ? 0 : now / 1_000 * this.playbackRate); },
    set currentTime(value) { timeOffset = value - now / 1_000 * this.playbackRate; },
  };
  const card = {
    getAttribute: () => id, querySelectorAll: () => [video],
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 600 }),
  };
  let feed = { querySelectorAll: () => [card] };
  let onDispatch = () => {};
  const body = {
    closest: () => false,
    dispatchEvent(event) { events.push(event); onDispatch(event); },
  };
  const doc = {
    body, activeElement: body, visibilityState: 'visible', hasFocus: () => true,
    querySelector: () => null,
    querySelectorAll(selector) { return selector === probeModule.ROOT ? [feed] : [video]; },
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type, callback) { if (listeners.get(type) === callback) listeners.delete(type); },
  };
  const root = {
    document: doc,
    location: { href: `https://www.douyin.com/?recommend=1&dwe_keyboard_probe=${mode}` },
    history: { state: null, replaceState(_state, _title, path) { root.location.href = new URL(path, root.location.href).href; } },
    performance: { now: () => now },
    console: { info: (...args) => logs.push(args) },
    KeyboardEvent: class { constructor(type, init) { Object.assign(this, { type, isTrusted: false }, init); } },
    setTimeout(callback, delay) { const key = ++timerId; timers.set(key, { callback, at: now + delay }); return key; },
    clearTimeout(key) { timers.delete(key); },
  };
  return {
    root, doc, video, card, events, listeners, timers, logs,
    changeId(next) { id = next; },
    replaceRoot() { feed = { querySelectorAll: () => [card] }; },
    onDispatch(callback) { onDispatch = callback; },
    advance(ms) {
      const end = now + ms;
      while (timers.size) {
        const [key, value] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (value.at > end) break;
        timers.delete(key);
        now = value.at;
        value.callback();
      }
      now = end;
    },
  };
}

test('normal, unsupported and invalid opt-in URLs are inert', () => {
  for (const href of ['https://www.douyin.com/?recommend=1', 'https://www.douyin.com/video/123?recommend=1&dwe_keyboard_probe=body-down', 'https://example.com/?recommend=1&dwe_keyboard_probe=body-down', 'https://www.douyin.com/?recommend=1&dwe_keyboard_probe=other']) {
    const env = environment();
    env.root.location.href = href;
    assert.equal(probeModule.bootstrap(env.root), null);
    assert.equal(env.timers.size, 0);
    assert.equal(env.listeners.size, 0);
  }
});

test('body scheme dispatches exactly one complete nontrusted keydown without retries', () => {
  const env = environment();
  const probe = probeModule.bootstrap(env.root);
  env.advance(16_000);
  assert.equal(env.events.length, 1);
  assert.deepEqual({ ...env.events[0] }, { type: 'keydown', isTrusted: false, key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true, cancelable: true, composed: false });
  assert.equal(probe.snapshot().outcome, 'not-confirmed');
  assert.equal(env.timers.size, 0);
  assert.equal(env.listeners.size, 0);
});

test('focus-pair scheme sends keydown then keyup to the focused noneditable element', () => {
  const env = environment('focus-pair');
  const focusedEvents = [];
  env.doc.activeElement = { closest: () => false, dispatchEvent: event => focusedEvents.push(event) };
  const probe = probeModule.bootstrap(env.root);
  env.advance(7_000);
  assert.deepEqual(focusedEvents.map(event => event.type), ['keydown', 'keyup']);
  assert.equal(focusedEvents.every(event => event.composed && !event.isTrusted), true);
  assert.equal(env.events.length, 0);
  assert.equal(probe.snapshot().targetKind, 'focused-element');
});

test('one identity change is observed with media counts and no identifiers or URLs in the report', () => {
  const env = environment();
  env.onDispatch(() => env.changeId('9876543210987654321'));
  const probe = probeModule.bootstrap(env.root);
  env.advance(7_000);
  assert.equal(probe.snapshot().outcome, 'one-change-observed');
  assert.deepEqual(probe.snapshot().afterMedia, { activeVideoCount: 1, activePlaying: 1, otherPlaying: 0 });
  assert.doesNotMatch(JSON.stringify(env.logs), /1234567890123456789|9876543210987654321|https:/);
});

test('baseline observes without generating events', () => {
  const env = environment('baseline');
  const probe = probeModule.bootstrap(env.root);
  env.advance(7_000);
  assert.equal(env.events.length, 0);
  assert.equal(probe.snapshot().outcome, 'baseline-stable');
});

test('multiple identity changes are not reported as a single successful navigation', () => {
  const env = environment();
  const probe = probeModule.bootstrap(env.root);
  env.advance(1_200);
  env.changeId('2222222222222222222');
  env.advance(200);
  env.changeId('3333333333333333333');
  env.advance(6_000);
  assert.equal(probe.snapshot().outcome, 'multiple-changes');
});

for (const reason of ['background', 'editable-focus', 'dialog-open', 'route-changed', 'root-changed']) {
  test(`${reason} aborts pending navigation and removes all work`, () => {
    const env = environment();
    const probe = probeModule.bootstrap(env.root);
    env.advance(200);
    if (reason === 'background') env.doc.visibilityState = 'hidden';
    if (reason === 'editable-focus') env.doc.activeElement = { closest: () => true };
    if (reason === 'dialog-open') env.doc.querySelector = () => ({});
    if (reason === 'route-changed') env.root.location.href = 'https://www.douyin.com/follow';
    if (reason === 'root-changed') env.replaceRoot();
    env.advance(7_000);
    assert.equal(env.events.length, 0);
    assert.equal(probe.snapshot().outcome, reason);
    assert.equal(env.listeners.size, 0);
    assert.equal(env.timers.size, 0);
  });
}

test('trusted input contaminates an observation; synthetic input does not', () => {
  const env = environment();
  const probe = probeModule.bootstrap(env.root);
  const listener = env.listeners.get('keydown');
  listener({ isTrusted: false });
  env.advance(1_200);
  assert.equal(env.events.length, 1);
  listener({ isTrusted: true });
  env.changeId('2222222222222222222');
  env.advance(7_000);
  assert.equal(probe.snapshot().outcome, 'user-input');
  assert.equal(env.listeners.size, 0);
});

test('near-end media is excluded to avoid attributing native autoplay to the probe', () => {
  const env = environment();
  env.video.currentTime = 95;
  const probe = probeModule.bootstrap(env.root);
  env.advance(7_000);
  assert.equal(env.events.length, 0);
  assert.equal(probe.snapshot().outcome, 'near-video-end');
});

test('manual stop prevents even an already queued callback from dispatching', () => {
  const env = environment();
  const probe = probeModule.bootstrap(env.root);
  const callback = [...env.timers.values()][0].callback;
  probe.stop();
  callback();
  assert.equal(env.events.length, 0);
  assert.equal(env.listeners.size, 0);
  assert.equal(probe.snapshot().outcome, 'stopped');
});

test('opt-in consumption failure prevents all side effects and duplicate bootstrap is inert', () => {
  const env = environment();
  env.root.history.replaceState = () => { throw new Error('private detail'); };
  assert.equal(probeModule.bootstrap(env.root), null);
  assert.equal(env.timers.size, 0);
  const fresh = environment();
  probeModule.bootstrap(fresh.root);
  assert.equal(probeModule.bootstrap(fresh.root), null);
  assert.equal(fresh.timers.size, 1);
});

test('dispatch errors are sanitized and do not retry', () => {
  const env = environment();
  env.onDispatch(() => { throw new Error('private detail'); });
  const probe = probeModule.bootstrap(env.root);
  env.advance(7_000);
  assert.equal(env.events.length, 1);
  assert.equal(probe.snapshot().outcome, 'probe-error');
  assert.doesNotMatch(JSON.stringify(env.logs), /private detail/);
  assert.equal(env.listeners.size, 0);
});

test('settled opt-in waits for eight seconds of playback and consumes both parameters', () => {
  const env = environment('focus-pair');
  env.root.location.href += '&dwe_keyboard_wait=settled';
  const probe = probeModule.bootstrap(env.root);
  assert.equal(env.root.location.href, 'https://www.douyin.com/?recommend=1');
  env.advance(8_000);
  assert.equal(env.events.length, 0);
  env.advance(100);
  assert.equal(env.events.length, 2);
  env.advance(5_000);
  assert.equal(probe.snapshot().stableWaitMs, 8_000);
  assert.equal(probe.snapshot().dispatchElapsedMs, 8_100);
  assert.equal(probe.snapshot().probeVersion, '0.3.0-test');
});

test('unknown delay cannot silently fall back to early dispatch', () => {
  const env = environment();
  env.root.location.href += '&dwe_keyboard_wait=invalid';
  assert.equal(probeModule.bootstrap(env.root), null);
  assert.equal(env.timers.size, 0);
  assert.equal(env.listeners.size, 0);
});

test('2x playback rejects video that has ten media seconds but less than ten wall seconds remaining', () => {
  const env = environment();
  env.video.playbackRate = 2;
  env.video.currentTime = 84;
  const probe = probeModule.bootstrap(env.root);
  env.advance(7_000);
  assert.equal(probe.snapshot().outcome, 'near-video-end');
  assert.equal(env.events.length, 0);
});

test('paused or unready playback times out without keyboard or leftover work', () => {
  for (const property of ['paused', 'readyState']) {
    const env = environment();
    env.video[property] = property === 'paused' ? true : 1;
    const probe = probeModule.bootstrap(env.root);
    env.advance(25_000);
    assert.equal(probe.snapshot().outcome, 'not-ready');
    assert.equal(env.events.length, 0);
    assert.equal(env.listeners.size, 0);
    assert.equal(env.timers.size, 0);
  }
});

test('buffering interruption restarts the continuous stability window', () => {
  const env = environment('focus-pair');
  env.root.location.href += '&dwe_keyboard_wait=settled';
  probeModule.bootstrap(env.root);
  env.advance(4_000);
  env.video.readyState = 1;
  env.advance(500);
  env.video.readyState = 4;
  env.advance(8_000);
  assert.equal(env.events.length, 0);
  env.advance(100);
  assert.equal(env.events.length, 2);
});

test('card animation restarts stability instead of dispatching mid-transition', () => {
  const env = environment();
  probeModule.bootstrap(env.root);
  env.advance(800);
  env.card.getBoundingClientRect = () => ({ top: 20, left: 0, width: 800, height: 600 });
  env.advance(1_000);
  assert.equal(env.events.length, 0);
  env.advance(100);
  assert.equal(env.events.length, 1);
});

test('first identity change latency and focus are captured without IDs', () => {
  const env = environment('focus-pair');
  env.doc.hasFocus = () => false;
  const probe = probeModule.bootstrap(env.root);
  env.advance(1_400);
  env.changeId('2222222222222222222');
  env.advance(5_000);
  assert.equal(probe.snapshot().firstChangeMs, 400);
  assert.equal(probe.snapshot().documentFocusedAtDispatch, false);
  assert.equal(probe.snapshot().beforePlayback.playbackRate, 1);
  assert.doesNotMatch(JSON.stringify(env.logs), /2222222222222222222/);
});

test('background cancels the long stability wait even if no next tick has fired', () => {
  const env = environment();
  env.root.location.href += '&dwe_keyboard_wait=settled';
  const probe = probeModule.bootstrap(env.root);
  env.advance(7_000);
  env.doc.visibilityState = 'hidden';
  env.listeners.get('visibilitychange')();
  env.advance(20_000);
  assert.equal(probe.snapshot().outcome, 'background');
  assert.equal(env.events.length, 0);
  assert.equal(env.timers.size, 0);
});

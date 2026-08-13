'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const stage2Navigation = require('../tools/stage2-navigation-probe.user.js');

function createFakeEnvironment(options = {}) {
  const href =
    options.href ??
    'https://www.douyin.com/?recommend=1&dwe_stage2_navigation_probe=native-click';
  const logs = [];
  const historyWrites = [];
  const timers = new Map();
  const observers = new Set();
  let timerId = 0;
  let nowMs = 100;
  let activeId = options.activeId ?? '1234567890123456789';
  let activeCount = options.activeCount ?? 1;
  let controlCount = options.controlCount ?? 1;
  let clickCount = 0;

  function notifyMutation() {
    for (const observer of [...observers]) {
      if (!observer.disconnected) observer.callback([]);
    }
  }

  const activeNode = {
    getAttribute(name) {
      return name === 'data-e2e-vid' ? activeId : null;
    },
  };

  const control = {
    isConnected: true,
    click() {
      clickCount += 1;
      if (options.clickError) throw options.clickError;
      if (options.nextActiveId) {
        activeId = options.nextActiveId;
        notifyMutation();
      }
    },
    getBoundingClientRect() {
      return options.controlRect ?? { width: 36, height: 40 };
    },
  };

  const document = {
    documentElement: {},
    querySelectorAll(selector) {
      if (selector === stage2Navigation.ACTIVE_VIDEO_SELECTOR) {
        return Array.from({ length: activeCount }, () => activeNode);
      }
      if (selector === stage2Navigation.NEXT_CONTROL_SELECTOR) {
        return Array.from({ length: controlCount }, () => control);
      }
      throw new Error(`unexpected selector: ${selector}`);
    },
  };

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observers.add(this);
    }

    observe() {}

    disconnect() {
      this.disconnected = true;
      observers.delete(this);
    }
  }

  const root = {
    location: { href },
    history: {
      state: { preserved: true },
      replaceState(state, title, nextUrl) {
        if (options.historyError) throw options.historyError;
        historyWrites.push({ state, title, nextUrl });
      },
    },
    document,
    MutationObserver: FakeMutationObserver,
    performance: { now: () => nowMs },
    setTimeout(callback, delay) {
      timerId += 1;
      timers.set(timerId, { callback, delay });
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    getComputedStyle() {
      return (
        options.controlStyle ?? {
          display: 'block',
          visibility: 'visible',
          pointerEvents: 'auto',
        }
      );
    },
    console: {
      info(...args) {
        logs.push(args);
      },
    },
  };

  return {
    root,
    document,
    logs,
    historyWrites,
    timers,
    get clickCount() {
      return clickCount;
    },
    setActiveId(nextId) {
      activeId = nextId;
      notifyMutation();
    },
    setCounts(nextActiveCount, nextControlCount) {
      activeCount = nextActiveCount;
      controlCount = nextControlCount;
      notifyMutation();
    },
    advance(ms) {
      nowMs += ms;
    },
    runTimerWithDelay(delay) {
      const timer = [...timers.entries()].find(([, value]) => value.delay === delay);
      assert.ok(timer, `expected a ${delay}ms timer`);
      timers.delete(timer[0]);
      timer[1].callback();
    },
  };
}

test('ordinary routes are completely inert', () => {
  const environment = createFakeEnvironment({
    href: 'https://www.douyin.com/?recommend=1',
  });

  assert.equal(stage2Navigation.bootstrap(environment.root), null);
  assert.equal(environment.root[stage2Navigation.API_KEY], undefined);
  assert.equal(environment.historyWrites.length, 0);
  assert.equal(environment.clickCount, 0);
  assert.equal(environment.timers.size, 0);
  assert.equal(environment.logs.length, 0);
});

test('unsupported explicit routes do not consume opt-in or click', () => {
  const environment = createFakeEnvironment({
    href: 'https://www.douyin.com/video/123?dwe_stage2_navigation_probe=native-click',
  });

  assert.equal(stage2Navigation.bootstrap(environment.root), null);
  assert.equal(environment.historyWrites.length, 0);
  assert.equal(environment.clickCount, 0);
  assert.equal(JSON.parse(environment.logs[0][1]).outcome, 'unsupported-route');
});

test('successful probe consumes opt-in, clicks once, and confirms an opaque identity change', () => {
  const beforeId = '1234567890123456789';
  const afterId = '9876543210987654321';
  const environment = createFakeEnvironment({
    activeId: beforeId,
    nextActiveId: afterId,
  });

  const probe = stage2Navigation.bootstrap(environment.root);
  const report = probe.snapshot();

  assert.equal(environment.historyWrites.length, 1);
  assert.deepEqual(environment.historyWrites[0], {
    state: { preserved: true },
    title: '',
    nextUrl: '/?recommend=1',
  });
  assert.equal(environment.clickCount, 1);
  assert.equal(report.outcome, 'confirmed');
  assert.equal(report.clickCount, 1);
  assert.equal(report.activeIdentityChanged, true);
  assert.deepEqual(report.state.activeIdShape, {
    present: true,
    decimal: true,
    length: 19,
  });
  assert.equal(JSON.stringify(report).includes(beforeId), false);
  assert.equal(JSON.stringify(report).includes(afterId), false);
  assert.equal(environment.timers.size, 0);
});

test('an unchanged active identity times out without a second click', () => {
  const environment = createFakeEnvironment();
  const probe = stage2Navigation.bootstrap(environment.root);

  assert.equal(environment.clickCount, 1);
  assert.equal(probe.snapshot(), null);

  environment.advance(3_000);
  environment.runTimerWithDelay(3_000);

  assert.equal(environment.clickCount, 1);
  assert.equal(probe.snapshot().outcome, 'not-confirmed');
  assert.equal(probe.snapshot().activeIdentityChanged, false);
});

test('ambiguous initial state waits, then fails closed without clicking', () => {
  const environment = createFakeEnvironment({ activeCount: 2 });
  const probe = stage2Navigation.bootstrap(environment.root);

  assert.equal(environment.clickCount, 0);
  environment.advance(10_000);
  environment.runTimerWithDelay(10_000);

  assert.equal(environment.clickCount, 0);
  assert.equal(probe.snapshot().outcome, 'not-ready');
  assert.equal(probe.snapshot().state.activeCount, 2);
});

test('a late-ready unique state still permits only one click', () => {
  const environment = createFakeEnvironment({ activeCount: 0, controlCount: 0 });
  const probe = stage2Navigation.bootstrap(environment.root);

  environment.setCounts(1, 1);
  environment.setActiveId('9876543210987654321');

  assert.equal(environment.clickCount, 1);
  environment.setActiveId('1111111111111111111');
  assert.equal(probe.snapshot().outcome, 'confirmed');
  assert.equal(environment.clickCount, 1);
});

test('click exceptions are sanitized and never retried', () => {
  const privateMessage = 'private page details';
  const environment = createFakeEnvironment({
    clickError: new TypeError(privateMessage),
  });
  const probe = stage2Navigation.bootstrap(environment.root);
  const serialized = JSON.stringify(probe.snapshot());

  assert.equal(environment.clickCount, 1);
  assert.equal(probe.snapshot().outcome, 'click-error');
  assert.equal(probe.snapshot().errorName, 'TypeError');
  assert.equal(serialized.includes(privateMessage), false);
});

test('failure to consume the opt-in parameter prevents navigation', () => {
  const privateMessage = 'history state internals';
  const environment = createFakeEnvironment({
    historyError: new Error(privateMessage),
  });

  assert.equal(stage2Navigation.bootstrap(environment.root), null);
  assert.equal(environment.clickCount, 0);
  assert.equal(environment.root[stage2Navigation.API_KEY], undefined);
  const serialized = environment.logs[0][1];
  assert.equal(JSON.parse(serialized).outcome, 'opt-in-not-consumed');
  assert.equal(serialized.includes(privateMessage), false);
});

test('stop disconnects all work and prevents late navigation', () => {
  const environment = createFakeEnvironment({ activeCount: 0, controlCount: 0 });
  const probe = stage2Navigation.bootstrap(environment.root);

  assert.equal(probe.stop(), true);
  environment.setCounts(1, 1);

  assert.equal(environment.clickCount, 0);
  assert.equal(environment.timers.size, 0);
  assert.equal(probe.snapshot(), null);
  assert.equal(probe.stop(), false);
});

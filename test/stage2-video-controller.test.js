'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const enhancer = require('../douyin-web-enhancer.user.js');

function createElement(options = {}) {
  const attributes = new Map(Object.entries(options.attributes ?? {}));
  const childrenBySelector = new Map();
  const eventListeners = new Map();
  const appended = [];

  const element = {
    nodeType: 1,
    parentElement: options.parentElement ?? null,
    textContent: options.textContent ?? '',
    isConnected: options.isConnected ?? true,
    style: {},
    appended,
    clickCount: 0,
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    append(node) {
      appended.push(node);
      node.parentElement = this;
      node.isConnected = true;
    },
    remove() {
      this.isConnected = false;
    },
    addEventListener(type, callback) {
      const values = eventListeners.get(type) ?? [];
      values.push(callback);
      eventListeners.set(type, values);
    },
    removeEventListener(type, callback) {
      eventListeners.set(
        type,
        (eventListeners.get(type) ?? []).filter((value) => value !== callback),
      );
    },
    dispatch(type, event = {}) {
      for (const callback of eventListeners.get(type) ?? []) {
        callback({ type, target: this, ...event });
      }
    },
    click() {
      this.clickCount += 1;
      options.onClick?.();
    },
    getBoundingClientRect() {
      return options.rect ?? { width: 36, height: 40 };
    },
    matches(selector) {
      if (options.matches) return options.matches(selector, this);
      return false;
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (current.matches?.(selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
    contains(node) {
      let current = node;
      while (current) {
        if (current === this) return true;
        current = current.parentElement;
      }
      return false;
    },
    querySelectorAll(selector) {
      if (childrenBySelector.has(selector)) {
        return childrenBySelector.get(selector);
      }
      return [];
    },
    setQuery(selector, nodes) {
      childrenBySelector.set(selector, nodes);
      for (const node of nodes) {
        if (!node.parentElement) node.parentElement = this;
      }
    },
  };

  Object.defineProperty(element, 'id', {
    get: () => attributes.get('id') ?? '',
    set: (value) => attributes.set('id', String(value)),
  });
  return element;
}

function createCard(id, text = '允许内容', rect) {
  const description = createElement({ textContent: text });
  description.setQuery(enhancer.PAGE_SELECTORS.hashtagLink, []);
  const identityLink = createElement({
    attributes: { href: `/video/${id}?aweme_id=${id}` },
  });
  const card = createElement({
    rect,
    attributes: {
      'data-e2e': 'feed-video',
      'data-e2e-vid': id,
    },
    matches(selector, node) {
      if (selector === enhancer.PAGE_SELECTORS.feedCard) {
        return (
          ['feed-video', 'feed-active-video'].includes(
            node.getAttribute('data-e2e'),
          ) && enhancer.isValidVideoId(node.getAttribute('data-e2e-vid'))
        );
      }
      if (selector === enhancer.PAGE_SELECTORS.activeCard) {
        return node.getAttribute('data-e2e') === 'feed-active-video';
      }
      return false;
    },
  });
  card.setQuery(enhancer.PAGE_SELECTORS.videoDescription, [description]);
  card.setQuery(enhancer.PAGE_SELECTORS.videoIdentityLink, [identityLink]);
  return { card, description };
}

function createControllerHarness(options = {}) {
  const listeners = new Map();
  const timers = new Map();
  const intervals = new Map();
  const frames = new Map();
  const observers = new Set();
  let nextTimerId = 1;
  let nowMs = 0;
  let activeCard = options.activeCard;
  let emitBgmMetadata = () => {};
  const cards = options.cards;
  const nextControl = createElement({
    matches(selector) {
      return selector === enhancer.PAGE_SELECTORS.nextControl;
    },
    onClick() {
      options.onClick?.();
      if (!options.autoAdvance) return;
      const currentIndex = cards.indexOf(activeCard);
      const nextCard = cards[currentIndex + 1];
      if (nextCard) switchActive(nextCard);
    },
  });
  const previousControl = createElement({
    matches(selector) {
      return selector === enhancer.PAGE_SELECTORS.previousControl;
    },
    onClick() {
      options.onPreviousClick?.();
      if (!options.autoAdvance) return;
      const currentIndex = cards.indexOf(activeCard);
      const previousCard = cards[currentIndex - 1];
      if (previousCard) switchActive(previousCard);
    },
  });
  const rootElement = createElement({
    attributes: { 'data-e2e': 'slideList', 'data-active': 'true' },
  });
  rootElement.setQuery(enhancer.PAGE_SELECTORS.feedCard, cards);
  rootElement.setQuery(enhancer.PAGE_SELECTORS.activeCard, [activeCard]);
  rootElement.isConnected = true;

  const documentElement = createElement();
  const document = {
    visibilityState: options.visibilityState ?? 'visible',
    documentElement,
    createElement: () => createElement({ isConnected: false }),
    querySelectorAll(selector) {
      if (selector === enhancer.PAGE_SELECTORS.feedRoot) return [rootElement];
      if (selector === enhancer.PAGE_SELECTORS.nextControl) return [nextControl];
      if (selector === enhancer.PAGE_SELECTORS.previousControl) return [previousControl];
      return [];
    },
    addEventListener(type, callback) {
      const values = listeners.get(type) ?? [];
      values.push(callback);
      listeners.set(type, values);
    },
    removeEventListener(type, callback) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((value) => value !== callback),
      );
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
    document,
    location: { href: 'https://www.douyin.com/?recommend=1' },
    performance: { now: () => nowMs },
    MutationObserver: FakeMutationObserver,
    console: { error() {}, warn() {} },
    getComputedStyle: () => ({
      display: 'block',
      visibility: 'visible',
      pointerEvents: 'auto',
    }),
    addEventListener(type, callback) {
      const values = listeners.get(type) ?? [];
      values.push(callback);
      listeners.set(type, values);
    },
    removeEventListener(type, callback) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((value) => value !== callback),
      );
    },
  };

  function setTimeoutFake(callback, delay) {
    const id = nextTimerId++;
    timers.set(id, { callback, delay });
    return id;
  }

  const controller = enhancer.createPageController(root, {
    document,
    MutationObserver: FakeMutationObserver,
    now: () => nowMs,
    setTimeout: setTimeoutFake,
    clearTimeout: (id) => timers.delete(id),
    setInterval(callback, delay) {
      const id = nextTimerId++;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
    requestAnimationFrame(callback) {
      const id = nextTimerId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    createBgmTransportObserver(_pageRoot, observerOptions) {
      emitBgmMetadata = observerOptions.onMetadata;
      let observing = false;
      return {
        start() { observing = true; return true; },
        stop() { observing = false; return true; },
        emit(items) { if (observing) emitBgmMetadata(items); },
      };
    },
  });

  function flushFrames() {
    while (frames.size > 0) {
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, callback] of pending) callback(nowMs);
    }
  }

  function switchActive(nextCard) {
    activeCard.setAttribute('data-e2e', 'feed-video');
    nextCard.setAttribute('data-e2e', 'feed-active-video');
    activeCard = nextCard;
    rootElement.setQuery(enhancer.PAGE_SELECTORS.activeCard, [activeCard]);
    for (const observer of [...observers]) observer.callback([]);
    for (const interval of intervals.values()) interval.callback();
    flushFrames();
  }

  return {
    controller,
    document,
    root,
    rootElement,
    nextControl,
    previousControl,
    timers,
    intervals,
    observers,
    frames,
    flushFrames,
    switchActive,
    advance(ms) {
      nowMs += ms;
    },
    fireTimersByDelay(delay) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay === delay) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    dispatch(type, event = {}) {
      for (const callback of listeners.get(type) ?? []) {
        callback({ type, ...event });
      }
    },
    emitBgm(items) {
      emitBgmMetadata(items);
      flushFrames();
    },
  };
}

function settings(videoKeywords, enabled = true) {
  return enhancer.createSettingsSnapshot({
    video: { enabled, keywords: videoKeywords },
    danmaku: { enabled: true, keywords: '' },
    bgm: { enabled: true, keywords: '' },
  });
}

function combinedSettings(videoKeywords, bgmKeywords) {
  return enhancer.createSettingsSnapshot({
    video: { enabled: Boolean(videoKeywords), keywords: videoKeywords },
    danmaku: { enabled: false, keywords: '' },
    bgm: { enabled: Boolean(bgmKeywords), keywords: bgmKeywords },
  });
}

test('BGM metadata uses the same navigation path as a video keyword hit', () => {
  const first = createCard('1111111111111111111', '允许内容').card;
  const second = createCard('2222222222222222222', '允许内容').card;
  first.setAttribute('data-e2e', 'feed-active-video');
  const harness = createControllerHarness({ cards: [first, second], activeCard: first });
  harness.controller.start(combinedSettings('', '目标音乐'));
  harness.flushFrames();
  assert.equal(harness.controller.snapshot().currentState, 'pending');

  harness.emitBgm([{
    awemeId: '1111111111111111111',
    musicTitle: '原声名称',
    musicName: '',
    relatedMusicTitle: '目标音乐',
  }]);

  assert.equal(harness.nextControl.clickCount, 1);
  assert.equal(harness.controller.snapshot().currentState, 'navigating');
});

test('BGM association fails open when a descendant identity conflicts with the card', () => {
  const id = '1111111111111111111';
  const { card } = createCard(id, '允许内容');
  card.setAttribute('data-e2e', 'feed-active-video');
  card.setQuery(enhancer.PAGE_SELECTORS.videoIdentityLink, [
    createElement({
      attributes: {
        href: '/video/2222222222222222222?gid=2222222222222222222',
      },
    }),
  ]);
  const second = createCard('3333333333333333333', '允许内容').card;
  const harness = createControllerHarness({ cards: [card, second], activeCard: card });

  harness.controller.start(combinedSettings('', '目标音乐'));
  harness.flushFrames();
  harness.emitBgm([{
    awemeId: id,
    musicTitle: '目标音乐',
    musicName: '',
  }]);

  assert.equal(harness.nextControl.clickCount, 0);
  assert.equal(harness.controller.snapshot().currentState, 'allow');
});

test('video keyword hits immediately without waiting for BGM', () => {
  const first = createCard('1111111111111111111', '视频命中').card;
  const second = createCard('2222222222222222222', '允许内容').card;
  first.setAttribute('data-e2e', 'feed-active-video');
  const harness = createControllerHarness({ cards: [first, second], activeCard: first });
  harness.controller.start(combinedSettings('视频命中', '尚未到达'));
  harness.flushFrames();
  assert.equal(harness.nextControl.clickCount, 1);
  assert.equal(harness.controller.snapshot().currentState, 'navigating');
});

test('late BGM cannot ambush an epoch after its 250ms bypass', () => {
  const first = createCard('1111111111111111111', '允许内容').card;
  const second = createCard('2222222222222222222', '允许内容').card;
  first.setAttribute('data-e2e', 'feed-active-video');
  const harness = createControllerHarness({ cards: [first, second], activeCard: first });
  harness.controller.start(combinedSettings('', '目标音乐'));
  harness.flushFrames();
  harness.advance(250);
  harness.fireTimersByDelay(250);
  assert.equal(harness.controller.snapshot().currentState, 'bypass');

  harness.emitBgm([{
    awemeId: '1111111111111111111',
    musicTitle: '目标音乐',
    musicName: '',
  }]);
  assert.equal(harness.nextControl.clickCount, 0);
  assert.equal(harness.controller.snapshot().currentState, 'bypass');
});

test('video extraction reads only video-desc and hashtag links', () => {
  const { card, description } = createCard('1234567890123456789', '标题 #话题');
  const hashtag = createElement({ textContent: '#话题' });
  description.setQuery(enhancer.PAGE_SELECTORS.hashtagLink, [hashtag]);
  card.textContent = '作者命中';

  assert.deepEqual(enhancer.extractVideoFields(card), {
    status: 'ready',
    fields: { title: '', description: '标题 #话题', hashtags: ['#话题'] },
  });
  assert.equal(
    enhancer.evaluateVideoFields(
      enhancer.extractVideoFields(card).fields,
      settings('作者命中').video,
    ),
    false,
  );
});

test('a blocked active video requests exactly one next action until confirmation', () => {
  const first = createCard('1111111111111111111', '命中内容').card;
  const second = createCard('2222222222222222222', '允许内容').card;
  first.setAttribute('data-e2e', 'feed-active-video');
  const harness = createControllerHarness({ cards: [first, second], activeCard: first });

  harness.controller.start(settings('命中'));
  harness.flushFrames();

  assert.equal(harness.nextControl.clickCount, 1);
  assert.equal(first.getAttribute(enhancer.VIDEO_STATE_ATTRIBUTE), 'navigating');
  assert.equal(harness.controller.snapshot().navigationAttempts, 1);

  for (const observer of [...harness.observers]) observer.callback([]);
  assert.equal(harness.nextControl.clickCount, 1);

  harness.switchActive(second);
  assert.equal(harness.controller.snapshot().currentState, 'allow');
  assert.equal(harness.controller.snapshot().skipCount, 1);
  assert.equal(first.getAttribute(enhancer.VIDEO_STATE_ATTRIBUTE), null);
  assert.equal(second.getAttribute(enhancer.VIDEO_STATE_ATTRIBUTE), 'allow');
});

test('downward intent merges a known blocked next card into one transition', () => {
  const first = createCard('1111111111111111111', '允许内容', {
    top: 0,
    bottom: 1_000,
    width: 1_000,
    height: 1_000,
  }).card;
  const blocked = createCard('2222222222222222222', '命中内容', {
    top: 1_000,
    bottom: 2_000,
    width: 1_000,
    height: 1_000,
  }).card;
  const third = createCard('3333333333333333333', '允许内容', {
    top: 2_000,
    bottom: 3_000,
    width: 1_000,
    height: 1_000,
  }).card;
  first.setAttribute('data-e2e', 'feed-active-video');
  const harness = createControllerHarness({
    cards: [first, blocked, third],
    activeCard: first,
    autoAdvance: true,
  });
  harness.controller.start(settings('命中'));
  harness.flushFrames();

  let prevented = 0;
  let propagationStopped = 0;
  harness.dispatch('click', {
    isTrusted: true,
    target: harness.nextControl,
    preventDefault() { prevented += 1; },
    stopImmediatePropagation() { propagationStopped += 1; },
  });

  assert.equal(harness.nextControl.clickCount, 1);
  assert.equal(harness.controller.snapshot().currentState, 'block');
  assert.equal(prevented, 1);
  assert.equal(propagationStopped, 1);
  harness.rootElement.dispatch('transitionend', { propertyName: 'transform' });
  assert.equal(harness.nextControl.clickCount, 2);
  assert.equal(harness.controller.snapshot().currentState, 'allow');
  assert.equal(third.getAttribute(enhancer.VIDEO_STATE_ATTRIBUTE), 'allow');
  assert.equal(harness.controller.snapshot().skipCount, 1);
  assert.equal(blocked.getAttribute(enhancer.VIDEO_STATE_ATTRIBUTE), null);
});

test('consecutive blocked cards keep the predictive direction and settle each transition', () => {
  const first = createCard('1111111111111111111', '允许内容', {
    top: 0, bottom: 1_000, width: 1_000, height: 1_000,
  }).card;
  const blockedA = createCard('2222222222222222222', '命中内容 A', {
    top: 1_000, bottom: 2_000, width: 1_000, height: 1_000,
  }).card;
  const blockedB = createCard('3333333333333333333', '命中内容 B', {
    top: 2_000, bottom: 3_000, width: 1_000, height: 1_000,
  }).card;
  const last = createCard('4444444444444444444', '允许内容', {
    top: 3_000, bottom: 4_000, width: 1_000, height: 1_000,
  }).card;
  first.setAttribute('data-e2e', 'feed-active-video');
  const harness = createControllerHarness({
    cards: [first, blockedA, blockedB, last],
    activeCard: first,
    autoAdvance: true,
  });
  harness.controller.start(settings('命中'));
  harness.flushFrames();

  harness.dispatch('click', {
    isTrusted: true,
    target: harness.nextControl,
    preventDefault() {},
    stopImmediatePropagation() {},
  });
  assert.equal(harness.nextControl.clickCount, 1);
  assert.equal(harness.controller.snapshot().currentState, 'block');

  harness.rootElement.dispatch('transitionend', { propertyName: 'transform' });
  assert.equal(harness.nextControl.clickCount, 2);
  assert.equal(harness.controller.snapshot().currentState, 'block');

  harness.rootElement.dispatch('transitionend', { propertyName: 'transform' });
  assert.equal(harness.nextControl.clickCount, 3);
  assert.equal(harness.controller.snapshot().currentState, 'allow');
  assert.equal(harness.controller.snapshot().skipCount, 2);
  assert.equal(blockedA.getAttribute(enhancer.VIDEO_STATE_ATTRIBUTE), null);
  assert.equal(blockedB.getAttribute(enhancer.VIDEO_STATE_ATTRIBUTE), null);
});

test('upward intent skips a known blocked previous card without reversing direction', () => {
  const first = createCard('1111111111111111111', '允许内容', {
    top: 0, bottom: 1_000, width: 1_000, height: 1_000,
  }).card;
  const blocked = createCard('2222222222222222222', '命中内容', {
    top: 1_000, bottom: 2_000, width: 1_000, height: 1_000,
  }).card;
  const third = createCard('3333333333333333333', '允许内容', {
    top: 2_000, bottom: 3_000, width: 1_000, height: 1_000,
  }).card;
  third.setAttribute('data-e2e', 'feed-active-video');
  const harness = createControllerHarness({
    cards: [first, blocked, third], activeCard: third, autoAdvance: true,
  });
  harness.controller.start(settings('命中'));
  harness.flushFrames();

  let prevented = 0;
  harness.dispatch('click', {
    isTrusted: true,
    target: harness.previousControl,
    preventDefault() { prevented += 1; },
    stopImmediatePropagation() {},
  });

  assert.equal(harness.previousControl.clickCount, 1);
  assert.equal(harness.controller.snapshot().currentState, 'block');
  assert.equal(prevented, 1);
  harness.rootElement.dispatch('transitionend', { propertyName: 'transform' });
  assert.equal(harness.previousControl.clickCount, 2);
  assert.equal(harness.controller.snapshot().currentState, 'allow');
  assert.equal(first.getAttribute(enhancer.VIDEO_STATE_ATTRIBUTE), 'allow');
  assert.equal(blocked.getAttribute(enhancer.VIDEO_STATE_ATTRIBUTE), null);
});

test('navigation retries once then fails open', () => {
  const first = createCard('1111111111111111111', '命中内容').card;
  const second = createCard('2222222222222222222', '允许内容').card;
  first.setAttribute('data-e2e', 'feed-active-video');
  const harness = createControllerHarness({ cards: [first, second], activeCard: first });
  harness.controller.start(settings('命中'));
  harness.flushFrames();

  harness.fireTimersByDelay(2_500);
  assert.equal(harness.nextControl.clickCount, 2);
  harness.fireTimersByDelay(2_500);

  assert.equal(harness.nextControl.clickCount, 2);
  assert.equal(harness.controller.snapshot().currentState, 'bypass');
  assert.equal(first.getAttribute(enhancer.VIDEO_STATE_ATTRIBUTE), 'bypass');
});

test('updating video rules does not ambush the current allowed epoch', () => {
  const first = createCard('1111111111111111111', '后来命中').card;
  const second = createCard('2222222222222222222', '后来命中').card;
  const third = createCard('3333333333333333333', '允许内容').card;
  first.setAttribute('data-e2e', 'feed-active-video');
  const harness = createControllerHarness({
    cards: [first, second, third],
    activeCard: first,
  });
  harness.controller.start(settings('旧词'));
  harness.flushFrames();

  harness.controller.updateSettings(settings('后来命中'));

  assert.equal(harness.nextControl.clickCount, 0);
  assert.equal(harness.controller.snapshot().currentState, 'allow');
  assert.equal(first.getAttribute(enhancer.VIDEO_STATE_ATTRIBUTE), 'allow');
  assert.equal(second.getAttribute(enhancer.VIDEO_STATE_ATTRIBUTE), 'block');

  harness.switchActive(second);
  assert.equal(harness.nextControl.clickCount, 1);
});

test('enabling the first video rule preserves the current card but reevaluates it after return', () => {
  const first = createCard('1111111111111111111', '后来命中').card;
  const second = createCard('2222222222222222222', '允许内容').card;
  const third = createCard('3333333333333333333', '允许内容').card;
  first.setAttribute('data-e2e', 'feed-active-video');
  const harness = createControllerHarness({
    cards: [first, second, third],
    activeCard: first,
  });
  harness.controller.start(settings('', false));
  harness.flushFrames();

  harness.controller.updateSettings(settings('后来命中'));
  harness.flushFrames();

  assert.equal(harness.nextControl.clickCount, 0);
  assert.equal(harness.controller.snapshot().currentState, 'bypass');
  assert.equal(first.getAttribute(enhancer.VIDEO_STATE_ATTRIBUTE), 'bypass');

  harness.switchActive(second);
  harness.rootElement.setQuery(enhancer.PAGE_SELECTORS.feedCard, [second, first, third]);
  harness.switchActive(first);

  assert.equal(harness.nextControl.clickCount, 1);
  assert.equal(harness.controller.snapshot().currentState, 'navigating');
});

test('hidden documents immediately retire navigation and fail open', () => {
  const first = createCard('1111111111111111111', '命中内容').card;
  const second = createCard('2222222222222222222', '允许内容').card;
  first.setAttribute('data-e2e', 'feed-active-video');
  const harness = createControllerHarness({ cards: [first, second], activeCard: first });
  harness.controller.start(settings('命中'));
  harness.flushFrames();

  harness.document.visibilityState = 'hidden';
  harness.dispatch('visibilitychange');

  assert.equal(harness.controller.snapshot().currentState, null);
  assert.equal(harness.controller.snapshot().ownedCardCount, 0);
  assert.equal(first.hasAttribute(enhancer.VIDEO_STATE_ATTRIBUTE), false);
  assert.equal(harness.timers.size, 0);
  assert.equal([...harness.observers].length, 0);
});

test('stopping or disabling restores owned DOM and releases lifecycle resources', () => {
  const first = createCard('1111111111111111111', '允许内容').card;
  const second = createCard('2222222222222222222', '允许内容').card;
  first.setAttribute('data-e2e', 'feed-active-video');
  const harness = createControllerHarness({ cards: [first, second], activeCard: first });
  harness.controller.start(settings('不命中'));
  harness.flushFrames();

  assert.ok(harness.controller.snapshot().ownedCardCount > 0);
  harness.controller.updateSettings(settings('', false));
  assert.equal(harness.controller.snapshot().ownedCardCount, 0);
  assert.equal(harness.intervals.size, 0);
  assert.equal([...harness.observers].length, 0);
  assert.equal(first.hasAttribute(enhancer.VIDEO_STATE_ATTRIBUTE), false);

  assert.equal(harness.controller.stop(), true);
  assert.equal(harness.controller.stop(), false);
});

test('empty descriptions stay pending, then watchdog bypasses without navigation', () => {
  const first = createCard('1111111111111111111', '').card;
  const second = createCard('2222222222222222222', '允许内容').card;
  first.setAttribute('data-e2e', 'feed-active-video');
  const harness = createControllerHarness({ cards: [first, second], activeCard: first });

  harness.controller.start(settings('命中'));
  harness.flushFrames();
  assert.equal(harness.controller.snapshot().currentState, 'pending');
  assert.equal(harness.nextControl.clickCount, 0);

  harness.advance(250);
  harness.fireTimersByDelay(250);
  assert.equal(harness.controller.snapshot().currentState, 'bypass');
  assert.equal(first.getAttribute(enhancer.VIDEO_STATE_ATTRIBUTE), 'bypass');
  assert.equal(harness.nextControl.clickCount, 0);
});

test('a blocked active card uses the semantic next control even when it is last in DOM order', () => {
  const previous = createCard('1111111111111111111', '允许内容').card;
  const active = createCard('2222222222222222222', '命中内容').card;
  active.setAttribute('data-e2e', 'feed-active-video');
  const harness = createControllerHarness({
    cards: [previous, active],
    activeCard: active,
  });

  harness.controller.start(settings('命中'));
  harness.flushFrames();

  assert.equal(harness.nextControl.clickCount, 1);
  assert.equal(harness.controller.snapshot().currentState, 'navigating');
  assert.equal(active.getAttribute(enhancer.VIDEO_STATE_ATTRIBUTE), 'navigating');
});

test('returning to a previously allowed card creates a new epoch under current settings', () => {
  const first = createCard('1111111111111111111', '后来命中').card;
  const second = createCard('2222222222222222222', '允许内容').card;
  const third = createCard('3333333333333333333', '允许内容').card;
  first.setAttribute('data-e2e', 'feed-active-video');
  const harness = createControllerHarness({
    cards: [first, second, third],
    activeCard: first,
  });
  harness.controller.start(settings('旧词'));
  harness.flushFrames();
  harness.controller.updateSettings(settings('后来命中'));

  harness.switchActive(second);
  harness.rootElement.setQuery(enhancer.PAGE_SELECTORS.feedCard, [second, first, third]);
  harness.switchActive(first);

  assert.equal(harness.nextControl.clickCount, 1);
  assert.equal(harness.controller.snapshot().currentState, 'navigating');
});

test('late root callbacks cannot operate after the generation is retired', () => {
  const first = createCard('1111111111111111111', '命中内容').card;
  const second = createCard('2222222222222222222', '允许内容').card;
  first.setAttribute('data-e2e', 'feed-active-video');
  const harness = createControllerHarness({ cards: [first, second], activeCard: first });
  harness.controller.start(settings('命中'));
  harness.flushFrames();
  const callbacks = [...harness.observers].map((observer) => observer.callback);

  harness.document.visibilityState = 'hidden';
  harness.dispatch('visibilitychange');
  for (const callback of callbacks) callback([]);
  harness.fireTimersByDelay(2_500);

  assert.equal(harness.nextControl.clickCount, 1);
  assert.equal(harness.controller.snapshot().currentState, null);
  assert.equal(harness.controller.snapshot().ownedCardCount, 0);
});

test('twelve confirmed skips trip the fuse before a thirteenth click', () => {
  const cards = Array.from({ length: 14 }, (_, index) =>
    createCard(String(10_000_000_000 + index), '命中内容').card,
  );
  cards[0].setAttribute('data-e2e', 'feed-active-video');
  const harness = createControllerHarness({
    cards,
    activeCard: cards[0],
    autoAdvance: true,
  });

  harness.controller.start(settings('命中'));
  harness.flushFrames();

  assert.equal(harness.nextControl.clickCount, 12);
  assert.equal(harness.controller.snapshot().skipCount, 12);
  assert.equal(harness.controller.snapshot().fuseTripped, true);
  assert.equal(harness.controller.snapshot().currentState, 'bypass');

  harness.controller.updateSettings(settings('另一个词'));
  assert.equal(harness.controller.snapshot().fuseTripped, false);
  assert.equal(harness.controller.snapshot().skipCount, 0);
});

test('reused card nodes cannot inherit a prior video decision', () => {
  const reused = createCard('1111111111111111111', '允许内容').card;
  const next = createCard('2222222222222222222', '允许内容').card;
  const tail = createCard('3333333333333333333', '允许内容').card;
  reused.setAttribute('data-e2e', 'feed-active-video');
  const harness = createControllerHarness({
    cards: [reused, next, tail],
    activeCard: reused,
  });
  harness.controller.start(settings('命中内容'));
  harness.flushFrames();
  assert.equal(harness.controller.snapshot().currentState, 'allow');

  harness.switchActive(next);
  reused.setAttribute('data-e2e-vid', '4444444444444444444');
  reused.setQuery(
    enhancer.PAGE_SELECTORS.videoDescription,
    [createElement({ textContent: '命中内容' })],
  );
  harness.rootElement.setQuery(enhancer.PAGE_SELECTORS.feedCard, [next, reused, tail]);
  harness.switchActive(reused);

  assert.equal(harness.nextControl.clickCount, 1);
  assert.equal(harness.controller.snapshot().currentState, 'navigating');
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const enhancer = require('../douyin-web-enhancer.user.js');

const DANMAKU_ROOT_ATTRIBUTE = 'data-dwe-danmaku-active';
const DANMAKU_STATE_ATTRIBUTE = 'data-dwe-danmaku-state';

function createElement(options = {}) {
  const attributes = new Map(Object.entries(options.attributes ?? {}));
  const childrenBySelector = new Map();
  const element = {
    nodeType: 1,
    parentElement: null,
    isConnected: options.isConnected ?? true,
    textContent: options.textContent ?? '',
    get children() {
      return [...new Set([...childrenBySelector.values()].flat())].filter(
        (node) => node.parentElement === this,
      );
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    remove() {
      this.isConnected = false;
    },
    append(node) {
      node.parentElement = this;
      node.isConnected = true;
    },
    matches(selector) {
      options.onMatches?.(selector);
      if (selector === enhancer.PAGE_SELECTORS.feedCard) {
        return (
          ['feed-video', 'feed-active-video'].includes(
            this.getAttribute('data-e2e'),
          ) && enhancer.isValidVideoId(this.getAttribute('data-e2e-vid'))
        );
      }
      if (selector === enhancer.PAGE_SELECTORS.feedRoot) {
        return (
          this.getAttribute('data-e2e') === 'slideList' &&
          this.getAttribute('data-active') === 'true'
        );
      }
      if (selector === enhancer.PAGE_SELECTORS.activeCard) {
        return this.getAttribute('data-e2e') === 'feed-active-video';
      }
      if (selector === enhancer.PAGE_SELECTORS.danmakuRoot) {
        return this.getAttribute('data-e2e') === 'danmaku-container';
      }
      if (selector === enhancer.PAGE_SELECTORS.danmakuNode) {
        return this.hasAttribute('data-danmu-id');
      }
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
      options.onQuerySelectorAll?.(selector);
      if (
        selector ===
        `${enhancer.PAGE_SELECTORS.danmakuNode}:not([${DANMAKU_STATE_ATTRIBUTE}])`
      ) {
        return (childrenBySelector.get(enhancer.PAGE_SELECTORS.danmakuNode) ?? [])
          .filter((node) => !node.hasAttribute(DANMAKU_STATE_ATTRIBUTE));
      }
      return childrenBySelector.get(selector) ?? [];
    },
    setQuery(selector, nodes) {
      childrenBySelector.set(selector, nodes);
      for (const node of nodes) node.parentElement = this;
    },
    setQueryWithoutReparent(selector, nodes) {
      childrenBySelector.set(selector, nodes);
    },
  };
  return element;
}

function createDanmakuNode(id, text) {
  return createElement({
    attributes: { 'data-danmu-id': id },
    textContent: text,
  });
}

function createDanmakuRoot(nodes = []) {
  const root = createElement({ attributes: { 'data-e2e': 'danmaku-container' } });
  root.setQuery(enhancer.PAGE_SELECTORS.danmakuNode, nodes);
  return root;
}

function createCard(id, danmakuRoot) {
  const card = createElement({
    attributes: { 'data-e2e': 'feed-video', 'data-e2e-vid': id },
  });
  card.setQuery(
    enhancer.PAGE_SELECTORS.danmakuRoot,
    danmakuRoot ? [danmakuRoot] : [],
  );
  card.setQueryWithoutReparent(
    enhancer.PAGE_SELECTORS.danmakuNode,
    danmakuRoot?.querySelectorAll(enhancer.PAGE_SELECTORS.danmakuNode) ?? [],
  );
  card.setQuery(enhancer.PAGE_SELECTORS.videoDescription, []);
  return card;
}

function settings(keywords, enabled = true) {
  return enhancer.createSettingsSnapshot({
    video: { enabled: false, keywords: '' },
    danmaku: { enabled, keywords },
    bgm: { enabled: false, keywords: '' },
  });
}

function combinedSettings(videoKeywords, danmakuKeywords) {
  return enhancer.createSettingsSnapshot({
    video: { enabled: Boolean(videoKeywords), keywords: videoKeywords },
    danmaku: { enabled: Boolean(danmakuKeywords), keywords: danmakuKeywords },
    bgm: { enabled: false, keywords: '' },
  });
}

function createHarness({
  cards,
  activeCard,
  href = 'https://www.douyin.com/?recommend=1',
  includeFeed = true,
}) {
  const frames = new Map();
  const intervals = new Map();
  const timers = new Map();
  const observers = new Set();
  const listeners = new Map();
  let nextId = 1;
  let currentActiveCard = activeCard;
  let feedRootQueryCount = 0;

  const feedRoot = createElement({
    attributes: { 'data-e2e': 'slideList', 'data-active': 'true' },
  });
  feedRoot.setQuery(enhancer.PAGE_SELECTORS.feedCard, cards);
  feedRoot.setQuery(enhancer.PAGE_SELECTORS.activeCard, [currentActiveCard]);
  currentActiveCard.setAttribute('data-e2e', 'feed-active-video');

  const documentElement = createElement();
  feedRoot.parentElement = documentElement;
  const pageDanmakuNodes = cards.flatMap((card) =>
    card.querySelectorAll(enhancer.PAGE_SELECTORS.danmakuNode),
  );
  documentElement.setQueryWithoutReparent(
    enhancer.PAGE_SELECTORS.danmakuNode,
    pageDanmakuNodes,
  );
  const document = {
    visibilityState: 'visible',
    documentElement,
    createElement: () => createElement({ isConnected: false }),
    querySelectorAll(selector) {
      if (selector === enhancer.PAGE_SELECTORS.feedRoot) {
        feedRootQueryCount += 1;
        return includeFeed ? [feedRoot] : [];
      }
      if (selector === enhancer.PAGE_SELECTORS.nextControl) return [];
      return [];
    },
    addEventListener(type, callback) {
      const callbacks = listeners.get(type) ?? [];
      callbacks.push(callback);
      listeners.set(type, callbacks);
    },
    removeEventListener(type, callback) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((candidate) => candidate !== callback),
      );
    },
  };

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.target = null;
      this.connected = false;
      observers.add(this);
    }
    observe(target) {
      this.target = target;
      this.connected = true;
    }
    disconnect() {
      this.connected = false;
      observers.delete(this);
    }
  }

  const root = {
    document,
    location: { href },
    performance: { now: () => 0 },
    getComputedStyle: () => ({
      display: 'block',
      visibility: 'visible',
      pointerEvents: 'auto',
    }),
    addEventListener(type, callback) {
      const callbacks = listeners.get(type) ?? [];
      callbacks.push(callback);
      listeners.set(type, callbacks);
    },
    removeEventListener(type, callback) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((candidate) => candidate !== callback),
      );
    },
  };

  const controller = enhancer.createPageController(root, {
    document,
    MutationObserver: FakeMutationObserver,
    now: () => 0,
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval(callback, delay) {
      const id = nextId++;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
    requestAnimationFrame(callback) {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
  });

  function flushFrames() {
    while (frames.size > 0) {
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, callback] of pending) callback(0);
    }
  }

  function emit(target, mutations) {
    for (const observer of [...observers]) {
      if (
        observer.connected &&
        mutations.some(
          (mutation) =>
            observer.target === mutation.target ||
            observer.target?.contains?.(mutation.target),
        )
      ) {
        observer.callback(mutations);
      }
    }
    flushFrames();
  }

  return {
    controller,
    document,
    feedRoot,
    flushFrames,
    emit,
    fireTimersByDelay(delay) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay === delay) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    runHealthChecks() {
      for (const interval of intervals.values()) interval.callback();
      flushFrames();
    },
    getFeedRootQueryCount: () => feedRootQueryCount,
    setHref(nextHref) {
      root.location.href = nextHref;
    },
    switchActive(nextCard) {
      currentActiveCard.setAttribute('data-e2e', 'feed-video');
      nextCard.setAttribute('data-e2e', 'feed-active-video');
      currentActiveCard = nextCard;
      feedRoot.setQuery(enhancer.PAGE_SELECTORS.activeCard, [nextCard]);
      emit(feedRoot, [{ type: 'attributes', target: nextCard, addedNodes: [] }]);
      for (const interval of intervals.values()) interval.callback();
      flushFrames();
    },
    replaceDanmakuRoot(card, nextRoot) {
      const previousRoots = card.querySelectorAll(
        enhancer.PAGE_SELECTORS.danmakuRoot,
      );
      card.setQuery(enhancer.PAGE_SELECTORS.danmakuRoot, [nextRoot]);
      card.setQueryWithoutReparent(
        enhancer.PAGE_SELECTORS.danmakuNode,
        nextRoot.querySelectorAll(enhancer.PAGE_SELECTORS.danmakuNode),
      );
      documentElement.setQueryWithoutReparent(
        enhancer.PAGE_SELECTORS.danmakuNode,
        cards.flatMap((candidate) =>
          candidate.querySelectorAll(enhancer.PAGE_SELECTORS.danmakuNode),
        ),
      );
      emit(card, [{
        type: 'childList',
        target: card,
        addedNodes: [nextRoot],
        removedNodes: previousRoots,
      }]);
    },
    dispatch(type) {
      for (const callback of listeners.get(type) ?? []) callback();
      flushFrames();
    },
  };
}

test('initial danmaku nodes are classified across page video players', () => {
  const blocked = createDanmakuNode('1111111111111111111', '需要屏蔽');
  const allowed = createDanmakuNode('2222222222222222222', '正常内容');
  const inactiveBlocked = createDanmakuNode('3333333333333333333', '需要屏蔽');
  const activeRoot = createDanmakuRoot([blocked, allowed]);
  const inactiveRoot = createDanmakuRoot([inactiveBlocked]);
  const activeCard = createCard('4444444444444444444', activeRoot);
  const inactiveCard = createCard('5555555555555555555', inactiveRoot);
  const harness = createHarness({ cards: [activeCard, inactiveCard], activeCard });

  harness.controller.start(settings('屏蔽'));
  harness.flushFrames();

  assert.equal(harness.document.documentElement.hasAttribute(DANMAKU_ROOT_ATTRIBUTE), true);
  assert.equal(blocked.getAttribute(DANMAKU_STATE_ATTRIBUTE), 'block');
  assert.equal(allowed.getAttribute(DANMAKU_STATE_ATTRIBUTE), 'allow');
  assert.equal(inactiveCard.hasAttribute(DANMAKU_ROOT_ATTRIBUTE), false);
  assert.equal(inactiveBlocked.getAttribute(DANMAKU_STATE_ATTRIBUTE), 'block');
});

test('danmaku nodes in a sibling branch of the semantic container are classified', () => {
  const semanticRoot = createDanmakuRoot([]);
  const blocked = createDanmakuNode('1111111111111111111', '包含你');
  const allowed = createDanmakuNode('2222222222222222222', '正常内容');
  const card = createCard('3333333333333333333', semanticRoot);
  card.setQuery(enhancer.PAGE_SELECTORS.danmakuNode, [blocked, allowed]);
  const harness = createHarness({ cards: [card], activeCard: card });

  harness.controller.start(settings('你'));
  harness.flushFrames();

  assert.equal(harness.document.documentElement.hasAttribute(DANMAKU_ROOT_ATTRIBUTE), true);
  assert.equal(blocked.getAttribute(DANMAKU_STATE_ATTRIBUTE), 'block');
  assert.equal(allowed.getAttribute(DANMAKU_STATE_ATTRIBUTE), 'allow');
});

test('danmaku filtering works on a standalone video route without a recommend lifecycle', () => {
  const blocked = createDanmakuNode('1111111111111111111', '有人说你');
  const root = createDanmakuRoot([blocked]);
  const card = createCard('2222222222222222222', root);
  const harness = createHarness({
    cards: [card],
    activeCard: card,
    href: 'https://www.douyin.com/video/2222222222222222222',
    includeFeed: false,
  });

  harness.controller.start(settings('你'));
  harness.flushFrames();

  assert.equal(
    harness.document.documentElement.hasAttribute(DANMAKU_ROOT_ATTRIBUTE),
    true,
  );
  assert.equal(blocked.getAttribute(DANMAKU_STATE_ATTRIBUTE), 'block');
  assert.equal(harness.controller.snapshot().rootConnected, false);
});

test('new and text-late danmaku nodes receive pending and block states', () => {
  const root = createDanmakuRoot([]);
  const card = createCard('1111111111111111111', root);
  const harness = createHarness({ cards: [card], activeCard: card });
  harness.controller.start(settings('命中'));
  harness.flushFrames();

  const late = createDanmakuNode('2222222222222222222', '');
  root.setQuery(enhancer.PAGE_SELECTORS.danmakuNode, [late]);
  harness.emit(root, [{ type: 'childList', target: root, addedNodes: [late] }]);
  assert.equal(late.getAttribute(DANMAKU_STATE_ATTRIBUTE), 'pending');

  late.textContent = '稍后命中';
  harness.emit(root, [{ type: 'characterData', target: late, addedNodes: [] }]);
  assert.equal(late.getAttribute(DANMAKU_STATE_ATTRIBUTE), 'block');
});

test('video feed generation changes cannot stale the page-level danmaku observer', () => {
  const root = createDanmakuRoot([]);
  const card = createCard('1111111111111111111', root);
  const harness = createHarness({ cards: [card], activeCard: card });
  harness.controller.start(combinedSettings('视频词', '你'));
  harness.flushFrames();

  const added = createDanmakuNode('2222222222222222222', '后来有你');
  root.setQuery(enhancer.PAGE_SELECTORS.danmakuNode, [added]);
  card.setQuery(enhancer.PAGE_SELECTORS.danmakuNode, [added]);
  harness.document.documentElement.setQueryWithoutReparent(
    enhancer.PAGE_SELECTORS.danmakuNode,
    [added],
  );
  harness.emit(root, [{ type: 'childList', target: root, addedNodes: [added] }]);

  assert.equal(added.getAttribute(DANMAKU_STATE_ATTRIBUTE), 'block');
});

test('danmaku beyond the added-element budget remain unowned and are not hidden by CSS', () => {
  const card = createCard('1111111111111111111');
  const harness = createHarness({ cards: [card], activeCard: card });
  const createdElements = [];
  harness.document.createElement = () => {
    const element = createElement({ isConnected: false });
    createdElements.push(element);
    return element;
  };
  harness.controller.start(settings('屏蔽'));
  const nodes = Array.from({ length: 65 }, (_, index) =>
    createDanmakuNode(String(2222222222222222200n + BigInt(index)), '正常内容'),
  );
  const root = harness.document.documentElement;
  root.setQuery(enhancer.PAGE_SELECTORS.danmakuNode, nodes);
  harness.emit(root, [{ type: 'childList', target: root, addedNodes: nodes, removedNodes: [] }]);
  harness.fireTimersByDelay(100);
  harness.runHealthChecks();
  assert.equal(nodes.filter((node) => node.hasAttribute(DANMAKU_STATE_ATTRIBUTE)).length, 64);
  assert.equal(nodes[64].hasAttribute(DANMAKU_STATE_ATTRIBUTE), false);
  const style = createdElements.find((node) => node.id === 'dwe-video-filter-style');
  assert.doesNotMatch(style.textContent, /\[data-danmu-id\]:not\(/);
  assert.match(style.textContent, /\[data-dwe-danmaku-state="pending"\]/);
  assert.match(style.textContent, /\[data-dwe-danmaku-state="block"\]/);
  nodes[64].textContent = '后来需要屏蔽';
  harness.emit(root, [{ type: 'characterData', target: nodes[64], addedNodes: [] }]);
  assert.equal(nodes[64].getAttribute(DANMAKU_STATE_ATTRIBUTE), 'block');
  harness.controller.stop();
  assert.equal(nodes[64].hasAttribute(DANMAKU_STATE_ATTRIBUTE), false);
});

test('health checks do not rescan danmaku missed by mutation delivery', () => {
  const root = createDanmakuRoot([]);
  const card = createCard('1111111111111111111', root);
  const harness = createHarness({ cards: [card], activeCard: card });
  harness.controller.start(settings('你'));
  harness.flushFrames();

  const missed = createDanmakuNode('2222222222222222222', '后来有你');
  root.setQuery(enhancer.PAGE_SELECTORS.danmakuNode, [missed]);
  card.setQuery(enhancer.PAGE_SELECTORS.danmakuNode, [missed]);
  harness.document.documentElement.setQueryWithoutReparent(
    enhancer.PAGE_SELECTORS.danmakuNode,
    [missed],
  );
  assert.equal(missed.hasAttribute(DANMAKU_STATE_ATTRIBUTE), false);

  harness.runHealthChecks();

  assert.equal(missed.hasAttribute(DANMAKU_STATE_ATTRIBUTE), false);
});

test('an unrelated global mutation does not rediscover the feed root', () => {
  const root = createDanmakuRoot([]);
  const card = createCard('1111111111111111111', root);
  const harness = createHarness({ cards: [card], activeCard: card });
  harness.controller.start(settings('你'));
  harness.flushFrames();
  const baseline = harness.getFeedRootQueryCount();

  let unrelatedDescendantQueries = 0;
  const unrelated = createElement({
    onQuerySelectorAll() {
      unrelatedDescendantQueries += 1;
    },
  });
  unrelated.parentElement = harness.document.documentElement;
  harness.emit(harness.document.documentElement, [{
    type: 'childList',
    target: harness.document.documentElement,
    addedNodes: [unrelated],
    removedNodes: [],
  }]);

  assert.equal(harness.getFeedRootQueryCount(), baseline);
  assert.equal(unrelatedDescendantQueries, 0);
});

test('a child-list mutation never scans the unrelated target subtree', () => {
  const root = createDanmakuRoot([]);
  const card = createCard('1111111111111111111', root);
  const harness = createHarness({ cards: [card], activeCard: card });
  harness.controller.start(settings('你'));
  harness.flushFrames();

  let targetDescendantQueries = 0;
  const commentList = createElement({
    onQuerySelectorAll() {
      targetDescendantQueries += 1;
    },
  });
  commentList.parentElement = harness.document.documentElement;
  const comment = createElement();
  comment.parentElement = commentList;
  harness.emit(commentList, [{
    type: 'childList',
    target: commentList,
    addedNodes: [comment],
    removedNodes: [],
  }]);

  assert.equal(targetDescendantQueries, 0);
});

test('one global mutation batch has one shared added-element budget', () => {
  const root = createDanmakuRoot([]);
  const card = createCard('1111111111111111111', root);
  const harness = createHarness({ cards: [card], activeCard: card });
  harness.controller.start(combinedSettings('视频词', ''));
  harness.flushFrames();

  let feedRootMatchChecks = 0;
  const addedNodes = Array.from({ length: 100 }, () =>
    createElement({
      onMatches(selector) {
        if (selector === enhancer.PAGE_SELECTORS.feedRoot) {
          feedRootMatchChecks += 1;
        }
      },
    }),
  );
  for (const node of addedNodes) {
    node.parentElement = harness.document.documentElement;
  }
  harness.emit(harness.document.documentElement, [{
    type: 'childList',
    target: harness.document.documentElement,
    addedNodes,
    removedNodes: [],
  }]);

  assert.equal(feedRootMatchChecks, 64);
});

test('one global mutation batch has a bounded mutation-record budget', () => {
  const root = createDanmakuRoot([]);
  const card = createCard('1111111111111111111', root);
  const harness = createHarness({ cards: [card], activeCard: card });
  harness.controller.start(combinedSettings('视频词', ''));
  harness.flushFrames();

  let inspectedRecords = 0;
  const mutations = Array.from({ length: 200 }, () => ({
    type: 'childList',
    target: harness.document.documentElement,
    get addedNodes() {
      inspectedRecords += 1;
      return [];
    },
    removedNodes: [],
  }));
  harness.emit(harness.document.documentElement, mutations);

  assert.equal(inspectedRecords, 64);
});

test('an unsupported route does not inspect added nodes for feed signals', () => {
  const root = createDanmakuRoot([]);
  const card = createCard('1111111111111111111', root);
  const harness = createHarness({ cards: [card], activeCard: card });
  harness.controller.start(combinedSettings('视频词', ''));
  harness.flushFrames();
  harness.setHref('https://www.douyin.com/jingxuan?from_nav=1');

  let feedRootMatchChecks = 0;
  const addedNodes = Array.from({ length: 100 }, () =>
    createElement({
      onMatches(selector) {
        if (selector === enhancer.PAGE_SELECTORS.feedRoot) {
          feedRootMatchChecks += 1;
        }
      },
    }),
  );
  for (const node of addedNodes) {
    node.parentElement = harness.document.documentElement;
  }
  harness.emit(harness.document.documentElement, [{
    type: 'childList',
    target: harness.document.documentElement,
    addedNodes,
    removedNodes: [],
  }]);

  assert.equal(feedRootMatchChecks, 0);
  assert.equal(harness.controller.snapshot().rootConnected, false);
});

test('empty danmaku fails open after the 100ms watchdog', () => {
  const empty = createDanmakuNode('1111111111111111111', '');
  const root = createDanmakuRoot([empty]);
  const card = createCard('2222222222222222222', root);
  const harness = createHarness({ cards: [card], activeCard: card });
  harness.controller.start(settings('命中'));
  harness.flushFrames();

  assert.equal(empty.getAttribute(DANMAKU_STATE_ATTRIBUTE), 'pending');
  harness.fireTimersByDelay(100);
  assert.equal(empty.getAttribute(DANMAKU_STATE_ATTRIBUTE), 'bypass');
});

test('reused danmaku nodes cannot inherit a previous decision', () => {
  const reused = createDanmakuNode('1111111111111111111', '正常内容');
  const root = createDanmakuRoot([reused]);
  const card = createCard('2222222222222222222', root);
  const harness = createHarness({ cards: [card], activeCard: card });
  harness.controller.start(settings('命中'));
  harness.flushFrames();
  assert.equal(reused.getAttribute(DANMAKU_STATE_ATTRIBUTE), 'allow');

  reused.setAttribute('data-danmu-id', '3333333333333333333');
  reused.textContent = '复用后命中';
  harness.emit(root, [{ type: 'attributes', target: reused, addedNodes: [] }]);
  assert.equal(reused.getAttribute(DANMAKU_STATE_ATTRIBUTE), 'block');
});

test('removed danmaku nodes immediately release attributes and watchdogs', () => {
  const removed = createDanmakuNode('1111111111111111111', '');
  const root = createDanmakuRoot([removed]);
  const card = createCard('2222222222222222222', root);
  const harness = createHarness({ cards: [card], activeCard: card });
  harness.controller.start(settings('命中'));
  harness.flushFrames();
  assert.equal(removed.getAttribute(DANMAKU_STATE_ATTRIBUTE), 'pending');

  root.setQuery(enhancer.PAGE_SELECTORS.danmakuNode, []);
  removed.parentElement = null;
  harness.emit(root, [{
    type: 'childList',
    target: root,
    addedNodes: [],
    removedNodes: [removed],
  }]);

  assert.equal(removed.hasAttribute(DANMAKU_STATE_ATTRIBUTE), false);
  assert.equal(harness.controller.snapshot().ownedDanmakuNodeCount, 0);
  harness.fireTimersByDelay(100);
  assert.equal(removed.hasAttribute(DANMAKU_STATE_ATTRIBUTE), false);
});

test('danmaku configuration updates apply immediately and disabling restores ownership', () => {
  const node = createDanmakuNode('1111111111111111111', '后来命中');
  const root = createDanmakuRoot([node]);
  const card = createCard('2222222222222222222', root);
  const harness = createHarness({ cards: [card], activeCard: card });
  harness.controller.start(settings('旧词'));
  harness.flushFrames();
  assert.equal(node.getAttribute(DANMAKU_STATE_ATTRIBUTE), 'allow');

  harness.controller.updateSettings(settings('后来命中'));
  assert.equal(node.getAttribute(DANMAKU_STATE_ATTRIBUTE), 'block');

  harness.controller.updateSettings(settings('', false));
  assert.equal(harness.document.documentElement.hasAttribute(DANMAKU_ROOT_ATTRIBUTE), false);
  assert.equal(node.hasAttribute(DANMAKU_STATE_ATTRIBUTE), false);
});

test('active-card replacement keeps page-level danmaku ownership', () => {
  const firstNode = createDanmakuNode('1111111111111111111', '命中');
  const secondNode = createDanmakuNode('2222222222222222222', '命中');
  const replacementNode = createDanmakuNode('3333333333333333333', '正常');
  const firstRoot = createDanmakuRoot([firstNode]);
  const secondRoot = createDanmakuRoot([secondNode]);
  const replacementRoot = createDanmakuRoot([replacementNode]);
  const firstCard = createCard('4444444444444444444', firstRoot);
  const secondCard = createCard('5555555555555555555', secondRoot);
  const harness = createHarness({ cards: [firstCard, secondCard], activeCard: firstCard });
  harness.controller.start(settings('命中'));
  harness.flushFrames();

  harness.switchActive(secondCard);
  assert.equal(harness.document.documentElement.hasAttribute(DANMAKU_ROOT_ATTRIBUTE), true);
  assert.equal(firstNode.getAttribute(DANMAKU_STATE_ATTRIBUTE), 'block');
  assert.equal(secondNode.getAttribute(DANMAKU_STATE_ATTRIBUTE), 'block');

  harness.replaceDanmakuRoot(secondCard, replacementRoot);
  assert.equal(secondCard.hasAttribute(DANMAKU_ROOT_ATTRIBUTE), false);
  assert.equal(secondNode.hasAttribute(DANMAKU_STATE_ATTRIBUTE), false);
  assert.equal(replacementRoot.hasAttribute(DANMAKU_ROOT_ATTRIBUTE), false);
  assert.equal(replacementNode.getAttribute(DANMAKU_STATE_ATTRIBUTE), 'allow');
});

test('hidden documents immediately fail open and restore danmaku nodes', () => {
  const node = createDanmakuNode('1111111111111111111', '命中');
  const root = createDanmakuRoot([node]);
  const card = createCard('2222222222222222222', root);
  const harness = createHarness({ cards: [card], activeCard: card });
  harness.controller.start(settings('命中'));
  harness.flushFrames();

  harness.document.visibilityState = 'hidden';
  harness.dispatch('visibilitychange');

  assert.equal(harness.document.documentElement.hasAttribute(DANMAKU_ROOT_ATTRIBUTE), false);
  assert.equal(node.hasAttribute(DANMAKU_STATE_ATTRIBUTE), false);
  assert.equal(harness.controller.snapshot().danmakuRootConnected, false);
  assert.equal(harness.controller.snapshot().ownedDanmakuNodeCount, 0);
});

test('a danmaku adapter error fails open only the broken node', () => {
  const broken = createDanmakuNode('1111111111111111111', '私密文本');
  Object.defineProperty(broken, 'textContent', {
    configurable: true,
    get() {
      throw new Error('synthetic text failure');
    },
  });
  const root = createDanmakuRoot([broken]);
  const card = createCard('2222222222222222222', root);
  const harness = createHarness({ cards: [card], activeCard: card });

  harness.controller.start(settings('命中'));
  harness.flushFrames();

  assert.equal(harness.controller.snapshot().rootConnected, false);
  assert.equal(harness.controller.snapshot().danmakuRootConnected, true);
  assert.equal(harness.controller.snapshot().ownedDanmakuNodeCount, 0);
  assert.equal(harness.document.documentElement.hasAttribute(DANMAKU_ROOT_ATTRIBUTE), true);
});

test('a configuration recheck error releases only the broken node', () => {
  const node = createDanmakuNode('1111111111111111111', '正常弹幕');
  const root = createDanmakuRoot([node]);
  const card = createCard('2222222222222222222', root);
  const harness = createHarness({ cards: [card], activeCard: card });
  harness.controller.start(settings('旧词'));
  harness.flushFrames();
  assert.equal(node.getAttribute(DANMAKU_STATE_ATTRIBUTE), 'allow');

  Object.defineProperty(node, 'textContent', {
    configurable: true,
    get() {
      throw new Error('synthetic recheck failure');
    },
  });
  assert.doesNotThrow(() => harness.controller.updateSettings(settings('新词')));

  assert.equal(harness.controller.snapshot().rootConnected, false);
  assert.equal(harness.controller.snapshot().danmakuRootConnected, true);
  assert.equal(harness.controller.snapshot().ownedDanmakuNodeCount, 0);
  assert.equal(harness.document.documentElement.hasAttribute(DANMAKU_ROOT_ATTRIBUTE), true);
  assert.equal(node.hasAttribute(DANMAKU_STATE_ATTRIBUTE), false);
});

test('disabling video while danmaku stays active retires video ownership only', () => {
  const node = createDanmakuNode('1111111111111111111', '弹幕命中');
  const root = createDanmakuRoot([node]);
  const card = createCard('2222222222222222222', root);
  card.setQuery(enhancer.PAGE_SELECTORS.videoDescription, [
    createElement({ textContent: '正常视频' }),
  ]);
  const harness = createHarness({ cards: [card], activeCard: card });
  harness.controller.start(combinedSettings('视频屏蔽词', '弹幕命中'));
  harness.flushFrames();
  assert.equal(card.getAttribute(enhancer.VIDEO_STATE_ATTRIBUTE), 'allow');

  harness.controller.updateSettings(combinedSettings('', '弹幕命中'));

  assert.equal(card.hasAttribute(enhancer.VIDEO_STATE_ATTRIBUTE), false);
  assert.equal(harness.controller.snapshot().currentState, null);
  assert.equal(node.getAttribute(DANMAKU_STATE_ATTRIBUTE), 'block');
  assert.equal(harness.document.documentElement.hasAttribute(DANMAKU_ROOT_ATTRIBUTE), true);
});

test('enabling video during an active danmaku lifecycle creates a preserved epoch', () => {
  const node = createDanmakuNode('1111111111111111111', '正常弹幕');
  const root = createDanmakuRoot([node]);
  const card = createCard('2222222222222222222', root);
  card.setQuery(enhancer.PAGE_SELECTORS.videoDescription, [
    createElement({ textContent: '后来命中' }),
  ]);
  const harness = createHarness({ cards: [card], activeCard: card });
  harness.controller.start(combinedSettings('', '弹幕屏蔽词'));
  harness.flushFrames();

  harness.controller.updateSettings(
    combinedSettings('后来命中', '弹幕屏蔽词'),
  );
  harness.flushFrames();

  assert.equal(card.getAttribute(enhancer.VIDEO_STATE_ATTRIBUTE), 'bypass');
  assert.equal(harness.controller.snapshot().currentState, 'bypass');
  assert.equal(harness.document.documentElement.hasAttribute(DANMAKU_ROOT_ATTRIBUTE), true);
});

test('a broken danmaku cannot suspend healthy nodes on another video', () => {
  const broken = createDanmakuNode('1111111111111111111', '私密文本');
  Object.defineProperty(broken, 'textContent', {
    configurable: true,
    get() {
      throw new Error('synthetic text failure');
    },
  });
  const healthy = createDanmakuNode('2222222222222222222', '后来命中');
  const firstRoot = createDanmakuRoot([broken]);
  const secondRoot = createDanmakuRoot([healthy]);
  const firstCard = createCard('3333333333333333333', firstRoot);
  const secondCard = createCard('4444444444444444444', secondRoot);
  const harness = createHarness({ cards: [firstCard, secondCard], activeCard: firstCard });
  harness.controller.start(settings('后来命中'));
  harness.flushFrames();
  assert.equal(harness.document.documentElement.hasAttribute(DANMAKU_ROOT_ATTRIBUTE), true);

  harness.switchActive(secondCard);

  assert.equal(harness.document.documentElement.hasAttribute(DANMAKU_ROOT_ATTRIBUTE), true);
  assert.equal(healthy.getAttribute(DANMAKU_STATE_ATTRIBUTE), 'block');
});

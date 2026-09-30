// ==UserScript==
// @name         Douyin Web Enhancer - Native Navigation Probe
// @namespace    https://github.com/OnlyDreams/douyin-web-enhancer
// @version      0.6.1-test
// @description  Opt-in native navigation discovery, guarded test, and product observation.
// @match        https://www.douyin.com/*
// @run-at       document-idle
// @sandbox      raw
// @grant        none
// @noframes
// @license      MIT
// ==/UserScript==

((root, factory) => {
  'use strict';
  const probe = factory();
  if (typeof module === 'object' && module?.exports) module.exports = probe;
  else probe.bootstrap(root);
})(globalThis, () => {
  'use strict';
  const PARAMETER = 'dwe_native_probe';
  const API_KEY = '__DWE_NATIVE_PROBE__';
  const ROOT = '[data-e2e="slideList"][data-active="true"]';
  const CARD = '[data-e2e="feed-active-video"][data-e2e-vid]';

  // 不执行页面 getter，不调用内部方法，只读取限定路径上的自有数据属性。
  function own(object, key) {
    if (!object || !['object', 'function'].includes(typeof object)) return undefined;
    return Object.getOwnPropertyDescriptor(object, key)?.value;
  }

  function createNavigationTrace(swiper, now, observeProduct = false) {
    const started = now();
    const records = [];
    const installed = [];
    let lastDisabledState = null;
    let recording = true;
    const status = { slideNextCalls: 0, slidePrevCalls: 0, slideToCalls: 0, nextEmits: 0, prevEmits: 0,
      disabledChecks: 0, readErrors: 0, cleanup: 'pending' };
    function state() {
      try {
        const data = own(swiper, 'data');
        const index = Number.isInteger(own(swiper, 'activeIndex')) ? own(swiper, 'activeIndex') : null;
        const dataLength = Array.isArray(data) ? data.length : null;
        return { animating: own(own(swiper, 'touchData'), 'animating') === true,
          index, dataLength, remaining: dataLength !== null && index !== null ? dataLength - index - 1 : null };
      } catch { status.readErrors += 1; return { animating: null, index: null, dataLength: null, remaining: null }; }
    }
    function stop() {
      if (!recording) return;
      recording = false;
      status.cleanup = 'restored';
      for (const { key, descriptor, wrapper } of installed.reverse()) {
        try {
          const current = Object.getOwnPropertyDescriptor(swiper, key);
          if (current?.value === wrapper && current.configurable === descriptor.configurable &&
            current.enumerable === descriptor.enumerable && current.writable === descriptor.writable) {
            Object.defineProperty(swiper, key, descriptor);
          } else status.cleanup = 'later-owner-preserved';
        } catch { status.cleanup = 'restore-error'; }
      }
    }
    try {
      const keys = observeProduct
        ? ['emit', 'slideNext', 'slidePrev', 'isDisabled'] : ['slideNext', 'isDisabled'];
      if (observeProduct && typeof own(swiper, 'slideTo') === 'function') keys.push('slideTo');
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(swiper, key);
        if (!descriptor?.configurable || !descriptor.writable || typeof descriptor.value !== 'function') {
          throw new Error('unsupported descriptor');
        }
        const wrapper = function (...args) {
          const relevant = key !== 'emit' || args[0] === 'changeNext' || args[0] === 'changePrev';
          const before = recording && relevant ? state() : null;
          const repeatedCheck = key === 'isDisabled' && JSON.stringify(before) === lastDisabledState;
          if (key === 'isDisabled') lastDisabledState = JSON.stringify(before);
          const record = recording && relevant && !repeatedCheck && records.length < 32 ? { method: key,
            eventType: key === 'emit' ? args[0] : null, elapsedMs: Math.round(now() - started),
            before, threw: true, returnedDisabled: null } : null;
          if (recording) {
            if (key === 'emit' && args[0] === 'changeNext') status.nextEmits += 1;
            else if (key === 'emit' && args[0] === 'changePrev') status.prevEmits += 1;
            else if (key === 'slideNext') status.slideNextCalls += 1;
            else if (key === 'slidePrev') status.slidePrevCalls += 1;
            else if (key === 'slideTo') status.slideToCalls += 1;
            else if (key === 'isDisabled') status.disabledChecks += 1;
          }
          if (record) records.push(record);
          try {
            const result = Reflect.apply(descriptor.value, this, args);
            if (record) {
              record.threw = false;
              if (key === 'isDisabled') record.returnedDisabled = typeof result === 'boolean' ? result : null;
            }
            return result;
          } finally {
            if (record) record.after = state();
          }
        };
        Object.defineProperty(swiper, key, { ...descriptor, value: wrapper });
        installed.push({ key, descriptor, wrapper });
      }
    } catch {
      stop();
      return null;
    }
    return { stop, snapshot: () => JSON.parse(JSON.stringify({ ...status, records })) };
  }

  function discover(card, feed, onCandidate = null) {
    const result = { outcome: 'no-fiber', visited: 0, currentTree: false, candidates: 0, matches: [] };
    const keys = Object.getOwnPropertyNames(card).filter(key => key.startsWith('__reactFiber$'));
    if (keys.length !== 1) return result;
    const seen = new Set();
    const path = [];
    const instances = new Map();
    const summarize = outcome => ({ ...result, outcome, candidates: instances.size,
      matches: [...instances.values()].slice(0, 4) });
    let fiber = own(card, keys[0]);
    let top = null;
    const id = card.getAttribute('data-e2e-vid');
    if (!/^\d{10,}$/.test(id || '')) return { ...result, outcome: 'invalid-card-id' };
    function collect(node) {
      const props = own(node, 'memoizedProps');
      const swiper = own(props, 'swiper');
      if (swiper && own(props, 'isActive') === true && own(own(props, 'item'), 'awemeId') === id) {
        const el = own(swiper, 'el');
        const index = own(swiper, 'activeIndex');
        const data = own(swiper, 'data');
        const item = Number.isInteger(index) && index >= 0 && Array.isArray(data) ? own(data, String(index)) : null;
        const scoped = !!el && feed.contains(el) && el.contains(card);
        instances.set(swiper, {
          scoped,
          indexMatches: own(item, 'awemeId') === id,
          destroyed: own(swiper, 'destroyed') === true,
          animating: own(own(swiper, 'touchData'), 'animating') === true,
          hasEmit: typeof own(swiper, 'emit') === 'function',
          hasSlideNext: typeof own(swiper, 'slideNext') === 'function',
          hasIsDisabled: typeof own(swiper, 'isDisabled') === 'function',
          hasPlayNextFunc: typeof own(props, 'playNextFunc') === 'function',
        });
      }
    }
    while (fiber && result.visited < 128) {
      if (seen.has(fiber)) return summarize('fiber-cycle');
      seen.add(fiber);
      path.push(fiber);
      result.visited += 1;
      collect(fiber);
      top = fiber;
      fiber = own(fiber, 'return');
    }
    if (fiber) return summarize('depth-limit');
    const rootState = own(top, 'stateNode');
    const currentRoot = own(rootState, 'current');
    result.currentTree = currentRoot === top;
    result.resolvedAlternate = false;
    if (!result.currentTree) {
      // 只沿已知祖先路径验证 current 的 child/sibling 归属，不扫描整棵树。
      instances.clear();
      if (!currentRoot || own(top, 'alternate') !== currentRoot ||
        own(currentRoot, 'stateNode') !== rootState) return summarize('stale-tree');
      let current = currentRoot;
      const currentPath = [currentRoot];
      let inspected = 0;
      for (let index = path.length - 2; index >= 0; index -= 1) {
        const expected = path[index];
        const alternate = own(expected, 'alternate');
        let child = own(current, 'child');
        const siblings = new Set();
        let match = null;
        while (child) {
          if (++inspected > 2048 || siblings.size >= 128) return summarize('current-path-limit');
          if (siblings.has(child)) return summarize('current-path-cycle');
          siblings.add(child);
          if (child === expected || child === alternate) {
            if (match) return summarize('ambiguous-current-path');
            match = child;
          }
          child = own(child, 'sibling');
        }
        if (!match) return summarize('current-path-missing');
        current = match;
        currentPath.push(current);
      }
      if (own(current, 'stateNode') !== card || own(rootState, 'current') !== currentRoot) {
        return summarize('current-path-changed');
      }
      for (const node of currentPath) collect(node);
      result.currentTree = true;
      result.resolvedAlternate = true;
    }
    result.candidates = instances.size;
    result.matches = [...instances.values()].slice(0, 4);
    result.outcome = !result.currentTree ? 'stale-tree' : instances.size !== 1 ? 'candidate-count-mismatch'
      : result.matches[0].scoped && result.matches[0].indexMatches && !result.matches[0].destroyed &&
        result.matches[0].hasEmit && result.matches[0].hasSlideNext ? 'candidate-observed' : 'candidate-unverified';
    if (result.outcome === 'candidate-observed' && onCandidate) onCandidate(instances.keys().next().value);
    return result;
  }

  function bootstrap(root) {
    let url;
    try { url = new URL(root.location.href); } catch { return null; }
    const mode = url.searchParams.get(PARAMETER);
    if (url.origin !== 'https://www.douyin.com' || url.pathname !== '/' ||
      url.searchParams.get('recommend') !== '1' ||
      !['inspect', 'next', 'trace-next', 'series-next', 'observe-product', 'observe-pair', 'observe-manual'].includes(mode) || root[API_KEY]) return null;
    try {
      url.searchParams.delete(PARAMETER);
      root.history.replaceState(root.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    } catch { return null; }
    if (mode === 'observe-product') return observeProduct(root);
    if (mode === 'observe-pair') return createPairLauncher(root);
    if (mode === 'observe-manual') return createPairLauncher(root, true);
    const doc = root.document;
    const route = root.location.href;
    const start = root.performance.now();
    let active = true;
    let timer = null;
    let feed = null;
    let report = null;
    let navigationCalls = 0;
    let dispatchedAt = null;
    let lastId = null;
    let identityChanges = 0;
    let firstChangeMs = null;
    let beforeMedia = null;
    let afterMedia = null;
    let discovery = {};
    let trace = null;
    const rounds = [];
    const attemptedIds = new Set();
    let expectedId = null;
    const listeners = [];
    function finish(outcome, details = {}) {
      if (!active) return;
      active = false;
      if (timer !== null) root.clearTimeout(timer);
      for (const [type, callback] of listeners) doc.removeEventListener(type, callback, true);
      trace?.stop();
        report = { probe: 'native-navigation', probeVersion: '0.6.1-test', mode, ...discovery, ...details, outcome,
        elapsedMs: Math.round(root.performance.now() - start), navigationCalls,
        dispatchElapsedMs: dispatchedAt === null ? null : Math.round(dispatchedAt - start),
        identityChanges, firstChangeMs, beforeMedia, afterMedia, trace: trace?.snapshot() ?? null, rounds };
      root.console.info('[DWE Native Probe]', JSON.stringify(report));
    }
    function blocked() {
      if (doc.visibilityState !== 'visible') return 'background';
      if (root.location.href !== route) return 'route-changed';
      if (doc.querySelector('[role="dialog"][aria-modal="true"], dialog[open]')) return 'dialog-open';
      if (doc.querySelector('[data-dwe-video-state]')) return 'enhancer-active';
      if (doc.activeElement?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return 'editable-focus';
      return null;
    }
    function media(card) {
      const videos = card ? [...card.querySelectorAll('video')] : [];
      const playing = video => !video.paused && !video.ended;
      return { activeVideoCount: videos.length, activePlaying: videos.filter(playing).length,
        otherPlaying: [...doc.querySelectorAll('video')].filter(video => !videos.includes(video) && playing(video)).length };
    }
    function tick() {
      timer = null;
      if (!active) return;
      try {
        const reason = blocked();
        if (reason) return finish(reason);
        if (root.performance.now() - start >= 30_000) return finish('session-timeout');
        const roots = [...doc.querySelectorAll(ROOT)];
        if (feed && (roots.length !== 1 || roots[0] !== feed)) return finish('root-changed');
        if (roots.length === 1) {
          feed = roots[0];
          const cards = [...feed.querySelectorAll(CARD)];
          if (cards.length > 1) return finish('ambiguous-card');
          if (dispatchedAt !== null) {
            const id = cards.length === 1 ? cards[0].getAttribute('data-e2e-vid') : null;
            afterMedia = media(cards[0]);
            if (/^\d{10,}$/.test(id || '') && id !== lastId) {
              identityChanges += 1;
              if (firstChangeMs === null) firstChangeMs = Math.round(root.performance.now() - dispatchedAt);
              lastId = id;
            }
            if (root.performance.now() - dispatchedAt >= 5_000) {
              const outcome = !/^\d{10,}$/.test(id || '') ? 'ambiguous-card' : identityChanges === 1
                ? 'one-change-observed' : identityChanges > 1 ? 'multiple-changes' : 'not-confirmed';
              if (mode !== 'series-next') return finish(outcome);
              trace?.stop();
              const traceReport = trace?.snapshot() ?? null;
              rounds.push({ outcome, dispatchElapsedMs: Math.round(dispatchedAt - start),
                identityChanges, firstChangeMs, beforeMedia, afterMedia, trace: traceReport });
              if (outcome !== 'one-change-observed') return finish(outcome);
              if (traceReport?.cleanup !== 'restored') return finish('trace-cleanup-incomplete');
              if (navigationCalls >= 3) return finish('three-changes-confirmed');
              // 每轮先完整确认，再重取新卡片的当前实例；绝不向失败卡片补发事件。
              expectedId = id;
              dispatchedAt = null;
              identityChanges = 0;
              firstChangeMs = null;
              beforeMedia = null;
              afterMedia = null;
              trace = null;
              timer = root.setTimeout(tick, 100);
              return;
            }
            timer = root.setTimeout(tick, 100);
            return;
          }
          if (cards.length === 1) {
            const cardId = cards[0].getAttribute('data-e2e-vid');
            if (expectedId !== null && cardId !== expectedId) return finish('between-round-drift');
            let candidate = null;
            const details = discover(cards[0], feed, value => { candidate = value; });
            if (mode === 'inspect' || !candidate) {
              if (details.outcome !== 'no-fiber') return finish(details.outcome, details);
            } else {
              discovery = details;
              const videos = [...cards[0].querySelectorAll('video')];
              const video = videos[0];
              beforeMedia = media(cards[0]);
              if (videos.length !== 1 || beforeMedia.activePlaying !== 1 || beforeMedia.otherPlaying !== 0 ||
                video.readyState < 2) return finish('media-not-ready');
              const remainingMs = (video.duration - video.currentTime) / video.playbackRate * 1_000;
              if (!Number.isFinite(remainingMs) || video.playbackRate <= 0 || remainingMs < 10_000) return finish('near-video-end');
              if (own(own(candidate, 'touchData'), 'animating') !== false) return finish('animation-not-ready');
              const isDisabled = own(candidate, 'isDisabled');
              if (typeof isDisabled !== 'function' || isDisabled.call(candidate) !== false) return finish('navigation-disabled');
              // 调用站点状态方法后重新验证上下文与实例，不叠加键盘或直接 slideNext 兜底。
              const blockedNow = blocked();
              if (!active) return;
              if (blockedNow) return finish(blockedNow);
              const freshRoots = [...doc.querySelectorAll(ROOT)];
              if (freshRoots.length !== 1 || freshRoots[0] !== feed) return finish('root-changed');
              const freshCards = [...feed.querySelectorAll(CARD)];
              if (freshCards.length !== 1 || freshCards[0] !== cards[0]) return finish('card-changed');
              let freshCandidate = null;
              discover(cards[0], feed, value => { freshCandidate = value; });
              if (freshCandidate !== candidate) return finish('candidate-changed');
              if (own(own(candidate, 'touchData'), 'animating') !== false) return finish('animation-not-ready');
              if (attemptedIds.has(cardId)) return finish('already-attempted-card');
              if (mode === 'trace-next' || mode === 'series-next') {
                trace = createNavigationTrace(candidate, () => root.performance.now());
                if (!trace) return finish('trace-unavailable');
              }
              lastId = cards[0].getAttribute('data-e2e-vid');
              dispatchedAt = root.performance.now();
              attemptedIds.add(cardId);
              navigationCalls += 1;
              own(candidate, 'emit').call(candidate, 'changeNext', { from: 'keyboard' });
              if (active) timer = root.setTimeout(tick, 100);
              return;
            }
          }
        }
        if (root.performance.now() - start >= 15_000) return finish('not-ready');
        timer = root.setTimeout(tick, 500);
      } catch { finish('probe-error'); }
    }
    for (const type of ['visibilitychange', 'keydown', 'wheel', 'pointerdown']) {
      const callback = event => {
        if (type === 'visibilitychange') {
          if (doc.visibilityState !== 'visible') finish('background');
        } else if (event.isTrusted) finish('user-input');
      };
      doc.addEventListener(type, callback, true);
      listeners.push([type, callback]);
    }
    const api = Object.freeze({ stop: () => finish('stopped'), snapshot: () => report ? JSON.parse(JSON.stringify(report)) : null });
    root[API_KEY] = api;
    timer = root.setTimeout(tick, 1_000);
    return api;
  }
  function createPairLauncher(root, manual = false) {
    const button = root.document.createElement('button');
    button.type = 'button';
    button.textContent = manual ? '记录一次手动方向键' : '开始首次／再次对照';
    button.setAttribute('data-dwe-probe-launcher', '');
    button.title = '普通点击记录自动跳过；Shift 点击后按方向键，记录手动导航。';
    button.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;padding:10px;background:#222;color:#fff;border:1px solid #aaa;border-radius:6px;';
    let session = null;
    let stopped = false;
    const start = event => {
      if (stopped || !event.isTrusted) return;
      session?.stop();
      const manualRun = manual || event.shiftKey === true;
      session = observeProduct(root, !manualRun, manualRun);
      root[API_KEY] = api;
      button.textContent = manual ? '记录一次手动方向键' : '重新开始首次／再次对照';
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      session?.stop();
      button.removeEventListener('click', start);
      root.removeEventListener('pagehide', stop);
      button.remove();
    };
    const api = Object.freeze({ stop, snapshot: () => session?.snapshot() ?? null });
    button.addEventListener('click', start);
    root.addEventListener('pagehide', stop);
    root.document.documentElement.appendChild(button);
    root[API_KEY] = api;
    return api;
  }

  function observeProduct(root, paired = false, manual = false) {
    const doc = root.document;
    const route = root.location.href;
    const start = root.performance.now();
    let active = true;
    let timer = null;
    let trace = null;
    let report = null;
    let watchedFeed = null;
    let armedAt = null;
    let firstChangeMs = null;
    let changedCount = 0;
    let lastId = null;
    let targetId = null;
    let exitedTarget = false;
    let ambiguousSamples = 0;
    const rounds = [];
    const listeners = [];
    function finish(outcome) {
      if (!active) return;
      active = false;
      if (timer !== null) root.clearTimeout(timer);
      for (const [target, type, listener] of listeners) target.removeEventListener(type, listener, true);
      trace?.stop();
      report = { probe: 'native-navigation', probeVersion: '0.6.1-test', mode: manual ? 'observe-manual' : paired ? 'observe-pair' : 'observe-product', outcome,
        elapsedMs: Math.round(root.performance.now() - start), armed: trace !== null,
        firstChangeMs, changedCount, trace: trace?.snapshot() ?? null,
        ...(paired ? { rounds } : {}) };
      root.console.info('[DWE Native Probe]', JSON.stringify(report));
    }
    function tick() {
      timer = null;
      if (!active) return;
      try {
        if (root.performance.now() - start >= 300_000) return finish('session-timeout');
        if (doc.visibilityState !== 'visible') {
          if (trace) return finish('background');
          timer = root.setTimeout(tick, 250);
          return;
        }
        if (root.location.href !== route) return finish('route-changed');
        if (doc.querySelector('[role="dialog"][aria-modal="true"], dialog[open]')) return finish('dialog-open');
        const feeds = [...doc.querySelectorAll(ROOT)];
        if (feeds.length === 0 && !watchedFeed) {
          timer = root.setTimeout(tick, 100);
          return;
        }
        if (feeds.length !== 1 || (watchedFeed && feeds[0] !== watchedFeed)) return finish('root-changed');
        const cards = [...feeds[0].querySelectorAll(CARD)];
        if (paired && trace && root.performance.now() - armedAt >= 3_500) {
          trace.stop();
          const round = { attempt: rounds.length + 1, sameTarget: true, firstChangeMs, changedCount,
            ambiguousSamples, outcome: changedCount ? 'identity-change-observed' : 'not-confirmed',
            trace: trace.snapshot() };
          rounds.push(round);
          root.console.info('[DWE Native Probe Round]', JSON.stringify(round));
          trace = null;
          if (round.trace.cleanup !== 'restored') return finish('trace-cleanup-incomplete');
          if (rounds.length === 2) return finish('pair-observed');
        }
        if (cards.length === 0 && !trace) {
          timer = root.setTimeout(tick, 100);
          return;
        }
        if (cards.length !== 1) {
          if (!paired) return finish('ambiguous-card');
          if (trace) ambiguousSamples += 1;
          timer = root.setTimeout(tick, trace ? 25 : 100);
          return;
        }
        const card = cards[0];
        const id = card.getAttribute('data-e2e-vid');
        if (!/^\d{10,}$/.test(id || '')) return finish('invalid-card-id');
        if (targetId !== null && id !== targetId) exitedTarget = true;
        if (trace) {
          if (id !== lastId) {
            changedCount += 1;
            if (firstChangeMs === null) firstChangeMs = Math.round(root.performance.now() - armedAt);
            lastId = id;
          }
          if (!paired && root.performance.now() - armedAt >= 3_500) return finish(
            changedCount === 0 ? 'not-confirmed' : changedCount === 1 ? 'one-change-observed' : 'multiple-changes',
          );
        } else if ((manual || card.getAttribute('data-dwe-video-state') === 'block') &&
          (!paired || targetId === null || (exitedTarget && id === targetId))) {
          const details = discover(card, feeds[0], candidate => {
            trace = createNavigationTrace(candidate, () => root.performance.now(), true);
          });
          if (details.outcome !== 'candidate-observed') return finish(details.outcome);
          if (!trace) return finish('trace-unavailable');
          watchedFeed = feeds[0];
          targetId ??= id;
          exitedTarget = false;
          firstChangeMs = null;
          changedCount = 0;
          ambiguousSamples = 0;
          lastId = id;
          armedAt = root.performance.now();
        }
        timer = root.setTimeout(tick, trace ? 25 : 100);
      } catch { finish('probe-error'); }
    }
    for (const [target, type] of [[doc, 'visibilitychange'], [root, 'pagehide']]) {
      const listener = () => {
        if (type === 'pagehide' || (trace && doc.visibilityState !== 'visible')) {
          finish(type === 'pagehide' ? 'pagehide' : 'background');
        }
      };
      target.addEventListener(type, listener, true);
      listeners.push([target, type, listener]);
    }
    if (paired) {
      for (const type of ['keydown', 'wheel', 'pointerdown']) {
        const listener = event => {
          if (trace && event.isTrusted) finish('user-input-during-observation');
        };
        doc.addEventListener(type, listener, true);
        listeners.push([doc, type, listener]);
      }
    }
    const api = Object.freeze({ stop: () => finish('stopped'), snapshot: () => report ? JSON.parse(JSON.stringify(report)) : null });
    root[API_KEY] = api;
    timer = root.setTimeout(tick, 100);
    return api;
  }
  return Object.freeze({ own, discover, bootstrap, createNavigationTrace, observeProduct, ROOT, CARD, API_KEY });
});

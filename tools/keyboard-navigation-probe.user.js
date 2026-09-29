// ==UserScript==
// @name         Douyin Web Enhancer - Keyboard Navigation Probe
// @namespace    https://github.com/OnlyDreams/douyin-web-enhancer
// @version      0.3.0-test
// @description  Opt-in, one-shot keyboard navigation comparison; no media writes.
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
  const PARAMETER = 'dwe_keyboard_probe';
  const WAIT_PARAMETER = 'dwe_keyboard_wait';
  const CONFIRM_MS = 5_000;
  const API_KEY = '__DWE_KEYBOARD_PROBE__';
  const MODES = ['baseline', 'body-down', 'focus-pair'];
  const ROOT = '[data-e2e="slideList"][data-active="true"]';
  const CARD = '[data-e2e="feed-active-video"][data-e2e-vid]';
  const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';

  function getMode(href) {
    try {
      const url = new URL(href);
      if (url.origin !== 'https://www.douyin.com' || url.pathname !== '/') return null;
      if (url.searchParams.get('recommend') !== '1') return null;
      const mode = url.searchParams.get(PARAMETER);
      return MODES.includes(mode) ? mode : null;
    } catch {
      return null;
    }
  }

  function getStableWaitMs(href) {
    try {
      const value = new URL(href).searchParams.get(WAIT_PARAMETER);
      if (value === null || value === 'early' || value === 'next-card') return 1_000;
      if (value === 'settled') return 8_000;
      return null;
    } catch {
      return null;
    }
  }

  function inspect(root) {
    const doc = root.document;
    const roots = [...doc.querySelectorAll(ROOT)];
    const cards = roots.length === 1 ? [...roots[0].querySelectorAll(CARD)] : [];
    const card = cards.length === 1 ? cards[0] : null;
    const id = card?.getAttribute('data-e2e-vid') ?? '';
    const videos = card ? [...card.querySelectorAll('video')] : [];
    const allVideos = [...doc.querySelectorAll('video')];
    const playing = video => !video.paused && !video.ended;
    const media = {
      activeVideoCount: videos.length,
      activePlaying: videos.filter(playing).length,
      otherPlaying: allVideos.filter(video => !videos.includes(video) && playing(video)).length,
    };
    const video = videos.length === 1 ? videos[0] : null;
    const rect = card?.getBoundingClientRect();
    const position = rect ? [rect.top, rect.left, rect.width, rect.height] : null;
    const playback = video ? {
      currentTime: video.currentTime,
      playbackRate: video.playbackRate,
      readyState: video.readyState,
      remainingWallMs: video.playbackRate > 0
        ? (video.duration - video.currentTime) / video.playbackRate * 1_000
        : null,
    } : null;
    return {
      feed: roots[0], card, id, videos, media, position, playback,
      ready: roots.length === 1 && cards.length === 1 && /^\d{10,}$/.test(id),
    };
  }

  function createProbe(root, mode, stableWaitMs = 1_000, waitForNextCard = false) {
    const doc = root.document;
    const started = root.performance.now();
    const route = root.location.href;
    let active = true;
    let timer = null;
    let baseline = null;
    let stableSince = started;
    let dispatchedAt = null;
    let lastId = '';
    let changes = 0;
    let events = 0;
    let report = null;
    let targetKind = 'none';
    let candidate = null;
    let previousTime = null;
    let firstChangeMs = null;
    let focusAtDispatch = null;
    let activationRequestedAt = null;
    let activationId = null;
    let activationAt = null;
    const listeners = [];

    function finish(outcome, state = null) {
      if (!active) return;
      active = false;
      if (timer !== null) root.clearTimeout(timer);
      for (const [type, listener] of listeners) doc.removeEventListener(type, listener, true);
      report = {
        probe: 'keyboard-navigation', probeVersion: '0.3.0-test', mode, outcome, targetKind,
        stableWaitMs,
        waitForNextCard,
        activationElapsedMs: activationAt === null ? null : Math.round(activationAt - started),
        eventCount: events, identityChanges: changes,
        dispatchElapsedMs: dispatchedAt === null ? null : Math.round(dispatchedAt - started),
        firstChangeMs,
        documentFocusedAtDispatch: focusAtDispatch,
        elapsedMs: Math.round(root.performance.now() - started),
        beforeMedia: baseline?.media ?? null,
        afterMedia: state?.media ?? null,
        beforePlayback: baseline?.playback ?? null,
      };
      // 只输出形状、计数和状态，不输出 ID、页面文本、媒体 URL 或错误消息。
      root.console.info('[DWE Keyboard Probe]', JSON.stringify(report));
    }

    function guard() {
      if (doc.visibilityState !== 'visible') return 'background';
      if (root.location.href !== route) return 'route-changed';
      if (doc.activeElement?.closest?.(EDITABLE)) return 'editable-focus';
      if (doc.querySelector('[role="dialog"][aria-modal="true"], dialog[open]')) return 'dialog-open';
      return null;
    }

    function tick() {
      timer = null;
      if (!active) return;
      try {
        const blocked = guard();
        if (blocked) return finish(blocked);
        const state = inspect(root);
        const now = root.performance.now();
        if (baseline && state.feed !== baseline.feed) return finish('root-changed', state);

        // 后续卡片实验只允许一次显式方向键启动；不把页面启动时间当成卡片等待时间。
        if (waitForNextCard && activationAt === null) {
          if (now - started >= 30_000) return finish('activation-timeout', state);
          if (activationRequestedAt !== null && now - activationRequestedAt >= 3_000) {
            return finish('activation-not-confirmed', state);
          }
          if (activationRequestedAt !== null && state.ready && state.id !== activationId) {
            activationAt = now;
          } else {
            timer = root.setTimeout(tick, 100);
            return;
          }
        }

        if (dispatchedAt === null) {
          if (now - (activationAt ?? started) >= 20_000) return finish('not-ready', state);
          const video = state.videos[0];
          const moving = candidate && state.position?.some((value, index) => Math.abs(value - candidate.position[index]) > 1);
          const playingReady = state.ready && state.videos.length === 1 &&
            state.media.activePlaying === 1 && video.readyState >= 2 &&
            state.position?.every(Number.isFinite) && state.position[2] > 0 && state.position[3] > 0;
          if (!playingReady) {
            candidate = null;
            previousTime = null;
            stableSince = now;
          } else if (!candidate || state.id !== candidate.id || video !== candidate.videos[0] || moving ||
            video.playbackRate !== candidate.playback.playbackRate || video.currentTime <= previousTime) {
            baseline = state;
            candidate = state;
            stableSince = now;
          } else if (now - stableSince >= stableWaitMs) {
            // 使用实际播放倍速计算墙钟余量，避免 2x 播放时自然连播落入观察窗。
            if (!Number.isFinite(state.playback.remainingWallMs) || state.playback.remainingWallMs < CONFIRM_MS + 5_000) {
              return finish('near-video-end', state);
            }
            baseline = state;
            lastId = state.id;
            dispatchedAt = now;
            focusAtDispatch = doc.hasFocus();
            if (mode !== 'baseline') {
              const target = mode === 'body-down' ? doc.body : (doc.activeElement || doc);
              targetKind = target === doc.body ? 'body' : target === doc ? 'document' : 'focused-element';
              const types = mode === 'body-down' ? ['keydown'] : ['keydown', 'keyup'];
              for (const type of types) {
                if (!active) return;
                const blockedNow = guard();
                if (blockedNow) return finish(blockedNow);
                // 两个社区方案分别保留其事件序列和 composed 设置。
                const event = new root.KeyboardEvent(type, {
                  key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40,
                  bubbles: true, cancelable: true, composed: mode === 'focus-pair',
                });
                events += 1;
                target.dispatchEvent(event);
              }
            }
          }
          previousTime = playingReady ? video.currentTime : null;
        } else {
          if (state.ready && state.id !== lastId) {
            changes += 1;
            if (firstChangeMs === null) firstChangeMs = Math.round(now - dispatchedAt);
            lastId = state.id;
          }
          if (now - dispatchedAt >= CONFIRM_MS) {
            const outcome = mode === 'baseline'
              ? (changes === 0 ? 'baseline-stable' : 'baseline-drift')
              : (!state.ready ? 'ambiguous-active-card' : changes === 1 ? 'one-change-observed' : changes > 1 ? 'multiple-changes' : 'not-confirmed');
            return finish(outcome, state);
          }
        }
        if (active) timer = root.setTimeout(tick, 100);
      } catch {
        finish('probe-error');
      }
    }

    const onInput = event => {
      if (!active || !event.isTrusted) return;
      if (waitForNextCard && activationRequestedAt === null && event.type === 'keydown' &&
        event.key === 'ArrowDown' && !event.repeat && !event.altKey && !event.ctrlKey &&
        !event.metaKey && !event.shiftKey && !guard()) {
        const state = inspect(root);
        if (state.ready) {
          baseline = state;
          activationId = state.id;
          activationRequestedAt = root.performance.now();
          return;
        }
      }
      finish('user-input');
    };
    const onVisibility = () => {
      if (doc.visibilityState !== 'visible') finish('background');
    };
    for (const [type, listener] of [
      ['keydown', onInput], ['wheel', onInput], ['pointerdown', onInput],
      ['visibilitychange', onVisibility],
    ]) {
      doc.addEventListener(type, listener, true);
      listeners.push([type, listener]);
    }
    timer = root.setTimeout(tick, 100);
    return Object.freeze({
      stop() { finish('stopped'); },
      snapshot() { return report ? JSON.parse(JSON.stringify(report)) : null; },
    });
  }

  function bootstrap(root) {
    const mode = getMode(root.location?.href);
    const stableWaitMs = getStableWaitMs(root.location?.href);
    if (!mode || stableWaitMs === null || root[API_KEY]) return null;
    const waitForNextCard = new URL(root.location.href).searchParams.get(WAIT_PARAMETER) === 'next-card';
    try {
      const url = new URL(root.location.href);
      url.searchParams.delete(PARAMETER);
      url.searchParams.delete(WAIT_PARAMETER);
      root.history.replaceState(root.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
      return null;
    }
    const probe = createProbe(root, mode, stableWaitMs, waitForNextCard);
    root[API_KEY] = probe;
    return probe;
  }

  return Object.freeze({ API_KEY, ROOT, CARD, getMode, getStableWaitMs, inspect, createProbe, bootstrap });
});

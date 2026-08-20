// ==UserScript==
// @name         Douyin Web Enhancer - Stage 2 Navigation Probe
// @namespace    https://github.com/OnlyDreams/douyin-web-enhancer
// @version      0.1.0-test
// @description  Opt-in, one-shot probe for Douyin's semantic next-video control.
// @match        https://www.douyin.com/*
// @run-at       document-idle
// @sandbox      raw
// @grant        none
// @noframes
// ==/UserScript==

((root, createModule) => {
  'use strict';

  const stage2Navigation = createModule();

  if (typeof module === 'object' && module?.exports) {
    module.exports = stage2Navigation;
    return;
  }

  stage2Navigation.bootstrap(root);
})(globalThis, () => {
  'use strict';

  const API_KEY = '__DWE_STAGE2_NAVIGATION_PROBE__';
  const QUERY_PARAMETER = 'dwe_stage2_navigation_probe';
  const PROBE_MODE = 'native-click';
  const ACTIVE_VIDEO_SELECTOR =
    '[data-e2e="feed-active-video"][data-e2e-vid]';
  const NEXT_CONTROL_SELECTOR = '[data-e2e="video-switch-next-arrow"]';
  const MAX_READY_WAIT_MS = 10_000;
  const MAX_CONFIRM_WAIT_MS = 3_000;

  function cloneJsonValue(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function describeIdentifier(value) {
    const text = typeof value === 'string' ? value : '';
    return Object.freeze({
      present: text.length > 0,
      decimal: /^\d+$/.test(text),
      length: text.length,
    });
  }

  function isSupportedLocation(locationLike) {
    try {
      const url = new URL(String(locationLike?.href ?? locationLike));
      return (
        url.protocol === 'https:' &&
        url.hostname === 'www.douyin.com' &&
        url.pathname === '/' &&
        url.searchParams.get('recommend') === '1'
      );
    } catch {
      return false;
    }
  }

  function getProbeMode(locationLike) {
    try {
      const url = new URL(String(locationLike?.href ?? locationLike));
      return url.searchParams.get(QUERY_PARAMETER) === PROBE_MODE
        ? PROBE_MODE
        : null;
    } catch {
      return null;
    }
  }

  function consumeProbeParameter(root) {
    const url = new URL(String(root.location?.href));
    url.searchParams.delete(QUERY_PARAMETER);
    root.history.replaceState(
      root.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
    return true;
  }

  function isUsableControl(control, root) {
    if (!control || control.isConnected === false || typeof control.click !== 'function') {
      return false;
    }

    try {
      const rect = control.getBoundingClientRect();
      const style = root.getComputedStyle(control);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.pointerEvents !== 'none'
      );
    } catch {
      return false;
    }
  }

  function inspectNavigationState(documentLike, root) {
    const activeVideos = Array.from(
      documentLike.querySelectorAll(ACTIVE_VIDEO_SELECTOR),
    );
    const nextControls = Array.from(
      documentLike.querySelectorAll(NEXT_CONTROL_SELECTOR),
    );
    const activeVideo = activeVideos.length === 1 ? activeVideos[0] : null;
    const nextControl = nextControls.length === 1 ? nextControls[0] : null;
    const activeId = activeVideo?.getAttribute('data-e2e-vid') ?? '';
    const activeIdShape = describeIdentifier(activeId);
    const controlUsable = isUsableControl(nextControl, root);

    return {
      activeCount: activeVideos.length,
      controlCount: nextControls.length,
      activeId,
      activeIdShape,
      activeVideo,
      nextControl,
      controlUsable,
      ready:
        activeVideos.length === 1 &&
        nextControls.length === 1 &&
        activeIdShape.decimal &&
        activeIdShape.length >= 10 &&
        controlUsable,
    };
  }

  function summarizeState(state) {
    return {
      activeCount: state.activeCount,
      controlCount: state.controlCount,
      activeIdShape: state.activeIdShape,
      controlUsable: state.controlUsable,
    };
  }

  function createNavigationProbe(root, options = {}) {
    const documentLike = options.document ?? root.document;
    const MutationObserverLike =
      options.MutationObserver ?? root.MutationObserver;
    const setTimeoutLike = options.setTimeout ?? root.setTimeout.bind(root);
    const clearTimeoutLike =
      options.clearTimeout ?? root.clearTimeout.bind(root);
    const now = options.now ?? (() => root.performance.now());
    const logger = options.logger ?? root.console;
    const readyWaitMs = options.readyWaitMs ?? MAX_READY_WAIT_MS;
    const confirmWaitMs = options.confirmWaitMs ?? MAX_CONFIRM_WAIT_MS;
    const startedMs = now();

    let active = true;
    let clickCount = 0;
    let report = null;
    let beforeId = '';
    let readyObserver = null;
    let confirmObserver = null;
    let readyTimer = null;
    let confirmTimer = null;

    function cleanup() {
      readyObserver?.disconnect();
      confirmObserver?.disconnect();
      readyObserver = null;
      confirmObserver = null;

      if (readyTimer !== null) {
        clearTimeoutLike(readyTimer);
        readyTimer = null;
      }
      if (confirmTimer !== null) {
        clearTimeoutLike(confirmTimer);
        confirmTimer = null;
      }
    }

    function finish(outcome, state, extra = {}) {
      if (!active || report) return false;

      active = false;
      cleanup();
      report = Object.freeze({
        schemaVersion: 1,
        probe: 'stage2-navigation',
        mode: PROBE_MODE,
        outcome,
        clickCount,
        activeIdentityChanged: outcome === 'confirmed',
        elapsedMs: Math.max(0, Math.round(now() - startedMs)),
        state: summarizeState(state),
        ...extra,
      });
      logger?.info?.(
        '[DWE Stage 2 Navigation Probe]',
        JSON.stringify(report),
      );
      return true;
    }

    function inspect() {
      return inspectNavigationState(documentLike, root);
    }

    function checkConfirmation() {
      if (!active || clickCount !== 1) return false;

      const state = inspect();
      if (
        state.activeCount === 1 &&
        state.activeIdShape.decimal &&
        state.activeIdShape.length >= 10 &&
        state.activeId !== beforeId
      ) {
        return finish('confirmed', state);
      }
      return false;
    }

    function attemptNavigation(state) {
      if (!active || clickCount !== 0 || !state.ready) return false;

      beforeId = state.activeId;
      confirmObserver = new MutationObserverLike(checkConfirmation);
      confirmObserver.observe(documentLike.documentElement, {
        attributes: true,
        attributeFilter: ['data-e2e', 'data-e2e-vid'],
        childList: true,
        subtree: true,
      });
      confirmTimer = setTimeoutLike(() => {
        if (!active) return;
        finish('not-confirmed', inspect());
      }, confirmWaitMs);

      clickCount = 1;
      try {
        state.nextControl.click();
      } catch (error) {
        finish('click-error', inspect(), {
          errorName: error?.name ?? 'Error',
        });
        return false;
      }

      checkConfirmation();
      return true;
    }

    function checkReadiness() {
      if (!active || clickCount !== 0) return false;
      const state = inspect();
      if (!state.ready) return false;

      readyObserver?.disconnect();
      readyObserver = null;
      if (readyTimer !== null) {
        clearTimeoutLike(readyTimer);
        readyTimer = null;
      }
      return attemptNavigation(state);
    }

    const initialState = inspect();
    if (initialState.ready) {
      attemptNavigation(initialState);
    } else {
      readyObserver = new MutationObserverLike(checkReadiness);
      readyObserver.observe(documentLike.documentElement, {
        attributes: true,
        attributeFilter: ['data-e2e', 'data-e2e-vid'],
        childList: true,
        subtree: true,
      });
      readyTimer = setTimeoutLike(() => {
        if (!active) return;
        finish('not-ready', inspect());
      }, readyWaitMs);
    }

    return Object.freeze({
      get active() {
        return active;
      },
      snapshot() {
        return report ? cloneJsonValue(report) : null;
      },
      stop() {
        if (!active) return false;
        active = false;
        cleanup();
        return true;
      },
    });
  }

  function bootstrap(root, options = {}) {
    if (getProbeMode(root.location) !== PROBE_MODE) return null;
    if (root[API_KEY]) return root[API_KEY];

    const logger = options.logger ?? root.console;
    const documentLike = options.document ?? root.document;
    const createProbe = options.createProbe ?? createNavigationProbe;

    if (!isSupportedLocation(root.location)) {
      logger?.info?.(
        '[DWE Stage 2 Navigation Probe]',
        JSON.stringify({
          schemaVersion: 1,
          probe: 'stage2-navigation',
          mode: PROBE_MODE,
          outcome: 'unsupported-route',
          clickCount: 0,
          activeIdentityChanged: false,
        }),
      );
      return null;
    }

    try {
      consumeProbeParameter(root);
    } catch (error) {
      logger?.info?.(
        '[DWE Stage 2 Navigation Probe]',
        JSON.stringify({
          schemaVersion: 1,
          probe: 'stage2-navigation',
          mode: PROBE_MODE,
          outcome: 'opt-in-not-consumed',
          clickCount: 0,
          activeIdentityChanged: false,
          errorName: error?.name ?? 'Error',
        }),
      );
      return null;
    }

    const probe = createProbe(root, { ...options, document: documentLike });
    root[API_KEY] = probe;
    return probe;
  }

  return Object.freeze({
    API_KEY,
    QUERY_PARAMETER,
    PROBE_MODE,
    ACTIVE_VIDEO_SELECTOR,
    NEXT_CONTROL_SELECTOR,
    bootstrap,
    consumeProbeParameter,
    createNavigationProbe,
    describeIdentifier,
    getProbeMode,
    inspectNavigationState,
    isSupportedLocation,
    isUsableControl,
    summarizeState,
  });
});

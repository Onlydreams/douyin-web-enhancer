// ==UserScript==
// @name         Douyin Web Enhancer - Stage 0 Probe
// @namespace    https://github.com/OnlyDreams/douyin-web-enhancer
// @version      0.2.1-test
// @description  Read-only, opt-in Stage 0 timing and structure probe.
// @match        https://www.douyin.com/*
// @run-at       document-start
// @sandbox      raw
// @grant        GM_info
// ==/UserScript==

((root, createModule) => {
  'use strict';

  const stage0 = createModule();

  if (typeof module === 'object' && module?.exports) {
    module.exports = stage0;
    return;
  }

  stage0.bootstrap(root);
})(globalThis, () => {
  'use strict';

  const API_KEY = '__DWE_STAGE0_PROBE__';
  const PROBE_MODE = 'capture';
  const MAX_EVENTS = 400;
  const MAX_CAPTURE_MS = 30_000;
  const CANDIDATE_RESOURCE = /(?:aweme|feed|render|rsc|danmaku|bullet|music|video|play)/i;
  const TRANSPORT_RESOURCE = /(?:\/aweme\/v1\/web\/tab\/feed\/|render|rsc|danmaku|bullet|music)/i;
  const MAX_RESPONSE_TEXT_LENGTH = 4 * 1024 * 1024;

  const cloneJsonValue = (value) => JSON.parse(JSON.stringify(value));

  const getProbeMode = (locationLike) => {
    try {
      const url = new URL(String(locationLike?.href ?? locationLike));
      return url.searchParams.get('dwe_stage0_probe') === PROBE_MODE ? PROBE_MODE : null;
    } catch {
      return null;
    }
  };

  const sanitizeResource = (value, baseUrl = 'https://www.douyin.com/') => {
    try {
      const url = new URL(String(value), baseUrl);
      const sameOrigin = url.origin === new URL(baseUrl).origin;
      if (!sameOrigin) return { sameOrigin: false, path: '<external>' };

      const path = url.pathname
        .split('/')
        .map((segment) => {
          if (/^\d{10,}$/.test(segment)) return '<id>';
          if (/^[a-f\d]{16,}$/i.test(segment)) return '<opaque>';
          if (/^[a-z\d_-]{32,}$/i.test(segment)) return '<opaque>';
          return segment;
        })
        .join('/');
      return {
        sameOrigin: true,
        path,
      };
    } catch {
      return { sameOrigin: false, path: '<unparseable>' };
    }
  };

  const describeIdentifier = (value) => {
    const text = typeof value === 'string' ? value : '';
    return {
      present: text.length > 0,
      decimal: /^\d+$/.test(text),
      length: text.length,
    };
  };

  const summarizeMetadataShape = (rootValue, options = {}) => {
    const maximumObjects = options.maximumObjects ?? 10_000;
    const maximumDepth = options.maximumDepth ?? 14;
    const queue = [{ value: rootValue, depth: 0 }];
    let queueIndex = 0;
    const seen = new WeakSet();
    const matches = new Map();
    let scannedObjects = 0;

    while (queueIndex < queue.length && scannedObjects < maximumObjects) {
      const current = queue[queueIndex];
      queueIndex += 1;
      const value = current.value;
      if (value == null || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      scannedObjects += 1;

      if (Array.isArray(value)) {
        if (current.depth < maximumDepth) {
          for (const item of value) queue.push({ value: item, depth: current.depth + 1 });
        }
        continue;
      }

      const keys = Object.keys(value);
      const videoIdKeys = ['awemeId', 'aweme_id', 'gid']
        .filter((key) => typeof value[key] === 'string' || typeof value[key] === 'number');

      for (const musicContainerKey of ['music', 'musicInfo', 'music_info']) {
        const music = value[musicContainerKey];
        if (music == null || typeof music !== 'object' || Array.isArray(music)) continue;
        const musicNameKeys = ['title', 'musicName', 'music_name']
          .filter((key) => typeof music[key] === 'string');
        if (videoIdKeys.length === 0 || musicNameKeys.length === 0) continue;

        const idValues = videoIdKeys.map((key) => String(value[key]));
        const shape = {
          videoIdKeys: [...videoIdKeys].sort(),
          musicContainerKey,
          musicNameKeys: [...musicNameKeys].sort(),
          idFieldsConsistent: new Set(idValues).size === 1,
        };
        const signature = JSON.stringify(shape);
        const existing = matches.get(signature);
        matches.set(signature, { ...shape, count: (existing?.count ?? 0) + 1 });
      }

      if (current.depth < maximumDepth) {
        for (const key of keys) queue.push({ value: value[key], depth: current.depth + 1 });
      }
    }

    return {
      scannedObjects,
      truncated: queueIndex < queue.length,
      matches: [...matches.values()].sort((left, right) => (
        right.count - left.count
        || JSON.stringify(left).localeCompare(JSON.stringify(right))
      )),
    };
  };

  const responseSizeBucket = (length) => {
    if (length <= 256 * 1024) return '<=256KiB';
    if (length <= 1024 * 1024) return '<=1MiB';
    if (length <= MAX_RESPONSE_TEXT_LENGTH) return '<=4MiB';
    return '>4MiB';
  };

  const summarizeXhrResponse = (xhr, resource) => {
    if (resource.path !== '/aweme/v1/web/tab/feed/') return null;

    try {
      if (xhr.responseType === 'json' && xhr.response && typeof xhr.response === 'object') {
        return { parsed: true, source: 'response-json', metadataShape: summarizeMetadataShape(xhr.response) };
      }
      if (xhr.responseType && xhr.responseType !== 'text') {
        return { parsed: false, reason: 'unsupported-response-type' };
      }

      const text = xhr.responseText;
      if (typeof text !== 'string') return { parsed: false, reason: 'text-unavailable' };
      const sizeBucket = responseSizeBucket(text.length);
      if (text.length > MAX_RESPONSE_TEXT_LENGTH) {
        return { parsed: false, reason: 'response-too-large', sizeBucket };
      }
      const trimmed = text.trimStart();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return { parsed: false, reason: 'not-json-text', sizeBucket };
      }

      return {
        parsed: true,
        source: 'response-text',
        sizeBucket,
        metadataShape: summarizeMetadataShape(JSON.parse(text)),
      };
    } catch (error) {
      return { parsed: false, reason: 'parse-failed', errorName: error?.name ?? 'Error' };
    }
  };

  const describeMediaContext = (video) => {
    const ancestorE2e = [];
    let ancestor = video?.parentElement ?? null;
    let depth = 1;
    let closestVideoId = describeIdentifier('');
    let videoIdDepth = null;

    while (ancestor && depth <= 16) {
      const e2e = ancestor.getAttribute?.('data-e2e');
      if (e2e && ancestorE2e.length < 8) {
        ancestorE2e.push(/^[a-z\d_-]{1,64}$/i.test(e2e) ? e2e : '<other>');
      }
      const videoId = ancestor.getAttribute?.('data-e2e-vid');
      if (videoIdDepth == null && videoId) {
        closestVideoId = describeIdentifier(videoId);
        videoIdDepth = depth;
      }
      ancestor = ancestor.parentElement;
      depth += 1;
    }

    return { ancestorE2e, closestVideoId, videoIdDepth };
  };

  const createRecorder = (maximum = MAX_EVENTS) => {
    const events = [];
    let dropped = 0;

    return {
      push(event) {
        if (events.length >= maximum) {
          dropped += 1;
          return false;
        }
        events.push(event);
        return true;
      },
      snapshot() {
        return { events: cloneJsonValue(events), dropped };
      },
    };
  };

  const createFetchCapture = ({ root, record, now }) => {
    const originalFetch = root.fetch;
    if (typeof originalFetch !== 'function') {
      return { installed: false, restore() {} };
    }

    let firstFetchRecorded = false;

    function stage0FetchCapture(...args) {
      const startedMs = now();
      let result;

      try {
        result = Reflect.apply(originalFetch, this, args);
      } catch (error) {
        record({
          type: 'fetch-throw',
          ms: now(),
          startedMs,
          errorName: error?.name ?? 'Error',
        });
        throw error;
      }

      const request = args[0];
      const requestUrl = typeof request === 'string' || request instanceof URL
        ? request
        : request?.url;
      const resource = sanitizeResource(requestUrl, root.location?.href);
      const method = String(args[1]?.method ?? request?.method ?? 'GET').toUpperCase();

      if (!firstFetchRecorded) {
        firstFetchRecorded = true;
        record({ type: 'fetch-first-call', ms: startedMs });
      }

      if (!TRANSPORT_RESOURCE.test(resource.path)) return result;

      record({ type: 'fetch-candidate-call', ms: startedMs, method, resource });

      if (result && typeof result.then === 'function') {
        result.then(
          (response) => {
            record({
              type: 'fetch-candidate-settle',
              ms: now(),
              startedMs,
              resource,
              ok: Boolean(response?.ok),
              status: Number(response?.status ?? 0),
              contentType: response?.headers?.get?.('content-type')?.split(';', 1)[0] ?? null,
            });
          },
          (error) => {
            record({
              type: 'fetch-candidate-reject',
              ms: now(),
              startedMs,
              resource,
              errorName: error?.name ?? 'Error',
            });
          },
        );
      }

      return result;
    }

    root.fetch = stage0FetchCapture;

    return {
      installed: true,
      wrapper: stage0FetchCapture,
      original: originalFetch,
      restore() {
        if (root.fetch === stage0FetchCapture) {
          root.fetch = originalFetch;
          return true;
        }
        return false;
      },
    };
  };

  const createXhrCapture = ({ root, record, now }) => {
    const Xhr = root.XMLHttpRequest;
    const prototype = Xhr?.prototype;
    const originalOpen = prototype?.open;
    const originalSend = prototype?.send;
    if (typeof originalOpen !== 'function' || typeof originalSend !== 'function') {
      return { installed: false, restore: () => ({ open: false, send: false }) };
    }

    const states = new WeakMap();
    const pendingListeners = new Map();
    let firstOpenRecorded = false;

    function stage0XhrOpen(method, url, ...rest) {
      const openedMs = now();
      const resource = sanitizeResource(url, root.location?.href);
      const candidate = TRANSPORT_RESOURCE.test(resource.path);
      states.set(this, {
        candidate,
        method: String(method ?? 'GET').toUpperCase(),
        openedMs,
        resource,
      });

      if (!firstOpenRecorded) {
        firstOpenRecorded = true;
        record({ type: 'xhr-first-open', ms: openedMs });
      }
      if (candidate) {
        record({
          type: 'xhr-candidate-open',
          ms: openedMs,
          method: String(method ?? 'GET').toUpperCase(),
          resource,
        });
      }

      return Reflect.apply(originalOpen, this, [method, url, ...rest]);
    }

    function stage0XhrSend(...args) {
      const state = states.get(this);
      if (state?.candidate) {
        const sentMs = now();
        record({
          type: 'xhr-candidate-send',
          ms: sentMs,
          openedMs: state.openedMs,
          method: state.method,
          resource: state.resource,
          hasBody: args[0] != null,
        });

        const onLoadEnd = () => {
          this.removeEventListener?.('loadend', onLoadEnd);
          pendingListeners.delete(this);
          record({
            type: 'xhr-candidate-settle',
            ms: now(),
            openedMs: state.openedMs,
            resource: state.resource,
            status: Number(this.status ?? 0),
            contentType: this.getResponseHeader?.('content-type')?.split(';', 1)[0] ?? null,
          });
          queueMicrotask(() => {
            record({
              type: 'xhr-candidate-shape',
              ms: now(),
              openedMs: state.openedMs,
              resource: state.resource,
              responseSummary: summarizeXhrResponse(this, state.resource),
            });
          });
        };
        this.addEventListener?.('loadend', onLoadEnd);
        pendingListeners.set(this, onLoadEnd);
      }

      return Reflect.apply(originalSend, this, args);
    }

    prototype.open = stage0XhrOpen;
    prototype.send = stage0XhrSend;

    return {
      installed: true,
      restore() {
        for (const [xhr, listener] of pendingListeners) {
          xhr.removeEventListener?.('loadend', listener);
        }
        pendingListeners.clear();
        const restored = { open: false, send: false };
        if (prototype.open === stage0XhrOpen) {
          prototype.open = originalOpen;
          restored.open = true;
        }
        if (prototype.send === stage0XhrSend) {
          prototype.send = originalSend;
          restored.send = true;
        }
        return restored;
      },
    };
  };

  const createDanmakuTracker = (record) => {
    const states = new WeakMap();

    return (node) => {
      if (!node?.matches?.('[data-danmu-id]')) return;

      const id = node.getAttribute('data-danmu-id') ?? '';
      const text = node.textContent ?? '';
      const state = {
        id,
        text,
        identifier: describeIdentifier(id),
        directChildren: Number(node.children?.length ?? 0),
        textPresent: text.trim().length > 0,
        textLength: text.length,
      };
      const previous = states.get(node);
      states.set(node, state);

      if (!previous) {
        record({ type: 'danmaku-observed', ...state, id: undefined, text: undefined });
        return;
      }
      if (previous.id !== id) {
        record({
          type: 'danmaku-node-reused',
          previousIdentifier: previous.identifier,
          identifier: state.identifier,
          directChildren: state.directChildren,
          textPresent: state.textPresent,
          textLength: state.textLength,
        });
        return;
      }
      if (previous.text !== text) {
        record({
          type: 'danmaku-content-changed',
          identifier: state.identifier,
          directChildren: state.directChildren,
          previousTextLength: previous.text.length,
          textPresent: state.textPresent,
          textLength: state.textLength,
        });
      }
    };
  };

  const createCaptureProbe = (root, options = {}) => {
    const scriptRoot = options.scriptRoot ?? root;
    const document = options.document ?? root.document;
    const performance = options.performance ?? root.performance;
    const now = options.now ?? (() => performance.now());
    const startedAt = now();
    const recorder = createRecorder(options.maximumEvents ?? MAX_EVENTS);
    const cleanups = [];
    const frameCallbacks = new Map();
    const instrumentedVideos = new WeakSet();
    let active = true;
    let stoppedReason = null;

    const relativeNow = () => Math.max(0, now() - startedAt);
    const record = (event) => {
      if (!active && event.type !== 'probe-stop') return false;
      return recorder.push({ ...event, ms: event.ms ?? relativeNow() });
    };
    const trackDanmaku = createDanmakuTracker(record);
    const addCleanup = (cleanup) => cleanups.push(cleanup);

    const report = {
      schemaVersion: 1,
      mode: PROBE_MODE,
      started: {
        readyState: document?.readyState ?? null,
        visibilityState: document?.visibilityState ?? null,
        documentElementPresent: Boolean(document?.documentElement),
        hasGmInfo: typeof GM_info !== 'undefined',
        hasModernGmInfo: typeof scriptRoot.GM?.info !== 'undefined',
        unsafeWindowAvailable: typeof scriptRoot.unsafeWindow !== 'undefined',
        pageRootSameAsScriptRoot: root === scriptRoot,
      },
    };

    const snapshot = () => {
      const recorded = recorder.snapshot();
      return cloneJsonValue({
        ...report,
        active,
        stoppedReason,
        elapsedMs: relativeNow(),
        events: recorded.events,
        droppedEvents: recorded.dropped,
      });
    };

    const stop = (reason = 'manual') => {
      if (!active) return snapshot();
      active = false;
      stoppedReason = reason;

      while (cleanups.length > 0) {
        try {
          cleanups.pop()();
        } catch {
          // Cleanup is best-effort; the final snapshot remains available.
        }
      }

      for (const [video, callbackId] of frameCallbacks) {
        try {
          video.cancelVideoFrameCallback?.(callbackId);
        } catch {
          // A detached or replaced player may reject cancellation.
        }
      }
      frameCallbacks.clear();
      record({ type: 'probe-stop', reason });
      const finalSnapshot = snapshot();
      root.console?.info?.('[DWE_STAGE0_CAPTURE]', JSON.stringify(finalSnapshot));
      return finalSnapshot;
    };

    const instrumentVideo = (video) => {
      if (!active || !video || instrumentedVideos.has(video)) return;
      instrumentedVideos.add(video);

      record({
        type: 'video-observed',
        inActiveCard: Boolean(video.closest?.('[data-e2e="feed-active-video"]')),
        muted: Boolean(video.muted),
        paused: Boolean(video.paused),
        readyState: Number(video.readyState ?? 0),
        context: describeMediaContext(video),
      });

      if (typeof video.requestVideoFrameCallback === 'function') {
        const registeredMs = relativeNow();
        const callbackId = video.requestVideoFrameCallback(() => {
          frameCallbacks.delete(video);
          if (!active) return;
          record({
            type: 'first-video-frame-after-observation',
            registeredMs,
            inActiveCard: Boolean(video.closest?.('[data-e2e="feed-active-video"]')),
            muted: Boolean(video.muted),
            paused: Boolean(video.paused),
            context: describeMediaContext(video),
          });
        });
        frameCallbacks.set(video, callbackId);
      }
    };

    const inspectElement = (element) => {
      if (!active || !element || element.nodeType !== 1) return;

      const inspectOne = (candidate) => {
        if (candidate.matches?.('video')) instrumentVideo(candidate);

        if (candidate.matches?.('[data-e2e="feed-active-video"][data-e2e-vid]')) {
          record({
            type: 'active-card-observed',
            identifier: describeIdentifier(candidate.getAttribute('data-e2e-vid')),
          });
        }

        if (candidate.matches?.('[data-danmu-id]')) {
          trackDanmaku(candidate);
        }
      };

      inspectOne(element);
      for (const candidate of element.querySelectorAll?.(
        'video,[data-e2e="feed-active-video"][data-e2e-vid],[data-danmu-id]',
      ) ?? []) {
        inspectOne(candidate);
      }
    };

    record({ type: 'probe-start' });

    const fetchCapture = createFetchCapture({ root, record, now: relativeNow });
    report.fetchWrapped = fetchCapture.installed;
    addCleanup(() => fetchCapture.restore());
    const xhrCapture = createXhrCapture({ root, record, now: relativeNow });
    report.xhrWrapped = xhrCapture.installed;
    addCleanup(() => xhrCapture.restore());

    const mediaEventTypes = ['play', 'playing', 'loadedmetadata', 'volumechange'];
    const onMediaEvent = (event) => {
      const video = event.target;
      if (!video || String(video.tagName).toUpperCase() !== 'VIDEO') return;
      instrumentVideo(video);
      record({
        type: `media-${event.type}`,
        inActiveCard: Boolean(video.closest?.('[data-e2e="feed-active-video"]')),
        muted: Boolean(video.muted),
        volumePositive: Number(video.volume ?? 0) > 0,
        paused: Boolean(video.paused),
        potentiallyAudible: event.type === 'playing'
          && !video.muted
          && Number(video.volume ?? 0) > 0,
      });
    };

    for (const eventType of mediaEventTypes) {
      document?.addEventListener?.(eventType, onMediaEvent, true);
      addCleanup(() => document?.removeEventListener?.(eventType, onMediaEvent, true));
    }

    const onVisibilityChange = () => record({
      type: 'visibility-change',
      state: document?.visibilityState ?? null,
    });
    document?.addEventListener?.('visibilitychange', onVisibilityChange);
    addCleanup(() => document?.removeEventListener?.('visibilitychange', onVisibilityChange));

    if (typeof root.MutationObserver === 'function' && document) {
      const observer = new root.MutationObserver((mutations) => {
        if (!active) return;
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes ?? []) inspectElement(node);
          if (mutation.type === 'childList') {
            const owner = mutation.target?.closest?.('[data-danmu-id]')
              ?? mutation.target?.parentElement?.closest?.('[data-danmu-id]');
            if (owner) trackDanmaku(owner);
          }
          if (mutation.type === 'characterData') {
            const owner = mutation.target?.parentElement?.closest?.('[data-danmu-id]');
            if (owner) trackDanmaku(owner);
          }
          if (mutation.type === 'attributes') {
            if (mutation.target?.matches?.('[data-danmu-id]')) trackDanmaku(mutation.target);
            inspectElement(mutation.target);
          }
        }
      });
      observer.observe(document, {
        attributeFilter: ['data-danmu-id', 'data-e2e', 'data-e2e-vid'],
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      addCleanup(() => observer.disconnect());
    }

    if (typeof root.PerformanceObserver === 'function') {
      try {
        const resourceObserver = new root.PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!CANDIDATE_RESOURCE.test(entry.name ?? '')) continue;
            record({
              type: 'resource-observed',
              initiatorType: entry.initiatorType ?? null,
              resource: sanitizeResource(entry.name, root.location?.href),
            });
          }
        });
        resourceObserver.observe({ type: 'resource', buffered: true });
        addCleanup(() => resourceObserver.disconnect());
      } catch {
        record({ type: 'performance-observer-unavailable' });
      }
    }

    for (const video of document?.querySelectorAll?.('video') ?? []) instrumentVideo(video);
    for (const card of document?.querySelectorAll?.(
      '[data-e2e="feed-active-video"][data-e2e-vid],[data-danmu-id]',
    ) ?? []) {
      inspectElement(card);
    }

    const timeoutId = root.setTimeout?.(() => stop('capture-timeout'), options.captureMs ?? MAX_CAPTURE_MS);
    if (timeoutId != null) addCleanup(() => root.clearTimeout?.(timeoutId));

    return Object.freeze({
      get active() {
        return active;
      },
      snapshot,
      stop,
    });
  };

  const bootstrap = (root, options = {}) => {
    if (getProbeMode(root.location) !== PROBE_MODE) return null;

    const existing = root[API_KEY];
    if (existing?.active) return existing;

    const pageRoot = root.unsafeWindow ?? root;
    const probe = createCaptureProbe(pageRoot, { ...options, scriptRoot: root });
    Object.defineProperty(root, API_KEY, {
      value: probe,
      configurable: true,
      enumerable: false,
      writable: false,
    });
    return probe;
  };

  return {
    API_KEY,
    PROBE_MODE,
    bootstrap,
    createCaptureProbe,
    createFetchCapture,
    createXhrCapture,
    createDanmakuTracker,
    createRecorder,
    describeMediaContext,
    describeIdentifier,
    getProbeMode,
    sanitizeResource,
    summarizeMetadataShape,
    summarizeXhrResponse,
  };
});

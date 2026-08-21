// ==UserScript==
// @name         抖音 Web 增强
// @name:zh-CN   抖音 Web 增强
// @name:en      Douyin Web Enhancer
// @namespace    https://github.com/OnlyDreams/douyin-web-enhancer
// @version      0.0.2
// @author       Onlydreams
// @description  按视频文本或 BGM 名称过滤推荐视频，并按显示文本过滤弹幕。
// @description:zh-CN  按视频文本或 BGM 名称过滤推荐视频，并按显示文本过滤弹幕。
// @description:en  Filters recommended videos by text or BGM name and filters visible danmaku text.
// @homepageURL  https://github.com/OnlyDreams/douyin-web-enhancer
// @supportURL   https://github.com/OnlyDreams/douyin-web-enhancer/issues
// @match        https://www.douyin.com/*
// @run-at       document-start
// @sandbox      raw
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @noframes
// @license      MIT
// ==/UserScript==

((root, createModule) => {
  'use strict';

  const enhancer = createModule();

  if (typeof module === 'object' && module?.exports) {
    module.exports = enhancer;
    return;
  }

  enhancer.bootstrap({ root });
})(globalThis, () => {
  'use strict';

  const STORAGE_KEYS = Object.freeze({
    video: Object.freeze({
      enabled: 'douyinEnhancer.videoKeywordFilter.enabled',
      keywords: 'douyinEnhancer.videoKeywordFilter.keywords',
    }),
    danmaku: Object.freeze({
      enabled: 'douyinEnhancer.danmakuKeywordFilter.enabled',
      keywords: 'douyinEnhancer.danmakuKeywordFilter.keywords',
    }),
    bgm: Object.freeze({
      enabled: 'douyinEnhancer.bgmKeywordFilter.enabled',
      keywords: 'douyinEnhancer.bgmKeywordFilter.keywords',
    }),
  });

  const CATEGORY_DEFINITIONS = Object.freeze([
    Object.freeze({
      id: 'video',
      statusName: '视频关键词屏蔽',
      editName: '编辑视频屏蔽词',
      promptMessage: '请输入视频屏蔽词，多个关键词用 | 分隔：',
    }),
    Object.freeze({
      id: 'danmaku',
      statusName: '弹幕关键词屏蔽',
      editName: '编辑弹幕屏蔽词',
      promptMessage: '请输入弹幕屏蔽词，多个关键词用 | 分隔：',
    }),
    Object.freeze({
      id: 'bgm',
      statusName: 'BGM 名称屏蔽',
      editName: '编辑 BGM 屏蔽词',
      promptMessage: '请输入 BGM 名称屏蔽词，多个关键词用 | 分隔：',
    }),
  ]);

  const PAGE_SELECTORS = Object.freeze({
    feedRoot: '[data-e2e="slideList"][data-active="true"]',
    feedCard:
      '[data-e2e="feed-active-video"][data-e2e-vid], [data-e2e="feed-video"][data-e2e-vid]',
    activeCard: '[data-e2e="feed-active-video"][data-e2e-vid]',
    videoDescription: '[data-e2e="video-desc"]',
    hashtagLink: 'a[href*="/search"]',
    videoIdentityLink: 'a[href*="aweme_id="], a[href*="gid="]',
    nextControl: '[data-e2e="video-switch-next-arrow"]',
    previousControl: '[data-e2e="video-switch-prev-arrow"]',
    danmakuRoot: '[data-e2e="danmaku-container"]',
    danmakuNode: '[data-danmu-id]',
  });
  const VIDEO_STATE_ATTRIBUTE = 'data-dwe-video-state';
  const DANMAKU_ROOT_ATTRIBUTE = 'data-dwe-danmaku-active';
  const DANMAKU_STATE_ATTRIBUTE = 'data-dwe-danmaku-state';
  const VIDEO_STYLE_ID = 'dwe-video-filter-style';
  const NOTICE_ATTRIBUTE = 'data-dwe-notice';
  const CARD_DECISION_WAIT_MS = 250;
  const DANMAKU_DECISION_WAIT_MS = 100;
  const NAVIGATION_CONFIRM_MS = 2_500;
  const PREDICTIVE_SETTLE_FALLBACK_MS = 350;
  const HEALTH_CHECK_MS = 750;
  const MAX_MUTATION_RECORDS_PER_BATCH = 64;
  const ALLOW_DWELL_RESET_MS = 3_000;
  const SKIP_WINDOW_MS = 15_000;
  const MAX_CONSECUTIVE_SKIPS = 12;

  function normalizeKeywordText(text) {
    return String(text ?? '')
      .normalize('NFKC')
      .replace(/\s+/gu, ' ')
      .trim();
  }

  function compileKeywords(rawKeywords) {
    const keywordParts = Array.isArray(rawKeywords)
      ? rawKeywords
      : String(rawKeywords ?? '').split('|');
    const compiledKeywords = [];
    const seenKeywords = new Set();

    for (const keywordPart of keywordParts) {
      const keyword = normalizeKeywordText(keywordPart).toLowerCase();
      if (!keyword || seenKeywords.has(keyword)) {
        continue;
      }

      seenKeywords.add(keyword);
      compiledKeywords.push(keyword);
    }

    return Object.freeze(compiledKeywords);
  }

  function matchesAnyKeyword(text, compiledKeywords) {
    const normalizedText = normalizeKeywordText(text).toLowerCase();
    if (!normalizedText || !Array.isArray(compiledKeywords)) {
      return false;
    }

    return compiledKeywords.some((keyword) => normalizedText.includes(keyword));
  }

  function isEffectiveRule(rule) {
    return rule?.enabled !== false && (rule?.compiledKeywords?.length ?? 0) > 0;
  }

  function evaluateVideoFields(fields, rule) {
    if (!isEffectiveRule(rule)) {
      return false;
    }

    const allowedFields = [
      fields?.title,
      fields?.description,
      ...(Array.isArray(fields?.hashtags) ? fields.hashtags : []),
    ];
    return allowedFields.some((value) =>
      matchesAnyKeyword(value, rule.compiledKeywords),
    );
  }

  function evaluateDanmakuText(text, rule) {
    return isEffectiveRule(rule) && matchesAnyKeyword(text, rule.compiledKeywords);
  }

  function evaluateBgmFields(fields, rule) {
    if (!isEffectiveRule(rule)) {
      return false;
    }

    return [
      fields?.musicTitle,
      fields?.musicName,
      fields?.relatedMusicTitle,
    ].some((value) =>
      matchesAnyKeyword(value, rule.compiledKeywords),
    );
  }

  function createCategorySettings(enabled, keywords) {
    const rawKeywords = String(keywords ?? '');
    return Object.freeze({
      enabled: enabled !== false,
      keywords: rawKeywords,
      compiledKeywords: compileKeywords(rawKeywords),
    });
  }

  function createSettingsSnapshot(settings) {
    return Object.freeze({
      video: createCategorySettings(
        settings?.video?.enabled,
        settings?.video?.keywords,
      ),
      danmaku: createCategorySettings(
        settings?.danmaku?.enabled,
        settings?.danmaku?.keywords,
      ),
      bgm: createCategorySettings(settings?.bgm?.enabled, settings?.bgm?.keywords),
    });
  }

  function isValidVideoId(value) {
    return /^\d{10,}$/.test(String(value ?? ''));
  }

  function isActiveFeedRootElement(node) {
    return (
      node?.getAttribute?.('data-e2e') === 'slideList' &&
      node?.getAttribute?.('data-active') === 'true'
    );
  }

  function extractCardVideoId(card, baseUrl = 'https://www.douyin.com/') {
    const cardId = card?.getAttribute?.('data-e2e-vid') ?? '';
    if (!isValidVideoId(cardId)) return Object.freeze({ status: 'missing' });

    const linkedIds = new Set();
    for (const link of card.querySelectorAll?.(PAGE_SELECTORS.videoIdentityLink) ?? []) {
      try {
        const url = new URL(link.getAttribute?.('href') ?? link.href ?? '', baseUrl);
        for (const key of ['aweme_id', 'gid']) {
          const value = url.searchParams.get(key);
          if (!value) continue;
          if (!isValidVideoId(value)) {
            return Object.freeze({ status: 'conflict' });
          }
          linkedIds.add(value);
        }
      } catch {
        return Object.freeze({ status: 'conflict' });
      }
    }
    if (linkedIds.size === 0) return Object.freeze({ status: 'missing' });
    if (linkedIds.size !== 1 || !linkedIds.has(cardId)) {
      return Object.freeze({ status: 'conflict' });
    }
    return Object.freeze({ status: 'ready', id: cardId });
  }

  function extractBgmMetadata(payload, options = {}) {
    const maxNodes = Math.max(1, options.maxNodes ?? 2_000);
    const maxDepth = Math.max(1, options.maxDepth ?? 12);
    const maxElapsedMs = Math.max(1, options.maxElapsedMs ?? 8);
    const readNow =
      options.now ??
      (() => globalThis.performance?.now?.() ?? Date.now());
    const deadline = readNow() + maxElapsedMs;
    const items = [];
    const stack = [{ value: payload, depth: 0 }];
    let scanned = 0;
    let truncated = false;
    let timedOut = false;

    function extractRelatedMusicTitle(value) {
      const anchors = [
        value.relatedMusicAnchor,
        value.related_music_anchor,
      ].filter((anchor) => anchor && typeof anchor === 'object');
      const titles = [];
      for (const anchor of anchors) {
        const extra = anchor.extra;
        if (typeof extra !== 'string' || extra.length > 20_000) continue;
        try {
          const parsed = JSON.parse(extra);
          if (
            parsed &&
            typeof parsed === 'object' &&
            typeof parsed.title === 'string' &&
            parsed.title.length <= 512 &&
            parsed.title
          ) {
            titles.push(parsed.title);
          }
        } catch {}
      }
      const uniqueTitles = [...new Set(titles)];
      return uniqueTitles.length === 1 ? uniqueTitles[0] : '';
    }

    while (stack.length > 0) {
      if (readNow() >= deadline) {
        timedOut = true;
        truncated = true;
        break;
      }
      if (scanned >= maxNodes) {
        truncated = true;
        break;
      }
      const { value, depth } = stack.pop();
      if (!value || typeof value !== 'object') continue;
      scanned += 1;

      if (!Array.isArray(value)) {
        const presentIds = [value.awemeId, value.aweme_id, value.gid].filter(
          (id) => id !== undefined && id !== null && id !== '',
        );
        const idsAreExactStrings = presentIds.every(
          (id) => typeof id === 'string' && isValidVideoId(id),
        );
        const uniqueIds = [...new Set(presentIds)];
        const music = value.music;
        const musicTitle =
          music && typeof music === 'object' ? String(music.title ?? '') : '';
        const musicName =
          music && typeof music === 'object'
            ? String(music.musicName ?? music.music_name ?? '')
            : '';
        const relatedMusicTitle = extractRelatedMusicTitle(value);
        if (
          idsAreExactStrings &&
          uniqueIds.length === 1 &&
          (musicTitle || musicName || relatedMusicTitle)
        ) {
          items.push(Object.freeze({
            awemeId: uniqueIds[0],
            musicTitle,
            musicName,
            relatedMusicTitle,
          }));
        }
      }

      if (depth >= maxDepth) continue;
      const remainingSlots = maxNodes - scanned - stack.length;
      if (remainingSlots <= 0) {
        truncated = true;
        continue;
      }

      // JSON payload 可能包含高扇出数组或对象；先 Object.values() 再压栈会让
      // 单个节点绕过 maxNodes。只检查剩余预算允许的子项，超出即 fail-open。
      const children = [];
      let inspected = 0;
      if (Array.isArray(value)) {
        const inspectLimit = Math.min(value.length, remainingSlots);
        for (let index = 0; index < inspectLimit; index += 1) {
          inspected += 1;
          const child = value[index];
          if (child && typeof child === 'object') children.push(child);
        }
        if (value.length > inspectLimit) truncated = true;
      } else {
        for (const key in value) {
          if (!Object.hasOwn(value, key)) continue;
          if (inspected >= remainingSlots) {
            truncated = true;
            break;
          }
          inspected += 1;
          const child = value[key];
          if (child && typeof child === 'object') children.push(child);
        }
      }
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ value: children[index], depth: depth + 1 });
      }
    }

    return Object.freeze({
      items: Object.freeze(items),
      scanned,
      timedOut,
      truncated,
    });
  }

  function createBgmMetadataCache(limit = 500) {
    const capacity = Math.max(1, limit);
    const entries = new Map();
    const conflicts = new Set();

    function sameMetadata(left, right) {
      return (
        (!left.musicTitle || !right.musicTitle || left.musicTitle === right.musicTitle) &&
        (!left.musicName || !right.musicName || left.musicName === right.musicName) &&
        (
          !left.relatedMusicTitle ||
          !right.relatedMusicTitle ||
          left.relatedMusicTitle === right.relatedMusicTitle
        )
      );
    }

    function mergeMetadata(left, right) {
      return Object.freeze({
        awemeId: left.awemeId,
        musicTitle: left.musicTitle || right.musicTitle,
        musicName: left.musicName || right.musicName,
        relatedMusicTitle:
          left.relatedMusicTitle || right.relatedMusicTitle,
      });
    }

    function trim() {
      while (entries.size + conflicts.size > capacity) {
        const oldestEntry = entries.keys().next();
        if (!oldestEntry.done) {
          entries.delete(oldestEntry.value);
          continue;
        }
        const oldestConflict = conflicts.values().next();
        if (!oldestConflict.done) conflicts.delete(oldestConflict.value);
      }
    }

    return Object.freeze({
      ingest(dtos) {
        for (const dto of dtos ?? []) {
          const id = dto?.awemeId;
          if (
            typeof id !== 'string' ||
            !isValidVideoId(id) ||
            conflicts.has(id)
          ) {
            continue;
          }
          const normalized = Object.freeze({
            awemeId: id,
            musicTitle: String(dto?.musicTitle ?? ''),
            musicName: String(dto?.musicName ?? ''),
            relatedMusicTitle: String(dto?.relatedMusicTitle ?? ''),
          });
          const previous = entries.get(id);
          if (previous && !sameMetadata(previous, normalized)) {
            entries.delete(id);
            conflicts.add(id);
          } else if (previous) {
            entries.set(id, mergeMetadata(previous, normalized));
          } else if (!previous) {
            entries.set(id, normalized);
          }
          trim();
        }
      },
      get(id) {
        if (typeof id !== 'string') return null;
        const key = id;
        if (conflicts.has(key)) return null;
        const value = entries.get(key) ?? null;
        if (value) {
          entries.delete(key);
          entries.set(key, value);
        }
        return value;
      },
      clear() {
        entries.clear();
        conflicts.clear();
      },
      get size() {
        return entries.size + conflicts.size;
      },
    });
  }

  function createBgmTransportObserver(pageRoot, options = {}) {
    const onMetadata = options.onMetadata ?? (() => {});
    const scheduleTask =
      options.scheduleTask ?? pageRoot.setTimeout?.bind(pageRoot) ?? setTimeout;
    let started = false;
    let originalFetch = null;
    let fetchWrapper = null;
    let xhrPrototype = null;
    let originalOpen = null;
    let originalSend = null;
    let openWrapper = null;
    let sendWrapper = null;
    let unavailable = false;
    let runSequence = 0;
    let activeRun = 0;
    let activeBodyRead = 0;
    let bodyReadSequence = 0;
    const pendingXhrs = new Map();
    const xhrCandidates = new WeakMap();
    const maxResponseChars = options.maxResponseChars ?? 2_000_000;

    function isCandidateUrl(input) {
      try {
        const raw = typeof input === 'string' ? input : input?.url;
        const url = new URL(String(raw ?? ''), pageRoot.location?.origin);
        return (
          url.origin === pageRoot.location?.origin &&
          url.pathname === '/aweme/v1/web/tab/feed/'
        );
      } catch {
        return false;
      }
    }

    function isCurrentRun(run) {
      return started && activeRun === run;
    }

    function beginBodyRead(run) {
      if (!isCurrentRun(run) || activeBodyRead !== 0) return 0;
      activeBodyRead = ++bodyReadSequence;
      return activeBodyRead;
    }

    function finishBodyRead(token) {
      if (activeBodyRead === token) activeBodyRead = 0;
    }

    function emitPayload(payload, run) {
      const result = extractBgmMetadata(payload);
      if (isCurrentRun(run) && result.items.length > 0) onMetadata(result.items);
    }

    function parseResponse(response, run) {
      if (!isCurrentRun(run) || !response?.ok) return;
      const contentType = response.headers?.get?.('content-type') ?? '';
      if (!/application\/json/i.test(contentType)) return;
      const contentLength = Number(response.headers?.get?.('content-length') ?? 0);
      if (contentLength > maxResponseChars) return;
      const bodyRead = beginBodyRead(run);
      if (!bodyRead) return;
      let clone;
      try { clone = response.clone(); } catch {
        finishBodyRead(bodyRead);
        return;
      }
      Promise.resolve(clone.text()).then((text) => {
        try {
          scheduleTask(() => {
            try {
              if (!isCurrentRun(run)) return;
              if (text.length > maxResponseChars) return;
              emitPayload(JSON.parse(text), run);
            } catch {
              // 解析失败时保持 fail-open；页面自己的响应不受影响。
            } finally {
              finishBodyRead(bodyRead);
            }
          }, 0);
        } catch {
          finishBodyRead(bodyRead);
        }
      }, () => finishBodyRead(bodyRead));
    }

    function installFetch(run) {
      if (typeof pageRoot.fetch !== 'function') return;
      originalFetch = pageRoot.fetch;
      fetchWrapper = function (...args) {
        const promise = originalFetch.apply(this, args);
        const method = String(
          args[1]?.method ?? args[0]?.method ?? 'GET',
        ).toUpperCase();
        if (method === 'GET' && isCandidateUrl(args[0])) {
          Promise.resolve(promise).then(
            (response) => parseResponse(response, run),
            () => {},
          );
        }
        return promise;
      };
      pageRoot.fetch = fetchWrapper;
    }

    function cleanupXhr(xhr) {
      const entry = pendingXhrs.get(xhr);
      if (!entry) return;
      xhr.removeEventListener?.('loadend', entry.listener);
      pendingXhrs.delete(xhr);
    }

    function installXhr(run) {
      xhrPrototype = pageRoot.XMLHttpRequest?.prototype ?? null;
      if (!xhrPrototype) return;
      originalOpen = xhrPrototype.open;
      originalSend = xhrPrototype.send;
      if (typeof originalOpen !== 'function' || typeof originalSend !== 'function') return;
      openWrapper = function (...args) {
        cleanupXhr(this);
        xhrCandidates.delete(this);
        const result = originalOpen.apply(this, args);
        xhrCandidates.set(
          this,
          String(args[0] ?? '').toUpperCase() === 'GET' && isCandidateUrl(args[1]),
        );
        return result;
      };
      sendWrapper = function (...args) {
        if (xhrCandidates.get(this)) {
          cleanupXhr(this);
          const xhr = this;
          const listener = () => {
            cleanupXhr(xhr);
            const bodyRead = beginBodyRead(run);
            if (!bodyRead) return;
            try {
              scheduleTask(() => {
                try {
                  if (!isCurrentRun(run) || xhr.status < 200 || xhr.status >= 300) {
                    return;
                  }
                  const contentType = xhr.getResponseHeader?.('content-type') ?? '';
                  if (!/application\/json/i.test(contentType)) return;
                  const raw = xhr.responseType === 'json' ? xhr.response : xhr.responseText;
                  if (typeof raw === 'string' && raw.length > maxResponseChars) return;
                  emitPayload(
                    typeof raw === 'string' ? JSON.parse(raw) : raw,
                    run,
                  );
                } catch {
                  // 页面响应格式变化时放行，不影响原 XHR。
                } finally {
                  finishBodyRead(bodyRead);
                }
              }, 0);
            } catch {
              finishBodyRead(bodyRead);
            }
          };
          pendingXhrs.set(xhr, { listener });
          xhr.addEventListener?.('loadend', listener);
        }
        try {
          return originalSend.apply(this, args);
        } catch (error) {
          cleanupXhr(this);
          throw error;
        }
      };
      xhrPrototype.open = openWrapper;
      xhrPrototype.send = sendWrapper;
    }

    function restoreTransports() {
      try {
        if (pageRoot.fetch === fetchWrapper) pageRoot.fetch = originalFetch;
      } catch {}
      try {
        if (xhrPrototype?.open === openWrapper) xhrPrototype.open = originalOpen;
      } catch {}
      try {
        if (xhrPrototype?.send === sendWrapper) xhrPrototype.send = originalSend;
      } catch {}
    }

    return Object.freeze({
      start() {
        if (started || unavailable) return false;
        started = true;
        const run = ++runSequence;
        activeRun = run;
        try {
          installFetch(run);
          installXhr(run);
        } catch {
          started = false;
          activeRun = 0;
          unavailable = true;
          for (const xhr of [...pendingXhrs.keys()]) cleanupXhr(xhr);
          restoreTransports();
          return false;
        }
        return true;
      },
      stop() {
        if (!started) {
          unavailable = false;
          return false;
        }
        started = false;
        activeRun = 0;
        for (const xhr of [...pendingXhrs.keys()]) cleanupXhr(xhr);
        restoreTransports();
        return true;
      },
    });
  }

  function extractQuickPlayerBgmMetadata(sourceText) {
    const source = String(sourceText ?? '');
    const results = [];
    const marker = 'createQuickPlayer(';
    let searchIndex = 0;

    function findPropertyValueIndex(objectSource, propertyName) {
      let quote = '';
      let escaped = false;
      let braceDepth = 0;
      let bracketDepth = 0;
      let parenthesisDepth = 0;
      for (let index = 0; index < objectSource.length; index += 1) {
        const character = objectSource[index];
        if (quote) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === quote) quote = '';
          continue;
        }
        if (character === '"' || character === "'" || character === '`') {
          quote = character;
          continue;
        }
        if (character === '{') {
          braceDepth += 1;
          continue;
        }
        if (character === '}') {
          braceDepth -= 1;
          continue;
        }
        if (character === '[') {
          bracketDepth += 1;
          continue;
        }
        if (character === ']') {
          bracketDepth -= 1;
          continue;
        }
        if (character === '(') {
          parenthesisDepth += 1;
          continue;
        }
        if (character === ')') {
          parenthesisDepth -= 1;
          continue;
        }
        if (
          braceDepth !== 1 ||
          bracketDepth !== 0 ||
          parenthesisDepth !== 0
        ) {
          continue;
        }
        if (!objectSource.startsWith(propertyName, index)) continue;
        const previous = objectSource[index - 1] ?? '';
        const next = objectSource[index + propertyName.length] ?? '';
        if (/[$\w]/u.test(previous) || /[$\w]/u.test(next)) continue;
        let cursor = index + propertyName.length;
        while (/\s/u.test(objectSource[cursor] ?? '')) cursor += 1;
        if (objectSource[cursor] !== ':') continue;
        cursor += 1;
        while (/\s/u.test(objectSource[cursor] ?? '')) cursor += 1;
        return cursor;
      }
      return -1;
    }

    function readObjectProperty(objectSource, propertyName) {
      const start = findPropertyValueIndex(objectSource, propertyName);
      if (start < 0 || objectSource[start] !== '{') return null;
      let depth = 0;
      let quote = '';
      let escaped = false;
      for (let cursor = start; cursor < objectSource.length; cursor += 1) {
        const character = objectSource[cursor];
        if (quote) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === quote) quote = '';
          continue;
        }
        if (character === '"' || character === "'" || character === '`') {
          quote = character;
        } else if (character === '{') {
          depth += 1;
        } else if (character === '}') {
          depth -= 1;
          if (depth === 0) return objectSource.slice(start, cursor + 1);
        }
      }
      return null;
    }

    function decodeStaticString(raw) {
      let decoded = '';
      for (let index = 0; index < raw.length; index += 1) {
        const character = raw[index];
        if (character !== '\\') {
          decoded += character;
          continue;
        }
        const escaped = raw[index + 1];
        if (escaped === undefined) return null;
        index += 1;
        const simple = {
          b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
          '0': '\0', '\\': '\\', '"': '"', "'": "'",
        };
        if (Object.hasOwn(simple, escaped)) {
          decoded += simple[escaped];
          continue;
        }
        if (escaped === 'x') {
          const hex = raw.slice(index + 1, index + 3);
          if (!/^[\da-f]{2}$/iu.test(hex)) return null;
          decoded += String.fromCharCode(Number.parseInt(hex, 16));
          index += 2;
          continue;
        }
        if (escaped === 'u') {
          if (raw[index + 1] === '{') {
            const end = raw.indexOf('}', index + 2);
            const hex = end < 0 ? '' : raw.slice(index + 2, end);
            const codePoint = Number.parseInt(hex, 16);
            if (!/^[\da-f]{1,6}$/iu.test(hex) || codePoint > 0x10ffff) return null;
            decoded += String.fromCodePoint(codePoint);
            index = end;
          } else {
            const hex = raw.slice(index + 1, index + 5);
            if (!/^[\da-f]{4}$/iu.test(hex)) return null;
            decoded += String.fromCharCode(Number.parseInt(hex, 16));
            index += 4;
          }
          continue;
        }
        if (escaped === '\n') continue;
        if (escaped === '\r') {
          if (raw[index + 1] === '\n') index += 1;
          continue;
        }
        decoded += escaped;
      }
      return decoded;
    }

    function readStringProperty(objectSource, propertyName) {
      const start = findPropertyValueIndex(objectSource, propertyName);
      const quote = objectSource[start];
      if (start < 0 || (quote !== '"' && quote !== "'")) return null;
      for (let cursor = start + 1; cursor < objectSource.length; cursor += 1) {
        if (objectSource[cursor] === '\\') {
          cursor += 1;
        } else if (objectSource[cursor] === quote) {
          return decodeStaticString(objectSource.slice(start + 1, cursor));
        } else if (objectSource[cursor] === '\n' || objectSource[cursor] === '\r') {
          return null;
        }
      }
      return null;
    }

    while (searchIndex < source.length) {
      const markerIndex = source.indexOf(marker, searchIndex);
      if (markerIndex < 0) break;
      let index = markerIndex + marker.length;
      while (/\s/u.test(source[index] ?? '')) index += 1;
      if (source[index] !== '{') {
        searchIndex = index + 1;
        continue;
      }

      let depth = 0;
      let quote = '';
      let escaped = false;
      let endIndex = -1;
      for (let cursor = index; cursor < source.length; cursor += 1) {
        const character = source[cursor];
        if (quote) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === quote) quote = '';
          continue;
        }
        if (character === '"' || character === "'") {
          quote = character;
        } else if (character === '{') {
          depth += 1;
        } else if (character === '}') {
          depth -= 1;
          if (depth === 0) {
            endIndex = cursor + 1;
            break;
          }
        }
      }
      if (endIndex < 0) break;

      const objectSource = source.slice(index, endIndex);
      const awemeInfo = readObjectProperty(objectSource, 'awemeInfo');
      if (awemeInfo) {
        const awemeId = readStringProperty(awemeInfo, 'awemeId');
        const music = readObjectProperty(awemeInfo, 'music');
        const musicTitle = music ? readStringProperty(music, 'title') : null;
        const musicName = music ? readStringProperty(music, 'musicName') : null;
        const relatedMusicAnchor = readObjectProperty(
          awemeInfo,
          'relatedMusicAnchor',
        );
        const relatedMusicExtra = relatedMusicAnchor
          ? readStringProperty(relatedMusicAnchor, 'extra')
          : null;
        let relatedMusicTitle = '';
        if (relatedMusicExtra && relatedMusicExtra.length <= 20_000) {
          try {
            const relatedMusic = JSON.parse(relatedMusicExtra);
            if (
              relatedMusic &&
              typeof relatedMusic === 'object' &&
              typeof relatedMusic.title === 'string' &&
              relatedMusic.title.length <= 512
            ) {
              relatedMusicTitle = relatedMusic.title;
            }
          } catch {}
        }
        if (
          isValidVideoId(awemeId) &&
          (musicTitle || musicName || relatedMusicTitle)
        ) {
          results.push(Object.freeze({
            awemeId,
            musicTitle: musicTitle ?? '',
            musicName: musicName ?? '',
            relatedMusicTitle,
          }));
        }
      }
      searchIndex = endIndex;
    }
    return Object.freeze(results);
  }

  function isSupportedRecommendRoute(locationLike) {
    try {
      const url = new URL(String(locationLike?.href ?? locationLike));
      const recommend = url.searchParams.get('recommend');
      return (
        url.protocol === 'https:' &&
        url.hostname === 'www.douyin.com' &&
        url.pathname === '/' &&
        (recommend === null || recommend === '1')
      );
    } catch {
      return false;
    }
  }

  function extractVideoFields(card) {
    const descriptionNodes = Array.from(
      card?.querySelectorAll?.(PAGE_SELECTORS.videoDescription) ?? [],
    );
    if (descriptionNodes.length === 0) {
      return Object.freeze({ status: 'pending' });
    }
    if (descriptionNodes.length !== 1) {
      return Object.freeze({ status: 'bypass' });
    }

    const descriptionNode = descriptionNodes[0];
    const description = normalizeKeywordText(descriptionNode.textContent);
    const hashtags = Array.from(
      descriptionNode.querySelectorAll?.(PAGE_SELECTORS.hashtagLink) ?? [],
    )
      .map((node) => normalizeKeywordText(node.textContent))
      .filter(Boolean);
    if (!description && hashtags.length === 0) {
      return Object.freeze({ status: 'pending' });
    }

    return Object.freeze({
      status: 'ready',
      fields: Object.freeze({
        // 当前推荐流把标题/描述统一放在 video-desc；不读取作者或其他容器补齐标题。
        title: '',
        description,
        hashtags: Object.freeze(hashtags),
      }),
    });
  }

  function createPageController(root, options = {}) {
    const documentLike = options.document ?? root.document;
    const pageRoot = options.pageRoot ?? root.unsafeWindow ?? root;
    const MutationObserverLike =
      options.MutationObserver ?? root.MutationObserver;
    const logger = options.logger ?? root.console;
    const now = options.now ?? (() => root.performance.now());
    const setTimeoutLike =
      options.setTimeout ?? root.setTimeout.bind(root);
    const clearTimeoutLike =
      options.clearTimeout ?? root.clearTimeout.bind(root);
    const setIntervalLike =
      options.setInterval ?? root.setInterval.bind(root);
    const clearIntervalLike =
      options.clearInterval ?? root.clearInterval.bind(root);
    const requestFrame =
      options.requestAnimationFrame ??
      root.requestAnimationFrame?.bind(root) ??
      ((callback) => setTimeoutLike(callback, 0));
    const cancelFrame =
      options.cancelAnimationFrame ??
      root.cancelAnimationFrame?.bind(root) ??
      clearTimeoutLike;

    let started = false;
    let settings = null;
    let settingsRevision = 0;
    let generation = 0;
    let danmakuGeneration = 0;
    let epochSequence = 0;
    let currentRoot = null;
    let currentActiveCard = null;
    let currentActiveId = '';
    let currentEpoch = null;
    let globalObserver = null;
    let rootObserver = null;
    let danmakuObserver = null;
    let currentDanmakuRoot = null;
    let danmakuSuspended = false;
    let healthTimer = null;
    let startupTimer = null;
    let activeFrame = null;
    let allowDwellTimer = null;
    let noticeTimer = null;
    let styleElement = null;
    let noticeElement = null;
    let lifecycleListening = false;
    let predictiveNavigation = null;
    let suppressPredictiveInput = false;
    let fuseTripped = false;
    let skipTimestamps = [];
    let videoSettingsSignature = '';
    let danmakuSettingsSignature = '';
    let fuseSettingsSignature = '';
    const bgmCache = options.bgmCache ?? createBgmMetadataCache(500);
    let bgmObserver = null;
    const scannedBgmScripts = new WeakSet();
    let preservedActivation = null;
    const cardRecords = new WeakMap();
    const ownedCards = new Set();
    const danmakuRecords = new WeakMap();
    const ownedDanmakuNodes = new Set();

    function reportError(message, error) {
      const errorName =
        error && typeof error === 'object' && typeof error.name === 'string'
          ? error.name
          : 'UnknownError';
      logger?.error?.(message, errorName);
    }

    function videoSignature(snapshot) {
      return JSON.stringify([
        snapshot?.video?.enabled !== false,
        snapshot?.video?.compiledKeywords ?? [],
        snapshot?.bgm?.enabled !== false,
        snapshot?.bgm?.compiledKeywords ?? [],
      ]);
    }

    function danmakuSignature(snapshot) {
      return JSON.stringify([
        snapshot?.danmaku?.enabled !== false,
        snapshot?.danmaku?.compiledKeywords ?? [],
      ]);
    }

    function fuseSignature(snapshot) {
      return JSON.stringify([
        snapshot?.video?.enabled !== false,
        snapshot?.video?.compiledKeywords ?? [],
        snapshot?.bgm?.enabled !== false,
        snapshot?.bgm?.compiledKeywords ?? [],
      ]);
    }

    function hasEffectiveVideoTextRule() {
      return isEffectiveRule(settings?.video);
    }

    function hasEffectiveBgmRule() {
      return isEffectiveRule(settings?.bgm);
    }

    function hasEffectiveVideoRule() {
      return hasEffectiveVideoTextRule() || hasEffectiveBgmRule();
    }

    function hasEffectiveDanmakuRule() {
      return isEffectiveRule(settings?.danmaku);
    }

    function hasEffectivePageRule() {
      return hasEffectiveVideoRule() || hasEffectiveDanmakuRule();
    }

    function captureActiveCard() {
      const roots = Array.from(
        documentLike?.querySelectorAll?.(PAGE_SELECTORS.feedRoot) ?? [],
      );
      if (roots.length !== 1) return null;

      const activeCards = Array.from(
        roots[0].querySelectorAll(PAGE_SELECTORS.activeCard),
      );
      if (activeCards.length !== 1) return null;

      const card = activeCards[0];
      const id = card.getAttribute('data-e2e-vid') ?? '';
      return isValidVideoId(id) ? { card, id } : null;
    }

    function isCurrentEpoch(epoch) {
      return (
        started &&
        currentEpoch === epoch &&
        !epoch.retired &&
        epoch.generation === generation
      );
    }

    function ensureStyle() {
      if (styleElement?.isConnected || !documentLike?.documentElement) return;

      const candidate = documentLike.createElement('style');
      candidate.id = VIDEO_STYLE_ID;
      candidate.textContent = `
[${VIDEO_STATE_ATTRIBUTE}="pending"] video,
[${VIDEO_STATE_ATTRIBUTE}="block"] video,
[${VIDEO_STATE_ATTRIBUTE}="navigating"] video,
[${VIDEO_STATE_ATTRIBUTE}="pending"] canvas,
[${VIDEO_STATE_ATTRIBUTE}="block"] canvas,
[${VIDEO_STATE_ATTRIBUTE}="navigating"] canvas,
[${VIDEO_STATE_ATTRIBUTE}="pending"] .xgplayer-poster,
[${VIDEO_STATE_ATTRIBUTE}="block"] .xgplayer-poster,
[${VIDEO_STATE_ATTRIBUTE}="navigating"] .xgplayer-poster {
  visibility: hidden !important;
  opacity: 0 !important;
}
[${DANMAKU_ROOT_ATTRIBUTE}] [data-danmu-id]:not([${DANMAKU_STATE_ATTRIBUTE}]),
[${DANMAKU_ROOT_ATTRIBUTE}] [${DANMAKU_STATE_ATTRIBUTE}="pending"],
[${DANMAKU_ROOT_ATTRIBUTE}] [${DANMAKU_STATE_ATTRIBUTE}="block"] {
  visibility: hidden !important;
  opacity: 0 !important;
}
[${NOTICE_ATTRIBUTE}] {
  position: fixed;
  z-index: 2147483647;
  left: 50%;
  top: 18px;
  max-width: min(560px, calc(100vw - 32px));
  transform: translateX(-50%);
  padding: 10px 14px;
  border-radius: 8px;
  color: #fff;
  background: rgba(28, 28, 32, 0.94);
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.28);
  font: 14px/1.5 system-ui, sans-serif;
  pointer-events: none;
}`;
      documentLike.documentElement.append(candidate);
      styleElement = candidate;
    }

    function removeStyle() {
      if (styleElement?.isConnected) styleElement.remove();
      styleElement = null;
    }

    function hideNotice() {
      if (noticeTimer !== null) {
        clearTimeoutLike(noticeTimer);
        noticeTimer = null;
      }
      if (noticeElement?.isConnected) noticeElement.remove();
      noticeElement = null;
    }

    function showNotice(message, persistent = false) {
      hideNotice();
      if (!documentLike?.documentElement) return;

      ensureStyle();
      const candidate = documentLike.createElement('div');
      candidate.setAttribute(NOTICE_ATTRIBUTE, '');
      candidate.textContent = message;
      documentLike.documentElement.append(candidate);
      noticeElement = candidate;
      if (!persistent) {
        noticeTimer = setTimeoutLike(hideNotice, 5_000);
      }
    }

    function setRecordState(record, state) {
      record.state = state;
      record.card.setAttribute(VIDEO_STATE_ATTRIBUTE, state);
      ownedCards.add(record.card);
    }

    function cleanupCard(card) {
      if (!ownedCards.has(card)) return;
      card.removeAttribute(VIDEO_STATE_ATTRIBUTE);
      ownedCards.delete(card);
    }

    function cleanupAllCards() {
      for (const card of [...ownedCards]) cleanupCard(card);
    }

    function setDanmakuState(record, state) {
      record.state = state;
      record.node.setAttribute(DANMAKU_STATE_ATTRIBUTE, state);
      ownedDanmakuNodes.add(record.node);
    }

    function cleanupDanmakuNode(node) {
      const record = danmakuRecords.get(node);
      if (record && record.timer !== null) {
        clearTimeoutLike(record.timer);
        record.timer = null;
      }
      if (ownedDanmakuNodes.has(node)) {
        node.removeAttribute(DANMAKU_STATE_ATTRIBUTE);
        ownedDanmakuNodes.delete(node);
      }
      danmakuRecords.delete(node);
    }

    function cleanupAllDanmakuNodes() {
      for (const node of [...ownedDanmakuNodes]) cleanupDanmakuNode(node);
    }

    function stopDanmakuObserver() {
      danmakuObserver?.disconnect();
      danmakuObserver = null;
    }

    function detachDanmakuRoot() {
      danmakuGeneration += 1;
      if (currentDanmakuRoot?.hasAttribute?.(DANMAKU_ROOT_ATTRIBUTE)) {
        // 先撤根门控再逐节点清理，异常时也不会把未决弹幕留在隐藏状态。
        currentDanmakuRoot.removeAttribute(DANMAKU_ROOT_ATTRIBUTE);
      }
      stopDanmakuObserver();
      cleanupAllDanmakuNodes();
      currentDanmakuRoot = null;
    }

    function processDanmakuNode(node, force = false) {
      if (
        !hasEffectiveDanmakuRule() ||
        !node?.matches?.(PAGE_SELECTORS.danmakuNode)
      ) {
        return null;
      }

      const id = node.getAttribute('data-danmu-id') ?? '';
      const text = normalizeKeywordText(node.textContent);
      const previous = danmakuRecords.get(node);
      const unchanged =
        previous?.id === id &&
        previous.text === text &&
        previous.revision === settingsRevision;
      if (!force && unchanged) return previous;
      if (previous) cleanupDanmakuNode(node);

      const record = {
        node,
        id,
        text,
        revision: settingsRevision,
        generation: danmakuGeneration,
        root: currentDanmakuRoot,
        state: 'pending',
        timer: null,
      };
      danmakuRecords.set(node, record);
      setDanmakuState(record, 'pending');

      if (!isValidVideoId(id)) {
        setDanmakuState(record, 'bypass');
        return record;
      }
      if (text) {
        setDanmakuState(
          record,
          evaluateDanmakuText(text, settings.danmaku) ? 'block' : 'allow',
        );
        return record;
      }

      record.timer = setTimeoutLike(() => {
        record.timer = null;
        if (
          !started ||
          record.generation !== danmakuGeneration ||
          record.root !== currentDanmakuRoot ||
          danmakuRecords.get(node) !== record ||
          record.state !== 'pending'
        ) {
          return;
        }
        setDanmakuState(record, 'bypass');
      }, DANMAKU_DECISION_WAIT_MS);
      return record;
    }

    function processDanmakuNodeSafely(node, force = false) {
      try {
        return processDanmakuNode(node, force);
      } catch (error) {
        cleanupDanmakuNode(node);
        reportError(
          '[抖音 Web 增强] 单条弹幕解析失败，已放行该节点',
          error,
        );
        return null;
      }
    }

    function createAddedElementBudget(maxElements = 64) {
      return { remaining: Math.max(0, maxElements) };
    }

    function visitMutationRecords(mutations, visitor) {
      let visited = 0;
      for (const mutation of mutations ?? []) {
        if (visited >= MAX_MUTATION_RECORDS_PER_BATCH) break;
        visited += 1;
        visitor(mutation);
      }
    }

    function visitAddedElements(node, visitor, budget) {
      // 评论区会产生高频大子树变更；限制单次增量工作，避免观察器退化成整页扫描。
      const sharedBudget = budget ?? createAddedElementBudget();
      if (sharedBudget.remaining <= 0) return;
      const queue = [];
      if (node?.nodeType === 1) queue.push(node);
      else for (const child of node?.children ?? []) queue.push(child);
      while (queue.length > 0 && sharedBudget.remaining > 0) {
        const element = queue.shift();
        sharedBudget.remaining -= 1;
        visitor(element);
        for (const child of element.children ?? []) {
          if (queue.length >= sharedBudget.remaining) break;
          queue.push(child);
        }
      }
    }

    function isWithinSubtree(node, subtreeRoot) {
      let current = node;
      while (current) {
        if (current === subtreeRoot) return true;
        current = current.parentElement ?? null;
      }
      return false;
    }

    function collectDanmakuNodeFromTarget(node, nodes) {
      const element = node?.nodeType === 1 ? node : node?.parentElement ?? null;
      if (!element) return;
      if (element.matches?.(PAGE_SELECTORS.danmakuNode)) nodes.add(element);
      const closest = element.closest?.(PAGE_SELECTORS.danmakuNode);
      if (closest) nodes.add(closest);
    }

    function collectDanmakuNodesFromAddedTree(node, nodes, budget) {
      visitAddedElements(node, (element) => {
        if (element.matches?.(PAGE_SELECTORS.danmakuNode)) nodes.add(element);
      }, budget);
    }

    function handleDanmakuMutations(mutations) {
      if (
        !started ||
        !currentDanmakuRoot ||
        documentLike.visibilityState === 'hidden'
      ) {
        return;
      }

      const affectedNodes = new Set();
      const removedNodes = new Set();
      const addedElementBudget = createAddedElementBudget();
      for (const mutation of mutations) {
        collectDanmakuNodeFromTarget(mutation.target, affectedNodes);
        for (const node of mutation.addedNodes ?? []) {
          collectDanmakuNodesFromAddedTree(node, affectedNodes, addedElementBudget);
        }
        for (const node of mutation.removedNodes ?? []) {
          collectDanmakuNodeFromTarget(node, removedNodes);
          for (const ownedNode of ownedDanmakuNodes) {
            if (isWithinSubtree(ownedNode, node)) {
              removedNodes.add(ownedNode);
            }
          }
        }
      }
      for (const node of removedNodes) cleanupDanmakuNode(node);
      for (const node of affectedNodes) processDanmakuNodeSafely(node);
    }

    function failOpenDanmaku(reason, error) {
      reportError(`[抖音 Web 增强] 弹幕过滤已降级：${reason}`, error);
      detachDanmakuRoot();
      danmakuSuspended = true;
    }

    function connectDanmakuRoot(nextRoot) {
      detachDanmakuRoot();
      if (!hasEffectiveDanmakuRule() || danmakuSuspended) return;

      currentDanmakuRoot = nextRoot;
      currentDanmakuRoot.setAttribute(DANMAKU_ROOT_ATTRIBUTE, '');
      try {
        for (const node of currentDanmakuRoot.querySelectorAll(
          PAGE_SELECTORS.danmakuNode,
        )) {
          processDanmakuNodeSafely(node);
        }
      } catch (error) {
        failOpenDanmaku('initial-scan-error', error);
        return;
      }

      if (typeof MutationObserverLike !== 'function') return;
      try {
        const observedRoot = currentDanmakuRoot;
        const observedGeneration = danmakuGeneration;
        danmakuObserver = new MutationObserverLike((mutations) => {
          if (
            currentDanmakuRoot !== observedRoot ||
            danmakuGeneration !== observedGeneration
          ) {
            return;
          }
          try {
            handleDanmakuMutations(mutations);
          } catch (error) {
            failOpenDanmaku('mutation-error', error);
          }
        });
        danmakuObserver.observe(currentDanmakuRoot, {
          attributes: true,
          attributeFilter: ['data-danmu-id'],
          characterData: true,
          childList: true,
          subtree: true,
        });
      } catch (error) {
        failOpenDanmaku('observer-error', error);
      }
    }

    function reconcileDanmakuRoot(force = false) {
      const nextRoot = documentLike?.documentElement ?? null;
      if (!hasEffectiveDanmakuRule() || !nextRoot || danmakuSuspended) {
        detachDanmakuRoot();
        return;
      }

      // 弹幕存在于推荐卡、独立视频页等不同播放器结构中；页面根只提供
      // 所有权范围，Observer 回调仍只分类受影响的 [data-danmu-id] 节点。
      if (currentDanmakuRoot !== nextRoot) {
        connectDanmakuRoot(nextRoot);
        return;
      }
      if (!force) return;
      try {
        for (const node of currentDanmakuRoot.querySelectorAll(
          PAGE_SELECTORS.danmakuNode,
        )) {
          processDanmakuNodeSafely(node, true);
        }
      } catch (error) {
        failOpenDanmaku('configuration-recheck-error', error);
      }
    }

    function cancelAllowDwell() {
      if (allowDwellTimer !== null) {
        clearTimeoutLike(allowDwellTimer);
        allowDwellTimer = null;
      }
    }

    function retireCurrentEpoch() {
      if (!currentEpoch) return null;

      const retiredEpoch = currentEpoch;
      retiredEpoch.retired = true;
      if (retiredEpoch.navigationTimer !== null) {
        clearTimeoutLike(retiredEpoch.navigationTimer);
        retiredEpoch.navigationTimer = null;
      }
      if (retiredEpoch.decisionTimer !== null) {
        clearTimeoutLike(retiredEpoch.decisionTimer);
        retiredEpoch.decisionTimer = null;
      }
      if (retiredEpoch.transitionTarget && retiredEpoch.transitionListener) {
        retiredEpoch.transitionTarget.removeEventListener?.(
          'transitionend',
          retiredEpoch.transitionListener,
        );
        retiredEpoch.transitionTarget.removeEventListener?.(
          'transitioncancel',
          retiredEpoch.transitionListener,
        );
        retiredEpoch.transitionTarget = null;
        retiredEpoch.transitionListener = null;
      }
      cancelAllowDwell();
      currentEpoch = null;
      return retiredEpoch;
    }

    function clearPredictiveNavigation() {
      predictiveNavigation = null;
    }

    function stopRootObserver() {
      rootObserver?.disconnect();
      rootObserver = null;
    }

    function detachRoot() {
      generation += 1;
      clearPredictiveNavigation();
      retireCurrentEpoch();
      if (activeFrame !== null) {
        cancelFrame(activeFrame);
        activeFrame = null;
      }
      stopRootObserver();
      cleanupAllCards();
      currentActiveCard = null;
      currentActiveId = '';
      currentRoot = null;
    }

    function clearFuse() {
      fuseTripped = false;
      skipTimestamps = [];
      hideNotice();
    }

    function pruneSkipWindow() {
      const cutoff = now() - SKIP_WINDOW_MS;
      skipTimestamps = skipTimestamps.filter((timestamp) => timestamp >= cutoff);
    }

    function tripFuse(record) {
      fuseTripped = true;
      setRecordState(record, 'bypass');
      if (currentEpoch?.record === record) currentEpoch.state = 'bypass';
      showNotice(
        '抖音 Web 增强已暂停自动跳过：15 秒内连续命中 12 条，请检查视频或 BGM 规则。',
        true,
      );
      logger?.warn?.('[抖音 Web 增强] 连续跳过熔断已触发');
    }

    function recordConfirmedSkip() {
      pruneSkipWindow();
      skipTimestamps.push(now());
    }

    function startAllowDwell(epoch) {
      cancelAllowDwell();
      allowDwellTimer = setTimeoutLike(() => {
        allowDwellTimer = null;
        if (!isCurrentEpoch(epoch) || epoch.state !== 'allow') return;
        skipTimestamps = [];
      }, ALLOW_DWELL_RESET_MS);
    }

    function classifyCard(card) {
      if (!hasEffectiveVideoRule()) return 'allow';

      let hasPendingSource = false;
      if (hasEffectiveVideoTextRule()) {
        const extracted = extractVideoFields(card);
        if (extracted.status === 'ready') {
          if (evaluateVideoFields(extracted.fields, settings.video)) return 'block';
        } else {
          hasPendingSource = true;
        }
      }

      if (hasEffectiveBgmRule()) {
        const identity = extractCardVideoId(card, root.location?.href);
        if (identity.status === 'ready') {
          const metadata = bgmCache.get(identity.id);
          if (metadata) {
            if (evaluateBgmFields(metadata, settings.bgm)) return 'block';
          } else {
            hasPendingSource = true;
          }
        }
      }

      return hasPendingSource ? 'pending' : 'allow';
    }

    function handleBgmMetadata(items) {
      if (!started || !hasEffectiveBgmRule()) return;
      if (
        documentLike.visibilityState === 'hidden' ||
        !isSupportedRecommendRoute(root.location)
      ) {
        return;
      }
      bgmCache.ingest(items);
      if (!currentRoot) return;
      const affectedIds = new Set(
        (items ?? []).map((item) => String(item?.awemeId ?? '')),
      );
      for (const card of currentRoot.querySelectorAll(PAGE_SELECTORS.feedCard)) {
        const identity = extractCardVideoId(card, root.location?.href);
        if (identity.status === 'ready' && affectedIds.has(identity.id)) {
          processCard(card, true);
        }
      }
    }

    function scanInlineBgmScript(script) {
      if (!script || scannedBgmScripts.has(script)) return;
      scannedBgmScripts.add(script);
      const source = String(script.textContent ?? '');
      if (source.length > 200_000 || !source.includes('createQuickPlayer')) {
        return;
      }
      handleBgmMetadata(extractQuickPlayerBgmMetadata(source));
    }

    function syncBgmObserver() {
      const shouldObserve =
        started &&
        hasEffectiveBgmRule() &&
        isSupportedRecommendRoute(root.location);
      if (shouldObserve) {
        if (!bgmObserver) {
          const factory =
            options.createBgmTransportObserver ?? createBgmTransportObserver;
          bgmObserver = factory(pageRoot, { onMetadata: handleBgmMetadata });
        }
        try {
          bgmObserver.start();
        } catch (error) {
          reportError('[抖音 Web 增强] BGM 响应观察器启动失败', error);
        }
      } else {
        bgmObserver?.stop();
        bgmObserver = null;
        bgmCache.clear();
      }
    }

    function handleCurrentDecision(record) {
      const epoch = currentEpoch;
      if (!epoch || epoch.record !== record || !isCurrentEpoch(epoch)) return;

      epoch.state = record.state;
      if (record.state !== 'pending' && epoch.decisionTimer !== null) {
        clearTimeoutLike(epoch.decisionTimer);
        epoch.decisionTimer = null;
      }
      if (record.state === 'block') {
        requestNavigation(epoch);
      } else if (record.state === 'allow') {
        startAllowDwell(epoch);
      }
    }

    function processCard(card, force = false) {
      if (!card?.matches?.(PAGE_SELECTORS.feedCard)) return null;

      const id = card.getAttribute('data-e2e-vid') ?? '';
      const previous = cardRecords.get(card);
      if (previous && previous.id !== id) {
        // 抖音会复用虚拟列表节点；新视频不得继承旧视频的终局决策。
        cleanupCard(card);
      }
      if (
        currentEpoch?.card === card &&
        currentEpoch.id === id &&
        ['allow', 'block', 'bypass', 'navigating'].includes(currentEpoch.state)
      ) {
        return previous ?? currentEpoch.record;
      }
      if (
        !force &&
        previous?.id === id &&
        previous.revision === settingsRevision &&
        previous.state !== 'pending'
      ) {
        return previous;
      }

      const record = {
        card,
        id,
        revision: settingsRevision,
        state: 'pending',
        activated: false,
      };
      cardRecords.set(card, record);
      setRecordState(record, 'pending');
      if (
        currentEpoch?.card === card &&
        currentEpoch.id === id &&
        currentEpoch.state === 'pending'
      ) {
        currentEpoch.record = record;
        record.activated = true;
      }

      const preserveCurrent =
        preservedActivation?.card === card &&
        preservedActivation.id === id &&
        card.matches(PAGE_SELECTORS.activeCard);
      if (preserveCurrent) {
        // 运行时首次启用规则不能突袭当前稳定视频；离开后再次激活会正常重判。
        setRecordState(record, 'bypass');
      } else if (!isValidVideoId(id)) {
        setRecordState(record, 'bypass');
      } else {
        try {
          setRecordState(record, classifyCard(card));
        } catch (error) {
          setRecordState(record, 'bypass');
          reportError('[抖音 Web 增强] 视频字段判定失败', error);
        }
      }

      handleCurrentDecision(record);
      return record;
    }

    function collectCardFromTarget(node, cards) {
      const element =
        node?.nodeType === 1 ? node : node?.parentElement ?? null;
      if (!element) return;

      if (element.matches?.(PAGE_SELECTORS.feedCard)) cards.add(element);
      const closest = element.closest?.(PAGE_SELECTORS.feedCard);
      if (closest) cards.add(closest);
    }

    function collectCardsFromAddedTree(node, cards, budget) {
      visitAddedElements(node, (element) => {
        if (element.matches?.(PAGE_SELECTORS.feedCard)) cards.add(element);
      }, budget);
    }

    function handleRootMutations(mutations) {
      if (!started || !currentRoot || documentLike.visibilityState === 'hidden') {
        return;
      }
      if (!isActiveFeedRootElement(currentRoot)) {
        safeReconcilePage();
        return;
      }

      const affectedCards = new Set();
      const removedCards = new Set();
      const addedElementBudget = createAddedElementBudget();
      visitMutationRecords(mutations, (mutation) => {
        collectCardFromTarget(mutation.target, affectedCards);
        for (const node of mutation.addedNodes ?? []) {
          collectCardsFromAddedTree(node, affectedCards, addedElementBudget);
        }
        for (const node of mutation.removedNodes ?? []) {
          if (ownedCards.has(node)) removedCards.add(node);
          for (const ownedCard of ownedCards) {
            if (node?.contains?.(ownedCard)) removedCards.add(ownedCard);
          }
        }
      });

      for (const card of removedCards) {
        if (card.isConnected && currentRoot.contains?.(card)) continue;
        if (currentEpoch?.card === card) retireCurrentEpoch();
        if (currentActiveCard === card) {
          currentActiveCard = null;
          currentActiveId = '';
        }
        cleanupCard(card);
        cardRecords.delete(card);
      }
      if (hasEffectiveVideoRule()) {
        for (const card of affectedCards) processCard(card);
      }
      scheduleActiveCheck();
    }

    function findActiveCard() {
      if (!currentRoot?.isConnected) return null;
      const activeCards = Array.from(
        currentRoot.querySelectorAll(PAGE_SELECTORS.activeCard),
      );
      if (activeCards.length !== 1) return null;
      const activeCard = activeCards[0];
      return isValidVideoId(activeCard.getAttribute('data-e2e-vid'))
        ? activeCard
        : null;
    }

    function getCardTransitionTrack(card) {
      const cardViewport = card?.parentElement ?? null;
      const transitionTrack = cardViewport?.parentElement ?? null;
      return transitionTrack?.contains?.(card) ? transitionTrack : currentRoot;
    }

    function isUsableNextControl(control) {
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

    function failOpenNavigation(epoch, reason) {
      if (!isCurrentEpoch(epoch)) return false;
      if (epoch.navigationTimer !== null) {
        clearTimeoutLike(epoch.navigationTimer);
        epoch.navigationTimer = null;
      }
      epoch.state = 'bypass';
      setRecordState(epoch.record, 'bypass');
      showNotice(
        reason === 'next-control-unavailable'
          ? '当前页面没有可用的上一条/下一条控件，已放行当前视频。'
          : '抖音 Web 增强未能确认下一条，已放行当前视频。',
      );
      logger?.warn?.('[抖音 Web 增强] 自动下一条已降级', reason);
      return true;
    }

    function handleNavigationTimeout(epoch) {
      if (!isCurrentEpoch(epoch) || epoch.state !== 'navigating') return;
      epoch.navigationTimer = null;

      const activeCard = findActiveCard();
      const activeId = activeCard?.getAttribute('data-e2e-vid') ?? '';
      if (activeId && activeId !== epoch.id) {
        refreshActiveCard();
        return;
      }

      if (epoch.navigationAttempts < 2) {
        requestNavigation(epoch, true, epoch.navigationDirection);
        return;
      }
      failOpenNavigation(epoch, 'confirmation-timeout');
    }

    function requestNavigation(epoch, retry = false, direction = 'down') {
      if (!isCurrentEpoch(epoch)) return false;
      if ((!retry && epoch.state !== 'block') || (retry && epoch.state !== 'navigating')) {
        return false;
      }
      if (documentLike.visibilityState === 'hidden') {
        failOpenNavigation(epoch, 'document-hidden');
        return false;
      }

      pruneSkipWindow();
      if (fuseTripped || skipTimestamps.length >= MAX_CONSECUTIVE_SKIPS) {
        tripFuse(epoch.record);
        return false;
      }

      const activeCard = findActiveCard();
      if (
        activeCard !== epoch.card ||
        activeCard?.getAttribute('data-e2e-vid') !== epoch.id
      ) {
        failOpenNavigation(epoch, 'active-card-unavailable');
        return false;
      }

      const controls = Array.from(
        documentLike.querySelectorAll(
          direction === 'up'
            ? PAGE_SELECTORS.previousControl
            : PAGE_SELECTORS.nextControl,
        ),
      );
      if (controls.length !== 1 || !isUsableNextControl(controls[0])) {
        failOpenNavigation(epoch, 'next-control-unavailable');
        return false;
      }

      epoch.state = 'navigating';
      setRecordState(epoch.record, 'navigating');
      epoch.navigationAttempts += 1;
      epoch.navigationDirection = direction;

      try {
        controls[0].click();
      } catch (error) {
        reportError('[抖音 Web 增强] 请求下一条失败', error);
        failOpenNavigation(epoch, 'click-error');
        return false;
      }

      if (!isCurrentEpoch(epoch)) return true;
      epoch.navigationTimer = setTimeoutLike(
        () => handleNavigationTimeout(epoch),
        NAVIGATION_CONFIRM_MS,
      );
      scheduleActiveCheck();
      return true;
    }

    function findPredictiveBlockedAdjacent(direction) {
      if (
        !currentRoot ||
        !currentEpoch ||
        !['allow', 'bypass'].includes(currentEpoch.state)
      ) {
        return null;
      }
      const activeCard = currentEpoch.card;
      let activeRect;
      try {
        activeRect = activeCard.getBoundingClientRect();
      } catch {
        return null;
      }
      const activeHeight = activeRect.height ?? activeRect.bottom - activeRect.top;
      if (!(activeHeight > 0)) return null;

      const candidates = [];
      for (const card of currentRoot.querySelectorAll(PAGE_SELECTORS.feedCard)) {
        if (card === activeCard) continue;
        const record = cardRecords.get(card);
        if (
          record?.id !== card.getAttribute('data-e2e-vid') ||
          record.revision !== settingsRevision ||
          record.state !== 'block'
        ) {
          continue;
        }
        try {
          const rect = card.getBoundingClientRect();
          const adjacent =
            direction === 'up'
              ? rect.bottom <= activeRect.top + 8 &&
                rect.bottom >= activeRect.top - Math.max(64, activeHeight * 0.5)
              : rect.top >= activeRect.bottom - 8 &&
                rect.top <= activeRect.bottom + Math.max(64, activeHeight * 0.5);
          if (adjacent) {
            candidates.push({ card, record, top: rect.top });
          }
        } catch {}
      }
      if (candidates.length !== 1) return null;
      return candidates[0];
    }

    function getNavigationDirection(event) {
      if (!event?.isTrusted || suppressPredictiveInput) return null;
      if (event.type === 'wheel') {
        if (
          !currentRoot?.contains?.(event.target) ||
          Math.abs(Number(event.deltaY)) <= 24 ||
          Math.abs(Number(event.deltaY)) < Math.abs(Number(event.deltaX ?? 0))
        ) return null;
        return Number(event.deltaY) < 0 ? 'up' : 'down';
      }
      if (event.type === 'keydown') {
        if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
          return false;
        }
        const target = event.target;
        if (
          target?.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/u.test(String(target?.tagName ?? ''))
        ) {
          return false;
        }
        if (event.key === 'ArrowUp' || event.key === 'PageUp') return 'up';
        if (event.key === 'ArrowDown' || event.key === 'PageDown') return 'down';
        return null;
      }
      if (event.type === 'click') {
        if (event.target?.closest?.(PAGE_SELECTORS.previousControl)) return 'up';
        if (event.target?.closest?.(PAGE_SELECTORS.nextControl)) return 'down';
      }
      return null;
    }

    function handlePredictiveNavigationIntent(event) {
      const direction = getNavigationDirection(event);
      if (
        !started ||
        documentLike.visibilityState === 'hidden' ||
        !direction ||
        predictiveNavigation?.sourceId === currentActiveId
      ) {
        return;
      }
      const candidate = findPredictiveBlockedAdjacent(direction);
      if (!candidate) return;
      const controls = Array.from(
        documentLike.querySelectorAll(
          direction === 'up'
            ? PAGE_SELECTORS.previousControl
            : PAGE_SELECTORS.nextControl,
        ),
      );
      if (controls.length !== 1 || !isUsableNextControl(controls[0])) return;

      const intent = {
        generation,
        sourceId: currentActiveId,
        targetId: candidate.record.id,
        direction,
        phase: 'directing',
      };
      predictiveNavigation = intent;
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      try {
        suppressPredictiveInput = true;
        controls[0].click();
      } catch (error) {
        reportError('[抖音 Web 增强] 预判直达失败', error);
        clearPredictiveNavigation();
      } finally {
        intent.phase = 'awaiting';
        suppressPredictiveInput = false;
      }

    }

    function schedulePendingWatchdog(epoch, deadline) {
      epoch.decisionTimer = setTimeoutLike(() => {
        epoch.decisionTimer = null;
        if (!isCurrentEpoch(epoch) || epoch.state !== 'pending') return;
        if (now() < deadline) {
          schedulePendingWatchdog(epoch, deadline);
          return;
        }
        epoch.state = 'bypass';
        setRecordState(epoch.record, 'bypass');
      }, Math.max(0, deadline - now()));
    }

    function startPendingWatchdog(epoch) {
      schedulePendingWatchdog(epoch, now() + CARD_DECISION_WAIT_MS);
    }

    function activateCard(card) {
      const id = card.getAttribute('data-e2e-vid') ?? '';
      const preserveThisActivation =
        preservedActivation?.card === card && preservedActivation.id === id;
      if (preservedActivation && !preserveThisActivation) {
        preservedActivation = null;
      }
      const existingRecord = cardRecords.get(card);
      const record =
        processCard(card, Boolean(existingRecord)) ?? {
          card,
          id,
          revision: settingsRevision,
          state: 'bypass',
          activated: false,
        };
      record.activated = true;
      if (preserveThisActivation) preservedActivation = null;
      const epoch = {
        sequence: ++epochSequence,
        generation,
        revision: record.revision,
        id,
        card,
        record,
        state: record.state,
        retired: false,
        navigationAttempts: 0,
        navigationDirection: 'down',
        navigationTimer: null,
        decisionTimer: null,
        transitionTarget: null,
        transitionListener: null,
      };
      currentEpoch = epoch;

      if (
        record.state === 'block' &&
        predictiveNavigation?.targetId === id &&
        predictiveNavigation.generation === generation
      ) {
        const finishPredictiveSettle = (event) => {
          if (
            event &&
            (event.target !== epoch.transitionTarget ||
              (event.propertyName && event.propertyName !== 'transform'))
          ) {
            return;
          }
          epoch.transitionTarget?.removeEventListener?.(
            'transitionend',
            epoch.transitionListener,
          );
          epoch.transitionTarget?.removeEventListener?.(
            'transitioncancel',
            epoch.transitionListener,
          );
          epoch.transitionTarget = null;
          epoch.transitionListener = null;
          if (epoch.decisionTimer !== null) {
            clearTimeoutLike(epoch.decisionTimer);
            epoch.decisionTimer = null;
          }
          if (!isCurrentEpoch(epoch) || epoch.state !== 'block') return;
          requestNavigation(epoch, false, predictiveNavigation.direction);
        };
        epoch.transitionTarget = getCardTransitionTrack(epoch.card);
        epoch.transitionListener = finishPredictiveSettle;
        epoch.transitionTarget.addEventListener?.(
          'transitionend',
          finishPredictiveSettle,
        );
        epoch.transitionTarget.addEventListener?.(
          'transitioncancel',
          finishPredictiveSettle,
        );
        // transitionend 是主路径；350ms 只处理页面漏发过渡事件。
        epoch.decisionTimer = setTimeoutLike(() => {
          epoch.decisionTimer = null;
          finishPredictiveSettle();
        }, PREDICTIVE_SETTLE_FALLBACK_MS);
      } else if (record.state === 'block') {
        requestNavigation(epoch);
      } else if (record.state === 'allow') {
        startAllowDwell(epoch);
      } else if (record.state === 'pending') {
        startPendingWatchdog(epoch);
      }
    }

    function refreshActiveCard() {
      if (!started || !currentRoot || documentLike.visibilityState === 'hidden') {
        return;
      }

      const activeCard = findActiveCard();
      if (!activeCard) return;
      const activeId = activeCard.getAttribute('data-e2e-vid') ?? '';
      const activeUnchanged =
        currentActiveCard === activeCard && currentActiveId === activeId;
      if (activeUnchanged) {
        return;
      }

      const previous = retireCurrentEpoch();
      const navigationConfirmed =
        previous?.state === 'navigating' && previous.id !== activeId;
      if (navigationConfirmed) {
        recordConfirmedSkip();
        cleanupCard(previous.card);
        cardRecords.delete(previous.card);
      }
      if (
        predictiveNavigation &&
        activeId !== predictiveNavigation.sourceId &&
        activeId !== predictiveNavigation.targetId
      ) {
        const activeRecord = processCard(activeCard, true);
        const predictedCard = Array.from(
          currentRoot.querySelectorAll(PAGE_SELECTORS.feedCard),
        ).find(
          (card) =>
            card.getAttribute('data-e2e-vid') === predictiveNavigation.targetId,
        );
        if (predictedCard) {
          cleanupCard(predictedCard);
          cardRecords.delete(predictedCard);
        }
        if (activeRecord?.state === 'block') {
          predictiveNavigation.targetId = activeId;
        } else {
          clearPredictiveNavigation();
        }
      }
      currentActiveCard = activeCard;
      currentActiveId = activeId;
      danmakuSuspended = false;
      if (hasEffectiveVideoRule()) activateCard(activeCard);
    }

    function scheduleActiveCheck() {
      if (activeFrame !== null || !started) return;
      const expectedGeneration = generation;
      activeFrame = requestFrame(() => {
        activeFrame = null;
        if (expectedGeneration !== generation) return;
        try {
          refreshActiveCard();
        } catch (error) {
          reportError('[抖音 Web 增强] 活动视频判定失败', error);
          failOpenController('active-card-error');
        }
      });
    }

    function connectRoot(nextRoot) {
      if (currentRoot === nextRoot && nextRoot?.isConnected) return;
      detachRoot();
      currentRoot = nextRoot;
      ensureStyle();

      if (hasEffectiveVideoRule()) {
        for (const card of currentRoot.querySelectorAll(PAGE_SELECTORS.feedCard)) {
          processCard(card);
        }
      }

      if (typeof MutationObserverLike === 'function') {
        try {
          const observedRoot = currentRoot;
          const observedGeneration = generation;
          rootObserver = new MutationObserverLike((mutations) => {
            if (
              currentRoot !== observedRoot ||
              generation !== observedGeneration
            ) {
              return;
            }
            try {
              handleRootMutations(mutations);
            } catch (error) {
              reportError('[抖音 Web 增强] Feed 变更处理失败', error);
              failOpenController('root-mutation-error');
            }
          });
          rootObserver.observe(currentRoot, {
            attributes: true,
            attributeFilter: ['data-e2e', 'data-e2e-vid'],
            characterData: true,
            childList: true,
            subtree: true,
          });
        } catch (error) {
          reportError('[抖音 Web 增强] Feed 观察器启动失败', error);
          failOpenController('root-observer-error');
          return;
        }
      }
      scheduleActiveCheck();
    }

    function collectPageSignalsFromAddedTree(node, roots, budget) {
      visitAddedElements(node, (element) => {
        if (element.matches?.(PAGE_SELECTORS.feedRoot)) roots.add(element);
        if (
          hasEffectiveBgmRule() &&
          String(element.tagName ?? '').toLowerCase() === 'script'
        ) {
          scanInlineBgmScript(element);
        }
      }, budget);
    }

    function handleGlobalMutations(mutations) {
      if (!isSupportedRecommendRoute(root.location)) {
        if (currentRoot) detachRoot();
        return;
      }
      let inspectedRecordCount = 0;
      let onlyCurrentRootMutations = Boolean(currentRoot?.isConnected);
      visitMutationRecords(mutations, (mutation) => {
        inspectedRecordCount += 1;
        if (!currentRoot?.contains?.(mutation.target)) {
          onlyCurrentRootMutations = false;
        }
      });
      if (onlyCurrentRootMutations && inspectedRecordCount > 0) {
        return;
      }
      const candidateRoots = new Set();
      const addedElementBudget = createAddedElementBudget();
      let currentRootRemoved = Boolean(currentRoot && !currentRoot.isConnected);
      visitMutationRecords(mutations, (mutation) => {
        for (const node of mutation.addedNodes ?? []) {
          collectPageSignalsFromAddedTree(node, candidateRoots, addedElementBudget);
        }
        for (const node of mutation.removedNodes ?? []) {
          if (node === currentRoot || node?.contains?.(currentRoot)) {
            currentRootRemoved = true;
          }
        }
      });
      if (currentRootRemoved || candidateRoots.size > 0) {
        safeReconcilePage();
      }
    }

    function ensureGlobalObserver() {
      if (globalObserver || !documentLike?.documentElement) return;
      if (typeof MutationObserverLike !== 'function') return;

      try {
        globalObserver = new MutationObserverLike((mutations) => {
          if (!started || !hasEffectivePageRule()) return;
          try {
            handleGlobalMutations(mutations);
          } catch (error) {
            reportError('[抖音 Web 增强] 页面增量生命周期处理失败', error);
            failOpenController('global-mutation-error');
          }
        });
        globalObserver.observe(documentLike.documentElement, {
          childList: true,
          subtree: true,
        });
      } catch (error) {
        globalObserver = null;
        reportError('[抖音 Web 增强] 页面生命周期观察器启动失败', error);
        failOpenController('global-observer-error');
      }
    }

    function reconcilePage() {
      if (!started) return;
      syncBgmObserver();
      if (
        !hasEffectivePageRule() ||
        documentLike.visibilityState === 'hidden'
      ) {
        if (currentRoot) detachRoot();
        detachDanmakuRoot();
        if (!hasEffectivePageRule()) removeStyle();
        return;
      }

      ensureStyle();
      ensureGlobalObserver();
      if (!lifecycleListening) return;

      if (hasEffectiveDanmakuRule()) reconcileDanmakuRoot();
      else detachDanmakuRoot();

      if (!hasEffectiveVideoRule() || !isSupportedRecommendRoute(root.location)) {
        if (currentRoot) detachRoot();
        return;
      }
      const roots = Array.from(
        documentLike.querySelectorAll(PAGE_SELECTORS.feedRoot),
      );
      if (roots.length !== 1) {
        if (currentRoot) detachRoot();
        return;
      }
      connectRoot(roots[0]);
    }

    function safeReconcilePage() {
      if (!started) return;
      try {
        reconcilePage();
      } catch (error) {
        reportError('[抖音 Web 增强] 页面生命周期处理失败', error);
        failOpenController('page-reconcile-error');
      }
    }

    function checkPageHealth() {
      if (!started || !hasEffectivePageRule()) return;
      const routeChanged = checkPageHealth.lastHref !== root.location?.href;
      checkPageHealth.lastHref = root.location?.href;
      const roots = Array.from(
        documentLike?.querySelectorAll?.(PAGE_SELECTORS.feedRoot) ?? [],
      );
      const nextRoot = roots.length === 1 ? roots[0] : null;
      const feedRootChanged = nextRoot !== currentRoot;
      const danmakuRootChanged =
        hasEffectiveDanmakuRule() &&
        currentDanmakuRoot !== documentLike?.documentElement;
      if (routeChanged && hasEffectiveBgmRule()) syncBgmObserver();
      if (
        routeChanged ||
        currentRoot?.isConnected === false ||
        feedRootChanged ||
        danmakuRootChanged
      ) {
        safeReconcilePage();
      }
    }
    checkPageHealth.lastHref = root.location?.href;

    function startLifecycle() {
      if (lifecycleListening || !started || !hasEffectivePageRule()) return;
      lifecycleListening = true;
      documentLike?.addEventListener?.(
        'visibilitychange',
        handleVisibilityChange,
      );
      root.addEventListener?.('popstate', safeReconcilePage);
      root.addEventListener?.('pageshow', safeReconcilePage);
      documentLike?.addEventListener?.(
        'click',
        handlePredictiveNavigationIntent,
        true,
      );
      documentLike?.addEventListener?.(
        'keydown',
        handlePredictiveNavigationIntent,
        true,
      );
      documentLike?.addEventListener?.(
        'wheel',
        handlePredictiveNavigationIntent,
        { capture: true, passive: false },
      );
      checkPageHealth.lastHref = root.location?.href;
      healthTimer = setIntervalLike(checkPageHealth, HEALTH_CHECK_MS);
      if (!documentLike?.documentElement) {
        startupTimer = setTimeoutLike(() => {
          startupTimer = null;
          safeReconcilePage();
        }, 0);
      }
      safeReconcilePage();
    }

    function stopLifecycle() {
      if (!lifecycleListening && !currentRoot && !globalObserver) {
        removeStyle();
        return;
      }
      lifecycleListening = false;
      detachRoot();
      detachDanmakuRoot();
      globalObserver?.disconnect();
      globalObserver = null;
      if (healthTimer !== null) {
        clearIntervalLike(healthTimer);
        healthTimer = null;
      }
      if (startupTimer !== null) {
        clearTimeoutLike(startupTimer);
        startupTimer = null;
      }
      documentLike?.removeEventListener?.(
        'visibilitychange',
        handleVisibilityChange,
      );
      root.removeEventListener?.('popstate', safeReconcilePage);
      root.removeEventListener?.('pageshow', safeReconcilePage);
      documentLike?.removeEventListener?.(
        'click',
        handlePredictiveNavigationIntent,
        true,
      );
      documentLike?.removeEventListener?.(
        'keydown',
        handlePredictiveNavigationIntent,
        true,
      );
      documentLike?.removeEventListener?.(
        'wheel',
        handlePredictiveNavigationIntent,
        true,
      );
      clearPredictiveNavigation();
      removeStyle();
    }

    function failOpenController(reason) {
      logger?.warn?.('[抖音 Web 增强] 视频过滤已停止并放行页面', reason);
      started = false;
      bgmObserver?.stop();
      bgmObserver = null;
      bgmCache.clear();
      stopLifecycle();
      hideNotice();
      preservedActivation = null;
      settings = null;
    }

    function handleVisibilityChange() {
      if (documentLike.visibilityState === 'hidden') {
        detachRoot();
        detachDanmakuRoot();
        globalObserver?.disconnect();
        globalObserver = null;
        return;
      }
      safeReconcilePage();
    }

    function updateInactiveCards() {
      if (!currentRoot) return;
      for (const card of currentRoot.querySelectorAll(PAGE_SELECTORS.feedCard)) {
        if (currentEpoch?.card === card) continue;
        processCard(card, true);
      }
    }

    return Object.freeze({
      start(initialSettings) {
        if (started) return false;
        started = true;
        settings = initialSettings;
        settingsRevision = 1;
        videoSettingsSignature = videoSignature(settings);
        danmakuSettingsSignature = danmakuSignature(settings);
        fuseSettingsSignature = fuseSignature(settings);
        syncBgmObserver();
        startLifecycle();
        return true;
      },
      updateSettings(nextSettings) {
        if (!started) {
          throw new Error('controller must be started before updating settings');
        }

        const hadEffectiveVideoRule = hasEffectiveVideoRule();
        const nextHasEffectiveVideoRule =
          isEffectiveRule(nextSettings?.video) || isEffectiveRule(nextSettings?.bgm);
        const nextVideoSignature = videoSignature(nextSettings);
        const nextDanmakuSignature = danmakuSignature(nextSettings);
        const nextFuseSignature = fuseSignature(nextSettings);
        const videoChanged = nextVideoSignature !== videoSettingsSignature;
        const danmakuChanged =
          nextDanmakuSignature !== danmakuSettingsSignature;
        const fuseInputsChanged = nextFuseSignature !== fuseSettingsSignature;
        settings = nextSettings;
        settingsRevision += 1;
        videoSettingsSignature = nextVideoSignature;
        danmakuSettingsSignature = nextDanmakuSignature;
        fuseSettingsSignature = nextFuseSignature;
        // 菜单更新发生在已加载页面上；历史 script 不做同步全扫，
        // 新增 script 由全局 Observer 增量处理，后续 Feed 由单飞传输观察补齐。
        syncBgmObserver();

        if (!hadEffectiveVideoRule && nextHasEffectiveVideoRule) {
          preservedActivation = captureActiveCard();
        } else if (!nextHasEffectiveVideoRule) {
          preservedActivation = null;
          retireCurrentEpoch();
          cleanupAllCards();
        }

        if (fuseInputsChanged) clearFuse();
        if (currentEpoch?.state === 'pending') {
          currentEpoch.state = 'bypass';
          setRecordState(currentEpoch.record, 'bypass');
        }
        if (!hasEffectiveDanmakuRule()) {
          detachDanmakuRoot();
          danmakuSuspended = false;
        } else if (danmakuChanged) {
          danmakuSuspended = false;
        }
        if (!hasEffectivePageRule()) {
          stopLifecycle();
          return true;
        }

        startLifecycle();
        safeReconcilePage();
        if (videoChanged && nextHasEffectiveVideoRule) {
          updateInactiveCards();
          const activeCard = findActiveCard();
          if (activeCard && !currentEpoch) {
            currentActiveCard = activeCard;
            currentActiveId = activeCard.getAttribute('data-e2e-vid') ?? '';
            activateCard(activeCard);
          }
        }
        if (danmakuChanged) {
          reconcileDanmakuRoot(true);
        }
        return true;
      },
      stop() {
        if (!started) return false;
        started = false;
        bgmObserver?.stop();
        bgmObserver = null;
        bgmCache.clear();
        stopLifecycle();
        hideNotice();
        preservedActivation = null;
        settings = null;
        return true;
      },
      snapshot() {
        pruneSkipWindow();
        return Object.freeze({
          started,
          generation,
          settingsRevision,
          rootConnected: Boolean(currentRoot?.isConnected),
          currentState: currentEpoch?.state ?? null,
          currentRevision: currentEpoch?.revision ?? null,
          navigationAttempts: currentEpoch?.navigationAttempts ?? 0,
          skipCount: skipTimestamps.length,
          fuseTripped,
          ownedCardCount: ownedCards.size,
          danmakuRootConnected: Boolean(currentDanmakuRoot?.isConnected),
          ownedDanmakuNodeCount: ownedDanmakuNodes.size,
        });
      },
    });
  }

  function createStage1Controller() {
    let started = false;
    let settings = null;

    return Object.freeze({
      start(initialSettings) {
        if (started) {
          return false;
        }
        started = true;
        settings = initialSettings;
        return true;
      },
      updateSettings(nextSettings) {
        if (!started) {
          throw new Error('controller must be started before updating settings');
        }
        settings = nextSettings;
        return true;
      },
      stop() {
        if (!started) {
          return false;
        }
        started = false;
        settings = null;
        return true;
      },
      snapshot() {
        return settings;
      },
    });
  }

  function bootstrap(overrides = {}) {
    const root = overrides.root ?? globalThis;
    const getValue =
      overrides.getValue ??
      (typeof GM_getValue === 'function' ? GM_getValue : null);
    const setValue =
      overrides.setValue ??
      (typeof GM_setValue === 'function' ? GM_setValue : null);
    const registerMenu =
      overrides.registerMenu ??
      (typeof GM_registerMenuCommand === 'function'
        ? GM_registerMenuCommand
        : null);
    const unregisterMenu =
      overrides.unregisterMenu ??
      (typeof GM_unregisterMenuCommand === 'function'
        ? GM_unregisterMenuCommand
        : null);
    const promptUser = overrides.promptUser ?? root.prompt?.bind(root);
    const logger = overrides.logger ?? root.console;

    if (!getValue || !setValue || !registerMenu) {
      logger?.error?.('[抖音 Web 增强] GM 配置或菜单 API 不可用');
      return null;
    }

    const reportError = (message, error) => {
      const errorName =
        error && typeof error === 'object' && typeof error.name === 'string'
          ? error.name
          : 'UnknownError';
      logger?.error?.(message, errorName);
    };

    let settings;
    try {
      settings = createSettingsSnapshot(
        Object.fromEntries(
          CATEGORY_DEFINITIONS.map(({ id }) => [
            id,
            {
              enabled: getValue(STORAGE_KEYS[id].enabled, true),
              keywords: getValue(STORAGE_KEYS[id].keywords, ''),
            },
          ]),
        ),
      );
    } catch (error) {
      reportError('[抖音 Web 增强] 读取本地设置失败', error);
      return null;
    }

    const controller = overrides.createController
      ? overrides.createController()
      : createPageController(root, { logger });
    let runtimeActive = false;

    function readRuntimeActive(fallback = runtimeActive) {
      try {
        const snapshot = controller.snapshot?.();
        if (typeof snapshot?.started === 'boolean') return snapshot.started;
        if (snapshot === null) return false;
        return snapshot === undefined ? fallback : true;
      } catch {
        return false;
      }
    }

    function startRuntime(nextSettings) {
      try {
        const startResult = controller.start(nextSettings);
        runtimeActive =
          startResult === false ? false : readRuntimeActive(true);
        return runtimeActive;
      } catch (error) {
        runtimeActive = false;
        reportError('[抖音 Web 增强] 恢复运行时失败', error);
        return false;
      }
    }

    try {
      const startResult = controller.start(settings);
      runtimeActive =
        startResult === false ? false : readRuntimeActive(true);
    } catch (error) {
      reportError('[抖音 Web 增强] 启动运行时失败', error);
    }

    const menuIds = new Map();

    function replaceCategorySettings(categoryId, nextCategory) {
      return createSettingsSnapshot({
        ...settings,
        [categoryId]: nextCategory,
      });
    }

    function commitCategorySetting(categoryId, storageKey, value, nextCategory) {
      try {
        setValue(storageKey, value);
      } catch (error) {
        reportError('[抖音 Web 增强] 保存本地设置失败', error);
        return false;
      }

      const nextSettings = replaceCategorySettings(categoryId, nextCategory);
      settings = nextSettings;
      runtimeActive = readRuntimeActive();
      if (!runtimeActive) {
        startRuntime(nextSettings);
        refreshMenus();
        return true;
      }
      try {
        controller.updateSettings(nextSettings);
        runtimeActive = readRuntimeActive(true);
      } catch (error) {
        // 存储已经提交成功；保留新快照，避免菜单与持久化状态分叉。
        reportError('[抖音 Web 增强] 更新运行时设置失败', error);
        startRuntime(nextSettings);
      }
      refreshMenus();
      return true;
    }

    function editKeywords(category) {
      const current = settings[category.id];
      const nextKeywords = promptUser?.(category.promptMessage, current.keywords);
      if (nextKeywords === null || nextKeywords === undefined) {
        return false;
      }

      const rawKeywords = String(nextKeywords);
      return commitCategorySetting(
        category.id,
        STORAGE_KEYS[category.id].keywords,
        rawKeywords,
        { ...current, keywords: rawKeywords },
      );
    }

    function toggleCategory(category) {
      const current = settings[category.id];
      runtimeActive = readRuntimeActive();
      if (!runtimeActive) {
        startRuntime(settings);
        refreshMenus();
        return runtimeActive;
      }
      if (current.compiledKeywords.length === 0) {
        return editKeywords(category);
      }

      const nextEnabled = !current.enabled;
      return commitCategorySetting(
        category.id,
        STORAGE_KEYS[category.id].enabled,
        nextEnabled,
        { ...current, enabled: nextEnabled },
      );
    }

    function getMenuLabels(category) {
      const current = settings[category.id];
      const keywordCount = current.compiledKeywords.length;
      if (!runtimeActive) {
        return {
          editLabel:
            keywordCount === 0
              ? category.editName
              : `${category.editName}（${keywordCount} 个）`,
          statusLabel:
            keywordCount === 0
              ? `${category.statusName}：运行已停止（未配置）`
              : `${category.statusName}：运行已停止（已保存 ${keywordCount} 个词）`,
        };
      }
      const statusLabel =
        keywordCount === 0
          ? `${category.statusName}：未配置`
          : current.enabled
            ? `${category.statusName}：已开启（${keywordCount} 个词）`
            : `${category.statusName}：已关闭（已保存 ${keywordCount} 个词）`;
      const editLabel =
        keywordCount === 0
          ? category.editName
          : `${category.editName}（${keywordCount} 个）`;
      return { editLabel, statusLabel };
    }

    function registerOrUpdateMenu(slot, label, callback) {
      const currentId = menuIds.get(slot);
      try {
        const nextId = registerMenu(
          label,
          callback,
          currentId === undefined ? undefined : { id: currentId },
        );
        menuIds.set(slot, nextId);
      } catch (error) {
        if (currentId === undefined || !unregisterMenu) {
          reportError('[抖音 Web 增强] 刷新脚本菜单失败', error);
          return;
        }

        try {
          unregisterMenu(currentId);
          menuIds.set(slot, registerMenu(label, callback));
        } catch (fallbackError) {
          reportError('[抖音 Web 增强] 重建脚本菜单失败', fallbackError);
        }
      }
    }

    function refreshMenus() {
      for (const category of CATEGORY_DEFINITIONS) {
        const { editLabel, statusLabel } = getMenuLabels(category);
        registerOrUpdateMenu(
          `${category.id}:status`,
          statusLabel,
          () => toggleCategory(category),
        );
        registerOrUpdateMenu(
          `${category.id}:edit`,
          editLabel,
          () => editKeywords(category),
        );
      }
    }

    refreshMenus();

    return Object.freeze({
      controller,
      getSettings: () => settings,
      refreshMenus,
      stop() {
        controller.stop();
        if (unregisterMenu) {
          for (const menuId of menuIds.values()) {
            try {
              unregisterMenu(menuId);
            } catch (error) {
              reportError('[抖音 Web 增强] 注销脚本菜单失败', error);
            }
          }
        }
        menuIds.clear();
      },
    });
  }

  return Object.freeze({
    CATEGORY_DEFINITIONS,
    STORAGE_KEYS,
    bootstrap,
    compileKeywords,
    createPageController,
    createBgmMetadataCache,
    createBgmTransportObserver,
    createSettingsSnapshot,
    createStage1Controller,
    evaluateBgmFields,
    extractBgmMetadata,
    extractQuickPlayerBgmMetadata,
    evaluateDanmakuText,
    evaluateVideoFields,
    extractCardVideoId,
    matchesAnyKeyword,
    normalizeKeywordText,
    extractVideoFields,
    isSupportedRecommendRoute,
    isValidVideoId,
    PAGE_SELECTORS,
    VIDEO_STATE_ATTRIBUTE,
  });
});

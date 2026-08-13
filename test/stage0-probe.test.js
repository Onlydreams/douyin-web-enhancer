'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const stage0 = require('../tools/stage0-probe.user.js');
const quickPlayerFixture = require('./fixtures/stage0-quick-player-shape.json');

const createControlledPromise = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createFakeEnvironment = (href = 'https://www.douyin.com/?recommend=1&dwe_stage0_probe=capture') => {
  const listeners = new Map();
  const mutations = { writes: 0 };
  let observerCallback;
  let observerDisconnected = false;
  let timerCallback;

  const document = {
    readyState: 'loading',
    visibilityState: 'visible',
    documentElement: {},
    addEventListener(type, listener) {
      const values = listeners.get(type) ?? [];
      values.push(listener);
      listeners.set(type, values);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((value) => value !== listener));
    },
    querySelectorAll() {
      return [];
    },
    createElement() {
      mutations.writes += 1;
      return {};
    },
  };

  class FakeMutationObserver {
    constructor(callback) {
      observerCallback = callback;
    }

    observe() {}

    disconnect() {
      observerDisconnected = true;
    }
  }

  const root = {
    location: { href },
    document,
    performance: { now: () => 100 },
    MutationObserver: FakeMutationObserver,
    setTimeout(callback) {
      timerCallback = callback;
      return 7;
    },
    clearTimeout() {},
    fetch() {
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null } });
    },
  };

  return {
    document,
    listeners,
    mutations,
    root,
    triggerMutations(mutationList) {
      observerCallback?.(mutationList);
    },
    triggerTimeout() {
      timerCallback?.();
    },
    get observerDisconnected() {
      return observerDisconnected;
    },
  };
};

test('probe is inert unless the explicit capture query parameter is present', () => {
  const environment = createFakeEnvironment('https://www.douyin.com/?recommend=1');

  assert.equal(stage0.bootstrap(environment.root), null);
  assert.equal(environment.root[stage0.API_KEY], undefined);
  assert.equal(environment.mutations.writes, 0);
});

test('bootstrap instruments unsafeWindow while keeping the API on the script global', () => {
  const environment = createFakeEnvironment();
  const pageRoot = environment.root;
  const originalFetch = pageRoot.fetch;
  const scriptRoot = {
    location: pageRoot.location,
    unsafeWindow: pageRoot,
    GM: { info: {} },
  };

  const probe = stage0.bootstrap(scriptRoot, { document: pageRoot.document });

  assert.equal(scriptRoot[stage0.API_KEY], probe);
  assert.notEqual(pageRoot.fetch, originalFetch);
  assert.equal(scriptRoot.fetch, undefined);
  assert.equal(probe.snapshot().started.pageRootSameAsScriptRoot, false);
  assert.equal(probe.snapshot().started.unsafeWindowAvailable, true);
  probe.stop('test-stop');
  assert.equal(pageRoot.fetch, originalFetch);
});

test('capture mode never writes to the page DOM when observing mutations', () => {
  const environment = createFakeEnvironment();
  const probe = stage0.bootstrap(environment.root);
  const harmlessNode = {
    nodeType: 1,
    matches: () => false,
    querySelectorAll: () => [],
  };

  for (let index = 0; index < 1_000; index += 1) {
    environment.triggerMutations([{ addedNodes: [harmlessNode] }]);
  }

  assert.equal(environment.mutations.writes, 0);
  assert.equal(probe.active, true);
  assert.ok(probe.snapshot().droppedEvents >= 0);
});

test('event recording is bounded under mutation pressure', () => {
  const environment = createFakeEnvironment();
  const probe = stage0.createCaptureProbe(environment.root, {
    maximumEvents: 8,
    document: environment.document,
  });
  for (let index = 0; index < 1_000; index += 1) {
    const danmakuNode = {
      nodeType: 1,
      children: [],
      textContent: `redacted text ${index}`,
      matches(selector) {
        return selector === '[data-danmu-id]';
      },
      getAttribute() {
        return String(index).padStart(19, '0');
      },
      querySelectorAll() {
        return [];
      },
    };
    environment.triggerMutations([{ addedNodes: [danmakuNode] }]);
  }

  const report = probe.snapshot();
  assert.equal(report.events.length, 8);
  assert.ok(report.droppedEvents > 900);
  assert.equal(JSON.stringify(report).includes('redacted text'), false);
  assert.equal(JSON.stringify(report).includes('1234567890123456789'), false);
});

test('fetch wrapper preserves receiver, arguments, and returned Promise identity', async () => {
  const controlled = createControlledPromise();
  const receiver = {};
  const calls = [];
  const events = [];
  const root = {
    location: { href: 'https://www.douyin.com/?recommend=1' },
    fetch(...args) {
      calls.push({ receiver: this, args });
      return controlled.promise;
    },
  };
  const originalFetch = root.fetch;
  const capture = stage0.createFetchCapture({
    root,
    record: (event) => events.push(event),
    now: () => 12,
  });

  const returned = root.fetch.call(receiver, '/aweme/v1/web/tab/feed/', { method: 'POST' });

  assert.equal(returned, controlled.promise);
  assert.equal(calls[0].receiver, receiver);
  assert.deepEqual(calls[0].args, ['/aweme/v1/web/tab/feed/', { method: 'POST' }]);

  controlled.resolve({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json; charset=utf-8' },
  });
  await returned;
  await Promise.resolve();

  assert.equal(events[0].type, 'fetch-first-call');
  assert.equal(events[1].type, 'fetch-candidate-call');
  assert.deepEqual(events[1].resource, { sameOrigin: true, path: '/aweme/v1/web/tab/feed/' });
  assert.equal(events[2].type, 'fetch-candidate-settle');
  assert.equal(events[2].contentType, 'application/json');
  assert.equal(capture.restore(), true);
  assert.equal(root.fetch, originalFetch);
});

test('cleanup does not overwrite a fetch wrapper installed after the probe', () => {
  const root = {
    location: { href: 'https://www.douyin.com/' },
    fetch() {
      return Promise.resolve();
    },
  };
  const laterWrapper = () => Promise.resolve();
  const capture = stage0.createFetchCapture({ root, record() {}, now: () => 0 });

  root.fetch = laterWrapper;

  assert.equal(capture.restore(), false);
  assert.equal(root.fetch, laterWrapper);
});

test('unrelated fetches get only one content-free timing marker', async () => {
  const events = [];
  const root = {
    location: { href: 'https://www.douyin.com/' },
    fetch() {
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null } });
    },
  };
  const capture = stage0.createFetchCapture({
    root,
    record: (event) => events.push(event),
    now: () => 4,
  });

  await root.fetch('/api/unrelated?token=secret');
  await root.fetch('/api/also-unrelated?id=123');

  assert.deepEqual(events, [{ type: 'fetch-first-call', ms: 4 }]);
  capture.restore();
});

test('XHR wrapper preserves receiver, arguments, return values, and loadend semantics', async () => {
  const calls = [];
  const events = [];

  class FakeXmlHttpRequest {
    constructor() {
      this.listeners = new Map();
      this.status = 200;
      this.responseType = '';
      this.responseText = JSON.stringify({
        aweme_id: '1234567890123456789',
        music: { title: 'private music title' },
      });
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    removeEventListener(type, listener) {
      if (this.listeners.get(type) === listener) this.listeners.delete(type);
    }

    open(...args) {
      calls.push({ type: 'open', receiver: this, args });
      return 'open-result';
    }

    send(...args) {
      calls.push({ type: 'send', receiver: this, args });
      return 'send-result';
    }

    getResponseHeader(name) {
      assert.equal(name, 'content-type');
      return 'application/json; charset=utf-8';
    }

    emit(type) {
      this.listeners.get(type)?.call(this, { type });
    }
  }

  const root = {
    location: { href: 'https://www.douyin.com/' },
    XMLHttpRequest: FakeXmlHttpRequest,
  };
  const originalOpen = FakeXmlHttpRequest.prototype.open;
  const originalSend = FakeXmlHttpRequest.prototype.send;
  const capture = stage0.createXhrCapture({
    root,
    record: (event) => events.push(event),
    now: () => 9,
  });
  const xhr = new FakeXmlHttpRequest();

  assert.equal(xhr.open('POST', '/aweme/v1/web/tab/feed/?token=secret', true), 'open-result');
  assert.equal(xhr.send('body'), 'send-result');
  assert.equal(calls[0].receiver, xhr);
  assert.deepEqual(calls[0].args, ['POST', '/aweme/v1/web/tab/feed/?token=secret', true]);
  assert.equal(calls[1].receiver, xhr);
  assert.deepEqual(calls[1].args, ['body']);

  xhr.emit('loadend');

  assert.deepEqual(events.map((event) => event.type), [
    'xhr-first-open',
    'xhr-candidate-open',
    'xhr-candidate-send',
    'xhr-candidate-settle',
  ]);
  assert.equal(events[3].responseSummary, undefined);
  await Promise.resolve();

  assert.deepEqual(events.map((event) => event.type), [
    'xhr-first-open',
    'xhr-candidate-open',
    'xhr-candidate-send',
    'xhr-candidate-settle',
    'xhr-candidate-shape',
  ]);
  assert.deepEqual(events[1].resource, { sameOrigin: true, path: '/aweme/v1/web/tab/feed/' });
  assert.equal(events[3].status, 200);
  assert.equal(events[3].contentType, 'application/json');
  assert.equal(events[4].responseSummary.parsed, true);
  assert.deepEqual(events[4].responseSummary.metadataShape.matches, [{
    videoIdKeys: ['aweme_id'],
    musicContainerKey: 'music',
    musicNameKeys: ['title'],
    idFieldsConsistent: true,
    count: 1,
  }]);
  assert.equal(JSON.stringify(events).includes('private music title'), false);
  assert.equal(JSON.stringify(events).includes('1234567890123456789'), false);
  assert.equal(JSON.stringify(events).includes('body'), false);
  assert.deepEqual(capture.restore(), { open: true, send: true });
  assert.equal(FakeXmlHttpRequest.prototype.open, originalOpen);
  assert.equal(FakeXmlHttpRequest.prototype.send, originalSend);
});

test('XHR cleanup removes pending probe listeners before requests settle', () => {
  class FakeXmlHttpRequest {
    constructor() {
      this.listeners = new Map();
    }
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }
    removeEventListener(type, listener) {
      if (this.listeners.get(type) === listener) this.listeners.delete(type);
    }
    open() {}
    send() {}
  }
  const root = {
    location: { href: 'https://www.douyin.com/' },
    XMLHttpRequest: FakeXmlHttpRequest,
  };
  const capture = stage0.createXhrCapture({ root, record() {}, now: () => 0 });
  const xhr = new FakeXmlHttpRequest();

  xhr.open('GET', '/aweme/v1/web/tab/feed/');
  xhr.send();
  assert.equal(xhr.listeners.has('loadend'), true);

  capture.restore();

  assert.equal(xhr.listeners.has('loadend'), false);
});

test('XHR cleanup never overwrites wrappers installed after the probe', () => {
  class FakeXmlHttpRequest {
    open() {}
    send() {}
  }
  const root = {
    location: { href: 'https://www.douyin.com/' },
    XMLHttpRequest: FakeXmlHttpRequest,
  };
  const capture = stage0.createXhrCapture({ root, record() {}, now: () => 0 });
  const laterOpen = () => 'later-open';
  const laterSend = () => 'later-send';

  FakeXmlHttpRequest.prototype.open = laterOpen;
  FakeXmlHttpRequest.prototype.send = laterSend;

  assert.deepEqual(capture.restore(), { open: false, send: false });
  assert.equal(FakeXmlHttpRequest.prototype.open, laterOpen);
  assert.equal(FakeXmlHttpRequest.prototype.send, laterSend);
});

test('danmaku tracker detects in-place text changes and ID reuse without leaking values', () => {
  const events = [];
  const node = {
    children: [{}, {}, {}],
    textContent: 'first private text',
    id: '1111111111111111111',
    matches(selector) {
      return selector === '[data-danmu-id]';
    },
    getAttribute(name) {
      return name === 'data-danmu-id' ? this.id : null;
    },
  };
  const track = stage0.createDanmakuTracker((event) => events.push(event));

  track(node);
  track(node);
  node.textContent = 'second private text';
  track(node);
  node.id = '2222222222222222222';
  track(node);

  assert.deepEqual(events.map((event) => event.type), [
    'danmaku-observed',
    'danmaku-content-changed',
    'danmaku-node-reused',
  ]);
  assert.equal(JSON.stringify(events).includes('first private text'), false);
  assert.equal(JSON.stringify(events).includes('second private text'), false);
  assert.equal(JSON.stringify(events).includes('1111111111111111111'), false);
  assert.equal(JSON.stringify(events).includes('2222222222222222222'), false);
});

test('metadata shape summary proves ID and music-name co-location without retaining values', () => {
  const summary = stage0.summarizeMetadataShape(quickPlayerFixture);

  assert.deepEqual(summary.matches, [{
    videoIdKeys: ['awemeId'],
    musicContainerKey: 'music',
    musicNameKeys: ['musicName', 'title'],
    idFieldsConsistent: true,
    count: 1,
  }]);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes('0000000000000000000'), false);
  assert.equal(serialized.includes('<music-title>'), false);
  assert.equal(serialized.includes('<music-name>'), false);
});

test('metadata shape summary reports conflicting ID fields without retaining them', () => {
  const summary = stage0.summarizeMetadataShape({
    awemeId: '1111111111111111111',
    gid: '2222222222222222222',
    music: { musicName: 'private name' },
  });

  assert.equal(summary.matches[0].idFieldsConsistent, false);
  assert.equal(JSON.stringify(summary).includes('1111111111111111111'), false);
  assert.equal(JSON.stringify(summary).includes('2222222222222222222'), false);
  assert.equal(JSON.stringify(summary).includes('private name'), false);
});

test('media context reports semantic ancestors and ID shape only', () => {
  const root = {
    parentElement: null,
    getAttribute(name) {
      if (name === 'data-e2e') return 'feed-active-video';
      if (name === 'data-e2e-vid') return '1234567890123456789';
      return null;
    },
  };
  const wrapper = {
    parentElement: root,
    getAttribute(name) {
      return name === 'data-e2e' ? 'video-player' : null;
    },
  };
  const context = stage0.describeMediaContext({ parentElement: wrapper });

  assert.deepEqual(context, {
    ancestorE2e: ['video-player', 'feed-active-video'],
    closestVideoId: { present: true, decimal: true, length: 19 },
    videoIdDepth: 2,
  });
  assert.equal(JSON.stringify(context).includes('1234567890123456789'), false);
});

test('automatic timeout disconnects observers, restores fetch, and retains a final snapshot', () => {
  const environment = createFakeEnvironment();
  const originalFetch = environment.root.fetch;
  const probe = stage0.bootstrap(environment.root);

  assert.notEqual(environment.root.fetch, originalFetch);
  environment.triggerTimeout();

  assert.equal(probe.active, false);
  assert.equal(probe.snapshot().stoppedReason, 'capture-timeout');
  assert.equal(environment.root.fetch, originalFetch);
  assert.equal(environment.observerDisconnected, true);
  assert.ok(environment.root[stage0.API_KEY]);
});

test('late fetch settlements cannot mutate a stopped probe report', async () => {
  const environment = createFakeEnvironment();
  const controlled = createControlledPromise();
  environment.root.fetch = () => controlled.promise;
  const probe = stage0.bootstrap(environment.root);

  const request = environment.root.fetch('/aweme/v1/web/tab/feed/');
  const stopped = probe.stop('test-stop');
  controlled.resolve({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
  });
  await request;
  await Promise.resolve();

  assert.deepEqual(probe.snapshot().events, stopped.events);
  assert.equal(
    probe.snapshot().events.some((event) => event.type === 'fetch-candidate-settle'),
    false,
  );
});

test('sanitizers omit query strings, identifiers, and text values', () => {
  assert.deepEqual(
    stage0.sanitizeResource(
      'https://www.douyin.com/aweme/v1/web/tab/feed/?token=secret&id=123',
      'https://www.douyin.com/',
    ),
    { sameOrigin: true, path: '/aweme/v1/web/tab/feed/' },
  );
  assert.deepEqual(stage0.describeIdentifier('1234567890123456789'), {
    present: true,
    decimal: true,
    length: 19,
  });
  assert.deepEqual(
    stage0.sanitizeResource(
      'https://www.douyin.com/video/1234567890123456789/abcdef0123456789?token=secret',
      'https://www.douyin.com/',
    ),
    { sameOrigin: true, path: '/video/<id>/<opaque>' },
  );
  assert.deepEqual(
    stage0.sanitizeResource(
      'https://video-cdn.example/private/video/path/1234567890123456789',
      'https://www.douyin.com/',
    ),
    { sameOrigin: false, path: '<external>' },
  );
});

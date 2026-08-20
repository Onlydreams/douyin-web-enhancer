'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const enhancer = require('../douyin-web-enhancer.user.js');

function createResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    clone() {
      return { text: async () => JSON.stringify(payload) };
    },
  };
}

test('overlapping feed responses cannot start more than one body clone', async () => {
  let cloneCount = 0;
  const neverSettles = new Promise(() => {});
  const response = {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    clone() {
      cloneCount += 1;
      return { text: () => neverSettles };
    },
  };
  const pageRoot = {
    location: { origin: 'https://www.douyin.com' },
    fetch: async () => response,
    queueMicrotask,
  };
  const observer = enhancer.createBgmTransportObserver(pageRoot, {
    onMetadata() {},
  });
  observer.start();

  for (let index = 0; index < 2; index += 1) {
    await pageRoot.fetch('/aweme/v1/web/tab/feed/?count=6');
  }
  await Promise.resolve();

  assert.equal(cloneCount, 1);
  observer.stop();
});

test('fetch wrapper preserves receiver, arguments and Promise identity', async () => {
  const payload = { aweme_id: '1111111111111111111', music: { title: '音乐' } };
  const response = createResponse(payload);
  const promise = Promise.resolve(response);
  const calls = [];
  const receiver = {};
  const pageRoot = {
    location: { origin: 'https://www.douyin.com' },
    fetch(...args) { calls.push({ receiver: this, args }); return promise; },
    queueMicrotask,
  };
  const original = pageRoot.fetch;
  const batches = [];
  const observer = enhancer.createBgmTransportObserver(pageRoot, {
    onMetadata: (items) => batches.push(items),
  });
  observer.start();

  const returned = pageRoot.fetch.call(receiver, '/aweme/v1/web/tab/feed/?count=6', { method: 'GET' });
  assert.equal(returned, promise);
  assert.deepEqual(calls, [{ receiver, args: ['/aweme/v1/web/tab/feed/?count=6', { method: 'GET' }] }]);
  await returned;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(batches[0][0].awemeId, '1111111111111111111');

  observer.stop();
  assert.equal(pageRoot.fetch, original);
});

test('fetch observer ignores unrelated and non-JSON responses', async () => {
  const batches = [];
  const pageRoot = {
    location: { origin: 'https://www.douyin.com' },
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      clone() { throw new Error('must not clone'); },
    }),
    queueMicrotask,
  };
  const observer = enhancer.createBgmTransportObserver(pageRoot, {
    onMetadata: (items) => batches.push(items),
  });
  observer.start();
  await pageRoot.fetch('/api/unrelated');
  await pageRoot.fetch('/aweme/v1/web/tab/feed/', { method: 'POST' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(batches, []);
});

test('stopping before async fetch parsing prevents metadata delivery', async () => {
  let resolveText;
  const response = {
    ok: true,
    headers: { get: () => 'application/json' },
    clone() {
      return { text: () => new Promise((resolve) => { resolveText = resolve; }) };
    },
  };
  const pageRoot = {
    location: { origin: 'https://www.douyin.com' },
    fetch: async () => response,
    queueMicrotask,
  };
  const batches = [];
  const observer = enhancer.createBgmTransportObserver(pageRoot, {
    onMetadata: (items) => batches.push(items),
  });
  observer.start();
  await pageRoot.fetch('/aweme/v1/web/tab/feed/');
  await Promise.resolve();
  observer.stop();
  resolveText(JSON.stringify({
    aweme_id: '1111111111111111111',
    music: { title: '迟到音乐' },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(batches, []);
});

test('a fetch response from an earlier run cannot enter a restarted observer', async () => {
  let resolveText;
  const response = {
    ok: true,
    headers: { get: () => 'application/json' },
    clone() {
      return { text: () => new Promise((resolve) => { resolveText = resolve; }) };
    },
  };
  const pageRoot = {
    location: { origin: 'https://www.douyin.com' },
    fetch: async () => response,
    queueMicrotask,
  };
  const batches = [];
  const observer = enhancer.createBgmTransportObserver(pageRoot, {
    onMetadata: (items) => batches.push(items),
  });

  observer.start();
  await pageRoot.fetch('/aweme/v1/web/tab/feed/');
  await Promise.resolve();
  observer.stop();
  observer.start();
  resolveText(JSON.stringify({
    aweme_id: '1111111111111111111',
    music: { title: '旧运行迟到音乐' },
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(batches, []);
});

test('a pending body clone keeps the single-flight slot across stop and restart', async () => {
  let cloneCount = 0;
  let resolveFirstText;
  const firstText = new Promise((resolve) => { resolveFirstText = resolve; });
  const response = {
    ok: true,
    headers: { get: () => 'application/json' },
    clone() {
      cloneCount += 1;
      return { text: () => firstText };
    },
  };
  const pageRoot = {
    location: { origin: 'https://www.douyin.com' },
    fetch: async () => response,
  };
  const observer = enhancer.createBgmTransportObserver(pageRoot, {
    onMetadata() {},
  });

  observer.start();
  await pageRoot.fetch('/aweme/v1/web/tab/feed/');
  await Promise.resolve();
  observer.stop();
  observer.start();
  await pageRoot.fetch('/aweme/v1/web/tab/feed/');
  await Promise.resolve();

  assert.equal(cloneCount, 1);
  resolveFirstText('{}');
  await new Promise((resolve) => setTimeout(resolve, 0));
  observer.stop();
});

test('an XHR task from an earlier run cannot enter a restarted observer', () => {
  const tasks = [];
  class FakeXHR {
    constructor() {
      this.listeners = new Map();
      this.status = 200;
      this.responseType = '';
      this.responseText = JSON.stringify({
        aweme_id: '2222222222222222222',
        music: { title: '旧运行迟到音乐' },
      });
    }
    open() {}
    send() {}
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    removeEventListener(type, callback) {
      if (this.listeners.get(type) === callback) this.listeners.delete(type);
    }
    emit(type) { this.listeners.get(type)?.call(this); }
    getResponseHeader() { return 'application/json'; }
  }
  const pageRoot = {
    location: { origin: 'https://www.douyin.com' },
    XMLHttpRequest: FakeXHR,
  };
  const batches = [];
  const observer = enhancer.createBgmTransportObserver(pageRoot, {
    onMetadata: (items) => batches.push(items),
    scheduleTask: (callback) => tasks.push(callback),
  });

  observer.start();
  const xhr = new FakeXHR();
  xhr.open('GET', '/aweme/v1/web/tab/feed/');
  xhr.send();
  xhr.emit('loadend');
  observer.stop();
  observer.start();
  tasks.shift()();

  assert.deepEqual(batches, []);
});

test('XHR wrapper preserves calls and parses after loadend', async () => {
  const calls = [];
  class FakeXHR {
    constructor() { this.listeners = new Map(); this.status = 200; this.responseType = ''; }
    open(...args) { calls.push(['open', this, args]); return 'open-result'; }
    send(...args) { calls.push(['send', this, args]); return 'send-result'; }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    removeEventListener(type, callback) { if (this.listeners.get(type) === callback) this.listeners.delete(type); }
    emit(type) { this.listeners.get(type)?.call(this); }
    getResponseHeader() { return 'application/json'; }
  }
  const originalOpen = FakeXHR.prototype.open;
  const originalSend = FakeXHR.prototype.send;
  const pageRoot = {
    location: { origin: 'https://www.douyin.com' },
    XMLHttpRequest: FakeXHR,
    queueMicrotask,
  };
  const batches = [];
  const observer = enhancer.createBgmTransportObserver(pageRoot, {
    onMetadata: (items) => batches.push(items),
  });
  observer.start();
  const xhr = new FakeXHR();
  assert.equal(xhr.open('GET', '/aweme/v1/web/tab/feed/?count=6'), 'open-result');
  assert.equal(xhr.send('body'), 'send-result');
  xhr.responseText = JSON.stringify({ aweme_id: '2222222222222222222', music: { title: '音乐' } });
  xhr.emit('loadend');
  assert.deepEqual(batches, []);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(batches[0][0].awemeId, '2222222222222222222');
  observer.stop();
  assert.equal(FakeXHR.prototype.open, originalOpen);
  assert.equal(FakeXHR.prototype.send, originalSend);
});

test('XHR send exceptions preserve the original error and remove listeners', () => {
  const expected = new Error('send failed');
  class FakeXHR {
    constructor() { this.listeners = new Map(); }
    open() {}
    send() { throw expected; }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    removeEventListener(type, callback) {
      if (this.listeners.get(type) === callback) this.listeners.delete(type);
    }
  }
  const pageRoot = {
    location: { origin: 'https://www.douyin.com' },
    XMLHttpRequest: FakeXHR,
    queueMicrotask,
  };
  const observer = enhancer.createBgmTransportObserver(pageRoot, { onMetadata() {} });
  observer.start();
  const xhr = new FakeXHR();
  xhr.open('GET', '/aweme/v1/web/tab/feed/');
  assert.throws(() => xhr.send(), (error) => error === expected);
  assert.equal(xhr.listeners.size, 0);
});

test('XHR task scheduling failure releases the single-flight slot', () => {
  class FakeXHR {
    constructor() {
      this.listeners = new Map();
      this.status = 200;
      this.responseType = '';
      this.responseText = '{}';
    }
    open() {}
    send() {}
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    removeEventListener(type, callback) {
      if (this.listeners.get(type) === callback) this.listeners.delete(type);
    }
    emit(type) { this.listeners.get(type)?.call(this); }
  }
  let scheduleAttempts = 0;
  const observer = enhancer.createBgmTransportObserver({
    location: { origin: 'https://www.douyin.com' },
    XMLHttpRequest: FakeXHR,
  }, {
    onMetadata() {},
    scheduleTask() {
      scheduleAttempts += 1;
      throw new Error('scheduler unavailable');
    },
  });
  observer.start();
  const xhr = new FakeXHR();

  for (let index = 0; index < 2; index += 1) {
    xhr.open('GET', '/aweme/v1/web/tab/feed/');
    xhr.send();
    assert.doesNotThrow(() => xhr.emit('loadend'));
  }

  assert.equal(scheduleAttempts, 2);
});

test('XHR reuse clears stale candidates and listeners before the next request', () => {
  class FakeXHR {
    constructor() { this.listeners = new Map(); }
    open(method, url) {
      if (url === '/throws') throw new Error('open failed');
    }
    send() {}
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    removeEventListener(type, callback) {
      if (this.listeners.get(type) === callback) this.listeners.delete(type);
    }
  }
  const pageRoot = {
    location: { origin: 'https://www.douyin.com' },
    XMLHttpRequest: FakeXHR,
    queueMicrotask,
  };
  const observer = enhancer.createBgmTransportObserver(pageRoot, { onMetadata() {} });
  observer.start();
  const xhr = new FakeXHR();
  xhr.open('GET', '/aweme/v1/web/tab/feed/');
  xhr.send();
  assert.equal(xhr.listeners.size, 1);
  assert.throws(() => xhr.open('GET', '/throws'), /open failed/);
  assert.equal(xhr.listeners.size, 0);
  xhr.send();
  assert.equal(xhr.listeners.size, 0);
});

test('installation failure restores an already installed transport wrapper', () => {
  const originalFetch = () => {};
  class FakeXHR { open() {} send() {} }
  const pageRoot = {
    location: { origin: 'https://www.douyin.com' },
    fetch: originalFetch,
    XMLHttpRequest: FakeXHR,
    queueMicrotask,
  };
  Object.defineProperty(FakeXHR.prototype, 'open', {
    configurable: true,
    value: FakeXHR.prototype.open,
    writable: false,
  });
  const observer = enhancer.createBgmTransportObserver(pageRoot, { onMetadata() {} });
  assert.equal(observer.start(), false);
  assert.equal(pageRoot.fetch, originalFetch);
  assert.equal(observer.stop(), false);
});

test('stop never overwrites wrappers installed later', () => {
  class FakeXHR { open() {} send() {} addEventListener() {} removeEventListener() {} }
  const pageRoot = {
    location: { origin: 'https://www.douyin.com' },
    fetch() {},
    XMLHttpRequest: FakeXHR,
    queueMicrotask,
  };
  const observer = enhancer.createBgmTransportObserver(pageRoot, { onMetadata() {} });
  observer.start();
  const laterFetch = () => {};
  const laterOpen = () => {};
  pageRoot.fetch = laterFetch;
  FakeXHR.prototype.open = laterOpen;
  observer.stop();
  assert.equal(pageRoot.fetch, laterFetch);
  assert.equal(FakeXHR.prototype.open, laterOpen);
});

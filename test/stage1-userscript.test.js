'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const stage1 = require('../douyin-web-enhancer.user.js');
const userscriptSource = fs.readFileSync(
  path.join(__dirname, '..', 'douyin-web-enhancer.user.js'),
  'utf8',
);

const createHarness = (initialValues = {}) => {
  const values = new Map(Object.entries(initialValues));
  const writes = [];
  const menus = new Map();
  const registrations = [];
  const reads = [];
  const controllerUpdates = [];
  const errors = [];
  const prompts = [];
  let nextMenuId = 1;

  const controller = {
    currentSettings: null,
    start(settings) {
      this.currentSettings = settings;
      controllerUpdates.push({ type: 'start', settings });
    },
    updateSettings(settings) {
      this.currentSettings = settings;
      controllerUpdates.push({ type: 'update', settings });
    },
    stop() {
      this.currentSettings = null;
      return true;
    },
    snapshot() {
      return this.currentSettings;
    },
  };

  const overrides = {
    createController: () => controller,
    getValue(key, defaultValue) {
      reads.push([key, defaultValue]);
      return values.has(key) ? values.get(key) : defaultValue;
    },
    setValue(key, value) {
      writes.push([key, value]);
      values.set(key, value);
    },
    registerMenu(label, callback, options) {
      const requestedId = options?.id;
      const id = requestedId ?? nextMenuId++;
      menus.set(id, { callback, label });
      registrations.push({ id, label, requestedId });
      return id;
    },
    promptUser(message, defaultValue) {
      prompts.push({ defaultValue, message });
      return null;
    },
    logger: { error: (...args) => errors.push(args) },
  };

  return {
    controller,
    controllerUpdates,
    errors,
    menus,
    overrides,
    prompts,
    reads,
    registrations,
    values,
    writes,
  };
};

test('normalizes NFKC, whitespace, case, empty entries, and duplicates', () => {
  assert.deepEqual(stage1.compileKeywords('ＡＢＣ | abc|  你\t好  ||😀|😀'), [
    'abc',
    '你 好',
    '😀',
  ]);
  assert.equal(stage1.matchesAnyKeyword('前缀 AbC 后缀', ['abc']), true);
  assert.equal(stage1.matchesAnyKeyword('不相关', ['abc']), false);
});

test('video and BGM evaluation only read their allowed fields', () => {
  const settings = {
    video: { enabled: true, compiledKeywords: ['命中'] },
    danmaku: { enabled: true, compiledKeywords: ['弹幕'] },
    bgm: { enabled: true, compiledKeywords: ['音乐'] },
  };

  assert.equal(
    stage1.evaluateVideoFields(
      { title: '允许', description: '命中', hashtags: ['话题'], author: '命中' },
      settings.video,
    ),
    true,
  );
  assert.equal(
    stage1.evaluateVideoFields(
      { title: '允许', description: '允许', hashtags: [], author: '命中' },
      settings.video,
    ),
    false,
  );
  assert.equal(
    stage1.evaluateBgmFields(
      {
        musicTitle: '允许',
        musicName: '音乐',
        relatedMusicTitle: '允许',
        author: '音乐',
      },
      settings.bgm,
    ),
    true,
  );
  assert.equal(
    stage1.evaluateBgmFields(
      {
        musicTitle: '允许',
        musicName: '允许',
        relatedMusicTitle: '允许',
        author: '音乐',
      },
      settings.bgm,
    ),
    false,
  );
  assert.equal(
    stage1.evaluateBgmFields(
      {
        musicTitle: '允许',
        musicName: '允许',
        relatedMusicTitle: '识别音乐',
      },
      settings.bgm,
    ),
    true,
  );
  assert.equal(stage1.matchesAnyKeyword('弹幕', settings.video.compiledKeywords), false);
  assert.equal(stage1.evaluateDanmakuText('一条弹幕', settings.danmaku), true);
  assert.equal(stage1.evaluateDanmakuText('音乐', settings.danmaku), false);
});

test('bootstrap reads exactly six independent storage keys and registers six menus', () => {
  const storage = stage1.STORAGE_KEYS;
  const harness = createHarness({
    [storage.video.enabled]: false,
    [storage.video.keywords]: '甲|甲|乙',
    [storage.danmaku.enabled]: true,
    [storage.danmaku.keywords]: '',
    [storage.bgm.enabled]: true,
    [storage.bgm.keywords]: '音乐',
  });

  const app = stage1.bootstrap(harness.overrides);
  assert.ok(app);
  assert.deepEqual(harness.reads, [
    [storage.video.enabled, true],
    [storage.video.keywords, ''],
    [storage.danmaku.enabled, true],
    [storage.danmaku.keywords, ''],
    [storage.bgm.enabled, true],
    [storage.bgm.keywords, ''],
  ]);
  assert.deepEqual(harness.controllerUpdates[0], {
    type: 'start',
    settings: {
      video: { enabled: false, keywords: '甲|甲|乙', compiledKeywords: ['甲', '乙'] },
      danmaku: { enabled: true, keywords: '', compiledKeywords: [] },
      bgm: { enabled: true, keywords: '音乐', compiledKeywords: ['音乐'] },
    },
  });
  assert.equal(harness.menus.size, 6);
  assert.deepEqual(
    [...harness.menus.values()].map(({ label }) => label),
    [
      '视频关键词屏蔽：已关闭（已保存 2 个词）',
      '编辑视频屏蔽词（2 个）',
      '弹幕关键词屏蔽：未配置',
      '编辑弹幕屏蔽词',
      'BGM 名称屏蔽：已开启（1 个词）',
      '编辑 BGM 屏蔽词（1 个）',
    ],
  );
  assert.equal([...harness.menus.values()].some(({ label }) => /甲|乙|音乐/u.test(label)), false);
});

test('unconfigured status opens its editor and saves only that category', () => {
  const harness = createHarness();
  let promptResult = 'ＡＢＣ | abc | 新  词';
  harness.overrides.promptUser = () => promptResult;
  stage1.bootstrap(harness.overrides);

  [...harness.menus.values()].find(({ label }) => label === '视频关键词屏蔽：未配置').callback();

  assert.deepEqual(harness.writes, [[stage1.STORAGE_KEYS.video.keywords, 'ＡＢＣ | abc | 新  词']]);
  assert.deepEqual(harness.controllerUpdates.at(-1).settings.video, {
    enabled: true,
    keywords: 'ＡＢＣ | abc | 新  词',
    compiledKeywords: ['abc', '新 词'],
  });
  assert.deepEqual(harness.controllerUpdates.at(-1).settings.danmaku.compiledKeywords, []);
  assert.equal([...harness.menus.values()].some(({ label }) => label === '视频关键词屏蔽：已开启（2 个词）'), true);

  promptResult = '';
  [...harness.menus.values()].find(({ label }) => label === '编辑视频屏蔽词（2 个）').callback();
  assert.equal([...harness.menus.values()].some(({ label }) => label === '视频关键词屏蔽：未配置'), true);
});

test('configured status toggles only its enabled key and reuses menu IDs', () => {
  const storage = stage1.STORAGE_KEYS;
  const harness = createHarness({
    [storage.bgm.enabled]: true,
    [storage.bgm.keywords]: '音乐',
  });
  stage1.bootstrap(harness.overrides);
  const initialIds = [...harness.menus.keys()];

  [...harness.menus.values()].find(({ label }) => label === 'BGM 名称屏蔽：已开启（1 个词）').callback();

  assert.deepEqual(harness.writes, [[storage.bgm.enabled, false]]);
  assert.deepEqual([...harness.menus.keys()], initialIds);
  assert.equal(harness.registrations.slice(-6).every(({ requestedId }) => requestedId != null), true);
  assert.equal([...harness.menus.values()].some(({ label }) => label === 'BGM 名称屏蔽：已关闭（已保存 1 个词）'), true);
});

test('menu refresh falls back to unregister and rebuild when ID updates are unsupported', () => {
  const storage = stage1.STORAGE_KEYS;
  const harness = createHarness({
    [storage.video.enabled]: true,
    [storage.video.keywords]: '关键词',
  });
  const baseRegisterMenu = harness.overrides.registerMenu;
  const unregistered = [];
  harness.overrides.registerMenu = (label, callback, options) => {
    if (options?.id != null) {
      throw new Error('menu ID updates unsupported');
    }
    return baseRegisterMenu(label, callback);
  };
  harness.overrides.unregisterMenu = (id) => {
    unregistered.push(id);
    harness.menus.delete(id);
  };
  stage1.bootstrap(harness.overrides);
  const statusMenu = [...harness.menus.values()].find(
    ({ label }) => label === '视频关键词屏蔽：已开启（1 个词）',
  );

  statusMenu.callback();

  assert.equal(unregistered.length, 6);
  assert.equal(harness.menus.size, 6);
  assert.equal(
    [...harness.menus.values()].some(
      ({ label }) => label === '视频关键词屏蔽：已关闭（已保存 1 个词）',
    ),
    true,
  );
  assert.equal(harness.errors.length, 0);
});

test('persistence failure keeps old runtime state and menu labels', () => {
  const storage = stage1.STORAGE_KEYS;
  const harness = createHarness({
    [storage.video.enabled]: true,
    [storage.video.keywords]: '旧词',
  });
  harness.overrides.setValue = () => {
    throw new Error('write failed');
  };
  harness.overrides.promptUser = () => '新词';
  stage1.bootstrap(harness.overrides);
  const updatesBefore = harness.controllerUpdates.length;

  [...harness.menus.values()].find(({ label }) => label === '编辑视频屏蔽词（1 个）').callback();

  assert.equal(harness.controllerUpdates.length, updatesBefore);
  assert.equal([...harness.menus.values()].some(({ label }) => label === '视频关键词屏蔽：已开启（1 个词）'), true);
  assert.equal(harness.errors.length, 1);
});

test('runtime update failure cannot roll the menu back after storage committed', () => {
  const storage = stage1.STORAGE_KEYS;
  const harness = createHarness({
    [storage.video.enabled]: true,
    [storage.video.keywords]: '旧词',
  });
  harness.controller.updateSettings = () => {
    throw new Error('runtime failed');
  };
  harness.overrides.promptUser = () => '新词|第二词';
  stage1.bootstrap(harness.overrides);

  [...harness.menus.values()].find(({ label }) => label === '编辑视频屏蔽词（1 个）').callback();

  assert.deepEqual(harness.writes, [[storage.video.keywords, '新词|第二词']]);
  assert.equal([...harness.menus.values()].some(({ label }) => label === '视频关键词屏蔽：已开启（2 个词）'), true);
  assert.equal(harness.errors.length, 1);
});

test('Stage 1 controller is inert and stores only settings snapshots', () => {
  const controller = stage1.createStage1Controller();
  assert.equal(controller.start({ video: { enabled: true } }), true);
  assert.equal(controller.start({}), false);
  assert.equal(controller.updateSettings({ bgm: { enabled: false } }), true);
  assert.deepEqual(controller.snapshot(), { bgm: { enabled: false } });
  assert.equal(controller.stop(), true);
  assert.equal(controller.stop(), false);
});

test('metadata grants only local storage and menu capabilities', () => {
  assert.match(userscriptSource, /@version\s+1\.0\.0/u);
  assert.match(userscriptSource, /@match\s+https:\/\/www\.douyin\.com\/\*/u);
  assert.match(userscriptSource, /@run-at\s+document-start/u);
  assert.match(userscriptSource, /@sandbox\s+raw/u);
  assert.match(userscriptSource, /@grant\s+GM_getValue/u);
  assert.match(userscriptSource, /@grant\s+GM_setValue/u);
  assert.match(userscriptSource, /@grant\s+GM_registerMenuCommand/u);
  assert.match(userscriptSource, /@grant\s+GM_unregisterMenuCommand/u);
  assert.match(userscriptSource, /@noframes/u);
  assert.doesNotMatch(userscriptSource, /@grant\s+GM_xmlhttpRequest/u);
  assert.doesNotMatch(userscriptSource, /@grant\s+window\.onurlchange/u);
  assert.doesNotMatch(userscriptSource, /@connect\b/u);
});

test('Stage 4 observes page transport without adding requests or media writes', () => {
  assert.match(userscriptSource, /\bMutationObserver\b/u);
  assert.match(userscriptSource, /\bXMLHttpRequest\b/u);
  assert.doesNotMatch(userscriptSource, /\bfetch\s*\(/u);
  assert.doesNotMatch(userscriptSource, /\b(?:pause|play)\s*\(/u);
  assert.doesNotMatch(userscriptSource, /\.muted\s*=/u);
  assert.doesNotMatch(userscriptSource, /\bGM_xmlhttpRequest\b/u);
});

test('browser bootstrap stays inert when GM configuration APIs are unavailable', () => {
  const errors = [];
  const result = stage1.bootstrap({
    root: { console: { error: (...args) => errors.push(args) } },
  });

  assert.equal(result, null);
  assert.equal(errors.length, 1);
});

test('cancelled editor does not persist or update runtime settings', () => {
  const harness = createHarness();
  stage1.bootstrap(harness.overrides);
  const updateCount = harness.controllerUpdates.length;

  [...harness.menus.values()].find(({ label }) => label === '编辑视频屏蔽词').callback();

  assert.deepEqual(harness.writes, []);
  assert.equal(harness.controllerUpdates.length, updateCount);
});

test('stop releases all registered menus without touching page state', () => {
  const harness = createHarness();
  const unregistered = [];
  harness.overrides.unregisterMenu = (id) => unregistered.push(id);
  const app = stage1.bootstrap(harness.overrides);

  app.stop();

  assert.deepEqual(unregistered, [...harness.menus.keys()]);
  assert.equal(harness.controller.snapshot(), null);
});

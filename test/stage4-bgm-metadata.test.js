'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const enhancer = require('../douyin-web-enhancer.user.js');

test('parses anonymized QuickPlayer source without executing page code', () => {
  const source = String.raw`window.x=createQuickPlayer({awemeInfo:{articleInfo:{music:{title:"嵌套字段不能抢占"}},awemeId:"1111111111111111111",relatedMusicAnchor:{extra:"{\"title\":\"识别歌曲\",\"author\":\"不保留\"}"},music:{cover:{urlList:["private"]},title:"括号 ) } \"音乐\"",musicName:"\u522b\u540d"}},callback:function(){throw new Error("must not run")}});`;
  assert.deepEqual(enhancer.extractQuickPlayerBgmMetadata(source), [{
    awemeId: '1111111111111111111',
    musicTitle: '括号 ) } "音乐"',
    musicName: '别名',
    relatedMusicTitle: '识别歌曲',
  }]);
  assert.deepEqual(enhancer.extractQuickPlayerBgmMetadata('createQuickPlayer({broken:'), []);
});

test('extracts only ID and music names from verified camel and snake shapes', () => {
  const payload = {
    items: [
      {
        aweme_id: '1111111111111111111',
        desc: 'private description',
        author: { nickname: 'private author' },
        video: { play_addr: { url_list: ['https://private.invalid/'] } },
        music: { title: '第一首', music_name: '别名' },
        related_music_anchor: {
          extra: JSON.stringify({
            title: '识别歌曲一',
            author: '不保留',
            medium_cover_urls: ['https://private.invalid/'],
          }),
        },
      },
      {
        awemeId: '2222222222222222222',
        music: { title: '第二首', musicName: '另一个名字' },
      },
    ],
  };

  assert.deepEqual(enhancer.extractBgmMetadata(payload).items, [
    {
      awemeId: '1111111111111111111',
      musicTitle: '第一首',
      musicName: '别名',
      relatedMusicTitle: '识别歌曲一',
    },
    {
      awemeId: '2222222222222222222',
      musicTitle: '第二首',
      musicName: '另一个名字',
      relatedMusicTitle: '',
    },
  ]);
});

test('rejects missing, conflicting and invalid IDs without inference', () => {
  const result = enhancer.extractBgmMetadata({
    items: [
      { desc: 'unique description', music: { title: '不能关联' } },
      { aweme_id: 'short', music: { title: '无效 ID' } },
      {
        aweme_id: '1111111111111111111',
        gid: '2222222222222222222',
        music: { title: '冲突 ID' },
      },
      {
        aweme_id: '3333333333333333333',
        gid: 'short',
        music: { title: '部分无效也冲突' },
      },
      {
        aweme_id: 4444444444444444444,
        music: { title: '数字 ID 会丢精度' },
      },
    ],
  });

  assert.deepEqual(result.items, []);
});

test('bounded extraction stops at the node limit', () => {
  const payload = { nested: Array.from({ length: 20 }, (_, index) => ({
    aweme_id: String(10_000_000_000 + index),
    music: { title: `音乐${index}` },
  })) };
  const result = enhancer.extractBgmMetadata(payload, { maxNodes: 5 });
  assert.equal(result.truncated, true);
  assert.ok(result.scanned <= 5);
});

test('bounded extraction stops at the elapsed-time limit', () => {
  const payload = { nested: Array.from({ length: 20 }, (_, index) => ({
    aweme_id: String(10_000_000_000 + index),
    music: { title: `音乐${index}` },
  })) };
  let nowMs = 0;
  const result = enhancer.extractBgmMetadata(payload, {
    maxNodes: 100,
    maxElapsedMs: 3,
    now: () => nowMs++,
  });

  assert.equal(result.timedOut, true);
  assert.ok(result.scanned < 20);
});

test('one high-fanout node cannot bypass the node budget while enqueuing children', () => {
  let childReads = 0;
  const items = new Proxy(
    Array.from({ length: 10_000 }, (_, index) => ({
      aweme_id: String(10_000_000_000 + index),
      music: { title: `音乐${index}` },
    })),
    {
      get(target, property, receiver) {
        if (/^\d+$/u.test(String(property))) childReads += 1;
        return Reflect.get(target, property, receiver);
      },
    },
  );
  const payload = { items };
  const result = enhancer.extractBgmMetadata(payload, {
    maxNodes: 5,
    maxElapsedMs: 100,
    now: () => 0,
  });

  assert.equal(result.truncated, true);
  assert.ok(childReads <= 5, `read ${childReads} children despite a 5-node budget`);
});

test('cache associates only exact IDs and rejects inconsistent metadata', () => {
  const cache = enhancer.createBgmMetadataCache(2);
  cache.ingest([
    {
      awemeId: '1111111111111111111',
      musicTitle: '音乐一',
      musicName: '',
      relatedMusicTitle: '',
    },
    {
      awemeId: '2222222222222222222',
      musicTitle: '音乐二',
      musicName: '',
      relatedMusicTitle: '',
    },
  ]);
  assert.deepEqual(cache.get('1111111111111111111'), {
    awemeId: '1111111111111111111',
    musicTitle: '音乐一',
    musicName: '',
    relatedMusicTitle: '',
  });
  assert.equal(cache.get('3333333333333333333'), null);

  cache.ingest([{
    awemeId: '1111111111111111111',
    musicTitle: '',
    musicName: '',
    relatedMusicTitle: '识别音乐一',
  }]);
  assert.equal(
    cache.get('1111111111111111111').relatedMusicTitle,
    '识别音乐一',
  );

  cache.ingest([
    { awemeId: '1111111111111111111', musicTitle: '不一致', musicName: '' },
  ]);
  assert.equal(cache.get('1111111111111111111'), null);

  cache.ingest([
    { awemeId: '3333333333333333333', musicTitle: '音乐三', musicName: '' },
  ]);
  assert.ok(cache.size <= 2);
  cache.clear();
  assert.equal(cache.size, 0);
});

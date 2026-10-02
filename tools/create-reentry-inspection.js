'use strict';

const enhancer = require('../douyin-web-enhancer.user.js');

// 从运行时权威函数生成一次性 Console 检查，避免另维护一份 React 发现算法。
function createInspectionSource({ watch = false } = {}) {
  const discoverySource = enhancer.discoverNativeNavigation.toString();
  return `(() => {
  'use strict';
  function own(object, key) {
    if (!object || !['object', 'function'].includes(typeof object)) return undefined;
    return Object.getOwnPropertyDescriptor(object, key)?.value;
  }
  const discover = ${discoverySource};
  function inspect(
    roots = Array.from(document.querySelectorAll(${JSON.stringify(enhancer.PAGE_SELECTORS.feedRoot)})),
    cards = Array.from(document.querySelectorAll(${JSON.stringify(enhancer.PAGE_SELECTORS.activeCard)})),
  ) {
    const report = { probe: 'reentry-inspection', roots: roots.length, activeCards: cards.length };
    if (roots.length === 1 && cards.length === 1 && roots[0].contains(cards[0])) {
      const state = cards[0].getAttribute(${JSON.stringify(enhancer.VIDEO_STATE_ATTRIBUTE)});
      report.state = ['pending', 'allow', 'block', 'bypass', 'navigating'].includes(state) ? state : null;
      report.discovery = discover(cards[0], roots[0]);
    }
    return report;
  }
  ${watch ? `const startedAt = performance.now();
  const roots = document.querySelectorAll(${JSON.stringify(enhancer.PAGE_SELECTORS.feedRoot)});
  const feed = roots.length === 1 ? roots[0] : null;
  let rootsCheckedAt = startedAt;
  let cards = [];
  let cardsDirty = true;
  let sampleTimer = null;
  let stopTimer = null;
  let stopped = false;
  let previous = '';
  let count = 0;
  function stop(reason) {
    if (stopped) return;
    stopped = true;
    clearTimeout(sampleTimer);
    clearTimeout(stopTimer);
    observer.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    console.info('[DWE reentry watch] ' + JSON.stringify({ stopped: reason }));
  }
  function sample() {
    if (stopped) return;
    try {
      if (document.visibilityState === 'hidden') return stop('document-hidden');
      if (!feed || !feed.isConnected || !feed.matches(${JSON.stringify(enhancer.PAGE_SELECTORS.feedRoot)})) {
        return stop('root-changed');
      }
      // React current 可无 DOM 变化地轮换；保持短周期采样，根唯一性另按秒复核。
      if (performance.now() - rootsCheckedAt >= 1000) {
        const currentRoots = document.querySelectorAll(${JSON.stringify(enhancer.PAGE_SELECTORS.feedRoot)});
        if (currentRoots.length !== 1 || currentRoots[0] !== feed) return stop('root-changed');
        rootsCheckedAt = performance.now();
      }
      if (cardsDirty) {
        cards = Array.from(feed.querySelectorAll(${JSON.stringify(enhancer.PAGE_SELECTORS.activeCard)}));
        cardsDirty = false;
      }
      const report = inspect([feed], cards);
      const signature = JSON.stringify(report);
      if (signature === previous) return;
      previous = signature;
      console.info('[DWE reentry watch] ' + JSON.stringify({ atMs: Math.round(performance.now() - startedAt), ...report }));
      if (++count >= 100) stop('report-limit');
    } catch {
      stop('inspection-error');
    }
  }
  function poll() {
    sampleTimer = null;
    sample();
    if (!stopped) sampleTimer = setTimeout(poll, 25);
  }
  function onVisibility() {
    if (document.visibilityState === 'hidden') stop('document-hidden');
  }
  function onMutations(records) {
    if (stopped || cardsDirty) return;
    try {
      for (const record of records) {
        if (record.type === 'attributes' && ['data-e2e', 'data-e2e-vid'].includes(record.attributeName) &&
          (cards.includes(record.target) || record.target.matches(${JSON.stringify(enhancer.PAGE_SELECTORS.activeCard)}))) {
          cardsDirty = true;
          return;
        }
        if (record.type !== 'childList') continue;
        for (const nodes of [record.addedNodes, record.removedNodes]) {
          for (const node of nodes) {
            if (node.nodeType === 1 && (cards.some(card => node.contains(card)) ||
              node.matches(${JSON.stringify(enhancer.PAGE_SELECTORS.activeCard)}) ||
              node.querySelector(${JSON.stringify(enhancer.PAGE_SELECTORS.activeCard)}))) {
              cardsDirty = true;
              return;
            }
          }
        }
      }
    } catch {
      stop('inspection-error');
    }
  }
  const observer = new MutationObserver(onMutations);
  if (feed) observer.observe(feed, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['data-e2e', 'data-e2e-vid', ${JSON.stringify(enhancer.VIDEO_STATE_ATTRIBUTE)}] });
  document.addEventListener('visibilitychange', onVisibility);
  stopTimer = setTimeout(() => stop('completed'), 120000);
  poll();` : `console.info('[DWE reentry inspection] ' + JSON.stringify(inspect()));`}
})();
`;
}

if (require.main === module) {
  const fs = require('node:fs');
  const path = require('node:path');
  const outputDirectory = path.resolve(__dirname, '../work');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const watch = process.argv.includes('--watch');
  const outputPath = path.join(outputDirectory, watch ? 'reentry-navigation-watch.js' : 'reentry-navigation-inspect.js');
  fs.writeFileSync(outputPath, createInspectionSource({ watch }), 'utf8');
  console.info(outputPath);
}

module.exports = { createInspectionSource };

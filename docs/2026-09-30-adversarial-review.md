# 2026-09-30 独立对抗性审查

## 结论

> 后续状态：2026-09-30 已完成第二轮工作树修复，七项发现均采纳并补正式回归；全套 254/254 通过，随后取得部分 Chrome + Tampermonkey 定向实页证据，覆盖范围和未闭环项见[当前工作树实页验收](2026-09-30-real-page-acceptance.md)。详细修复映射见 Stage 5 报告的“独立对抗性 review 后的第二轮修复”。下文保留审查时的源码快照、行号、失败行为和临时复现，不代表修复后的代码仍有这些已记录故障。

当前工作树不宜据 235 项 Node 测试通过认定导航修复完成。本次确认 7 项问题：Standards 轴 3 项，Spec 轴 4 项。最高优先级分别为 P1 的语义控件异步上下文缺失和 P1 的等待取消后反向导航。另有两项已存在于固定基线的交叉路径问题，明确标记，不归因于本次修改。

下面的临时脚本断言的是**当前确实出现错误行为**。这些脚本退出 0 表示反例成功复现，不是正确行为的验收通过。所有新增反例均为 Node 模拟证据；没有安装或执行浏览器探针，没有取得当前工作树的实页验收。

## 范围与固定快照

- 仓库分支：`master`；HEAD：`e3830ed`。
- 固定基线：`599f9df`，正式 `0.0.3`。
- 正式版：`e3830ed`，`0.0.4`。
- 当前未提交工作树：审查开始时已有 README、Stage 5、发布说明、主 Userscript 和三份测试文件修改；本审查未改变这些文件。
- 分别读取 `git diff 599f9df...e3830ed`、`git diff e3830ed`、`git diff 599f9df`。代码范围包括主 Userscript、两个新增导航探针、新增/更新的测试和两份键盘导航 JSON fixture。
- 规范来源：`AGENTS.md`、`docs/2026-08-13-douyin-userscript-design.md`、README、导航调查、Stage 5 和发布说明。仓库不存在 `CONTEXT.md`。按照独立审查要求，没有再委派 reviewer。

审查开始和结束核对的 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `douyin-web-enhancer.user.js` | `950F57A08BEB3B1E69A123CE45686288999912CCA99111D7C4073D7705ED5440` |
| `tools/keyboard-navigation-probe.user.js` | `286B22E8CC4C3A2DD679327EB03BA21DA1FD8A6573E10DDAABE4F6BAD31BE613` |
| `tools/native-navigation-probe.user.js` | `7D3BA31C7B7DB862CE225E2C9E78C63F8ADE68783D398D0930D675AD47E42F0D` |

## Standards

### A1 — P1：语义控件的延后派发没有复核路由和唯一 Feed 根

位置：`douyin-web-enhancer.user.js:1907`、`:1940`、`:1963`、`:2053`。

规则：AGENTS 的推荐流支持边界、失败放行和“所有异步入口在产生副作用前必须重新校验 generation、epoch 和 retired 状态”；README 开发说明也承诺“路由或实例不符时放行”。generation/epoch 的检查只证明旧控制器尚未收到失效通知，不能代替当前路由与根的现场核对。

触发：语义控件可用，可信方向输入进入一张随后才命中的卡，当前修复建立 500ms 等待；等待期间 SPA 通过 `pushState` 离开推荐页，750ms 健康检查或 Observer 尚未退休旧根。旧根仍连接且保留活动标记。

结果：500ms 回调重新进入 `requestNavigation`，可以点击当前文档中的控件，越过推荐流边界。对原生路径的唯一根/路由复核位于 `controls` 不可用的分支，语义控件可用时完全绕过；这也是为什么本次新增的交互守卫没有阻断反例。

当前 Node 输出：

```text
route-changed-before-semantic-wait: {"clicks":1,"state":"navigating","href":"https://www.douyin.com/follow"}
```

最小修改：把支持路由、当前唯一活动 Feed 根、活动卡身份和交互状态的复核移到两条派发路径共享的位置，等待、重试与沉降回调必须使用这套复核；不要依赖下一个健康检查。根变更但旧根未断开的情形同样需要覆盖。

引入归属：缺少共同路由守卫早已存在；本反例的“控件可用仍创建 500ms 延后派发”窗口由**本次修复**新增。版本矩阵中基线/正式版进入时已点击（`before=1, after=1`），当前工作树为等待前 `0`、离开路由后 `1`。不把这个矩阵错误表述成旧版同样发生了本反例。

### A2 — P2：动画就绪在绝对期限之后才被观察到，仍会派发

位置：`douyin-web-enhancer.user.js:1978`—`:1994`。

规则：AGENTS 要求失败放行和迟到回调隔离；Stage 5 的当前动画边界明确写为 2500ms 放行、迟到就绪不再派发。

触发：第一次看到 `animating=true` 后建立 `nativeReadyDeadline`；前台事件循环迟延，50ms 回调直到 3000ms 才执行，此时状态已变为 `false`。

结果：期限比较只在 `animating === true` 的分支内。迟到回调看到 `false` 后绕过期限检查，继续调用 `isDisabled`、再次发现实例并 `emit`。当前修复没有改动这个分支。

```text
animation-ready-only-after-deadline: {"calls":["changeNext"],"state":"navigating"}
```

最小修改：只要已经建立动画绝对期限，在任何就绪派发前都核对它；过期则终局 bypass。增加“回调执行时已经过期且此时刚看到 false”的测试，不能只测试回调按计划反复看到 true。

引入归属：**0.0.4** 的原生等待路径。版本矩阵中正式版和当前均复现；基线没有该原生入口，输出 bypass。

### A3 — P2：主动原生导航探针没有重新验证动画状态

位置：`tools/native-navigation-probe.user.js:324`、`:325`、`:337`、`:347`。

规则：探针必须在不安全上下文中停止，不影响页面原行为；导航调查明确要求调用站点状态方法后重新验证，动画锁释放后才测试导航。

触发：`next` / `trace-next` / `series-next` 模式首次看到动画为 false，但调用站点 `isDisabled()` 时其更新动画为 true 并返回 false。

结果：第二次 `discover` 仍将同一实例作为 candidate，因为 discovery 的结果允许 `animating=true`；探针只比较实例是否相同，没有重新检查动画，继续 `emit`。产品路径有对应的复核，不能用产品测试替代探针测试。

```text
probe-animation-mutates-in-disabled: {"calls":1,"animating":true}
```

最小修改：在最后一次派发前重新验证 `touchData.animating === false`，连同身份、路由、根和交互状态一并检查；探针自身需要此反例。未知或变化状态应停止，不使用额外派发验证。

引入归属：**0.0.4** 中新增的 native 探针；当前未修改该探针。这是显式诊断模式问题，不是普通推荐地址会自行执行。

## Spec

### B1 — P1：取消等待时丢掉新的可信进入方向，下一张命中卡立即向下导航

位置：`douyin-web-enhancer.user.js:2147`—`:2152`、`:2366`—`:2371`。

契约：Stage 5 的方向说明要求可信输入绑定 source、target 和方向；目标不符时放行，新人工输入优先，向上进入不能转为向下。

触发：从允许卡向上进入命中卡 B，B 正在等待 500ms、动画或队列；用户再次向上输入，平台实际进入 B 上方的命中卡 U。

结果：最前面的等待取消分支先把 B bypass，然后立即 return，未记录这次可信向上输入。U 激活时既无 observed intent，上一 epoch 也不再 navigating，于是采用默认 down；U 甚至没有新的 500ms 等待，立刻 `changeNext`，把用户拉回原方向。当前修复针对 navigating 的接管逻辑位于早退之后，因此无法覆盖 block 等待状态。

```text
cancel-wait-then-upward-entry: {"calls":[["u","changeNext"]],"state":"navigating"}
```

最小修改：取消旧等待与记录新可信方向应在同一输入处理链中完成；有效方向输入不能被 cancellation 的 return 丢弃。新卡只使用准确目标的进入意图；无法绑定时 bypass。

引入归属：**0.0.4** 的 block 等待早退逻辑。正式版和当前均复现；基线没有原生导航。

### B2 — P2：预判沉降期间人工反向输入没有取消旧导航

位置：`douyin-web-enhancer.user.js:2147`、`:2164`、`:2284`—`:2307`。

契约：人工输入优先，等待失效时放行；用户方向不得被脚本的旧方向覆盖。

触发：语义控件的预判流程先把允许卡切到命中卡，命中卡正在 350ms fallback 或 transitionend 沉降；用户在此期间反向输入，而平台因节流暂未切换活动身份。

结果：epoch 仍为 block，但没有 `nativeReadyDeadline/nativeQueueDeadline/entryReadyAt`，故等待取消条件不成立；当前新增接管只处理 navigating。旧 `predictiveNavigation.direction` 留存，沉降回调仍按旧方向点击。复现先输入 Down、再输入 Up，最终向下点击两次、向上零次。

```text
reverse-during-predictive-settle: {"downClicks":2,"upClicks":0,"state":"allow"}
```

最小修改：把预判沉降纳入人工接管的等待状态，取消它的 timer/listener 并使当前命中卡放行或建立新输入事务。沉降回调使用它所属的 intent 身份，不读取可能被替换的全局 intent。

引入归属：**已存在于固定基线 599f9df**，正式版和当前均延续。当前修复尚未覆盖；不列为本次新增退化。

### B3 — P2：已知目的卡不符时只停止计数，仍继续跳过意外命中卡

位置：`douyin-web-enhancer.user.js:2366`—`:2376`、`:2407`。

契约：Stage 5 的进入方向说明明确要求目的不符或相邻身份不可验证时放行；继承方向应来自已确认导航。

触发：脚本已向已知相邻目标派发导航，实际激活另一张命中卡，且没有新可信输入证明其进入方向。

结果：`inheritedDirection` 只检查上一 epoch navigating 和 ID 改变，先继承方向；随后 `navigationConfirmed` 因目标不同变成 false，但该判断仅用于计数。意外目的卡仍按继承方向创建 epoch 并继续点击。这条路径同时绕过应有的“不明确方向则放行”。当前“偏离已知目标不计数”的修复只完成了计数半边。

```text
unexpected-blocked-destination: {"clicks":2,"skipCount":0,"state":"navigating"}
```

最小修改：在计算进入方向前确定上一派发是否确实到达对应目标；不符且没有准确的新意图时，entryDirection 应为 unknown 并 bypass。回归目标必须是命中卡，现有 `unexpected destination` 用例选择允许卡，只能验证不计数。

引入归属：**基线已有意外命中卡继续导航**；0.0.4 添加了方向继承，本次修复添加目标计数守卫，但未处理行为。矩阵中的三版点击均为 2；旧版 skipCount=1，当前为 0。

### B4 — P2：原生目标取自 DOM 顺序，正确原生跳过可以完全绕过熔断

位置：`douyin-web-enhancer.user.js:2016`、`:2044`—`:2047`、`:2374`—`:2376`；相关测试 seam：`test/stage2-video-controller.test.js:1247`—`:1260`。

契约：15 秒内确认跳过 12 条后停止继续自动跳过；原生导航已经取得并验证了当前实例和队列索引。

触发条件：原生队列的 `data[activeIndex + direction]` 是实际目的视频 C，但虚拟列表 DOM 的相邻标准卡仍是其他 ID（例如渲染尚未跟上队列）。源卡和原生当前行身份都准确，emit 正常按队列切换到 C。

结果：目标存在检查来自原生队列，`navigationTargetId` 却来自 DOM 顺序。正确切到 C 被当作“偏离目标”而漏计，随后仍继续处理命中卡。独立反例将每次实际切换绑定到经过读取的队列行，连续 14 次派发后 skipCount 仍为 0，熔断未触发。

```text
native-queue-target-differs-dom-order: {"calls":["changeNext"],"skipCount":0,"state":"allow"}
native-dom-target-fuse-bypass: {"calls":14,"skipCount":0,"fuseTripped":false,"state":"allow"}
```

最小修改：原生路径记录最后一次验证的队列目标身份，语义控件路径才使用其可验证目标；身份无法确定的情况应有保守导航/熔断策略，不能任由不计数的连续派发。补充原生 fixture：队列目的 ID 与 `onEmit` 激活的真实目标必须一致，不应让固定 `999...` 队列行通过任意切卡 callback 宣称确认正确。

引入归属：**本次修复**新增的 `navigationTargetId` 与确认守卫造成原生漏计；正式版对任意 ID 变化计数，因此没有这一漏计形式。

证据边界：Node 确认代码在“队列与 DOM 顺序不同”输入下会漏计并越过 12 次限制；本轮未取得实际页面出现该失配的频率证据，不声称正常实页必然复现。B3 与 B4 关联于确认守卫，但分别是继续导航和错误目标来源，修复一个不会自动修复另一个。

## 已排除、已修复和尚未确认的风险

- 当前源码已删除 `@updateURL/@downloadURL`，当前元数据满足仓库禁止手工更新字段的规则。正式 e3830ed 仍包含它们，历史违规记录不能改写成当时合规；本次删除及对应测试方向正确。
- 没有新增 `GM_xmlhttpRequest`、`@connect`、网络请求、Cookie/Local Storage 读取或媒体写入。bootstrap 仍持有 GM 读写；控制器通过设置快照工作。无需因单文件长度判为模块化违规。
- 当前焦点/模态框守卫确实覆盖预判输入和共享 `requestNavigation`；它不解决 A1 的路由和根，也不解决 B1/B2 的状态交叉。
- `own` 对普通自有 getter 不求值；独立 probe 反例 `getter-risk-refuted` 输出 getter reads=0、candidate-count-mismatch。没有把 descriptor 读取误写成 getter 执行。
- probe wrapper 保留 `this`、参数、返回 Promise 的身份；停止恢复原 descriptor，并保留后来写入的方法。独立断言输出 `calls=1, restore=restored, laterOwner=later-owner-preserved`。
- 手动记录模式实际以 `observeProduct(root, false, true)` 启动，不走 paired 的人工输入取消监听。独立可信按键后仍记录 `prevEmits=1, cleanup=restored`；“手动按键会立即取消测量”的初步风险被证伪。
- 预判沉降、导航确认和 native 轮询的停用/根退役回调会核对 epoch；根替换的 generation 递增与退休顺序仍正确。这不代替 A1 的实时根唯一性检查。
- 新增 fuseSignature 使用原始配置文本，等价文本编辑解除熔断、完全相同的 focus 同步不解除，符合当前修复说明。未发现需要为代码味道增加抽象的理由。
- 两份新增 JSON fixture 仅含匿名形状、计数、播放状态和历史采样；已阅读内容并扫描 token/账号/路径/URL，没有发现泄漏。早期键盘 ID 变化样本的自然连播混淆已由 fixture 的 limits 明确限制；后续 fixture 使用墙钟余量，未将历史采样作为当前产品通过。
- keyboard 探针普通 URL 惰性、一次性启用参数消费、界面/后台/路由取消、完整键盘序列、等待稳定播放和媒体倍速余量路径均已检查；未确认新的实质问题。native 探针的包装恢复、日志脱敏、bounded Fiber/alternate 查找、三连测不重试和 product/manual/pair 生命周期均已检查；其新增确认问题为 A3。

## 测试与证据文件

审查机器 Node：`v24.14.1`。

执行结果：

| 检查 | 结果 |
| --- | --- |
| `node --check .\douyin-web-enhancer.user.js` | 通过 |
| 两个 tools 的 `node --check` | 通过 |
| `git diff --check` | 通过；Git 提示后续可能 LF→CRLF，没有空白错误 |
| `node --test` | 失败：10 个测试文件均因 `spawn EPERM` 未运行，不是断言失败 |
| `node --test --test-isolation=none` | 235 tests、235 pass、0 fail |
| 当前对抗性复现 | 7 条主脚本错误行为成功复现；probe 另有 1 条错误行为和 3 组风险证伪 |
| 三版本矩阵 | 5 个路径逐版对照，归属见上文 |

系统临时目录中保留以下文件，没有删除。文档使用 `$env:TEMP` 避免把本机身份路径写入仓库。

```powershell
node "$env:TEMP\dwe-review-20260930\adversarial-repros.cjs"
node "$env:TEMP\dwe-review-20260930\version-matrix.cjs"
node "$env:TEMP\dwe-review-20260930\probe-boundaries.cjs"
```

- `adversarial-repros.cjs`：主脚本 7 条反例，断言现存错误行为。它读取现有测试文件并仅复制 fixture 辅助函数到独立 VM；不运行现有测试主体，也不修改正式测试。
- `version-matrix.cjs`：逐版实际执行 5 个反例，使用 `baseline-599f9df.cjs`、`release-e3830ed.cjs` 两份保留的 `git show` 临时源副本及当前工作树源文件。
- `probe-boundaries.cjs`：A3 反例及普通 getter、手动输入模式、wrapper 原调用/恢复/后来者边界的独立断言。
- `node-tests.log`：本轮当前 235 项单进程套件输出。

版本矩阵关键输出：

```text
baseline predictive-reverse: {"downClicks":2,"upClicks":0} | route-wait: {"before":1,"after":1} | wait-next-entry: {"calls":[]} | animation-late: {"calls":[],"state":"bypass"} | unexpected-block: {"clicks":2,"skipCount":1}
release predictive-reverse: {"downClicks":2,"upClicks":0} | route-wait: {"before":1,"after":1} | wait-next-entry: {"calls":[["u","changeNext"]]} | animation-late: {"calls":["changeNext"],"state":"navigating"} | unexpected-block: {"clicks":2,"skipCount":1}
current predictive-reverse: {"downClicks":2,"upClicks":0} | route-wait: {"before":0,"after":1} | wait-next-entry: {"calls":[["u","changeNext"]]} | animation-late: {"calls":["changeNext"],"state":"navigating"} | unexpected-block: {"clicks":2,"skipCount":0}
```

证据分层：

1. 静态源码：两个固定差异和当前综合差异、调用链、规范、测试/fixture 全部纳入范围。
2. 本轮 Node：语法、235 项现有套件、保留的独立反例与版本矩阵；只证明模拟输入下的行为。
3. 历史实页：文档中 `0.0.12-test` 等 Chrome 导航证据按其原版本保留，本轮没有复做，也不替代当前修复。
4. 用户手工：历史日常“没遇到过”等反馈只按原文作为观察记录，不作为上述边界通过。
5. 当前缺口：当前工作树 Tampermonkey 的方向、沉降、500ms、animation deadline、模态/焦点、队列/DOM目标及熔断；Edge 和其他浏览器；网络/性能 trace、根异常替换、后台、音频与逐帧测量。浏览器安全策略已阻止扩展管理入口，本轮没有采用其他办法绕过安装限制。

本审查正式树唯一新增文件为本报告；主源码、测试、tools、规则均未修改，未 commit/push。

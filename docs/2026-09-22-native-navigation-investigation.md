# 原生导航入口调查

## 结论与边界

当前推荐页公开 JS 存在可复用的导航对象和业务回调，油猴方案仍值得验证，暂不需要改成
通过 debugger 发送按键的扩展。本轮只读分析当前浏览器实际加载的公开静态资源；未调用
页面内部方法，未安装新探针，未改正式脚本，也未证明运行时实例可取得或切换已修复。

## 当前资源中的调用关系

2026-09-22 Chrome 推荐页资源清单中包含以下分包；文件下载至系统临时目录后仅作文本检索，未执行。

1. [推荐页与卡片业务](https://lf-douyin-pc-web.douyinstatic.com/obj/douyin-pc-web/ies/douyin_web/async/routes-route.7b50f221.js)
   - 推荐列表向卡片传递 swiper、playNextFunc、playPrevFunc 与 isActive。
   - 活动卡片订阅 swiper 的 changeNext/changePrev 事件，并进入 changeNextVideo/changePrevVideo。
   - 外层推荐翻页回调最终调用 slideNext；业务回调还包含边界和状态处理，因此不应只为
     省事就绕过整条链直接调用最底层方法。
   - 文件中一处方向键处理采用 500ms 的 leading 节流，随后发出 changeNext 事件；存在
     弹层和快捷键禁用条件。该文件包含多种场景，尚未动态证明用户当前页面走哪一分支。
2. [自定义轮播组件](https://lf-douyin-pc-web.douyinstatic.com/obj/douyin-pc-web/ies/douyin_web/async/96205.051d961a.js)
   - dySwiperStatusRef 保存导航对象，经 useImperativeHandle 暴露给父组件 ref。
   - 对象提供 el、activeIndex、on/off/emit、slideNext/slidePrev、isDisabled 和 touchData。
   - slideNext 先检查禁用状态及前台动画锁，再按当前索引和数据边界进入 slideTo。
   - 此处没有发现固定 8 秒等待；不能据此排除其他上层条件，也不能宣布整体不存在延迟。
3. [另一按键处理分包](https://lf-douyin-pc-web.douyinstatic.com/obj/douyin-pc-web/ies/douyin_web/async/13343.f682b6ff.js)
   - 监听 document keydown，通过 keyCode 区分上下方向，再发出 changeNext/changePrev。
   - 检查 nativeEvent、可编辑状态和其他短路条件；nativeEvent 不能误读为 isTrusted。
   - 本次查看的这些处理片段未见直接拒绝 isTrusted=false 的判断，不构成全站不存在该判断的证明。

SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| routes-route.7b50f221.js | F4EE3FFF89D4051E19B7700E0333650EB4FCC48B63760063D31520E849D9CE18 |
| 96205.051d961a.js | 265967B7D64E73060CB1FC02A93AA8244DEBC3D259C724F0CF0F7E48099DE3B7 |
| 13343.f682b6ff.js | 685D236D3FC3BE866019938379CE8FCC3ED58B91BA5468B3C1AA0CB6BFC1A205 |

社区辅助线索：[抖音精简优化 1.2.2](https://greasyfork.org/zh-CN/scripts/590280-%E6%8A%96%E9%9F%B3%E7%B2%BE%E7%AE%80%E4%BC%98%E5%8C%96/code)
通过 React 属性取得全屏或倍速方法，但未提供可直接采纳的下一条方案。没有安装或执行该脚本。

## 建议验证顺序

1. 独立、显式启用、离线测试过的只读探针，从唯一活动卡片出发，有界向上查找对应
   React 属性或 ref。只记录匹配数、方法类型、索引一致性和禁用/动画状态，不输出 props
   对象、Feed 数据、账号或视频标识，不扫描全站组件树。
2. 确认候选对象属于当前活动 Feed，区分外层推荐与弹层/相关视频；实例不唯一、卡片
   身份或根不一致时放行。React alternate 可能陈旧，不能拿到一个函数就直接调用。
3. 优先验证现有业务事件入口 changeNext 或相应卡片业务回调，保留边界处理；仅在
   证据支持时再考虑直接 slideNext。一次调用后必须确认活动 ID 恰好变化一次，不能叠加
   键盘或滚动兜底。事件也可能存在其他监听者，须先确认作用范围。
4. 测试普通短视频、连续命中、列表边界、弹层、后台、根替换及停止清理，成功后再将
   经过验证的适配器接入正式导航控制器。内部 API 会漂移，必须保留失败放行。

当前浏览器工具只提供只读 DOM 求值，不能借该接口遍历隐藏框架状态或直接执行上述
方法；运行时验证应通过项目允许的、离线测试过的独立探针完成。扩展管理页仍需用户
手动安装。此次没有为未验证入口制作自动调用补丁。

## 只读发现探针 0.1.0-test

已新增 `tools/native-navigation-probe.user.js`，与键盘探针身份分开。
请新建独立 Tampermonkey 脚本粘贴该文件，停用正式增强脚本和旧键盘探针。
普通推荐地址完全不运行；唯一启用地址为：

```text
https://www.douyin.com/?recommend=1&dwe_native_probe=inspect
```

参数会一次性消费。探针只检查唯一活动 Feed 的唯一活动卡片，以最多 48 层上溯读取
React 自有数据属性，不执行 getter、不遍历 alternate、不遍历完整状态树。不调用
emit、slideNext、playNextFunc 或 isDisabled。这里只报告 isDisabled 是否存在，不能
把方法存在解读为当前未禁用。没有网络观察、网络请求、媒体写入或导航调用。

候选须来自 isActive=true 且 item.awemeId 与卡片一致的组件属性；另核对 swiper.el
包含卡片且位于该 Feed 内，swiper.data 的 activeIndex 对应身份一致。React 树根的
stateNode.current 必须指向当前上溯树根；否则报告 stale-tree，不能用于下一步调用。
只输出布尔值、计数和结果，不输出 ID、页面正文、props 或完整对象。

候选一旦发现即报告并停止；未找到 Fiber 最多等待 15 秒。后台、可信用户输入、路由
变化、等待中的 Feed 根替换、模态弹层或正式脚本标记会终止。stop() 也会完整清理。
报告前缀为 `[DWE Native Probe]`，navigationCalls 恒为 0；candidate-observed 只代表
结构匹配，不能表述为导航成功或方法已可安全调用。

离线验证：正式脚本及该探针语法通过；10 项新增测试、全仓库 162 项单进程 Node
测试通过。覆盖旧树/身份/根不匹配、重复候选、getter 不执行、深度和循环上限、
显式启用、取消清理、超时及异常脱敏。实页发现尚待用户安装，正式脚本未修改。

### 实页发现与 0.1.1-test 修正

2026-09-22 11:44:12 UTC，Chrome 已安装 0.1.0-test，启用参数已消费，活动卡片 1、
正式脚本标记 0。报告 depth-limit、visited=48、elapsedMs=1632、navigationCalls=0。
这是探针检查上限导致未完成核验，不是站点不存在入口的证据。旧实现提前退出时没有
汇总中途候选，因此该报告的 candidates=0 也不能解释为途中未发现候选。

0.1.1-test 将有界上溯上限改为 128，深度/循环退出时保留候选形状信息，但仍报告
currentTree=false，不将部分结果判为可用。仍然不执行导航。新增深树与截断报告回归，
全仓库单进程测试 163/163、正式脚本及探针语法检查通过。新版尚待替换安装和实页验证。

### 0.1.1-test 实页发现与当前树定位

2026-09-22 11:49:07 UTC，Chrome 0.1.1-test 检查 108 层到根，报告 stale-tree。
发现一个候选：scoped/indexMatches 均为 true，destroyed/animating 均为 false，
emit/slideNext/isDisabled/playNextFunc 均存在；elapsedMs=1641，navigationCalls=0。
这证明匹配形状存在于 DOM 关联的 Fiber 分支，但尚未证明它属于当前提交树。

0.1.2-test 增加有界 current 路径核验：从已确认的同一 rootState.current 出发，
逐层在当前父节点的直接 child/sibling 中查找已知祖先或它的 alternate，最后核对
宿主 stateNode 为同一卡片，且 root.current 未变。每层最多检查 128 个兄弟，累计
最多 2048 个节点；不递归扫描无关子树。不直接把 alternate 属性当成当前节点证明。
旧分支候选清空，仅从核验路径读取候选；缺失、歧义、循环、上限或宿主不匹配均退出。
仍然只读、不调用导航。新增当前/旧回调区分、共享子链及异常路径测试，166 项全量
单进程测试与语法检查通过；0.1.2-test 尚待用户替换安装实测。

### 0.1.2-test 当前实例实页通过与 0.2.0-test 单次导航实验

2026-09-22 11:53:09 UTC，Chrome 0.1.2-test 报告 candidate-observed：visited=108、
currentTree=true、candidates=1、scoped/indexMatches=true、destroyed/animating=false，
emit/slideNext/isDisabled/playNextFunc 均存在，resolvedAlternate=false，elapsedMs=1031，
navigationCalls=0。该样本直接位于当前树，尚未形成 alternate 解析的实页通过证据。
已确认当前实例结构匹配；尚未调用或验证真实导航。

同一探针升级为 0.2.0-test，保留 inspect，只在下列显式 next 地址发起一次原生事件：

```text
https://www.douyin.com/?recommend=1&dwe_native_probe=next
```

派发前要求唯一当前实例、非动画、isDisabled() 返回 false、唯一活动视频可播放且
无其他视频播放、按倍速计算剩余墙钟时长至少 10 秒。调用状态方法后再次检查活动上下文
与实例；不满足即停止。事件为 changeNext，使用站点既有 keyboard 来源标记；该标记
仅兼容站点参数，不代表事件来自真实键盘。不调用 slideNext 兜底、不发送合成按键。

首次检查在启动后约 1 秒，无固定 8 秒等待；派发后以 100ms 间隔观察 5 秒，记录首次
ID 变化延迟和总变化次数，成功条件为恰好变化一次。观察期间后台、可信输入、根变化、
弹层等均取消；自然播完风险通过派发前墙钟余量限制，但仍须结合实页行为判断。
报告只保留计数/布尔值/延迟和媒体播放数量，不输出 ID、正文或完整对象。

0.2.0-test 新增五项行为测试覆盖单次事件、无重试、重复变化、前置条件、重入停止、
上下文变化、后台和错误脱敏。正式脚本/探针语法通过，单进程 Node 全仓库 171/171。
默认 node --test 仍受沙箱 spawn EPERM 限制。新版需用户完整替换安装；原生单次切换
及正式过滤器集成尚未实页验证。保持正式脚本和旧键盘探针停用。

### 0.2.0-test 原生事件实页结果

2026-09-22 Chrome，用户确认安装 0.2.0-test 后执行三次独立推荐页加载。
每组都核验 currentTree=true、candidates=1、scoped/indexMatches=true、非动画、
实例未销毁，导航调用恰好一次。首组后 DOM 检查正式脚本标记为 0、活动卡片 1、
启用参数已消费。三个报告前后均 activeVideoCount=1、activePlaying=1、otherPlaying=0。

| UTC 报告时间 | 派发距启动 | 首次 ID 变化距派发 | ID 变化次数 | alternate 解析 | 结果 |
| --- | ---: | ---: | ---: | --- | --- |
| 11:58:16.887 | 1093ms | 201ms | 1 | 否 | one-change-observed |
| 11:58:52.484 | 1010ms | 180ms | 1 | 是 | one-change-observed |
| 11:59:21.372 | 1002ms | 无 | 0 | 否 | not-confirmed |

前两组分别观察至派发后 5088ms 和 5066ms，未记录第二次变化；100ms 轮询只能给出
采样观察延迟，不能证明精确动画或首帧耗时，也不能排除采样间隔内不可见的短暂变化。
第三组观察 5076ms 未变，随后对同一视频发送浏览器 ArrowDown，下一次 DOM 检查
确认 ID 已变化，活动卡片 1、播放视频 1。后续浏览器输入与原生事件有时间差，不能
排除状态随时间变化。不同加载的内容也不同，这些不是完全相同条件的随机实验。

结论：当前 Feed 原生事件确实能驱动切换，且 alternate 定位取得一组实页通过；
但 2/3 成功不足以认定可靠，不能直接集成正式过滤器。不能据此宣布键盘失败根因已找到。
后续应区分 changeNext 事件监听/业务分支与底层状态门控，核验活动卡片业务回调的
实际执行路径；不叠加事件重试或底层 slideNext 兜底来掩盖失败。
本轮仅更新证据，正式脚本未修改，无额外新探针安装要求。

### 0.3.0-test 调用路径实验（待安装）

新增独立模式，原 inspect/next 不启用方法包装：

```text
https://www.douyin.com/?recommend=1&dwe_native_probe=trace-next
```

沿用当前树与媒体前置检查后，临时包装该实例的 slideNext/isDisabled 自有可写且
可配置方法，再发一次 changeNext。包装保留 this、参数、返回值（含 Promise 身份）
和原异常，不增加状态方法调用。最多存储 8 条方法记录，并记录调用总数、相对时间、
动画布尔值、调用前后索引及实际 isDisabled 返回布尔值；不保存参数、异常文本或对象。
在 5 秒观察结束、用户输入、后台、异常或停止时清理，只恢复仍由本探针拥有的方法。
后来者替换方法时保留后来者，报告 cleanup；安装不完整会回滚并取消导航。

解读边界：slideNextCalls=0 仅表示未经过被包装的实例属性，不能证明任何事件监听都
没执行。源码的 slideNext 也可能直接使用闭包中的禁用判断，绕过公开 isDisabled 属性，
因此 disabledChecks=0 不代表没有检查禁用条件。此探针用于缩小失败范围，不单靠计数
宣告根因。包装可能改变微小时序，须结合原 next 模式基线，不将源码或模拟测试当作实页成功。

离线验证新增 5 项测试，覆盖参数/接收者/返回身份、原异常、记录上限、部分安装回滚、
后来者保护、各退出路径恢复及安装失败不导航。全仓库单进程 Node 测试 176/176、语法
检查通过。默认 node --test 仍受沙箱 spawn EPERM 限制。正式脚本未修改；0.3.0-test
待用户完整替换 Tampermonkey 中 Native Navigation Probe，保持其他两个脚本停用。

### 0.3.0-test 调用链实页结果

2026-09-22 Chrome，用户更新后运行 4 组 trace-next，再运行 1 组无包装 next 对照。
各组为独立推荐页加载；均确认当前树、唯一候选、身份及 Feed 归属匹配，导航调用和
观察到的 ID 变化均恰好一次，结束时 activePlaying=1、otherPlaying=0。

| UTC 报告时间 | 模式 | 派发距启动 | 首次 ID 变化距派发 | alternate |
| --- | --- | ---: | ---: | --- |
| 12:26:03.298 | trace-next | 1208ms | 151ms | 是 |
| 12:26:37.325 | trace-next | 1042ms | 133ms | 否 |
| 12:27:09.005 | trace-next | 1020ms | 184ms | 是 |
| 12:27:39.099 | trace-next | 1072ms | 172ms | 是 |
| 12:28:13.437 | next | 1113ms | 138ms | 否 |

四组 trace-next 均记录 slideNextCalls=1，进入包装方法的相对时间分别为 2/2/2/1ms；
调用前 animating=false、index=0，返回后 animating=true、index=1，无异常。
disabledChecks=0，与可能直接使用内部闭包判断的源码相容，不能解释为未检查禁用状态。
各组 readErrors=0、cleanup=restored。无包装对照 trace=null，同样切换成功。

本轮确认成功路径为事件进入 slideNext、索引更新、DOM 身份随之改变；未复现旧版的
失败，因此未确定失败根因，不能用本轮 5/5 覆盖旧版 2/3 的结果，也不能证明包装没有
时序影响。当前结果仍限于刷新后首条、单次调用；同页连续卡片、过滤器集成、后台和
输入焦点真实交互以及音频输出仍未完成验收。本轮仅更新证据，不修改正式脚本。

### 2026-09-23：0.4.0-test 同页三连测（待安装）

新增 series-next 模式，不刷新页面，最多对三个不同活动视频各发一次 changeNext。
每次沿用 trace-next 的调用记录与完整前置检查，观察 5 秒且 ID 恰好变化一次后才继续。
每轮恢复临时包装，再重新发现下一张卡片的当前树/身份/Feed 实例，不沿用上一轮回调。

```text
https://www.douyin.com/?recommend=1&dwe_native_probe=series-next
```

任何未确认/多次变化、轮次之间自然漂移、已尝试过的 ID、后台/输入焦点/可信输入、
根替换、禁用状态或包装恢复不完整都会停止。最多 3 次导航，整体最长 30 秒。
最终报告 rounds 保存各轮脱敏结果，navigationCalls 为全程次数；顶层 identityChanges
与 firstChangeMs 对应最后一轮，不应当成三轮总计。

5 秒是诊断观察窗，不是产品延迟设计。本模式只验证同页连续实例重取与切换稳定性，
不能证明快速连续命中、首帧或零音频目标。原 inspect/next/trace-next 模式保持原用途。

新增 5 项离线回归：三轮单次调用与恢复、第二轮失败不重试、轮次间漂移/后台/输入焦点/
根替换、禁止重访 ID/保留后来者，以及第二张卡片禁用检查。全仓库单进程测试 181/181，
正式脚本和探针语法检查通过。默认 node --test 仍因沙箱 spawn EPERM 无法启动子进程。
正式脚本未改；用户需完整替换 Native Navigation Probe 至 0.4.0-test 后再实页验证。

### 2026-09-23：0.4.0-test Chrome 同页实测结果

用户确认更新后执行三组 series-next。以下均为 UTC 报告时间，延迟为 100ms 轮询检测
活动卡片身份变化的耗时，不是首帧或音频测量。

| 报告时间 | 结果 | 各轮首次身份变化 | 调用数 |
| --- | --- | --- | ---: |
| 04:28:59.478 | 第二轮 ambiguous-card，停止 | 259ms / 未识别 | 2 |
| 04:30:16.521 | 第二轮观察期间进入后台，停止 | 279ms / 183ms | 2 |
| 04:30:43.195 | three-changes-confirmed | 142ms / 183ms / 170ms | 3 |

第一组第二轮记录 slideNext 恰好一次，索引 1→2，无异常，包装已恢复。随后只读 DOM
检查发现标准活动视频卡为 0，存在 feed-live/live-slider，页面显示直播预览和进入直播间
提示。因此确认探针对直播目的卡缺少身份观察能力，不能把该组简单记为导航失败；
也不能将直播视频计入 otherPlaying=1 解读为旧视频串音。当前报告没有精确直播身份，
不计为完整三连测通过，不自动继续跳过直播。

第二组第一轮观察窗完整；第二轮虽检测到一次身份变化，但观察窗未完成就触发 background。
已恢复包装并停止第三次派发，不计为完整通过。

第三组在同一页面完成三次导航，派发距启动分别为 1033/6233/11414ms，总计 16500ms。
每轮 slideNextCalls=1、identityChanges=1、readErrors=0、cleanup=restored，索引依次
0→1、1→2、2→3，调用前 animating=false，返回后 true，无异常。三轮观察结束均为
activePlaying=1、otherPlaying=0；最后一轮重新发现当前树时 resolvedAlternate=true。

本轮证据支持当前 Chrome 标准视频卡的同页连续实例重取与单次导航；5 秒仍是观察窗，
不代表正式功能必须等待 5 秒。此前偶发未切换的根因仍未复现，快速连续命中、直播目的卡
确认、关键词/BGM 控制器集成、首帧和音频输出尚未闭环。正式脚本 0.0.3 未修改。

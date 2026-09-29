# 键盘导航候选方案验证

## 当前结论

第二轮 `0.2.0-test` 已完成实页触发时机对照：稳定 1 秒后触发的 3 组均未切换，稳定 8 秒后触发的 3 组均在 114–116ms 内观察到一次身份变化，延迟基线无变化。全部派发时页面聚焦、2x 播放且剩余墙钟时长大于 10 秒。这支持启动就绪时机假设，且说明当前页面存在可用的合成组合按键路径；不能推出“所有卡片固定等待 8 秒即可稳定过滤”。正式脚本未修改。

已完成 Chrome + 用户手动安装的 `0.1.0-test` 探针实页对照。`body-down` 的 4 个样本均未确认切换；`focus-pair` 的 5 个无真实输入干扰样本中观察到 2 次单次切换、3 次未切换，另有 1 个真实输入介入的样本作废。两次浏览器输入工具发送的 Down 对照均改变活动视频 ID。后续审查发现旧探针未按倍速折算自然播放结束时间，因此那 2 次身份变化不能认定为合成按键成功。正式脚本保持 `0.0.3`，未修改。

浏览器工具访问 Tampermonkey 管理页被 URL 安全策略拒绝。没有通过其他入口绕过限制；用户已手动安装探针并确认准备完成，代理随后从普通抖音页面触发测试。

## 实页结果（2026-09-21）

| 组别 | 有效样本 | 观察结果 |
| --- | --- | --- |
| 无按键基线 | 2 | 两组均无身份变化，当前视频持续播放 |
| body 单次 keydown | 4 | 0 次切换，4 次 `not-confirmed` |
| 焦点 keydown + keyup | 5 | 2 次 `one-change-observed`，3 次 `not-confirmed` |
| 真实输入介入 | 1（剔除） | `user-input`；虽然观察到身份变化，不计为探针成功 |
| 浏览器输入工具发送 Down | 2 | 两次均观察到唯一活动视频 ID 改变；第二次结束时仅 1 个 video 处于播放状态 |

所有有效探针样本在结束时均为 `activeVideoCount=1, activePlaying=1, otherPlaying=0`。检查时下一条语义控件数量为 0，正式脚本的 `data-dwe-video-state` 标记数量为 0。所有组合样本的实际派发目标都是 body；尚未验证其他非编辑焦点元素。

脱敏原始报告摘要见 [`test/fixtures/keyboard-navigation-chrome-2026-09-21.json`](../test/fixtures/keyboard-navigation-chrome-2026-09-21.json)。它是现场记录，不是用 Node 模拟生成的兼容性结论，也不是新增自动测试的通过断言。日志时间为 UTC。

此前曾据此推断可以否定“必然拒绝所有合成方向键”，现撤回这一过强推断：旧探针只要求剩余 10 秒媒体时长，2x 等倍速可能让自然连播落入 5 秒观察窗口，且旧日志未采集倍速，无法追溯排除。身份变化是有效观察，但因果尚未确认；同样没有证据证明抖音检查了 `isTrusted`。每组都是重新加载推荐页后的早期激活状态，网页快捷键处理器就绪时机、焦点、卡片类型与其他原生状态尚未被完全隔离。

未进入过滤控制器集成阶段，因此未进行连续命中过滤、配置切换、动画期间重复导航的产品验收。只检查了 DOM 活动身份与媒体属性；没有系统音频、录屏或首帧证据。所有探针均已结束，地址参数已被消费；已安装的临时探针仍需用户停用/删除，原正式脚本需用户恢复。

## 候选与边界

源码：[`tools/keyboard-navigation-probe.user.js`](../tools/keyboard-navigation-probe.user.js)。测试：[`test/keyboard-navigation-probe.test.js`](../test/keyboard-navigation-probe.test.js)。

| 模式 | 行为 | 社区参考 |
| --- | --- | --- |
| `baseline` | 仅观察，不派发事件 | 排除自然切换或其他脚本干扰 |
| `body-down` | 向 body 派发一次 ArrowDown keydown，包含 key/code/keyCode/which | [Frequenk VideoController](https://github.com/Frequenk/douyin-enhancer-userscript/blob/master/douyin-enhancer.user.js#L405-L489) |
| `focus-pair` | 向非编辑焦点元素派发一次 keydown/keyup，设置 composed | [抖音净化助手 dispatchNextAction](https://greasyfork.org/zh-CN/scripts/581278-%E6%8A%96%E9%9F%B3%E5%87%80%E5%8C%96%E5%8A%A9%E6%89%8B-v4-4-37/code) |

当前探针为 `0.2.0-test`，已由用户更新安装并完成下述实页时机对照。旧版实页结果保留版本区分。

只在首页推荐 URL 显式携带 `dwe_keyboard_probe` 参数时运行。先消费参数，避免刷新重放；等待唯一 Feed 根、唯一标准视频及单一视频元素，并要求可播放、播放时间连续推进、卡片位置稳定和倍速不变。`dwe_keyboard_wait=early`（默认）要求稳定至少 1 秒，`settled` 要求至少 8 秒，然后派发一次方案指定的事件序列，观察 5 秒，不重试。等待就绪最多 20 秒。探针不调用网络接口，不读 GM 配置，不修改媒体属性、DOM、原始响应或页面监听器。

用户真实按键、滚轮、pointerdown 会使本组结果失效并停止。后台、编辑焦点、模态框、路由变化、Feed 根替换也停止。当前视频按播放倍速折算距结束不足 10 秒墙钟时间时不触发，降低自然连播干扰。停止后取消 timer 并移除自己的监听器。

报告仅包含事件次数、身份变化次数、媒体数量/播放状态、时间、派发时文档焦点和倍速，不输出实际视频 ID、媒体 URL、页面文本或关键词。新版增加 `probeVersion`、`stableWaitMs`、`dispatchElapsedMs`、`firstChangeMs`、`documentFocusedAtDispatch` 和 `beforePlayback`。身份变化以 100ms 轮询观察，不能证明轮询间不存在极短暂切换；`one-change-observed` 仅说明观察到一次身份变化，不能单独证明因果或完整功能通过。

## 第二轮：触发时机对照（已完成）

| 分组 | 有效样本 | 结果 | 派发后首次身份变化 |
| --- | --- | --- | --- |
| baseline / settled | 1 | 无变化 | 无 |
| focus-pair / early（稳定 1 秒） | 3 | 全部 `not-confirmed` | 无 |
| focus-pair / settled（稳定 8 秒） | 3 | 全部 `one-change-observed`，每组仅一次 | 114、115、116ms |
| early 短视频 | 1（剔除） | `near-video-end`，没有派发 | 无 |

记录时间：2026-09-21 10:15–10:20 UTC（北京时间 18:15–18:20）。完整脱敏字段见 [`keyboard-navigation-timing-chrome-2026-09-21.json`](../test/fixtures/keyboard-navigation-timing-chrome-2026-09-21.json)。

实际 early 派发发生在探针启动约 1.81–2.14 秒后，settled 约 8.82–8.90 秒后。有效组合样本均为 body 目标、文档聚焦、readyState=4、2x 播放；early 剩余墙钟时长约 23/174/314 秒，settled 约 92/142/96 秒。全部结束时 activePlaying=1、otherPlaying=0。再次检查下一条控件数量为 0、正式增强脚本标记数量为 0。

新版成功样本与自然播完的时间明显不符，并且变化紧随派发发生；相比旧版，更支持合成组合按键能够驱动切换。不同样本仍来自不同推荐页加载，因而不把 3/3 当作普遍可靠性或根因证明。尚未直接确认快捷键监听注册时刻、动画锁状态，也未验证已初始化页面中后续卡片能否立即跳过。

下一步应在页面完成初始化后，对后续视频激活进行单次组合按键验证，区分“页面启动就绪”与“每张卡片自身等待”。不能将固定 8 秒延迟直接用于无感过滤，也不应先叠加盲目重试。本轮探针均已自动停止，URL 测试参数均已消费。

复现实验方法如下：

先将 Tampermonkey 中已安装的临时探针完整替换为 `0.2.0-test`，保持正式增强脚本及其他自动跳过脚本停用。不访问扩展管理页绕过工具限制，更新由用户完成。

按基线、early、settled 交替采样；先确认控制台报告含 `probeVersion: "0.2.0-test"`，避免旧版忽略新参数造成错误对照。

```text
https://www.douyin.com/?recommend=1&dwe_keyboard_probe=baseline&dwe_keyboard_wait=settled
https://www.douyin.com/?recommend=1&dwe_keyboard_probe=focus-pair&dwe_keyboard_wait=early
https://www.douyin.com/?recommend=1&dwe_keyboard_probe=focus-pair&dwe_keyboard_wait=settled
```

early 和 settled 各取得至少 3 组有效样本，对照实际派发时间、文档焦点、倍速与首次身份变化延迟。失效或近结束样本剔除；用户介入不算通过。若结果仍不稳定，不能仅通过延迟或重复按键宣布修复。不同加载对应不同推荐内容，仍非完全同条件随机对照。评论焦点与动画期间取消已有离线覆盖，真实用户交互和正式过滤集成仍需单独验收。

## 安装与实页流程

1. 在 Tampermonkey **新建独立脚本**，完整粘贴探针源码并保存，勿覆盖正式脚本。
2. 临时停用原来的“抖音 Web 增强”和其他会自动跳过视频的脚本，以免混淆归因。保留原配置，测试后恢复。
3. 分别在前台打开以下地址。默认 early 每组通常约 7 秒，期间不要操作该页；settled 通常约 14 秒。等待就绪最多 20 秒，随后最多观察 5 秒。先确认 baseline，再分别测试两种输入。

```text
https://www.douyin.com/?recommend=1&dwe_keyboard_probe=baseline
https://www.douyin.com/?recommend=1&dwe_keyboard_probe=body-down
https://www.douyin.com/?recommend=1&dwe_keyboard_probe=focus-pair
```

4. 读取控制台 `[DWE Keyboard Probe]` 报告，结合可见卡片、活动 ID 变化和 active/otherPlaying 计数。每个方案至少 3 次独立样本，失败不立即叠加其他动作。不同页面加载的推荐视频不同，不能视为完全相同条件的随机对照试验。
5. 如机制成立，再验证评论输入焦点、切换动画、连续调用及是否重复越过正常视频。若将来集成过滤控制器，仍需验证连续关键词命中、配置 revision、后台/根替换、熔断和清理；本探针不代表这些已通过。
6. 完成后停用/删除临时探针，恢复原脚本并刷新普通推荐地址。刷新或关闭页面也会终止探针；控制台可使用 `__DWE_KEYBOARD_PROBE__.stop()` 提前停止。

## 离线证据

- 正式脚本及新探针 `node --check` 通过。
- 旧探针 `0.1.0-test` 的 16 项回归通过；当前 `0.2.0-test` 的 24 项回归通过，新增延迟触发、缓冲/动画恢复、倍速自然连播排除、变化延迟和长等待取消。
- 默认 `node --test` 被沙箱以 `spawn EPERM` 阻止启动测试子进程；不属于断言失败。
- 旧探针版本 `node --test --test-isolation=none`：139/139 通过；当前版本：147/147 通过。
- `git diff --check` 通过。
- Chrome + Tampermonkey `0.1.0-test` 与 `0.2.0-test` 实页验证：均已执行，结果按版本分开记录；正式过滤控制器未集成。
- Edge、连续命中过滤、音频与首帧：未验证。

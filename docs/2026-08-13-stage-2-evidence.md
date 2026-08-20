# Stage 2 视频关键词与导航证据报告

> 日期：2026-08-13
> 当前候选版本：`douyin-web-enhancer.user.js` `0.2.1-test`
> 状态：可编程导航能力闸门已通过；正式脚本自动跳过已确认生效，无感切换人工验收未通过并降级记录

## 1. 本阶段范围

本轮只实现和验证：

- 首页“推荐”标准视频流生命周期；
- `data-e2e-vid` 精确活动卡片身份；
- `[data-e2e="video-desc"]` 内标题/描述/话题文本匹配；
- 单一语义化下一条路径、活动 ID 变化确认、一次重试和连续跳过熔断；
- 配置 revision、激活 epoch、根替换、后台切换和停止清理；
- 只隐藏脚本判定为 `pending` / `block` / `navigating` 的卡片媒体画面。

本轮没有实现弹幕过滤、BGM 过滤或响应观察，也没有写入 `muted`、调用 `pause()/play()`、发送额外请求或合成键盘事件。系统音频、临时静音争用与恢复仍未验证，因此媒体写入保持禁用。

## 2. 可编程导航能力闸门

### 2.1 离线安全审查

一次性探针位于 `tools/stage2-navigation-probe.user.js`，具备以下约束：

- 只有 URL 参数 `dwe_stage2_navigation_probe=native-click` 存在时运行；
- 参数在动作前通过 `history.replaceState` 消费，避免刷新重复执行；
- 只接受唯一、可见且可点击的 `[data-e2e="video-switch-next-arrow"]`；
- 只调用一次 `.click()`，不使用键盘事件、滚动或第二条动作路径；
- 只以唯一活动 `data-e2e-vid` 变化确认完成；
- 报告不保留原始视频 ID、正文、关键词或 URL 查询参数；
- 超时、歧义、异常或停止时不重试、不猜测。

该探针先通过 9 项专用 Node 测试，再进入 Chrome。安装前全仓测试为 40/40 通过。

### 2.2 Chrome + Tampermonkey 结果

真实页面先确认：

- 唯一可见的 `[data-e2e="video-switch-prev-arrow"]` 和 `[data-e2e="video-switch-next-arrow"]` 均存在；
- 下一条控件 `pointer-events: auto`；
- 一次可信浏览器点击使唯一活动 ID 在约 588ms 内变化。

随后由 Tampermonkey 探针在独立刷新中连续运行三次：

| 运行 | 结果 | 点击次数 | 活动 ID 改变 | 探针耗时 |
| ---: | --- | ---: | --- | ---: |
| 1 | `confirmed` | 1 | 是 | 2177ms |
| 2 | `confirmed` | 1 | 是 | 2280ms |
| 3 | `confirmed` | 1 | 是 | 2099ms |

三次运行后 URL 均恢复为 `https://www.douyin.com/?recommend=1`。控制台报告来源为 Tampermonkey Userscript，且每次均为 `clickCount: 1`。据此，Stage 2 可编程导航能力闸门按“可重复、可确认、不改变账号状态”的标准通过。

匿名结构化证据位于 `test/fixtures/stage2-navigation-chrome.json`。

## 3. `0.2.1-test` 控制器实现边界

正式脚本保留 Stage 1 的六个 GM 键和六个菜单。页面控制器不读取 GM API，只接收不可变设置快照，对外仍为：

```text
start(settings)
updateSettings(settings)
stop()
```

视频控制器当前采用：

- 唯一 `[data-e2e="slideList"][data-active="true"]` 作为 Feed 根；
- 唯一 `[data-e2e="feed-active-video"][data-e2e-vid]` 作为活动卡；
- `[data-e2e="feed-video"][data-e2e-vid]` 作为预加载标准卡；
- `[data-e2e="video-desc"]` 作为视频文本所有权边界；
- `[data-e2e="video-switch-next-arrow"]` 作为唯一导航动作；
- 活动 ID 改变作为导航确认；
- `data-dwe-video-state` 作为脚本专属视觉状态，不删除、移动或重建抖音卡片。

当前配置更新不重判已经稳定激活的 `allow` / `bypass` 视频；从空配置首次启用规则时，当前稳定视频只放行本次激活，离开并返回后按新规则重判。新规则作用于未激活候选和下一次激活 epoch。文档进入后台、离开支持路由、根替换或 `stop()` 时，先递增 generation 并 retire 旧 epoch，再取消任务、断开观察器和恢复脚本专属 DOM。

`0.2.0-test` 的首次正式脚本实页验收暴露了一个导航误判：抖音虚拟列表仍可正常上下切换，但活动卡位于已加载 DOM 序列末尾时，控制器因找不到“排在后面”的预加载卡而提前 fail-open。`0.2.1-test` 删除该 DOM 顺序门控；是否可导航改由唯一可用的语义化下一条控件决定，结果仍以活动视频 ID 变化确认。

## 4. 源码验证

当前交付前检查：

```text
node --check douyin-web-enhancer.user.js          PASS
node --check tools/stage0-probe.user.js           PASS
node --check tools/stage2-navigation-probe.user.js PASS
node --test                                        PASS (53/53)
git diff --check                                   PASS（仅既有 LF/CRLF 提示）
```

Stage 2 控制器回归覆盖：

- 视频文本边界不读取作者；
- 命中只发起一次下一条，确认前互斥；
- 未确认时最多重试一次并 fail-open；
- 配置更新和首次启用规则都不突袭当前稳定视频，返回后使用新 epoch 重判；
- 后台切换立即 retire、撤门控并断开观察；
- 停止或关闭规则恢复脚本专属 DOM；
- 空描述 250ms watchdog 后 `bypass`；
- 活动卡位于已加载 DOM 末尾时仍调用可用的语义化下一条；
- 返回旧卡时使用新 epoch；
- 根失效后的迟到回调不产生副作用；
- 12 次已确认连续跳过后熔断，第 13 次不点击；
- 虚拟列表节点复用不继承旧视频决策。

## 5. 正式脚本实页结果与剩余验收

正式 `0.2.1-test` 已在 Chrome + Tampermonkey 中确认：首次添加关键词不会突袭当前视频；离开并返回命中视频后会调用下一条，不再出现“未能确认下一条”的 DOM 顺序误判。

人工同时观察到切换存在明显卡顿。离线控制器检查确认：文本已就绪的命中卡在活动变化后的下一动画帧内同步调用 `.click()`，250ms watchdog 只用于正文尚为空的卡；既有浏览器基线显示单次原生语义化切换的活动 ID 变化约为 588ms。由于本次验收路径包含“上一条进入命中卡 + 脚本下一条退出”的反向双动画，卡顿可见，但当前没有高帧率录屏或可信实页时序将总时长进一步拆分。因此结论分层为：

- 自动跳过功能：通过；
- DOM 顺序误判修复：通过；
- 无感切换：未通过；
- 精确卡顿时长与动画分段：未测；
- 不引入合成键盘、滚动、连续点击或直跳等未经能力闸门验证的补丁。

以下项目仍需后续实页验收：

1. 非命中规则下当前卡和预加载卡均为 `allow`，页面无视觉或导航副作用；
2. 使用当前视频标题/描述中的窄关键词命中时，只进入下一条一次；
3. 中间命中卡在确认前保持视觉门控，下一条允许卡恢复可见；
4. 修改规则不会突袭跳过当前稳定播放的视频，从下一次激活生效；
5. 关闭或清空视频规则后专属属性和样式全部恢复；
6. 控制台没有脚本错误，页面原生暂停、播放、音量和账号状态不受修改。

高帧率逐帧、系统音频、Edge/Firefox/Violentmonkey、直播/图文/广告等仍未验证，不得写成通过。

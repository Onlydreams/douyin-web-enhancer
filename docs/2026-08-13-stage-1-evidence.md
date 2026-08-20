# Stage 1 配置骨架验收报告

> 日期：2026-08-13
> 正式脚本版本：`0.1.0-test`
> 浏览器：Google Chrome + Tampermonkey，已登录抖音会话
> 状态：Stage 1 已完成；自动页面验收与用户手工菜单验收均通过

## 1. 交付范围

Stage 1 只交付：

- 单文件 Userscript 元数据与可安装产物；
- 视频、弹幕和 BGM 三组独立关键词设置；
- 六个 GM 存储键；
- 每组一个状态菜单和一个编辑菜单；
- NFKC、空白压缩、大小写归一、去空和去重的纯关键词规则；
- 惰性控制器 interface，为后续阶段保留 `start(settings)`、`updateSettings(settings)` 和 `stop()` 边界。

本阶段不包含页面 DOM 处理、Observer、自动导航、视觉/媒体门控、弹幕过滤或 BGM 响应观察。

## 2. 源码与离线证据

- `node --check .\douyin-web-enhancer.user.js` 通过；
- `node --check .\tools\stage0-probe.user.js` 通过；
- `node --test` 共 31 项通过，其中 Stage 1 专项 14 项；
- 所有匿名 fixture JSON 可解析；
- `git diff --check` 通过，仅有 Windows 工作树 LF → CRLF 提示；
- 范围测试确认正式脚本没有页面查询、Observer、XHR/fetch、媒体调用或事件监听；
- 脱敏扫描未发现本机路径、认证头、Cookie、Token 或调试日志。

## 3. Chrome 自动页面验收

在安装 `0.1.0-test` 后刷新 `https://www.douyin.com/?recommend=1`，确认：

- 唯一活动 Feed 和唯一标准活动卡片正常存在；
- 页面没有脚本专属 DOM 属性、class 或 style；
- 没有 Stage 1 相关错误或控制台日志；
- 没有 Stage 0 探针报告残留；
- 视频保持站点原生播放、静音和预加载状态。

这证明 Stage 1 正式脚本在普通推荐页保持惰性。它不证明后续过滤能力可用。

## 4. 用户手工菜单验收

用户在 Chrome + Tampermonkey 中确认：

- 三类功能共六个菜单，未配置时状态正确；
- 从状态菜单可以直接打开视频关键词编辑；
- 输入 `ＡＢＣ|abc|测试  词` 后显示“已开启（2 个词）”；
- 点击状态项后显示“已关闭（已保存 2 个词）”；
- 刷新页面后关闭状态和有效词数保持；
- 清空词表后恢复“未配置”。

有效词数为 2 是预期结果：`ＡＢＣ` 经 NFKC 和小写归一后与 `abc` 重复；`测试  词` 经空白压缩后成为一个关键词 `测试 词`。菜单统计规范化、去空和去重后的有效词数，不统计原始分隔项数。

## 5. 阶段结论

Stage 1 已完成。下一阶段可以进入 Stage 2，但必须先处理两项独立能力闸门：

1. 找到可重复、可确认且不破坏原生状态的可编程下一条动作；
2. 媒体写入只有在 ownership token、争用、清理和下一卡不污染回归通过后才允许启用。

任一闸门失败时必须按设计降级，不能把真实键盘输入基线或离线测试替代为 Userscript 实页能力证据。

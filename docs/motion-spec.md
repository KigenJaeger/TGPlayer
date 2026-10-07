# TGPlayer Motion Spec

TGPlayer 的动效规范。时序、曲线与动效模式对齐 **Telegram Desktop（tdesktop）** 的动效语言；调色、圆角与材质仍是 TGPlayer 自己的 Material You 体系。

这份文档是动效的单一事实来源。改动的入口顺序是：

1. 改 `src/motion.css` 里的 token（时长与曲线）；
2. 需要新模式的，在 `src/motion.js` 加运行时能力；
3. 组件按"元素映射表"接线。

---

## 1. 设计原则

取自 tdesktop 的六条原则，TGPlayer 照此执行：

1. **快而克制。** 微交互 100–200ms，转场 150–200ms，内容入场 200–320ms。没有任何为了好看而拖长的过渡。
2. **缓动优先于时长。** 用急减速曲线（`easeOutCirc` / `easeOutQuint` / `easeOutCubic`）让动效起步快、收尾稳；不用线性，也不做对称的缓入缓出。
3. **入场与离场不对称。** 进入用 `easeOut*` 且更快；离开用 `easeIn*` 且更慢。大面离开可以慢到 600ms，而同样的进入只要 200ms。
4. **一切皆可插值。** 位置、尺寸、透明度、颜色、数字、文字内容都当可插值对象，变化永远连续，不闪断。
5. **降级是跳终态，不是放慢。** 关闭动效时直接落在最终值。动画停在中间是 bug，不是妥协。
6. **相位式计时。** 进度由时间戳算，不累加帧步长。掉帧不改变终点，切换标签页也不会把数值卡在半路。

---

## 2. Motion Tokens

定义在 `src/motion.css` 的 `:root`，`src/motion.js` 通过 `TGMotion.tokenMs()` 读取同一组值，因此时长只有一处定义。

### 时长

| Token | 值 | 用途 |
| --- | --- | --- |
| `--motion-instant` | 100ms | 按压反馈、图标瞬时切换 |
| `--motion-fast` | 150ms | **默认值**：hover、淡入、揭示、列表项 |
| `--motion-normal` | 200ms | 面板、浮层、菜单入场 |
| `--motion-slow` | 320ms | 页面入场、文字替换、封面淡入、数字滚动 |
| `--motion-exit` | 600ms | 最大面积离场的上限 |
| `--motion-ambient` | 800ms | 呼吸/脉冲循环的一个周期 |
| `--motion-glare` | 700ms | 一次高光扫过 |
| `--motion-ripple` | 200ms | 一次水波纹扩散 |
| `--motion-stagger` | 24ms | 列表错峰的单项步长 |

对应 tdesktop 的实测值：`universalDuration`/`slideDuration`/`itemRevealDuration` ≈ 150ms，`emojiPanDuration`/`introSlideDuration` ≈ 200ms，`AnimatedString` 默认 320ms，`mediaviewHideDuration` = 600ms，`kRoundPeriod`/`sineDuration` = 700–800ms。

### 缓动

| Token | 值 | 近似 tdesktop | 用途 |
| --- | --- | --- | --- |
| `--ease-slide` | `cubic-bezier(.075,.82,.165,1)` | `easeOutCirc` | 页面/图层滑动的 CSS 侧 |
| `--ease-enter` | `cubic-bezier(.23,1,.32,1)` | `easeOutQuint` | 入场、菜单、开关滑块 |
| `--ease-fade` | `cubic-bezier(.215,.61,.355,1)` | `easeOutCubic` | 交叉淡化、hover |
| `--ease-exit` | `cubic-bezier(.55,.055,.675,.19)` | `easeInCubic` | 离场 |
| `--ease-bounce` | `cubic-bezier(.34,1.56,.64,1)` | `easeOutBack` | 勾选、微弹跳 |
| `--ease-breath` | `cubic-bezier(.445,.05,.55,.95)` | `sineInOut` | 呼吸、脉冲 |
| `--ease-ripple` | 同 `--ease-slide` | `easeOutCirc` | 水波纹扩散 |
| `--ease` | `var(--ease-fade)` | — | 兼容别名，旧规则仍在用 |

> CSS 的 cubic-bezier 只是近似。需要精确曲率的地方（页面转场、震动、抛物线飞行、数字滚动）由 `TGMotion` 用**精确公式**在 JS 里补间：`outCirc(t)=√(1-(t-1)²)`、`outQuint(t)=1-(1-t)⁵`、`outBack` 带超调参数、`sineInOut(t)=-(cos(πt)-1)/2`。

---

## 3. 元素映射表

| 动效元素 | 来源（tdesktop） | TGPlayer 落点 | 参数 |
| --- | --- | --- | --- |
| 水波纹 Ripple | `RippleButton` / `RippleAnimation` | 所有可点元素（列表见 `TGMotion.ripple.selector`） | `--motion-ripple` + `--ease-ripple`，从按下点扩散，按宿主圆角裁剪 |
| 页面转场 | `Window::SlideAnimation` | `.page` 切换 | 出场 150ms `easeInCubic` + `translateY(-8px)`；入场 320ms `easeOutQuint` + `translateY(10px)→0` |
| 菜单/浮层入场 | 弹层出现 | `.device-popover` / `.track-menu` / `--motion-normal` `--ease-enter`，`scale(.96)→1`，`transform-origin` 贴锚点 |
| 弹窗 | `boxDuration` | `.modal-backdrop` / `.modal` | 入场 200ms `--ease-enter`；离场 150ms `--ease-exit` |
| Toast | 通知条 | `.toast` | 入场 200ms `--ease-enter`；离场 150ms `--ease-exit` |
| 高度滑入滑出 | `SlideWrap` | `.selection-bar` / `.picker-filters` | `--motion-normal` + `--ease-enter` |
| 列表错峰揭示 | `itemRevealDuration` | `.track-row` / `.channel-card` / `.playlist-card` / `.chat-row` / `.popover-item` | 每项 150ms + `--i × 24ms`，上限 8 项 |
| 交叉淡化文字 | `CrossFadeLabel` | 播放器标题/艺人、Now Playing 标题/艺人 | 320ms `easeOutCubic`：旧值上移淡出，新值下移淡入 |
| 数字滚动 | `NumbersAnimation` | 库计数、播放列表计数、收藏数、缓存大小 | 320ms `easeOutQuint` |
| 勾选形变 | `RoundCheckbox` | `.pick-box` 对勾 | 150ms `easeOutBack`，`scale(.4)→1` |
| 呼吸脉冲 | `kRoundPeriod` 循环 | `.eyebrow-pulse` / `.cloud-live i` / `.sync-state i` | 800ms `sineInOut` 循环 |
| 高光扫过 | `GlareEffect` | `.motion-glare`（最强动作：主按钮、播放键） | 700ms `easeOutCubic`，hover 触发一次 |
| 骨架微光 | 加载占位 | `.skeleton` / `.skeleton-list` | 700ms 线性循环扫过 |
| 错误震动 | `DefaultShakeCallback` | 登录表单字段组（`.auth-field` 所属容器） | 5 段阻尼位移，约 400ms，幅度 7px |
| 抛物线飞行 | `ReactionFlyAnimation` | 「加入队列」→ 队列按钮；「加入列表」→ 目标播放列表卡 | 320ms **线性** + 抛物线弧顶（弧高 92px），末段 18% 淡出，终点缩放至接收控件尺寸 |
| 封面淡入 | 图片解码 | `.track-art img` 等 | 320ms `--ease-fade` |
| 装饰浮动 | 封面悬浮动画 | `.orbit-art` / `.art-disc-small` | 6–9s `sineInOut` 循环 |
| 忙碌旋转 | 环形进度 | `.is-busy .icon` | 1s linear 循环（循环周期，非过渡时长） |

**未迁移**（与音乐播放器调性不符或成本过高）：烟花、雪花、GPU 像素溶解（Thanos）、Premium 3D 星/币、Lottie 场景动画。

---

## 4. 降级规则

两级开关，语义相同，取或：

- 应用内：`body.reduce-motion`（设置页「减弱动效」）。
- 系统级：`prefers-reduced-motion: reduce`。

行为：

- **CSS**：`motion.css` 与 `styles.css` 把过渡/动画时长压到 `.01ms`、`animation-delay` 归零、循环次数为 1。
- **JS**：`TGMotion` 的每个入口先查 `reduced()`，为真时**直接应用最终值**——`tween` 只调用一次 `onUpdate(to)` 并立刻 `onDone`；`ripple` 不创建墨点；`fly` 直接跳过并调 `onDone`；`pageTransition` 直接切换 class。
- **布局不变**：降级只影响"怎么到"，不影响"到哪里"，也不会留下位移或半透明。

---

## 5. 实现约定

- **时长/曲线只在 token 里定义。** `src/styles.css` 不写裸时长；`src/motion.js` 通过 `tokenMs()` 读取同一组 token。
- **JS 补间一律时间戳式。** 不累加帧步长（见原则 6）。
- **Ripple 在每次渲染后刷新。** 列表由 `innerHTML` 重建，监听器随行一起销毁，因此 `refreshMotion()` 是幂等的、可反复调用。
- **CSS 只做 hover / 状态过渡。** 需要在进场和离场用不同曲线、或需要精确 `easeOutCirc` 的地方，交给 `TGMotion`。
- **独立窗口手工同步。** `src/tray-menu.html` 是另一个窗口，无法共享主样式表，其内联时序按 token 数值重复声明；改动 token 时必须同步该文件。
- **震动只作用于无 transform 的容器。** 它写内联 `transform`，作用于已带 transform 的元素会覆盖原有变换。

---

## 6. 验收标准

| 项 | 标准 |
| --- | --- |
| Token 覆盖 | `src/styles.css` 除循环周期（`sync-spin 1s`）与降级用的 `.01ms` 外，无裸时长 |
| 缓动分层 | 入场用 `--ease-enter`、离场用 `--ease-exit`、滑动 `--ease-slide`、弹跳 `--ease-bounce`、呼吸 `--ease-breath` |
| 降级正确 | 打开「减弱动效」或系统 `prefers-reduced-motion` 后，所有动效跳终态、布局无位移、无残留半透明 |
| 时长克制 | 任何单次转场 ≤ 320ms；仅大面离场可到 600ms |
| 无功能回归 | `npm run check` 通过；播放、同步、登录、缓存、多选行为不变 |
| 语法正确 | `node --check` 覆盖 `src/motion.js`、`src/app.js`、`electron/main.cjs`、`electron/preload.cjs` |

---

## 7. 文件

```text
src/motion.css    token 层、共享 keyframes、工具类（ripple/skeleton/breath/glare/stagger/leaving）
src/motion.js     TGMotion 运行时（缓动公式、tween、ripple、转场、错峰、震动、交叉淡化、计数、飞行）
src/styles.css    组件接线：哪些元素用哪条曲线，以及需要区分进/离场的地方
src/app.js        调用点：渲染后刷新 ripple、页面转场、菜单/弹窗/Toast 的离场、错误震动、飞行
src/tray-menu.html 独立窗口，时序数值需与 token 手工一致
```

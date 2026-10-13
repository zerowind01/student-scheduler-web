# LessonMate（学员排课系统）— 项目说明

> 本文件供 AI 编程助手（Claude Code / Codex / Cursor / Hermes 等）快速了解本项目。改代码前请先读完。

## 项目概览

- **产品名**：LessonMate（品牌名），一个机构学员排课工作台
- **架构**：纯前端（HTML + 原生 JS + Tailwind CDN），无后端服务器
- **主站**：`index.html`（电脑完整版）+ `mobile.html`（手机版）
- **线上**：https://lesson-mate.pages.dev （Cloudflare Pages，项目名 `lesson-mate`）
- **仓库**：GitHub `zerowind01/student-scheduler-web`

## 关键文件

| 文件 | 作用 |
|---|---|
| `index.html` | 电脑端主页面 |
| `mobile.html` | 手机端页面 |
| `js/app.js` | 电脑端逻辑 |
| `js/mobile.js` | 手机端逻辑（~2500行，单 IIFE） |
| `css/mobile-theme.css` | 手机端 Intercom 风格主题（渐变底/软陶卡/岛台导航） |
| `css/tokens.css` `css/styles.css` | 通用样式（尽量别动） |
| `design-preview/` | 设计稿（HTML+PNG），改 UI 前先看规范稿 |
| `LessonMate-项目优化方案.md` | 产品优化方案文档 |

## 数据层（⚠️ 最重要，键名/结构不能改）

- 存储：`localStorage` + Upstash 云同步（2秒轮询 + BroadcastChannel 跨标签同步 + URL 扫码同步）
- localStorage 键：
  - `edu_scheduler_students_v2` — 学员（课程内嵌 `st.courses[].name` / `remainingLessons` / `unitPrice`）
  - `edu_scheduler_schedules_v2` — 排课（`subject`，兼容 `courseName` 字段）
  - `edu_scheduler_teachers_v2` — 老师（`accessPin` 是**本地-only字段**，云同步用 `mergeTeachersKeepPin` 保护）
  - `edu_scheduler_debts_v2` — 欠课账（字段 `amount`）
  - `edu_scheduler_checkin_logs_v2` — 消课记录
  - `edu_teacher_session_v1` — 老师登录会话
  - `edu_scheduler_school_key` — 云同步键（默认 `school_demo_2026`）
- **欠课规则**：消课才扣课时；课时为负 = 欠课，`syncAllDebts()` 自动校准进欠课账（所有数据入口都要触发）
- **课时预警**：剩余 ≤2 节 = 待续费

## 权限模型

- 管理员：全部数据 + 教师管理 + 导出
- 老师视角：排课全量可见 + 全功能，**隔离仅财务 + 个人待办**；PIN 登录门（设置页可发PIN）；设置页 `msetIdentity` 可切身份
- 手机端底部导航 6 项：首页（默认）/ 课表 / 学员 / ＋ / 财务 / 设置

## UI 设计规范（Intercom 风格，已定稿勿随意改）

- 背景：奶油亮渐变 上 `#FDFBF8` → 下 `#F1EADE`
- 卡片：白色软陶质感（多层柔影，无细边框），圆角 18~24px
- 文字：炭黑 `#111` 主色，灰阶 `#626260` / `#9c9fa5`
- 状态色：粉 `#ff2067`=欠费、橙 `#fe4c02`=待续费、**Fin 橙 `#ff5600`=唯一主按钮色（仅课表页）**
- ⚠️ **禁止使用琥珀色（amber）**——唯一例外：学员头像调色板按人配色
- 底部导航：悬浮毛玻璃岛台 `.lm-island`（blur 26px、白 42% 半透明、高62、距边18）
- 手机首页顺序：本周课时 Hero → 统计四卡 → 今日课程 → **待补课（近 7 天请假未补）** → 续费跟进清单

## 部署

```bash
export CLOUDFLARE_API_TOKEN=<token>
npx wrangler pages deploy . --project-name lesson-mate --branch main --commit-dirty=true
```

- 部署完必须线上验证（curl 或浏览器）
- git push 走真 github.com（网络慢时重试 3~5 次）

## 开发注意事项

1. 改 `js/mobile.js` 后必须跑 `node --check js/mobile.js`
2. `mobile.js` 是单 IIFE，函数间作用域私有；跨作用域用 `window.__switchMobileView` 桥
3. 云同步会覆盖本地 localStorage（2秒轮询）——本地测试种子数据会被冲掉，注意时序
4. 渲染函数：`renderMobileHome` / `renderCalendar`（课表渲染门面，按 `calView` 分派到 `renderTimeline3` 或 `renderCalGrid`）/ `renderMobileStudents` / `renderMobileFinance`
5. 课表三档视图由**单一状态** `calView('day3'|'week'|'month')` 驱动，入口只有一个分段控件（`[data-calview]`）；旧的双入口 `calMode`+`calExpanded` 已移除，不要再加回来
6. 状态徽章（已消课/请假/正在上课/待消课/待上课）统一走 `buildStatusBadge(s, {isToday, interactive})`，判定口径在 `resolveStatusKey`，不要在别处重写一份
7. 弹窗用真按钮弹窗（`lm-sheet`），**不要用 `prompt()`**
8. 每次改完端到端验证真实用户操作路径，再部署
9. 周/月网格只有一份 DOM：`renderCalGrid` 永远渲染「选中日所在整月」，周档只是把 `#calGridWrap` 裁剪到一行（高度）+ 把 `#calGrid` 上移（位移）。**任何周↔月的视觉差异都必须由 `applyCalGridHeight(单一标量)` 推出**，不要在 calView 上分叉 DOM；跨月日期压暗也归 `#calGrid.is-month` 状态类管（周档那一行可能整行跨月）
10. 切档只有 `setCalView()` 一个入口（分段控件 / `#calGrabber` 手势滑条 / 键盘共用）；周↔月的高度动画由 GSAP 驱动（`animateCalGridHeight`），**不要**再往 `#calGridWrap` 上写 CSS `transition:max-height`（那条过渡无法跟手、也无法从中途接管）
11. `#calGrabber` 的拖动方向**固定为「下滑展开整月 / 上滑收起为周」**（`move` 里是 `h0 + dy`，`end` 里 `v > 0.5 → month`，键盘 `ArrowDown → month`）。滑条贴在日历底边，往下拉才跟着手指走；写成 `h0 - dy` 会变成「手指往下、滑条往上跑」的倒挂手感
12. 「老师进课表默认只看自己的课」由 `applyTeacherScopeDefault()` 负责，且**只能在渲染门面 `renderCalendar()` 里调用**（三档视图共用，写进 `renderTimeline3`/`renderCalGrid` 就只对那一档生效）。它每次老师会话只应用一次，之后用户手动改的筛选范围不被覆盖；`teacherLogout()` 负责把范围重置回 `all`，设置页「切换身份」进出都要调它，否则课表会卡在上一位老师的范围里
13. 底部弹层（`flex items-end` 的遮罩容器）**必须贴屏幕底部**：容器上**不要**加 `padding-bottom` 去给底部岛台留位置。岛台 `z-40` 本来就被弹层遮罩 `z-50` 盖住、点它也只会关弹层，留出高度只会让弹层悬空、把那条半透明灰带露在下面（看起来像块空隙）。内容与 home indicator 的间距由**弹层自身**的 `padding-bottom: calc(…rem + env(safe-area-inset-bottom))` 负责，这也是全站其它 `lm-sheet` 的做法
14. 动效分两套，**别混用同一个元素**：① 常驻 HTML、靠 `.hidden` 显隐的 `.modal-box` → CSS 过渡 + `@starting-style`（styles.css 第 7 节，带 `!important`，GSAP 写不进去）；② 运行时 `appendChild` 出来的浮层（课表操作菜单等，不挂 `.modal-box`）→ `uiAnim.sheetIn / sheetOut`（anim.js 第 5 节）驱动上滑进场 / 下滑退场。第 ② 类浮层**必须**有唯一的关闭出口（`closeActionMenu()`），不能各处零散 `menu.remove()` —— 直接摘节点就没有退场动画。遮罩要做成独立子节点 `[data-sheet-backdrop]`，否则一个节点同时挂"整块淡出"和"面板上滑"会互相牵制
15. 第 ② 类浮层的**动作要排在退场之后**：`closeActionMenu(() => 动作())`。同步执行会让紧跟着打开的弹窗和退场动画叠在一起；而依赖 FLIP / 高亮的动作（请假沉底等）在弹层还没走时执行，用户等于什么都没看见（被弹层挡着）。**能改数据后再关**的另说（消课三态要跑在按钮上，所以它是反过来：跑完才关）
16. **Tailwind 是预生成的静态样式（`css/tailwind.css`），不是 Play CDN。** 2026-10 换掉了 `cdn.tailwindcss.com`：它在页面里挂 `MutationObserver`，每次 DOM 变更都重新扫描/生成样式表，而本项目所有渲染都是 `innerHTML` 整块重建 —— 等于每渲染一次就付一次全量样式重算。实测（4x CPU 节流）冷态单个转场最长帧：周→月 143→18ms、点日期格（纯重渲染，无动画）108→18ms、容器切换 179→54ms。
    **改完任何 JS/HTML 里的 class 之后必须重新生成**：`tools\build-tailwind.cmd`（内部是 `npx -y tailwindcss@3.4.17 -c tailwind.config.js -i tools/tailwind-input.css -o css/tailwind.css --minify`），然后提升两个 HTML 里的 `?v=`。
    两条硬约束：① 两个 HTML 里的 `<link href="css/tailwind.css">` **必须留在 `</head>` 之前**（即排在所有自有样式之后）—— 旧 CDN 是把 `<style>` append 到 head 末尾的，工具类实际压过自有样式，挪到 head 前部会翻转层叠顺序；② **不要写 `text-${size}` 这类前缀拼接式 class**（扫描器扫不到，漏了就会掉样式），过渡属性也显式列出。
17. **退场补间不能用 `ease-in` 家族**（`power1.in / power2.in` …）：退出时用户盯的就是"第一帧有没有动"。实测面板高 420px / 退场 220ms：`power1.in` 前 70ms 只走 134px（32%），`power2.out` 走 225px（54%）—— 前者手感就是"先黏半拍再走"。`uiAnim.sheetOut` 现在用 `power2.out` + 0.20s（进场 0.34s，刻意非对称）。
18. **整站重渲染（`refreshMobileAll` 这类）不要和动画抢同一帧**：排在退场补间之后（`closeActionMenu(() => refresh)`），否则冷态下这块同步活儿能造出 100ms+ 长任务，正好砸在退场起步那几帧上。
19. **两端各有一份「共享原子类」，加新类要写两处。** 手机端引 `css/intercom-tokens.css`，电脑端**不引它**（引的是 `css/legacy-tokens.css`，两者都定义 `.lm-btn-ink` / `.lm-*` 同名类，是并行的两套）。往 `intercom-tokens.css` 加了 `.lm-btn-leave` / `.lm-sheet-del` 之后，电脑端会完全没有样式 —— 表现是「请假按钮没有底色、删除图标变成标题行里一个裸图标」，而且 `getBoundingClientRect()` 的尺寸断言**照样通过**（裸图标本来就很小）。写两端共用的原子类时，`legacy-tokens.css` 里必须再抄一份（沿用现有做法，两处都注明来源）。
20. **弹层里的动作按「可逆性」分配视觉重量**：不可逆的删除不许占一条满宽按钮（会和请假抢重量、也容易被扫读成主操作），收成右上角 40px 角标 `.lm-sheet-del`；标题块用 `.lm-sheet-head`（`padding-right:52px`）给角标让位，否则长学员名会钻到图标底下。请假用 `.lm-btn-leave`（暖黄 `#FEF3C7`/`#7C4A03`，口径「请假=黄」），别再用玫红 —— 玫红是删除的色，两者同色会让人以为点错就没了。
21. **补课链路（F11）只落三个字段，不新增集合。** `needMakeup`（源请假课是否要补）、`makeupOfId`（补课课次 → 源请假课）、`madeUpById`（源请假课 → 核销它的补课课次）。不加集合就绕开了「7 处 × 2 文件」那套高风险改动。**不是每次请假都要补** —— 请假时必须让用户二选一（`[data-ask]` 两步交互，两张面板同一容器内切内容，不新开浮层），**不许给默认值**：漏选等于直接错在账上。`needMakeup` 缺省 `false`，历史请假数据不能凭空冒出一堆待补。
22. **补课链路的双向标记由 `syncMakeupLink(sch)` 一处反推**，不变量：`madeUpById` 只在「源课仍是请假」且「补课课次已消课」时存在。于是「撤销消课 / 请假被还原 / 补课被删/改请假」都能自动把课退回待补，不用到处写 if。新增状态变更（消课、还原、请假、删除）**必须调它**（删除走 `cleanupMakeupLinks(id)`）。两端各有一份，语义必须一致。
23. **请假子态统一走 `resolveStatusKey`**：`leavePend`（待补，暖黄）/ `leaveDone`（已补，灰米）/ `leave`（不补，玫红）。电脑端没有这个函数，用同一组 `isPendingMakeup` / `isMakeupDone` 判定，别再各写一份。
24. **排补课预填源课时间必须 `snapTo5Min()`**：排课表单的时间框是 `step="300"`，而历史/导入数据的分钟位未必是 5 的倍数 —— 那种值填进去会让 **原生校验静默拦下提交**（用户点保存毫无反应，也看不出哪个字段有问题）。测试里特意留了一个非 5 分钟整的种子来钉住这条。
25. **待补池的回溯窗口是「含今天在内的最近 7 天」**，取数走两端的 `pendingMakeupList(scopeFn)`（`MAKEUP_WINDOW_DAYS = 7`），**禁止在渲染里另写过滤**。口径：只列「请假 + `needMakeup` + 未核销」——补完 / 当初选不补 / 超窗 都不出现，**清单空则整块不渲染**（不留空标题占位）。排序**按日期升序**（拖最久的排最前，先补最容易烂的那节）。今日行上的「排补课」只管今天，这块才是整周的口子；入口统一走 `openMakeupFor(schId)`（预填学员/时间，**日期取今天** —— 补课排的是接下来要上的课，不是回到请假那天去补）。手机端渲染在 `renderMobileHome`（`#mobileHomeMakeup`），电脑端在 `renderDashboard`（`#dashMakeupCard`，空则整卡 `hidden`）。注意今天请的假会同时出现在「今日课程」和这里：这是刻意的 —— 计数要是把今天排除掉，「还欠几节」就报不准了。
26. **「与上月对比」的环比徽章口径锁死为「本月累计 vs 上月整月合计」**，取数走两端的 `prevMonthLogs()`（跨年由 `Date` 自动回退），渲染走两端的 `momBadge(cur, prev, unit, fmt, big)`（`js/app.js` 与 `js/mobile.js` **各一份同语义副本，改口径必须两边一起改**）。三条硬约束：① **上月为 0 时不出徽章** —— 除零算出的「+∞%」是假数据；② 只给能由消课流水直接推出的两项（**本月课消 / 消课价值**），「待消存量 / 欠课学员」没有历史快照（充值不进流水、欠课账只存当前值），硬算会出假数；③ 徽章是卡片标题行**右上方**（label 左、徽章右，靠 `margin-left:auto` 顶开，**不要**为了它去引新 tailwind 类 —— `css/tailwind.css` 是预生成的）。样式类 `.lm-mom / .is-up / .is-down / .is-flat / .is-lg` 在 `css/legacy-tokens.css` 和 `css/intercom-tokens.css` **各一份**（并行的两套，见第 19 条）。颜色只用绿（升）/玫红（降）/暖灰（持平），不碰琥珀色。悬停 `title` 带两侧绝对值，口径可核对。三处 UI 都挂了徽章：财务页 4 卡（桌面 `renderPageFinance` / 手机 `renderMobileFinance`）+ 待排课抽屉的「本月经营」小卡（桌面 `updateFinancePanel`，见第 27 条）。
27. **桌面端「待排课学生」抽屉（`#sidebarStudent`，含底部的「本月经营」`#financePanel`）目前没有入口**：唯一打开它的按钮 `#btnBatchSchedule` 在 commit `fb1c3e3`（「课表去新建学员/批量排课」）时删掉了，但 `updateFinancePanel()` 还在照常往里写。**别把它当成用户看得见的 UI** —— 要在这块加东西（或改口径）时先确认入口是否已恢复，否则改动等于零。恢复入口只需在课表页给 `#btnBatchSchedule` 一个按钮（`expandSidebar()` / `collapseSidebar()` 都还在，事件绑定也还在）。

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
27. **桌面端「待排课学生」抽屉（`#sidebarStudent`，含底部的「本月经营」`#financePanel`）入口已恢复。**
    唯一开关 `#btnBatchSchedule` 曾在 commit `fb1c3e3`（「课表去新建学员/批量排课」）被删掉，抽屉连同底部的财务面板一起变成点不到的代码；本轮回补了顶栏按钮（课表页可见，**月历视图下由 `setCalendarViewMode` 收起**，避免抽屉压住月历）。`expandSidebar()` / `collapseSidebar()` 与事件绑定一直都在，恢复只需给按钮一个 id。
    **回补时暴露了两处被「入口缺失」掩盖已久的问题，都已修**：
    ① **筛选行被挤成竖排**：抽屉只有 288px 宽，4 个筛选按钮 + 两个下拉挤一行时按钮文字会逐字换行。改成「按钮一行（`flex-wrap` + `whitespace-nowrap`）+ 两个下拉一行（`flex-1`）」。
    ② **选中态从来没生效过**：`.filter-student-btn.active` 只定义在 `css/desktop-theme.css` 里，而**那个文件没有被任何 HTML 引用**（历史遗留，见第 19 条附近），JS 又只切 `.active` / `.lm-t2`，于是按钮的深色底一直靠 HTML 上硬编码的 `bg-[#111111] text-white` 装样子 —— 点别的筛选项时旧按钮不脱色，出现「两个都像选中」。已把规则搬进 `css/legacy-tokens.css`（`!important` + 双类特异性压过 `.lm-t2` 的 `!important`），HTML 上的硬编码底色删掉，**选中态由 `.active` 独家驱动**。
    另注：这处的「预警(≤2)」筛选**故意包含欠课**（负课时 ≤2 也算命中）—— 它是**待排课筛选**，欠课的人更该排课；与财务页「续费预警」口径不同是刻意的，别顺手统一（`tmp/renewal-check.mjs` 的 O6 用固定值 5 人钉住了这点）。
28. **退款（F12）复用 `checkInLogs` 记账，不新建集合。** 记法靠三个字段表达，这是本轮最关键的取舍：
    ① `deductedLessons = 0` —— 退的是「没上过的课」，**不该动「本月课消节数」**；
    ② `paymentAmount = -金额` —— 「课消价值 / 收入 / 环比徽章 / 明细 / 导出」全部**自动被扣减**；
    ③ `type = 'refund'` —— 与消课流水区分（**老数据没有该字段，读取处一律按消课处理**，判定统一走 `isRefundLog(l)`）。
    这样撤销快照（`pushUndo` 已含 `checkInLogs`）、云同步、跨标签同步、`refreshView` 都是现成路径，
    完全绕开了「7 处 × 2 文件」那套高风险改动。**别为了「台账更干净」再去拆一个 refunds 集合。**
    口径（用户当场拍板）：**支持部分退款**（按课时退，金额默认 = 节数 × 单价、可手改）；**从收入里扣减**（不另立指标）；
    入口在**学员详情**（桌面 `openStudentDetail` 的 `#detailRefundBtn` / 手机 `openMobileStudentDetail` 的 `#mDetailRefundBtn`），
    **不建第二个入口**。校验：退款节数 ≥ 1 且 ≤ 该包剩余课时，余额 ≤ 0（用光 / 欠课）直接拒绝 —— 退款只会让余额朝 0 变小，
    永远造不出负余额，**所以不要调 `syncAllDebts()`**。金额显示统一用 `fmtMoney()`（负数写成 `-¥1400` 而不是 `¥-1400`）。
    两处必须记住的口径细节：**「本月课消」节数不变、「课消价值」变负是正常的**（退的钱可能超过本月已消的价值）；
    **老师视角不摊分退款**（一笔退款不对应某一节课，若走 `logRelatedToTeacher` 的兜底分支会被每个老师重复扣一次），
    「本月老师课时」排行里也要跳过退款行，否则会冒出一行「未指定老师」。学员详情里退款**单列一个「退款记录」区块**，
    并且要从「消课记录」里排除（退款不是消课，混着读会把节数看糊涂）。双端各一份 `isRefundLog / recordRefundLog /
    refundableCourses / executeRefund / fmtMoney`，**语义必须一致**。核对脚本 `tmp/refund-check.mjs`（43 项）。
29. **低课时续费预警（F1）三处共用一套口径。** 阈值全站唯一 `LOW_LESSON_THRESHOLD = 2`（侧边栏筛选那处见第 27 条的例外），
    取数走两端的 `lowLessonRows(studentsScope, courseOf)`（`js/app.js` 与 `js/mobile.js` **各一份同语义副本，改口径必须两边一起改**），
    **禁止在渲染里另写过滤**。三处 UI：财务页「续费预警」卡（桌面右栏 / 手机在 4 张 KPI 之后）+ 看板「课时预警」（`#dashLowList`）。三条硬约束：
    ① **只收余额落在 [0, 阈值] 的课程包** —— 欠课（负数）**不进预警**，它们归「欠课名单」；两处同时列同一个人会让老师以为要退钱。
       余 0 节仍要提醒，文案统一走 `lowLessonText()`（0 写「已用完」，不写「剩 0 节」）。
    ② **按课程包逐条判，不按学员聚合**：同一学员可以同时「竖琴 2 节进预警 + 长笛欠课进欠课名单」（这正是分开两块的理由）。
    ③ 排序：剩余节数升序（最该续费的排最前），同数按学员名。
    点一行 → **直通充值**并预选到该课程包：`openRechargeModal(student, presetCourseName)` / `openMobileRechargeModal(student, presetCourseName)`
    （**第二个入参是本轮新增的**，课程下拉预选该项并且单价随之带出）。手机端老师视角沿用既有的 `relStudents` + `myCoursesOf` 收窄；
    电脑端财务页历来不分老师视角，保持一致。
    核对脚本 `tmp/renewal-check.mjs`（50 项）—— 其中 **H3 直接拿手机端实测行集合与电脑端逐条比对**，跨端口径不一致会立刻报红。
30. **断言「颜色 / 位置」时的两个陷阱（实操踩过）：**
    ① **带 transition 的元素，改完 class 立刻读 `getComputedStyle` 拿到的是过渡起始值（旧色）**。`.filter-student-btn` 有 `transition: background-color .15s`，
        同一个任务里点完按钮马上读，`.active` 明明切对了、颜色断言却报「样式没生效」（本轮白查了一轮）。
        正确做法：`await waitForTimeout(>过渡时长)` 再读，或把「改 class」和「读颜色」拆成两次 evaluate。
        反面样板：**读 `.classList` 不受影响**（它不等过渡），所以「class 对 + 颜色不对」这个组合基本就是撞上过渡了。
    ② **flex 容器里 `innerText` 会在 flex item 之间插换行**，想截「一行」别用 `[^\n]*`（卡头 `续费预警` + 阈值 span 是 flex 兄弟，
       只截到「续费预警」）。先 `innerText.replace(/\s+/g,' ')` 压平再匹配。

31. **桌面月视图（`#monthViewWrap`）按 Google Calendar 形态实现：事件整行铺在格子里，不再只画小圆点。**
    渲染全在 `renderMonthView()`（`js/app.js`）+ `css/styles.css` 第 17 节（`.month-cell-num` / `.month-ev` / `.month-evs`）。
    用户当场定的三条：**保留右栏**（380px，含当日清单与「查看周课表 →」）/ **沿用自有暖色 tokens**（不照搬 Google 的蓝灰）/
    **事件全部显示，放不下由格子内部滚动**（不做「还有 N 项」，也不让格子被撑高）。
    几条硬口径，改动时别踩：
    - **网格自身不滚动**：`#monthViewGrid` 是 `overflow-hidden` + `auto-rows-fr` 铺满高度；每格 `flex flex-col` 且
      **必须有 `overflow-hidden`**（grid item 一旦 `overflow != visible`，自动最小尺寸归零，行高才不会被 8 节课顶开）。
      事件区 `.month-evs` 是 `flex-1 min-h-0 overflow-y-auto`。滚动条**默认隐形、悬停格子才浮出**（42 格各挂一条常驻滚动条太吵）。
    - **点事件行 → `openScheduleActionMenu(sch)`**（对齐 Google 点事件）；**点格子空白 → 切 `monthSelectedDate` + 右栏跟随**。
      两件事靠 `#monthViewGrid` 上**一次性的事件委托**区分（网格 innerHTML 每次渲染都重建，绑在格子上会随渲染丢掉）；
      先判 `closest('[data-month-sch]')` 再判 `closest('[data-month-day][data-in-month="1"]')`。**非本月格故意不带 `data-in-month`** → 点了不改右栏。
    - **日期数字不是固定宽度正圆**：`min-width: 26px` + `padding: 0 5px` + `white-space: nowrap`。写死 `width: 26px` 会把
      1 号的「10月1」（对齐 Google 的月份前缀）折成两行。
    - **今天 = 橙描边圈；选中 = 炭黑实心。默认进月视图时选中日就是今天** → 必须补 `.is-sel.is-today`（橙外圈）这一条，
      否则选中态的实心圆会把「今天是哪一格」整个吞掉（本轮就是这个组合翻车，靠断言抓出来的）。
    - 已消课整行灰化（`.is-done`）；请假是**玫红 + 删除线 + 空心圆点**（`.is-leave`），对齐 Google 的「已谢绝」事件。
    - 窄列（1280 下约 108px/列）事件标题会截断成「19:30 钢琴 …」——这是「保右栏」的既定代价，不是 bug。
    核对脚本 `tmp/month-gcal-check.mjs`（78 项，宽屏 1600 + 窄屏 1280 各一遍），出图 `tmp/month-gcal-shots.mjs`。

32. **「点击后大块区域瞬换」要有一条空间线索，但只给每天/每屏看几次的地方加。**
    2026-10-14 用 `find-animation-opportunities` 技能扫了一遍双端，结论是**动效已经接近刚好，缺的是「桥」而不是数量**。
    落地四项，规则如下：
    - **月视图「选中日清单」进场**：桌面 `renderMonthDayList(..., animate)`、手机 `renderCalGrid()` 末尾调
      `uiAnim.listIn(el)`（`js/anim.js` 第 4.5 节，淡入 + 上浮 6px，0.18s `power2.out`，`clearProps` 收尾）。
      **只有用户主动换一天才播**：桌面由 `renderMonthView({ dayListIn: true })` 传入，调用点是「点格子 / 翻月 / 回今天」；
      **进入月视图本身不播**（那里已有 `viewIn(monthWrap)`，会重复）。
      手机端**拖动中（`calDrag`）绝对不播** —— 那一刻整页在跟手改高度，再插一个补间会互相抢。
      容器是常驻节点，所以 `listIn` 内部先 `killTweensOf` 再起新的（连点格子必须能被打断重放）。
    - **桌面「待排课学生」抽屉**（`#sidebarStudent` + `#batchSidebarBackdrop`，`css/styles.css` 第 18 节）：
      从左侧滑入 / 原路滑出。`display:none` 无法过渡，所以退场是「先加 `.lm-drawer-closing` 播动画 → 延迟 200ms 摘 `.hidden`」。
      **两个必须保留的硬保证**：① 定时器一定会跑完（transitionend 不来也照摘，否则遮罩会卡住界面）；
      ② `cancelDrawerHide()` 要能被重开取消。**`#btnBatchSchedule` 的判据看「最终会不会是开着」，不是「此刻有没有 `.hidden`」** ——
      退场途中节点还没带 `.hidden`，按 hidden 判会再走一次 collapse，而 collapse 在退场中会直接 return，
      症状就是「点了没反应、然后自己关掉」（本轮真实翻车，靠脚本里的「退场途中重开」用例抓出来的）。
      例外：**拖拽开始时的自动收起仍走直接切类**（`dragstart` 里那处）—— 拖拽要的是遮罩立刻消失，不该等退场动画。
    - **按压反馈**：`.month-ev:active`（月视图事件行）与 `.lm-card:active`（手机端学员/日程卡）加 `transform: scale(0.97~0.98)`，
      `transition` 里**显式列出 `transform`**（禁 `transition: all`）。**不要给 `.schedule-event-card` 加 `:active` 缩放** ——
      它被 `animateCardsStagger` 用 `clearProps:'opacity,transform'` 管着，两者会争同一个属性（会静默失效）。
      另：`.lm-tile` 只在**未被任何 HTML 引用的** `css/desktop-theme.css` 里，是死代码，别去改它。
    - **「点击排课」浮动指示条**（`#mobileTapScheduleBanner`，**在 `index.html` 里、不在 mobile.html**）：
      **原先挂 Tailwind `animate-bounce`（整条横幅持续弹）**，属 `anim.js` 文件头明令禁止的「循环动画」，已删除，
      改为 `.lm-tap-banner` 的 `opacity + translateY` 进出场（`css/styles.css` 第 19 节）。
      **它靠 `left:50%` + `translateX(-50%)` 居中 —— 动 `transform` 就必须把 `-50%` 一起带上**，
      所以居中从 Tailwind 的 `-translate-x-1/2` 搬进了这个类（漏掉会跳到屏幕左侧）。
      退场同抽屉：先加 `.lm-tap-banner-out`，延迟 180ms 再摘 `.hidden`；**重开前必须先 `clearTimeout`**，
      否则挂起的定时器会把刚显示的横幅又藏掉。点上的 `animate-ping`（呼吸点）**保留**，它是「进行中」的状态指示。
    - **reduced-motion**：`css/tokens.css` 的全局兜底会把 `transition-duration` 压到 0.01ms，但**位移要单独去掉**（位移才是眩晕来源），
      上面两个组件都在第 18/19 节的 `@media (prefers-reduced-motion: reduce)` 里改成「只留 120ms 淡入」。
      **注意 `translateX(-50%)` 是布局不是动效，RM 下也必须保留**（指示条那条已按此处理）。
    - **明确不做**：底部 tab / 侧边栏切页整页淡入（高频 + 撞最重的重渲染帧，代码里早有注释，别翻案）；
      学员列表 stagger（搜索框即搜即渲，每敲一个字会重播一遍）；看板/财务数字与柱状图的进场（**用户在读的功能性数据**，
      且云同步 2s 轮询会反复打断重播）；`.lm-tile`/`.nav-page-btn` 之类死代码或纯导航元素的按压。
    - 核对脚本 `tmp/motion-gaps-check.mjs`（39 项：机制 / 终态 / 真实路径接线 / 连点稳定 / RM 降级），出图 `tmp/motion-shots.mjs`。
      **踩坑**：`file://` 下 `document.styleSheets[].cssRules` 全部读不到（CORS）→ 断言「规则是否存在」只能查 CSS **源文本**；
      **`display:none` 的元素 `getComputedStyle().transform` 恒为 `none`**，测位移前必须先让它可见；
      **元素在 0×0 容器里时 transform 也恒为 `none`**（构造成「没切到课表页就点月视图」会误判成「过渡没生效」）。

33. **电脑端财务页支持「按老师查看」（2026-10-16）。** 需求原话：「除了全校的财务信息，也要能分别看每个老师单独的」。
    - **状态是 `financeTeacherFilter`（`'all'` 或 teacherId），故意不复用课表页的 `selectedTeacherFilter`**：
      顶栏那个选择器只在课表页可见（`switchPage` 里 `mainTopbar` 加 `header-hide-desktop` 的条件是 `page !== 'schedule'`），
      若共用，用户在课表页筛了某老师、切到财务页会看到数字变了却找不到原因（选择器根本不在屏幕上）。
    - **取数三件套**：`teacherRelatedStudent(st, teacherId)` / `teacherRelatedCourse(st, courseName, teacherId)` /
      `teacherRelatedLog(log, teacherId)`，与手机端 `js/mobile.js` 的 `studentRelatedToTeacher` / `courseRelatedToTeacher` /
      `logRelatedToTeacher` **同语义**（那边靠 `teacherSession` 登录态，这边靠参数）。**改判定逻辑必须两边一起改**，
      核对脚本 `tmp/finance-teacher-check.mjs` 的 I 段会拿手机端老师登录态的实测行集合与电脑端逐条比对。
    - **切到某老师后「全部指标」都收窄**（用户拍的板）：4 张 KPI（本月课消 / 课消价值 / 待消存量 / 欠课学员）+
      本月收入明细 + 续费预警 + 欠课名单 + 课时存量价值 + **环比徽章**。少收窄任何一个都会出现「这个数到底是谁的」。
    - **退款不摊分到老师**（与手机端一致）：一笔退款不对应某一节课，`scheduleId=''` 会让 `teacherRelatedLog` 的兜底分支
      （`!sch` → true）对**每个**老师都返回 true → 一笔退款被重复扣。故老师视角先 `!isRefundLog(l)` 过滤，
      于是 `monthRefund` 在老师视角下天然为 0、表头的「已退 ¥N」也不会出现。
    - **课程包归属只看排课**（照抄手机端）：`teacherRelatedCourse` 查的是 `schedules` 里该老师（主讲或助教）上过/将上的课，
      **不看 `st.teacherIds`**。所以「被 `teacherIds` 关联但零排课」的学员会算进 `relStudents`（人在名单里）却一个课程包都不归该老师
      → 待消存量计 0。这是既有语义，别顺手"修"成看 teacherIds，否则两端立刻不一致。
    - **同一学员可拆给两位老师**：孙八的竖琴（排课给 t1）算 t1、长笛（排课给 t2）算 t2 → t1 视角只看到竖琴那 2 节，
      长笛的欠课也不进 t1 的欠课名单。核对脚本 B16/B17 用「孙八出现但『长笛』一个字都不该露」钉住这点。
    - **老师被删除 → 静默回退全校**：`vSel.value = tId` 落空时（下拉里没这个 option）把状态重置成 `'all'` 并重设 value，
      **不重渲染**（避免递归）。
    - 核对脚本 `tmp/finance-teacher-check.mjs`（60 项：全校 14 / t1 17+1 / t2 11 / 视角隔离 5 / 窄屏与零老师 4 / 跨端 7），
      出图 `tmp/finance-teacher-shots.mjs` → `tmp/fin-f1-all / f2-t1 / f3-t2-narrow.png`。
    - **两个测试坑（踩过）**：
      ① **`page.addInitScript(fn)` 会把函数序列化后丢进浏览器执行 —— 函数体里引用的外部常量在那边根本不存在**，
         静默抛 `ReferenceError`，而**函数里排在前面的字面量 `setItem` 已经成功写入了**。
         症状极迷惑：`students` / `teachers` / `debts` 都生效，只有引用了 `T1` / `MONTH` 的 `schedules` / `checkin_logs` 是空的
         → 现象是「全校视角课消/明细全是 0，但待消存量和欠课人数正常」。
         **fixture 必须完全自包含**（日期在函数内部自算），或走 `addInitScript(fn, arg)` 传参。
      ② **环比徽章排在数值前面**（「本月课消 ▲ 300% 4.0 节」）→ 断言别取「第一个数字」（会抠到百分比）。按单位匹配 `/\d+\.\d 节/`。

34. **桌面看板「今日时间轴」的欠课标签按「这一行的科目」判，不是学员级（2026-10-16 修）。**
    - **症状**（用户报的）：「一位学生排了钢琴课显示欠费，但当前的钢琴课程没有欠费，欠费的是她声乐课程。」
    - **原因**：`renderDashboard` 里那行 `debtTag` 只判 `debts.find(d => d.studentId === student.id && d.amount > 0)`，
      **完全没比对科目** → 学员只要有**任一**科目欠费，她当天**所有**课的行都挂「欠课」。
      而 `debts` 本来就是 `(studentId × courseName)` 维度的账（见第 5 条 / `syncDebtForCourse`），
      查询漏掉 `courseName` 这一半条件，等于把账降级成了学员级。
    - **修法**：新增 `scheduleDebt(sch, student)` —— 科目名**优先取排课指向的课程包名**（`sch.courseId` → `student.courses` 里的 `name`），
      **回退** `sch.subject`（老排课可能没有 `courseId`）。标签 hover 的 `title` 写明「〈课程包〉 欠课 N 节」，
      免得只看到「欠课」两个字还得去猜是谁欠、欠的哪一科。
    - **哪些地方该科目级、哪些该学员级**（改之前先想清楚渲染的是「一节课」还是「一个人」）：
      - **科目级**（按节课渲染）：看板今日时间轴。此外周课表课卡、月视图事件、手机端今日课程行**本来就没有**这个标签。
      - **学员级**（按人渲染，本轮**刻意保留**）：学员卡片 / 财务页「欠课名单」/ 课程操作菜单的
        「⚠ 该学员有欠课：声乐 3节」—— 最后这个虽然是「节课」的弹层，但它**列了科目名**，不误导，
        而且老师点开某节课时知道「她还有别的科目欠着」是有用信息。
    - **两端差异是「有无该功能」不是「口径不一致」**：手机端 `renderTodayRow` 从来没挂过欠课标签，
      所以别为了「两端一致」往手机端补一个（会挤爆那行）。核对脚本 F2 钉住了这点。
    - 核对脚本 `tmp/debt-tag-check.mjs`（21 项：用户场景 / 同行同人对照 / 两科都欠 / 请假与已消课 / courseId 回退 /
      学员级视图未被误改 / 手机端无此标签），出图 `tmp/debt-tag-shots.mjs` → `tmp/debt-tag-d1-dash / d2-today.png`。
    - **一个测试选择器的坑**：`#studentListContainer` 是**课表页那个「待排课学生」抽屉**的容器；
      学员管理页的列表是 `#pageStudentsList`，且卡片类名是 `lm-stat-card` + `data-student-page-id`（**不是** `.student-card`）。
      两个别搞混（本轮断言先踩了一次）。

35. **手机端三档日历的翻页步长：只有「周」档是按天，别再改回按周**（2026-10-16 修复回归）
    - 三档共用同一条 `#mobileDateBar`（翻页按钮 + `#mobileDateText`）和 `shiftCalPage(dir)`：
      **3日档 ±3 天**（`mobileStartDate` 整窗平移，走 `setupCalendarSwipe` 里的 `dir * 3`）/
      **周档 ±1 天**（`calSelected` 按天步进）/ **月档 ±1 月**（保持"选中日序号"）。
    - **为什么周档是按天而不是按周**：周档渲染的其实是**整月网格**（`#calGrid` 从 `getMonday(月初)` 到月末），
      只是靠「裁剪到一行 + 上移」露出选中周。所以它的操作对象是**唯一的选中日游标**，
      手势语义就是「换选中的那一天」；跨周时网格自己上移一行，用户看到的是"一格一格挪"。
      月档才是真正的"翻页"（整月换），也才该整月跳。
    - **⚠️ 回归史（这是第三次被改坏的风险点）**：
      `66d87a4` 专门做过「week-calendar swipe now steps one day (was a full week)」；
      之后 `f7ed5ce`（三档视图整合）把 `shiftCalPage` 的周档分支写回 `addDays(sel, dir * 7)`，
      **没有任何测试报红**，直到用户报「又变成上下周了」。改这段前先看 `shiftCalPage` 上方那段注释。
    - **按钮文案必须与真实步长一致**，唯一写入点是 `syncCalViewChrome()`：
      周档「前一天 / 后一天」、3日档「前3天 / 后3天」、月档「前月 / 后月」。
      按钮与手势**共用** `shiftCalPage`，所以改了步长就必须改文案 ——
      写着「前周」却只跳一天，比手势本身更让人费解。`mobile.html` 里的静态文案也要同步（首屏不闪）。
    - 手势判定（`setupCalSwipe`，绑 `#viewCalweek`）：`|dx| > 48px` 且 `|dx| > |dy| * 1.2` 且耗时 `< 900ms`，
      move 阶段以 `|dx| > 14 && |dx| > |dy|` 锁定横向。别顺手放宽阈值 —— 按天步进本来就更"敏感"，
      放宽后会跟纵向滚动抢手势。
    - 跨周的断言**不要写「首行日期变了」**：跨周但没跨月时，网格范围仍是同一个整月，
      首行永远是那月的第一个周一（`firstRowDate` 不该变）。要断言的是
      **「选中格在网格里的布局位移 + 网格 transform 位移 ≈ 0」**（= 选中格在屏幕上纹丝不动），
      以及反向滑同样次数能精确回位（按天步进不能有累积漂移）。
    - 核对脚本 `tmp/cal-swipe-day-check.mjs`（38 项：A 初始态 / B 按天步进与按钮同口径 / C 跨周网格跟随与可逆性 /
      D 月档仍翻月 / E 3日档仍跳 3 天 / F 短距·纵向·慢速守卫 / G 点格子）。
      **护栏自检法**：把 `addDays(sel, dir)` 临时改回 `dir * 7` 再跑，应看到 B1~B7 + C1/C3/C4 报红；
      这 9 条就是用户在真机上遇到的现象，改完一定复查它们还绿着。
      出图 `tmp/cal-swipe-day-shots.mjs` → `tmp/swipe-day-1today / 2next / 3nextweek.png`。

36. **新建排课必须显式写 `status`，否则 ICS 日历订阅会整条漏掉**（2026-10-17 修）
    - **症状**：界面上明明有这节课，但手机日历订阅（ICS）里没有；老课都在，**偏偏新排的没有**。
    - **根因链**：
      1. `makeSchedule()`（`js/app.js` + `js/mobile.js` 各一份）构造排课对象时**没写 `status` 字段**；
      2. `saveData()` → `pushToCloudSync()` 是 `JSON.stringify(schedules)` **原样推送**，不做任何补全；
      3. 于是云端那条记录**压根没有 `status` 这个键**；
      4. `functions/api/ics.js` 用的是**白名单**判断 `if (s.status !== 'scheduled' && s.status !== 'completed') return;`
         → `undefined` 不等于任何一项 → 整条被跳过。
    - **为什么界面看不出问题**：`normalizeSchedule()`（`if (!sch.status) sch.status = 'scheduled'`）只挂在
      **加载 / 云端同步 / 导入**这几条入口上（`js/app.js` 的 134/1385/647/740/776 行）。
      新建的对象**不经过它**直接 push 进数组，而界面渲染按「非完成、非请假」处理，恰好表现正常。
      一刷新页面 → 加载时 normalize → 内存对象补上 `status` → 下次保存才会推回去。
      **所以这个 bug 有"自愈"的假象：刷新一下就好了，很难复现**。
    - **修法（三处，缺一不可）**：
      1. 两个 `makeSchedule` 都显式加 `status: SCHEDULE_STATUS.SCHEDULED`（治本）；
      2. 数据导入（`importScheduleData` 的 overwrite / merge 两条分支）都要 `.map(normalizeSchedule)`；
      3. `functions/api/ics.js` 改成 `const st = s.status || 'scheduled';`（**兜底**）——
         这一步是**必须**的：已经推到云端的那批缺 `status` 记录不会自己变好（除非用户刷新页面再保存一次）。
         兜底口径与前端 `normalizeSchedule` 完全一致，不会误收请假/取消。
    - **改 `ics.js` 的判断时记住它是白名单**：`completed` 分支也要用同一个 `st`（`const completed = st === 'completed'`）。
    - **运维提醒**：`functions/api/ics.js` 是 Cloudflare Pages Function，**必须重新 deploy 才生效**（不是改静态文件就行）。
    - 核对脚本 `tmp/ics-check.mjs`（35 项，用假 Upstash 真跑 `onRequest`，不依赖网络/真实同步码）：
      A 缺 status 必须进日历（用户场景）/ B 状态白名单与完成课透明化 / C 老师三字段匹配 / D 时间窗与跨天 /
      E ICS 结构（UID/DTSTAMP/折行 ≤75 字节/CRLF）/ F 参数校验与 `no-store` / G 按老师姓名订阅。
      **护栏自检法**：把兜底改回 `const st = s.status;` 再跑，应看到 A2/A3/A4 报红、事件清单里少掉那条课。
    - **写 ICS 断言的两个坑**：① 别用 `BEGIN:VEVENT[\s\S]*?VALARM` 判"某节课有没有提醒"，
      非贪婪会越过 `END:VEVENT` 抓到**后面**那节课的 VALARM（本轮先踩了这个，伪造出一个"失败"）；
      ② `DTEND` 是 **UTC**，跨天课别拿本地日期算（23:30 CST + 60min = 次日 00:30 CST = **当日** 16:30Z）。

37. **一节课永远 = 1 节，计费不按时长折算**（2026-10-17 修，Jackson 定的口径）
    - **症状**：财务页「本月课消」节数和「课消价值」偏大；90 分钟的课在流水里是 `deductedLessons = 2`、
      金额 = 2 × 单价、课程包余额多扣 1 节。
    - **根因**：`getLessonCost()` 按时长折算，而且**两端基准还不一样**：
      `js/app.js` = `Math.max(1, Math.round(durationMinutes / 60))`，`js/mobile.js` = `Math.max(1, Math.round(durationMinutes / 45))`
      → 90 分钟的课两边都 = 2 节；一台电脑上一节 60 分钟课 = 1 节，同一节课在手机上再算一遍可能又是别的数。
    - **口径**：**与 durationMinutes 完全无关**。时长只影响课表排版、冲突检测、ICS 的 DTEND。
      这条是**用户明确要求**的（"不管我设置的课程是多长，就是算一节课的钱"）。
    - **改法**：`getLessonCost()` 恒 `return 1`（两端各一份，**保留函数和入参签名**——
      将来若要支持「一节课记 N 节」只需改这一处，别在各处写死 1）。
    - **历史账目一起回正**：新增 `migrateLessonUnits()`（两端同语义），在 `loadData()` /
      `pullFromCloudSync()` / `checkUrlSyncData()` 里各调一次，且**必须在 `syncAllDebts()` 之前**
      （欠课账是按 `remainingLessons` 反推的，先改余额再对账）。规则：
      1. 只看 `checkInLogs` 里 `deductedLessons > 1` 的记录 —— 消课流水的节数只可能是 1（正常）或 0（退款），
         **>1 的必定是旧折算产物**，所以跑完不会再有 >1 → **天然幂等**，刷新/多设备各跑一遍都安全；
      2. 流水：节数回 1、金额 `/= oldUnits`（旧值就是 节数 × 单价）、`remarks` 追加「历史校准：…」；
      3. 课时包：`remainingLessons += oldUnits - 1`，定位顺序 = 排课的 `courseId` → 流水上的 `courseName`
         （流水的 `courseName` 存的是 `schedule.subject`，可能不等于课时包名）；
      4. **退款流水（`isRefundLog`）一律不碰** —— 它没有节数概念，`deductedLessons` 本来就是 0；
      5. 负余额不要清零：0 节时上了一节 90 分钟的课，正确欠课是 1 节（旧口径记成 2 节欠账）。
    - **坑：测试种子数据不能再用「一笔 N 节」**。`tmp/refund-check.mjs` 原来用一条 `deductedLessons: 3 / ¥600`
      的种子，被校准成 1 节 / ¥200 后 12 项断言全红；要表达「本月已消 3 节」请写成**三条 1 节记录**。
      `tmp/dash-bars-test.mjs` 同理（柱高按天聚合，同一天 3 节 = 同一天 3 条记录）。
    - 核对脚本 `tmp/lesson-unit-check.mjs`（39 项）：A 45/60/75/90/120 分钟消课都 = 1 节 /
      B 历史校准（含负余额与退款不被碰）/ C 操作菜单文案「消课签到（1节）」/
      D 老数据无 `durationMinutes` 与 `=0` 不炸 / E 财务 KPI 跟着走 / F 刷新幂等 / G 手机端同口径。
      **护栏自检**：把 `getLessonCost` 改回按 `/60` 折算 → A5/A6/A7/A8 报红（90/120 分钟变 2 节、¥400、余额 8）；
      把 `migrateLessonUnits()` 注释掉 → B1~B7 报红。
    - 当时发现的「删除排课白送课时」问题已在第 38 条修掉。


38. **删除排课 = 回滚这节课「真实发生过」的一切；退还课时只认消课流水，不看 status**（2026-10-17 修）
    - **症状**：删一节**待上课**的课，课程包 `remainingLessons` 反而 +1 —— 待消存量越删越多（白送课时）。
    - **根因**：`handleDeleteScheduleWithCleanup()`（桌面）用 `if (sch.status === SCHEDULED) remainingLessons += getLessonCost(sch)`
      来"退还"。但**排课环节从来不扣课时**（`makeSchedule` 只写对象、不碰余额），只有消课（`executeCheckIn`）才扣。
      所以给待上课退课时 = 凭空加一节。手机端更糟：`deleteMobileScheduleWithScope()` 既不退课时、**也不删消课流水**
      （删掉一节已消课的课，财务流水还挂在那儿，指向一个不存在的排课 id）。
    - **口径（两端统一）**：删除一节课 = 把这节课存在过的所有痕迹一起回滚。
      而"这节课扣过多少课时"的唯一可信来源，就是它自己的**消课流水之和**：
      ```js
      const deductedUnits = checkInLogs
        .filter((l) => l.scheduleId === id && !isRefundLog(l))
        .reduce((sum, l) => sum + (Number(l.deductedLessons) || 0), 0);
      ```
      → `deductedUnits` 就是该退的节数，退完再删流水。四种状态自动正确：
      待上课（无流水）= 0 节不退 ✅ / 已消课（1 条 1 节）= 退 1 节 ✅ / 请假（无流水）= 不退 ✅ / 退款流水（`deductedLessons=0`）= 不计 ✅。
      **别再用 status 猜**，也别读 `getLessonCost(sch)` —— 那是在"这节课该扣几节"，不是在问"它到底扣过没有"。
    - **同时把手机端对齐到桌面语义**：删课也要 `checkInLogs.filter(l => l.scheduleId !== id)`。
      否则两端删同一节课，一边财务回滚、一边数字不动。
    - **确认文案跟着改**：`'确定删除该课程？待上课状态的课程会退还已扣课时。'` →
      `'确定删除该课程？已消课的记录会一并撤销，并退还对应课时。'`（旧文案描述的是错的语义）。
    - **撤销安全**：`pushUndo()` 快照本来就含 `students` + `checkInLogs`，所以课时加减都能被撤销还原，不用额外处理。
    - **欠课账不在这里同步**：`debts` 是按 `remainingLessons` 反推的派生数据，全站约定是**加载时**由 `syncAllDebts()` 校准
      （撤销消课、改请假这些同样改余额的路径也都不当场同步），别在这个函数里单独调，否则口径分叉。
    - 核对脚本 `tmp/delete-credit-check.mjs`（39 项，桌面 A 段 + 手机 M 段）：
      A0 基线 / A2 删待上课不退（旧实现 10→11）/ A3 确认文案 / A4 撤销还原 /
      A6·A8 删已消课退 1 节且流水同步移除 / A10 删请假不退 / A12 退款伪流水不计退还 / A13 无关流水不被误删 /
      A15·A16 「本次及之后」系列逐节清理；M 段同语义逐条比对。
      **护栏自检**：把桌面端改回 `if (status === SCHEDULED) += getLessonCost()`，应见 A2/A6/A8/A10/A12/A16 共 6 条报红。
      ⚠️ 本地 `file://` 打开时 favicon 是绝对路径 `/icons/...`，控制台必有一条 `Failed to load resource`，
      那是打开方式的噪音，脚本里已过滤；别把它当成 JS 报错。

39. **学员详情的消课记录：合计按全量、时间必须转本地、点行直达课程菜单**（2026-10-18）
    - **入口结构变了**：`openStudentDetail()` 拆成「重置展开状态 + `renderStudentDetail()` + `showModal()`」。
      因为整块是 `innerHTML` 重建的，而「查看全部」要触发重渲染 —— 展开状态必须放在函数外的
      `detailLogExpanded`，且 `openStudentDetail()` 每次都重置成 `false`（重进详情先看最近 30 条）。
      手机端同理：`openMobileStudentDetail()` + `renderMobileStudentDetail()`。
    - **累计合计按全量算**（`allLogs`），不是渲染出来的那 30 条 —— 分页只影响"渲染多少"。
      合计口径：节数 `Σ deductedLessons`、金额 `Σ paymentAmount`，**退款流水（`isRefundLog`）先排除**。
    - **时间必须转本地**：`checkInTime` 是 `new Date().toISOString()`（UTC ISO），
      `logClock()` 要 `new Date(l.checkInTime)` 再取 `getHours()/getMinutes()`。
      **别切字符串**（`.slice(11,16)`）—— 会正好差 8 小时。本轮第一次跑测试就是被这个抓到的（显示 06:30）。
      日期仍然优先用流水上的 `date`（老数据可能没有 `checkInTime`）。
    - **补课 / 请假状态不要新造判断**：消课行用 `isMakeupLesson(sch)` 打「补课」标；
      请假行用 `isPendingMakeup(s)` / `isMakeupDone(s)` 打「待补课 / 已补课」。
      三者都只认排课上的 `makeupOfId` / `needMakeup` / `madeUpById`，与课表一致。
    - **点记录行直达课程菜单**：`hideModal(详情)` → 280ms 后 `openScheduleActionMenu(sch)`（手机端
      `openMobileScheduleActionMenu`）。这让「想撤销某条消课」不用再回课表翻。
      **两种情况要守住**：① 排课已被删（`scheduleId` 找不到）→ `showToast('这节课的排课已被删除…')`
      且**不能顺手关掉详情**（用户还在看）；② `scheduleId` 为空（老数据/退款）→ 提示没有关联排课。
    - **监听用 `body.onclick = …` 赋值，不要 `addEventListener`**：body 是常驻节点，每次渲染都挂一个会叠加，
      点一次触发 N 次。
    - **备注 `truncate`（单行省略号）**，别让一条长备注把行撑高。展开后**去掉 `max-h-56` 限高**
      （`${detailLogExpanded ? '' : 'max-h-56'}`）—— 展开 30+ 条还塞在 224px 小框里二次滚动很别扭，
      让弹层自己滚。折叠时保留限高，半条露出反而暗示"可滚动"。
    - **`.btn-quiet` 其实没有样式**：它只定义在 `css/desktop-theme.css`，而那个文件**没有任何 HTML 引用**
      （同一类坑在 `.filter-student-btn` 上踩过）。桌面两个次要按钮改成显式
      `bg-white border border-[#f0ebe2] hover:bg-[#f8f5f0]`，别再往 `.btn-quiet` 上加东西。
    - `courseName` 渲染要兜底 `|| '课程'`（导入/老数据可能为空，否则页面上直接出现 `undefined`）。
    - 核对脚本 `tmp/log-detail-check.mjs`（35 项）：A 合计与分页 / B 时间·补课标·请假状态·截断·无单价 /
      C 展开与点击（含"排课已删"两个分支）/ M 手机端同语义 / N 空数据。
      两个断言陷阱：① 找备注节点要取**最内层**（`children.length === 0`），外层 `flex-1` 容器
      `textContent` 也含那段字，会误判成"没有 truncate"；② 断言 toast 文案读 `#toastMsg`，
      别用 `#toast`（它可能还留着上一条"操作成功"）。
      测「查看全部」之后要保持展开态才能点到底部那些行 —— 重开详情会重置展开状态。

40. **课时总结图：纯 Canvas 手绘，用图片高度验条数**（2026-10-18，Jackson 提的需求）
    - **需求原话**：「需要总结十节课或者任意节课，生成图片发给家长看」。
      所以入口放在**学员详情**（`课时总结图` 按钮），范围可选 5/10/20/30/全部 + 可选起止日期。
    - **不引 html2canvas / dom-to-image**：本项目 PWA 无构建步骤、要能离线，多一个第三方库就多一份失效风险，
      而且截图库在长图/字体/滚动容器上有一堆不可控行为。Canvas 手绘 ~200 行，完全可控。
    - **几何是写死的**：宽 1080，高 `= 780 + 96 × 条数`（`LIST_TOP 640 + n*96 + 44 + 96`）。
      好处是**"取了几条"可以用 `img.naturalHeight` 直接断言**，比截图比对和 OCR 都稳、也更快。
      改布局常量就要同步改 `tmp/lesson-summary-check.mjs` 里的 `IMG_H(n)`。
    - **取数**：`count = 0` 表示"全部"，但**上限 `SUMMARY_MAX_ROWS = 40`**（再长一张图在微信里就糊了），
      被截断时 `rangeText` 会写「最近 40 节（共 N 节记录）」。日期范围与节数**叠加生效**（先过滤再截前 N）。
    - **KPI**：本期上报节数（`Σ deductedLessons`，不是条数）、本期课时费（`Σ paymentAmount`，为 0 显示 `—`
      而不是 `¥0`）、当前剩余课时（默认**所有课程包合计**；按课程出图时只算该课程包，见下条）。
      明细下方还有一行科目汇总（「钢琴 7 节 · 声乐 2 节」），家长最关心这个。
    - **保存 / 分享**：先 `navigator.canShare({ files: [file] })` → `navigator.share()`（手机能直接发微信），
      不支持（桌面）再退回 `<a download>`。`AbortError` 是用户自己取消，**必须静默返回**，不能当失败提示。
    - **Canvas 的两个必要兜底**：① `ctx.roundRect` 是 Chrome 99+，老内核要用 `arcTo` 手画；
      ② 文字没有 `truncate`，`summaryFit()` 自己量宽度加省略号。
      字体用系统栈 `PingFang SC / Microsoft YaHei / Noto Sans CJK SC`，**不要引 web font**
      （canvas 不会等字体加载完再画，会退化成默认衬线体）。
    - **两端各一份实现**（与项目其他双端逻辑一致）：`buildSummaryRows` / `buildSummaryMeta` /
      `buildLessonSummaryCanvas` / `exportSummaryImage` 同名同语义，弹层 id 前缀 `summary*` / `mSummary*`。
    - **坑：`max-h-[52vh]` 这类任意值 class 必须重建 tailwind**，否则类不存在、静默没样式 ——
      本轮改预览框限高时就是这样，截图看着"没变化"，其实是 CSS 里根本没这条。
    - 核对脚本 `tmp/lesson-summary-check.mjs`（48 项）：S 入口与默认值 / T 取数范围→图片高度 /
      U 像素采样（橙带、暖白底、深色文字数）/ V 下载文件名 / P 手机同尺寸 / Q 走分享不重复下载 /
      G 多课程按课程出图 / M 手机端同上 / E 空数据。
      出图 `tmp/lesson-summary-shots.mjs` → `summary-d1-detail / d2-modal / d3-preview / d4-course-modal /
      d5-course-preview / img-10 / img-course / m1-detail / m2-preview.png`。

41. **按课程出总结图：一个学员多门课必须能分开出**（2026-10-18 第 2 轮，Jackson：「有不同课程的学生，需要按课程生成总结图」）
    - **课程下拉只在课程数 ≥ 2 时渲染**（`#summaryCourse` / `#mSummaryCourse`）。只有一门课时不出现，
      别为了"两端一致"补个单选题。选项来源 `summaryCourseNames()` = **课程包 ∪ 消课流水出现过的课程名**
      —— 历史改名/课程包已删的旧课也要能选到，否则那部分钱永远出不了图。
    - **过滤顺序：课程 → 日期 → 节数**。「最近 10 节」的口径是**这门课**最近 10 节，不是"全科最近 10 节里挑这门课的"。
      传给 `buildSummaryMeta` 的 `allLogs` 必须是**课程收窄后**的集合，否则截断文案「共 N 节记录」会算错。
    - **剩余课时跟着课程走**：选了课程只累加该课程包的 `remainingLessons`（家长问的是"这门课还剩几节"）。
      课程包匹配不到（只剩历史流水）时显示 `—` 而不是 `0 节` —— 别谎报。
    - **图片标题带课程名**：`课时总结 · 声乐`（`meta.titleText`，`summaryFit` 限宽避免撞右侧"生成于"）。
      同一学员的多张图在微信里必须一眼分得清。文件名同步带课程：`课时总结_学员_课程_日期.png`。
    - **换条件就收起旧预览**：`courseSel/countSel/fromInput/toInput` 的 `change` 一律 `pendingCanvas = null`
      ＋ 隐藏预览框。否则预览里挂着上一门课的图，用户点保存就发出去了（生成失败分支同样要收起）。
    - 单课程学员路径完全不变，所以 G/M 段用**多课程种子**（钢琴 3 + 声乐 7 + 古筝 1 + 一分没上过的乐理）：
      高度断言天然能证明过滤生效（7 条 vs 3 条 vs 11 条不可能同时成立）。
      手机端找学员卡片是 `.lm-card`（**不是** `div[class*="bg-white"]`，按名字找认准这个类）。

42. **导入历史消课：只追加流水，一行 N 节必须拆成 N 条**（2026-10-18 第 3 轮，Jackson：「加入一个导入数据功能，
    记录使用 LessonMate 之前的学生历史数据」）
    - **定位**：老师换到本系统前用 Excel / 纸质账本，要把**过去上过的课**补进来，否则财务历史、家长对账、
      学员详情全空。与第 13 条的「导入课表数据」完全不同 —— 那个是全量 JSON 覆盖/合并（会改学员和排课），
      这个**只往 `checkInLogs` 追加**，不动已有排课、不动余额。
    - **入口**：设置页 `#btnPageHistoryImport`（电脑）/ `#msetHistoryImport`（手机）。
      用户选的口径：**CSV 文件上传**（不是粘贴）、**只导历史明细**、**计入财务统计**。
    - **CSV 列**：`日期 / 学员 / 课程 / 节数 / 金额 / 老师 / 备注`，表头靠 `HISTORY_HEADER_ALIASES` 认别名、
      顺序随意；**认不到表头就按固定列序读**（并 toast 提醒）。
    - **解析容错**（`historyParseDate` / `historyParseAmount`）：`2026-04-02` `2026/4/2` `2026.4.2`
      `2026年4月16日` `20260423`；`¥1,200` `1200元`；带时间的只取日期部分。
      金额看不懂**报错该行**而不是当 0（当 0 等于悄悄少记一笔钱）。
    - **⚠️ 一行 N 节必须展开成 N 条 `deductedLessons: 1`**，金额均摊、余数补最后一条。
      `deductedLessons > 1` 会被第 37 条的 `migrateLessonUnits` 当成旧折算产物改回 1，金额同步错位。
    - **⚠️ 日期双写**：`date` = `YYYY-MM-DD`，`checkInTime` = **本地中午 12:00** 转 ISO。
      财务按月聚合用的是 `checkInTime` 前 7 位（`updateFinancePanel` / `prevMonthLogs`），
      取本地 00:00 会变成前一天 UTC，月初的记录直接滑到上个月。
    - **⚠️ 新建学员的课程包必须在 `normalizeStudent` 之前带好**：`courses: []` 会被补一个
      「基础课程 10 节」的默认包，等于凭空给历史学员 10 节存量（财务"待消存量"虚高）。这是本轮真踩到的 bug。
    - **新课程包余额一律 0**：历史课已经上完，给节数就是造假。弹层里给了勾选项
      `historySeedRemaining`「把历史合计当初始余额」，默认**关**，要一次定好余额才勾。
    - **幂等**：去重键 `studentId|date|course|金额(分)`，按「系统里已有几条」逐条消耗。
      重导同一份文件 → 全部跳过（`已存在（跳过）`），再导另一份是**叠加**不是覆盖。
    - **撤销**：流水带 `source: 'history'` + `batchId`；弹层里的「清空历史导入（N 条）」
      只删 `source === 'history'`，真实消课/退款一条不碰（新建的学员和课程包会保留，去学员页删）。
    - 两端同名同语义：`parseHistoryCsv` / `buildHistoryPlan` / `applyHistoryPlan` / `removeHistoryLogs` /
      `downloadHistoryTemplate`。预览和真正导入**共用同一个 `buildHistoryPlan` 结果**，
      不会出现"预览 42 条、实际导 45 条"。手机端刷新用 `refreshMobileAll()`（mobile.js **没有** `refreshView`）。
    - 核对 `tmp/history-import-check.mjs`（48 项）：H 入口 / I 解析预览 / J 落库明细 / K 重导幂等 /
      L 计入财务 / M 清空 / N 手机端 / P 无表头与空文件。出图 `tmp/history-import-shots.mjs` →
      `hist-d1-settings / d2-modal / d3-preview / d4-students / d5-detail / m1-preview.png`。

43. **加入时间 + 累计已上几节**（2026-10-18 第 4 轮，Jackson：「历史数据要导入一条加入时间，然后根据现有数据和历史数据，
    统计一共上过几节课」）
    - 用户选的口径：加入时间**从 CSV 加一列**进来；累计节数**显示在学员详情头部**（不做列表卡片、不做导入预览逐人）。
    - **加入时间是学员属性，不是课次属性**：CSV 里同一学员每行写一样，导入时按 `studentId` 取**最早那天**
      （`plan.joinDates`，Map）。落在 `student.joinDate`（`YYYY-MM-DD` 字符串），随 `saveData` 整份持久化。
    - **以文件为准（覆盖），不是只补空**：表格是这个字段的唯一来源，界面上没有别的编辑入口，
      只补空的话导错的日期就再也改不掉了。预览里写明「加入时间 N 人（M 人将更新）」，`M` 只统计
      已有值且与新值不同的人。
    - **加入时间解析失败只提醒、不废行**：`row.joinDateBad` 计数 → 预览 warn 里点出「N 行加入时间看不懂」。
      它只是附加信息，不该因为一个日期把整条已经上过的课（和钱）丢掉 —— 这点和「日期/金额看不懂要报错」故意不同。
    - **`joinDates` 用 `drafts` 而不是 `accepted` 生成**：该行课因去重被跳过时，带来的加入时间仍然有效，
      否则「清空历史后重导」会补不上日期。
    - 列位置：表头认别名（`加入时间/加入日期/入学时间/入学日期/报名时间/报名日期/开课日期`），顺序随意；
      无表头时按第 8 列读（模板里也放在最后，老文件 7 列不受影响）。
    - **「一共上过几节课」= 现有消课 + 历史导入**，不用另算：历史导入本来就落在 `checkInLogs` 里，
      `totalLoggedLessons` 一条求和就是全部。历史那部分只在「占一部分」时才标出来
      （`historyLoggedLessons > 0 && < total` → 「含历史 N 节」），全是历史时不重复念。
    - 展示位：渲染成 `[data-detail-life]` 一行（`2025-09-01 加入 · 累计已上 4 节（含历史 3 节）`），
      两端同构；没有加入时间又没消课时整行不渲染。退款不计入（`isRefundLog` 已在 `allLogs` 过滤）。
    - 核对 `history-import-check`（65 项）：Q 段解析与落库（含「看不懂不废行」「覆盖」「新建学员」）、
      R 段两个学员各自算各自的、S 段手机端同口径。护栏自检 = 把覆盖改回 `st.joinDate || date`
      应见 Q5/R4/S3 报红。

44. **历史导入模板改成「一个 Excel 两个工作表」**（2026-10-18 第 5 轮，Jackson：「模板改一下，学员一个分页，
    消课记录一个分页」）
    - 用户选的口径：**一个 .xlsx 两个工作表**（不是两个 CSV）；「学员」页只要 **姓名 + 加入时间**。
      CSV 天生装不下多个工作表，所以这轮把导入从「只读 CSV」升级成「能读 xlsx」。
    - **模板三个表**：`学员`（姓名 / 加入时间）、`消课记录`（日期 / 学员 / 课程 / 节数 / 金额 / 老师 / 备注）、
      `说明`（纯文字，导入时按表名跳过）。示例数据 1 + 2 + 1 节 = 4 条流水、2 个人。
    - **自写 xlsx 读写（无依赖）**，两端同一份 `xlsxRead` / `xlsxWrite`：
      - 读 = 解 ZIP（中央目录 + 兼容 data descriptor，大小以中央目录为准）→ **raw inflate**（bit 级
        canonical Huffman：固定/动态/存储三种块都实现了）→ 正则取 XML。
      - **日期单元格是「序列号 + 数字格式」**，必须查 `xl/styles.xml` 的 `cellXfs.numFmtId`
        （内置 14~22/45~47 等 + 自定义格式串里带 y/m/d）再按 1900/1904 基准换算，
        否则 2026-03-05 会读成 `46086`。1900 系统要处理那个不存在的 2/29（serial < 60 用 12-31 起算）。
      - 写 = 只打 STORE（不压缩），省掉 deflate 实现。`fills` 要给两个（none + gray125）、
        `cellStyles` 要有 Normal，否则 Excel 打开会提示"修复"。
    - **工作表分工**（`historyPickSheets`）：先按表名（消课|上课|记录 / 学员|学生|名单），
      认不到再看表头（有「节数」的是记录页、只有「姓名」的是名单页），**都不认才退回第一个表** ——
      所以「说明」页放第一也没事，用户把表改名成 Sheet1/Sheet2 也能用。
    - **名单是加入时间的权威来源**：同一人 `joinDate` 以「学员」页为准，**盖掉**消课记录里的行内值；
      老 CSV（第 8 列 `加入时间`）仍然兼容，行内值只在名单没写时生效。
    - **只有名单、没有消课记录也要能导**：这是合法输入（建学员本身有价值），
      预览显示「本次只导入学员名单，没有消课记录」，按钮不禁用。
    - ⚠️ **这类学员必须打 `noDefaultCourse: true`**：`normalizeStudent` 见到空 `courses` 会补
      「基础课程 10 节」，下次 `loadData` 又补一遍 —— 等于凭空造 10 节存量（财务虚高）。
      逃生口只由历史导入设置，其他入口不受影响。
    - 解析层重构：`parseHistoryCsv` 先切二维表，再走 `historyParseMatrix` —— **xlsx 和 CSV 共用同一套
      单元格→行的逻辑**，两条入口不会解析出不同结果。空行过滤但保留原始行号（报错说「第 8 行」仍准）。
    - 核对 `tmp/history-import-check.mjs`（102 项）：T 模板结构（用 node 的 zlib 自己解一遍 zip 验工作表名/表头）/
      U 模板原样导回（4 条 + 2 人 + 加入时间 + 重导幂等）/ V 只有名单、表名被改、真实日期单元格、
      说明页在前、坏文件提示 / W 手机端同口径。fixtures 在 `tmp/fixtures/*.xlsx`（openpyxl 生成，
      带真正的日期单元格）。**护栏自检**：删掉 `noDefaultCourse` 那行 → V7 立刻报红（补出「基础课程 10 节」）。
    - 测试侧两个坑：① `addInitScript` 每次导航都跑，`page.reload()` 会把 localStorage 重种一遍 →
      种子函数要先查标记位（否则"刷新后还在不在"这类断言必假红）。② reload 后引导层会重新挂上，
      要再摘一次 `syncGateOverlay/teacherLoginGate/modalSyncGate` 才能点设置页。

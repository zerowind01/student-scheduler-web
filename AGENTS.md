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

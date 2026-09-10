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
- 手机首页顺序：本周课时 Hero → 统计四卡 → 今日课程 → 续费跟进清单

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
4. 渲染函数：`renderMobileHome` / `renderMobile3DayView` / `renderMobileStudents` / `renderMobileFinance`
5. 弹窗用真按钮弹窗（`lm-sheet`），**不要用 `prompt()`**
6. 每次改完端到端验证真实用户操作路径，再部署

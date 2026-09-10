# LessonMate 排课工作台 — 项目优化方案

> 生成时间：2026-09-06 ｜ 依据：`student-scheduler-web` skill（含 future-features-backlog 参考文档）
> 线上主站：https://lesson-mate.pages.dev（Cloudflare Pages，wrangler 手动部署，**push ≠ 部署**）

---

## 一、项目现状快照

| 维度 | 现状 |
|---|---|
| 架构 | 双代码库镜像（桌面 `js/app.js` + 手机 `js/mobile.js`），共享 localStorage key 与 Upstash 云同步 |
| 部署 | Cloudflare Pages（主站）+ CF Pages Function 云同步（`functions/api/sync.js`）；Netlify 已废，GitHub 无 CI |
| 数据层 | 6 大集合（students / schedules / teachers / course_types / checkin_logs / debts），课时语义 =「消课才扣」 |
| UI 体系 | 2026-09-07 重设计完成：tokens.css 设计令牌 + anim.js 动效层 + 四区分色（课表琥珀/学员绿/财务玫红/设置天蓝） |
| 可访问性 | 2026-09-07 审查基线已落地（aria-label / role=dialog / Esc 关弹窗 / reduced-motion 兜底） |
| 已落地功能 | 批量重复排课（含双选项删除）、学员详情弹窗（单价/欠课/消课记录）、单价设置、手机端充值、欠课账本全路径校准 |

---

## 二、功能优化（按 backlog 优先级）

### P1 — 退款功能（backlog #3，优先级最高的未移植项）
- **目标**：对齐 App 的 `executeRefund(studentId, coursePackId, amount, lessons)`
- **要点**：
  - 新增 `refunds` 集合 → 触发**数据层 7 处 × 2 文件**同步改动（STORAGE_KEY 常量、let 变量、loadData、saveDataLocalOnly、pushToCloud payload、pullFromCloud 赋值、BroadcastChannel 赋值）
  - 云同步 pull 侧容错：`remoteData.refunds || []`
  - 校验剩余课时 ≥ 退款节数，扣减包余额，财务统计扣减退款金额
- **风险**：财务统计口径变化（收入需减退款）；需按 `lesson-accounting-semantics.md` 回归脚本跑端到端

### P2 — 试课学员（backlog #4）
- **要点**：`student.isTrial` 字段（normalize 补 `false`），消课备注自动打【试课】前缀，学员列表/筛选支持试课标记；匿名试课 = 名字「试课学员(待定)」
- **成本**：低（单字段 + 筛选 + 备注前缀），双端同步改

### P3 — 续费预警明细（backlog #5）
- **要点**：财务页新增聚合卡片，列出 `remainingLessons ≤ 2` 的学员，直通充值入口
- **注意**：课时余额计算用 `Math.max(0, remainingLessons)`，负数（欠课）不进预警、进欠课名单

### P4 — courseTypes 管理入口（已知遗留）
- **现状**：`course_types` 集合已云同步但无 UI 管理入口，排课仍是自由文本科目名
- **建议**：在设置分页加「课程类型管理」（遵守「同一功能绝不建第二个入口」铁律），排课弹窗科目字段改为下拉 + 可自定义新增
- **优先级最低**：现有自由文本可用，做之前先问用户真实需求

---

## 三、技术债 / 一致性优化

1. **派生数据校准的路径全覆盖复查**：欠课账本曾因只校准 loadData 路径漏掉「编辑→保存」真实用户路径（两轮返工教训）。后续每次新增派生数据（如退款后重算财务）必须枚举全部数据入口：初始加载 / 写保存 / 云拉 / URL 导入，并用用户真实操作序列端到端复现。
2. **双端数据层改动 checklist 固化**：任何新字段/新集合按 7 处 × 2 文件清单逐项打勾，避免双端不一致 bug。
3. **老数据字段兜底**：新增流水字段（如 teacherName/date）时，读取处一律 `l.date || (l.checkInTime||'').slice(0,10)` 式 fallback，不让存量数据展示空白。
4. **死代码清理**：用户持续做布局级重构（分页化/抽屉化），每次改动同步清理被替换机制的 HTML 按钮、JS 绑定、CSS 规则，避免冒烟测试误判。

---

## 四、体验优化候选（需用户确认后做）

- 学员详情页内单笔消课撤销（backlog 中明确标为「未做候选」）
- 财务页欠课/续费数据的导出（现有导出为全量数据）
- 手机端 3 日视图与桌面周视图的联动体验打磨（保持现有「今天按钮锚定今天」规则）

## 明确不做（已评估，勿再提）
- 系统日历双向同步（浏览器无 device_calendar 对等权限）
- CSV 批量导入学员（学员量小）
- 分课程类型单价（per-course unitPrice 已等价实现）
- 「修复历史财务数据」迁移补丁（web 无此包袱）

---

## 五、工程流程优化（每次开发必须遵守）

1. **改动流程**：改代码 → `node --check js/app.js js/mobile.js` → 本地 http server 浏览器冒烟（**端口随轮次换新**）→ wrangler 部署 → cache-busting 线上验证（`curl "...?v=$RANDOM" | grep -c 特征串`）→ 才能答复用户「已上线」。
2. **绝不承诺 CI 部署**：本项目没有 git 集成，push 只做备份；「Vercel: success」是残留假集成。
3. **浏览器验证优先用户真实路径**：本地干净数据通过 ≠ 线上通过；先确认线上 JS 已含修复特征串再测，否则测的是旧代码。
4. **大功能先出方案**：入口/交互/边界/数据来源/改动范围先给用户确认，用户补的细节进第一版实现，不做二期。
5. **可访问性不退化**：新增 UI 维持 aria 基线（弹窗 role=dialog、图标按钮 aria-label、Toast role=status、Esc 关闭自动覆盖规则）。

---

## 六、建议执行顺序

| 阶段 | 内容 | 预估工作量 |
|---|---|---|
| 第 1 步 | 退款功能（refunds 集合 + 财务口径 + 双端） | 大（数据层 7×2 + 财务回归） |
| 第 2 步 | 试课学员标记 | 小（字段 + 筛选 + 前缀） |
| 第 3 步 | 续费预警明细卡片 | 小（财务页一节） |
| 第 4 步 | courseTypes 管理入口 | 中（需先确认业务规则） |

> 按用户偏好：动手前先确认每项的业务规则细节（如退款是否可部分退、试课是否计入财务统计），确认后一次做到位。

/**
 * 学生排课助手 - 手机版核心逻辑 (Mobile Pure Tap-Based Engine)
 * 特点：完全去掉拖拽排课，采用100%手机触控点按交互、3日大列宽日历、双师共上与冲突检测
 * 与桌面端 (index.html) 共享完全相同的 LocalStorage 与 Upstash 云端数据库
 */

(function () {
  'use strict';

  const STORAGE_KEY_STUDENTS = 'edu_scheduler_students_v2';
  const STORAGE_KEY_SCHEDULES = 'edu_scheduler_schedules_v2';
  const STORAGE_KEY_TEACHERS = 'edu_scheduler_teachers_v2';
  const STORAGE_KEY_COURSE_TYPES = 'edu_scheduler_course_types_v2';
  const STORAGE_KEY_CHECKIN_LOGS = 'edu_scheduler_checkin_logs_v2';
  const STORAGE_KEY_DEBTS = 'edu_scheduler_debts_v2';

  let students = [];
  let schedules = [];
  let teachers = [];
  let courseTypes = [];
  let checkInLogs = [];
  let debts = [];
  let selectedTeacherFilter = 'all';           // 课表筛选范围：'all' | 老师 id
  let teacherFilterAutoApplied = false;        // 老师身份下「默认只看自己」是否已应用（每次登录仅一次）
  let mobileStartDate = getToday(); // 默认从今天开始显示 3 日日历（周末也能直接看到今天）

  // 课表三档视图：一个状态 + 一个分段控件，各自分派到自己的渲染器
  // 'day3' 3日时间轴 | 'week' 一周条 + 当天清单 | 'month' 整月格 + 当天清单
  // 默认「周」：进课表先看这一周全貌，比 3 日窗口更适合快速定位。
  let calView = 'week';
  let mobileStudentScope = 'active';           // 学员页范围：active=在读 / archived=历史学员库
  let calSelected = formatDate(getToday());    // 当前选中日期（周/月档共用）
  const CAL_CELL_H = 46;                       // 单行日期格高度（px）
  const CAL_ROW_GAP = 2;                       // #calGrid 的 gap-y-0.5 = 2px
  const CAL_WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const isMonthView = () => calView === 'month';
  // 周/月网格的几何与动画状态：网格始终渲染整月，周档只是"裁剪到一行"
  // （见 renderCalGrid / applyCalGridHeight）—— 于是周↔月切换只是同一个标量的补间。
  let calGridGeom = null;   // { collapsedH, fullH, rowStep, rowIdx }
  let calGridTween = null;  // 当前高度补间（手势接管前先 kill，避免两边抢同一属性）
  let calDrag = null;       // 手势拖动中的临时状态
  // 动效总开关（anim.js 的 RM 是实时值，系统偏好中途改也能立刻跟上）
  const reduceMotion = () => !!(window.uiAnim && window.uiAnim.reduceMotion && window.uiAnim.reduceMotion());

  // 随机卡片颜色主题（app.js 里有同名函数，但手机端不加载 app.js，需本地实现）
  const MOBILE_COLOR_THEMES = ['amber', 'emerald', 'sky', 'purple', 'rose', 'mint'];
  function getRandomColorTheme() {
    return MOBILE_COLOR_THEMES[Math.floor(Math.random() * MOBILE_COLOR_THEMES.length)];
  }

  // ============ 老师访问会话（PIN 登录，管理员不受限） ============
  // teacherSession = null 表示管理员；否则 { teacherId, name }
  // 会话持久化到 localStorage，换设备/清缓存需重输 PIN
  let teacherSession = null;

  function loadTeacherSession() {
    try {
      const raw = localStorage.getItem('edu_teacher_session_v1');
      teacherSession = raw ? JSON.parse(raw) : null;
      if (teacherSession && !teachers.some((t) => t.id === teacherSession.teacherId && t.accessPin === teacherSession.pin)) {
        teacherSession = null; // 访问码已被管理员撤销/更换
        localStorage.removeItem('edu_teacher_session_v1');
      }
    } catch (e) { teacherSession = null; }
    return teacherSession;
  }

  // 同步合并：远端 teachers 覆盖本地时保留本地 accessPin（PIN 只由管理员端设置，不同步下发）
  function mergeTeachersKeepPin(remoteTeachers, localTeachers) {
    const pinById = new Map((localTeachers || []).filter((t) => t.accessPin).map((t) => [t.id, t.accessPin]));
    return (remoteTeachers || []).map((t) => (pinById.has(t.id) ? { ...t, accessPin: pinById.get(t.id) } : t));
  }

  function tryTeacherLogin(pin) {
    const t = teachers.find((x) => x.accessPin && x.accessPin === String(pin).trim());
    if (!t) return null;
    teacherSession = { teacherId: t.id, name: t.name, pin: t.accessPin };
    localStorage.setItem('edu_teacher_session_v1', JSON.stringify(teacherSession));
    return t;
  }

  function teacherLogout() {
    teacherSession = null;
    localStorage.removeItem('edu_teacher_session_v1');
    // 课表筛选是「跟着身份走的视图范围」：退出老师身份就该回到全校，
    // 否则管理员接手后课表还卡在上一位老师的范围里。
    selectedTeacherFilter = 'all';
    teacherFilterAutoApplied = false;
  }

  function isTeacherView() { return !!teacherSession; }

  // 老师视角：判断学员是否与该老师有关（显式关联名单、或主讲/助教上过/将上该学员的课）
  function studentRelatedToTeacher(st) {
    if (!teacherSession) return true;
    if ((st.teacherIds || []).includes(teacherSession.teacherId)) return true;
    return schedules.some((s) => s.studentId === st.id && (s.teacherId === teacherSession.teacherId || s.assistantTeacherId === teacherSession.teacherId));
  }

  // 老师视角：某条学员课程是否属于该老师的教学范围
  // 判定：排课记录里该老师（主讲或助教）上过/将上这门课 → 归属该老师
  function courseRelatedToTeacher(st, courseName) {
    if (!teacherSession) return true;
    return schedules.some((s) => s.studentId === st.id &&
      (s.teacherId === teacherSession.teacherId || s.assistantTeacherId === teacherSession.teacherId) &&
      ((s.subject || '') === courseName || s.courseId === st.courses.find((c) => c.name === courseName)?.id));
  }

  // 老师视角：某条消课流水是否属于该老师的课（流水带 teacherId 直接判，老流水回退查排课）
  function logRelatedToTeacher(log) {
    if (!teacherSession) return true;
    if (log.teacherId) return log.teacherId === teacherSession.teacherId;
    const sch = schedules.find((s) => s.id === log.scheduleId);
    if (sch) return sch.teacherId === teacherSession.teacherId || sch.assistantTeacherId === teacherSession.teacherId;
    // 历史导入的流水只有老师名字（无 teacherId / 无排课）→ 按名字归属，否则会重复算进每位老师
    if (log.teacherName) return log.teacherName === teacherSession.name;
    return true;
  }

  function getToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function getMonday(d) {
    const date = new Date(d);
    const day = date.getDay();
    const diff = date.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(date.setDate(diff));
  }

  function formatDate(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
  }

  function normalizeStudent(st) {
    // 名单导入的学员（只有姓名 + 加入时间、还没买课）：没有课程包是正常状态，
    // 补一个「基础课程 10 节」等于凭空造存量。这个标记只由历史导入设置。
    if (st.noDefaultCourse && (!st.courses || !st.courses.length)) return st;
    if (!st.courses || !Array.isArray(st.courses) || st.courses.length === 0) {
      st.courses = [
        {
          id: 'course_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
          name: st.subject || '基础课程',
          remainingLessons: typeof st.remainingLessons === 'number' ? st.remainingLessons : 10,
        },
      ];
    }
    return st;
  }

  // ============ 历史学员库（与桌面端 app.js 同口径）============
  // 归档 ≠ 删除：档案、课程包、消课流水全留，只是从在读列表 / 课时预警 / 欠课 / 排课选人里拿掉。
  function isArchivedSt(st) {
    return !!(st && st.archived);
  }
  function activeStudentsOf(list) {
    return (list || students).filter((s) => !isArchivedSt(s));
  }
  function archivedStudentsOf(list) {
    return (list || students).filter(isArchivedSt);
  }
  function setStudentArchived(st, on, reason) {
    if (!st) return;
    if (on) {
      st.archived = true;
      if (!st.archivedAt) st.archivedAt = formatDate(new Date());
      if (reason) st.archiveReason = reason;
    } else {
      delete st.archived;
      delete st.archivedAt;
      delete st.archiveReason;
    }
  }

  function toggleMobileStudentArchive(st, on) {
    if (!st) return;
    if (on) {
      if (!confirm(`把「${st.name}」移入历史学员库？\n\n档案、课程包、消课记录都会保留，只是不再出现在在读列表、课时预警和排课选人里。随时可以移回。`)) return;
      setStudentArchived(st, true, '结课');
      saveData();
      refreshMobileAll();
      showToast(`📦 ${st.name} 已移入历史学员库`);
    } else {
      setStudentArchived(st, false);
      saveData();
      refreshMobileAll();
      showToast(`↩️ ${st.name} 已移回在读`);
    }
  }

  // ============ 教务扩展（与桌面端 app.js 保持一致） ============
  const SCHEDULE_STATUS = { SCHEDULED: 'scheduled', COMPLETED: 'completed', STUDENT_LEAVE: 'student_leave' };

  // 今日课程列表重排动画的「主角」：请假/撤销时记下这节课 id，下一次渲染播放一次后清空
  let pendingReorderId = null;

  function normalizeSchedule(sch) {
    if (!sch.status) sch.status = SCHEDULE_STATUS.SCHEDULED;
    // 兼容 courseName 字段（部分数据入口只写 courseName）
    if (!sch.subject && sch.courseName) sch.subject = sch.courseName;
    return sch;
  }

  // 系列课迁移（与桌面端 app.js 同逻辑）：给无 seriesId 的排课回溯分组。
  function migrateSeriesIds() {
    const parent = new Map();
    const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    const byKey = new Map();
    schedules.forEach((s) => {
      if (s.seriesId) return;
      parent.set(s.id, s.id);
      const key = `${s.studentId}|${s.courseId || s.subject}|${s.startTime}|${s.teacherId || ''}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(s);
    });
    byKey.forEach((group) => {
      group.sort((a, b) => a.date.localeCompare(b.date));
      for (let i = 1; i < group.length; i++) {
        for (let j = i - 1; j >= 0; j--) {
          const gapDays = Math.round((new Date(group[i].date) - new Date(group[j].date)) / 86400000);
          if (gapDays === 7 || gapDays === 14) { union(group[j].id, group[i].id); break; }
          if (gapDays < 7) break;
        }
      }
    });
    const rootIds = new Map();
    parent.forEach((_, id) => {
      const root = find(id);
      if (!rootIds.has(root)) rootIds.set(root, 'ser_' + root);
      const sch = schedules.find((s) => s.id === id);
      if (sch && !sch.seriesId) sch.seriesId = rootIds.get(root);
    });
  }

  // 与 sch 同系列且在其之后的排课
  function seriesLaterSiblings(sch) {
    return schedules.filter((s) =>
      s.id !== sch.id &&
      (s.seriesId ? s.seriesId === sch.seriesId
        : (s.studentId === sch.studentId && s.courseId === sch.courseId && s.startTime === sch.startTime && (s.teacherId || '') === (sch.teacherId || ''))) &&
      (s.date > sch.date || (s.date === sch.date && (s.startTime || '') > (sch.startTime || '')))
    ).sort((a, b) => a.date.localeCompare(b.date) || (a.startTime || '').localeCompare(b.startTime || ''));
  }

  // 两个 YYYY-MM-DD 相差的整天数（to - from）
  function diffDays(fromStr, toStr) {
    const a = new Date(fromStr + 'T00:00:00');
    const b = new Date(toStr + 'T00:00:00');
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
    return Math.round((b - a) / 86400000);
  }

  // 日期整体平移 N 天
  function shiftDateStr(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return dateStr;
    d.setDate(d.getDate() + days);
    return formatDate(d);
  }

  function weekdayLabel(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return '';
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  }

  function minutesOfDay(hhmm) {
    const parts = String(hhmm || '00:00').split(':');
    const h = parseInt(parts[0], 10) || 0;
    const m = parseInt(parts[1], 10) || 0;
    return h * 60 + m;
  }

  // 系列整体平移日期时，判断某一节平移到 targetDate 后是否会撞上既有排课
  function seriesShiftConflict(self, targetDate, startTime, durationMinutes, teacherId, room, excludeIds) {
    const start = minutesOfDay(startTime);
    const end = start + (durationMinutes || 45);
    return schedules.some((o) => {
      if (o.id === self.id || excludeIds.has(o.id)) return false;
      if (o.date !== targetDate) return false;
      if (o.status && o.status !== SCHEDULE_STATUS.SCHEDULED) return false;
      const os = minutesOfDay(o.startTime);
      const oe = os + (o.durationMinutes || 45);
      if (start >= oe || end <= os) return false;
      const sameStudent = o.studentId === self.studentId;
      const sameTeacher = !!teacherId && !!o.teacherId && o.teacherId === teacherId;
      const sameRoom = !!room && !!o.room && o.room === room;
      return sameStudent || sameTeacher || sameRoom;
    });
  }

  // 系列批量修改提示文案：跟着日期框实时变化
  function updateSeriesHint() {
    const block = document.getElementById('mobileSeriesEditBlock');
    const hint = document.getElementById('seriesEditHintMobile');
    if (!block || !hint || block.classList.contains('hidden')) return;
    const idEl = document.getElementById('inputMobileScheduleId');
    const dateEl = document.getElementById('inputMobileDate');
    const sch = schedules.find((s) => s.id === (idEl ? idEl.value : ''));
    const count = sch ? seriesLaterSiblings(sch).filter((s) => !s.status || s.status === SCHEDULE_STATUS.SCHEDULED).length : 0;
    let shift = 0;
    if (sch && dateEl && dateEl.value) shift = diffDays(sch.date, dateEl.value);
    const tail = `同步修改本节及之后的 ${count} 节课（日期 / 开始时间 / 时长 / 课室 / 老师 / 课程）`;
    hint.textContent = shift !== 0
      ? `勾选后${tail}，日期整体平移 ${shift > 0 ? '+' : ''}${shift} 天：${weekdayLabel(sch.date)} → ${weekdayLabel(dateEl.value)}`
      : `勾选后${tail}，日期保持不变`;
  }

  function bindSeriesHintUpdates() {
    ['input', 'change'].forEach((evt) => {
      document.addEventListener(evt, (e) => {
        if (e.target && e.target.id === 'inputMobileDate') updateSeriesHint();
      });
    });
  }

  function migrateStudentCourses(st) {
    if (!st.courses) return;
    st.courses.forEach((c) => {
      if (typeof c.unitPrice !== 'number') c.unitPrice = 0;
    });
  }

  function ensureDefaultCourseTypes() {
    if (courseTypes.length === 0) {
      courseTypes = ['钢琴', '美术', '乐理', '吉他'].map((n) => ({ id: 'ct_' + n, name: n }));
    }
  }

  function normalizeDebt(d) {
    if (!d.id) d.id = 'debt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    if (typeof d.amount !== 'number') d.amount = 0;
    return d;
  }

  function recordCheckInLog(schedule, deducted, payment, remarks) {
    checkInLogs.push({
      id: 'cil_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      scheduleId: schedule.id,
      studentId: schedule.studentId,
      studentName: schedule.studentName,
      courseName: schedule.subject,
      deductedLessons: deducted,
      paymentAmount: payment,
      checkInTime: new Date().toISOString(),
      remarks: remarks || '',
      teacherName: schedule.teacherName || '',
      date: schedule.date || '',
    });
  }

  // ==========================================
  // 学员详情弹窗（课时/单价/欠课/消课记录）
  // ==========================================
  // 学员详情：消课记录支持「查看全部」「点行直达课程菜单」、累计合计、补课打标
  // detailLogExpanded 记住"是否已展开"（渲染是整块重建的，状态得放在函数外面）
  let detailLogExpanded = false;
  const DETAIL_LOG_PAGE = 30;

  function openMobileStudentDetail(studentId) {
    detailLogExpanded = false;
    renderMobileStudentDetail(studentId);
    showModal('modalMobileStudentDetail');
  }

  // 流水时钟：checkInTime 存的是 UTC ISO，必须转本地再取 HH:mm（直接切字符串会差 8 小时）
  function logClock(log) {
    if (!log || !log.checkInTime) return '';
    const d = new Date(log.checkInTime);
    if (isNaN(d.getTime())) return '';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function logDateText(log) {
    return (log && (log.date || (log.checkInTime || '').slice(0, 10))) || '';
  }

  function renderMobileStudentDetail(studentId) {
    const student = students.find((s) => s.id === studentId);
    if (!student) return;
    normalizeStudent(student);

    const titleEl = document.getElementById('mobileStudentDetailTitle');
    if (titleEl) titleEl.textContent = `${student.name} · 详情`;
    const body = document.getElementById('mobileStudentDetailBody');
    if (!body) return;

    const studentDebts = getStudentDebts(student.id);
    // 全部消课流水（倒序），分页只影响"渲染多少"，合计永远按全量算
    const allLogs = checkInLogs
      .filter((l) => l.studentId === student.id && !isRefundLog(l))
      .slice()
      .sort((a, b) => (b.checkInTime || '').localeCompare(a.checkInTime || ''));
    const totalLoggedLessons = allLogs.reduce((acc, l) => acc + (Number(l.deductedLessons) || 0), 0);
    const totalLoggedAmount = allLogs.reduce((acc, l) => acc + (Number(l.paymentAmount) || 0), 0);
    // 「一共上过几节课」= 现有消课 + 导入的历史消课（历史导入也落在 checkInLogs 里，一条求和就够）
    const historyLoggedLessons = allLogs
      .filter((l) => l.source === 'history')
      .reduce((acc, l) => acc + (Number(l.deductedLessons) || 0), 0);
    const lifeText = [
      student.joinDate ? `${student.joinDate} 加入` : '',
      totalLoggedLessons > 0 ? `累计已上 ${totalLoggedLessons} 节` : '',
    ].filter(Boolean).join(' · ')
      + (historyLoggedLessons > 0 && historyLoggedLessons < totalLoggedLessons ? `（含历史 ${historyLoggedLessons} 节）` : '');
    const logs = detailLogExpanded ? allLogs : allLogs.slice(0, DETAIL_LOG_PAGE);
    // 退款记录单列（退款不是「消课」，混进消课记录里会把节数读糊涂）
    const refundLogs = checkInLogs
      .filter((l) => l.studentId === student.id && isRefundLog(l))
      .slice()
      .sort((a, b) => (b.checkInTime || '').localeCompare(a.checkInTime || ''))
      .slice(0, 10);
    const leaves = schedules
      .filter((s) => s.studentId === student.id && s.status === SCHEDULE_STATUS.STUDENT_LEAVE)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, 10);

    const totalLessons = student.courses.reduce((acc, c) => acc + c.remainingLessons, 0);
    const totalOwed = studentDebts.reduce((acc, d) => acc + d.amount, 0);
    const canRefund = refundableCourses(student).length > 0;

    body.innerHTML = `
      <div class="flex items-center gap-3 bg-slate-50 rounded-2xl p-3">
        <div class="w-12 h-12 rounded-full bg-[#111111] text-white flex items-center justify-center font-bold text-base">${student.name.substring(0, 1)}</div>
        <div class="flex-1">
          <div class="font-bold text-sm text-slate-800 flex items-center gap-1.5 flex-wrap">${student.name}${isArchivedSt(student) ? `<span class="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-slate-200 text-slate-500">历史学员${student.archivedAt ? ' · ' + student.archivedAt : ''}</span>` : ''}</div>
          <div class="text-[11px] text-slate-500">${student.phone ? '📞 ' + student.phone : '未填电话'}</div>
          ${lifeText ? `<div class="text-[10px] text-slate-400 mt-0.5" data-detail-life>${student.joinDate ? '<i class="fa-solid fa-calendar-plus text-[9px]"></i> ' : ''}${lifeText}</div>` : ''}
        </div>
        <div class="text-right">
          <div class="text-xl font-black ${totalOwed > 0 ? 'text-[#d5304f]' : 'text-[#fe4c02]'}">${totalLessons}</div>
          <div class="text-[9px] text-slate-400 font-bold">总剩课时${totalOwed > 0 ? ' · 欠' + totalOwed + '节' : ''}</div>
        </div>
      </div>

      <button type="button" id="mDetailRechargeBtn" class="w-full py-3 rounded-xl bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-1.5 active:bg-emerald-600 transition">
        <i class="fa-solid fa-circle-plus"></i> 充值 / 新购课时包
      </button>

      <div class="grid grid-cols-3 gap-2">
        <button type="button" id="mDetailSummaryBtn" class="py-3 rounded-xl bg-white border border-[#f0ebe2] text-slate-700 font-bold text-xs flex items-center justify-center gap-1.5 active:bg-slate-50 transition">
          <i class="fa-solid fa-image"></i> 总结图
        </button>
        <button type="button" id="mDetailRefundBtn" class="py-3 rounded-xl bg-white border border-rose-200 text-rose-600 font-bold text-xs flex items-center justify-center gap-1.5 active:bg-rose-50 transition"${canRefund ? '' : ' disabled style="opacity:.45"'}>
          <i class="fa-solid fa-circle-minus"></i> 退款${canRefund ? '' : '（无可退）'}
        </button>
        <button type="button" id="mDetailArchiveBtn" class="py-3 rounded-xl bg-white border border-[#f0ebe2] text-slate-700 font-bold text-xs flex items-center justify-center gap-1.5 active:bg-slate-50 transition" data-archived="${isArchivedSt(student) ? '1' : '0'}">
          <i class="fa-solid ${isArchivedSt(student) ? 'fa-rotate-left' : 'fa-box-archive'}"></i> ${isArchivedSt(student) ? '移回在读' : '移入历史库'}
        </button>
      </div>

      <div>
        <div class="font-bold text-[11px] text-slate-500 uppercase tracking-wider mb-1.5">课程与课时</div>
        <div class="space-y-1.5">
          ${student.courses.map((c) => {
            const isDebt = c.remainingLessons < 0;
            const isLow = !isDebt && c.remainingLessons <= 2;
            return `
            <div class="flex items-center justify-between bg-white border ${isDebt ? 'border-rose-200 bg-rose-50/40' : isLow ? 'border-[#fe4c02]/30' : 'border-[#f0ebe2]'} rounded-xl px-3 py-2.5">
              <div>
                <span class="font-bold text-slate-800">${c.name}</span>
                ${isDebt ? '<span class="text-[9px] font-bold text-[#d5304f] bg-[#fff2f4] px-1.5 py-0.5 rounded-full ml-1.5">欠课</span>' : isLow ? '<span class="text-[9px] font-bold text-[#fe4c02] bg-[#fff2f4] px-1.5 py-0.5 rounded-full ml-1.5">课时不足</span>' : ''}
              </div>
              <div class="flex items-center gap-3 text-[11px]">
                ${c.unitPrice > 0 ? `<span class="text-slate-500">¥${c.unitPrice}/节</span>` : ''}
                <span class="font-black ${isDebt ? 'text-rose-600' : isLow ? 'text-[#fe4c02]' : 'text-[#111111]'}">${c.remainingLessons} 课时</span>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>

      ${studentDebts.length ? `
      <div>
        <div class="font-bold text-[11px] text-rose-500 uppercase tracking-wider mb-1.5">⚠️ 欠课账</div>
        <div class="space-y-1.5">
          ${studentDebts.map((d) => `
          <div class="flex items-center justify-between bg-rose-50 border border-rose-200 rounded-xl px-3 py-2.5">
            <span class="font-bold text-slate-700">${d.courseName}</span>
            <span class="font-black text-rose-600">欠 ${d.amount} 节</span>
          </div>`).join('')}
        </div>
      </div>` : ''}

      <div>
        <div class="flex items-center justify-between mb-1.5">
          <div class="font-bold text-[11px] text-slate-500 uppercase tracking-wider">🕘 消课记录</div>
          ${allLogs.length ? `<div class="text-[10px] text-slate-400">累计 <span class="font-black text-slate-700">${totalLoggedLessons} 节</span> · <span class="font-black text-slate-700">${fmtMoney(totalLoggedAmount)}</span></div>` : ''}
        </div>
        ${allLogs.length === 0 ? '<div class="text-[11px] text-slate-400 py-4 text-center bg-slate-50 rounded-2xl">暂无消课记录</div>' : `
        <div class="space-y-1 ${detailLogExpanded ? '' : 'max-h-56'} overflow-y-auto">
          ${logs.map((l) => {
            const sch = l.scheduleId ? schedules.find((s) => s.id === l.scheduleId) : null;
            const isMakeup = isMakeupLesson(sch);
            const clock = logClock(l);
            return `
          <button type="button" class="w-full text-left flex items-center justify-between bg-slate-50 px-3 py-2.5 rounded-xl active:bg-slate-100 transition" data-detail-log-sch="${l.scheduleId || ''}">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="font-bold text-slate-700">${l.courseName || '课程'}</span>
                ${isMakeup ? '<span class="text-[9px] font-bold px-1.5 py-0.5 rounded bg-[#e8f2f4] text-[#2E5D68]">补课</span>' : ''}
                ${l.teacherName ? `<span class="text-slate-400">${l.teacherName}</span>` : ''}
              </div>
              ${l.remarks ? `<div class="text-[10px] text-slate-400 truncate mt-0.5">${l.remarks}</div>` : ''}
            </div>
            <div class="text-right shrink-0 ml-2">
              <div class="font-bold text-slate-600">${l.deductedLessons}节${l.paymentAmount > 0 ? ' ¥' + Number(l.paymentAmount).toFixed(0) : ''}</div>
              <div class="text-[9px] text-slate-400">${logDateText(l)}${clock ? ' ' + clock : ''}</div>
            </div>
          </button>`;
          }).join('')}
        </div>
        ${allLogs.length > DETAIL_LOG_PAGE ? `
        <button type="button" id="mDetailLogToggle" class="w-full mt-1.5 py-2 rounded-xl text-[11px] font-bold text-slate-500 active:bg-slate-50 transition">
          ${detailLogExpanded ? '收起' : `查看全部 ${allLogs.length} 条`}
        </button>` : ''}`}
      </div>

      ${refundLogs.length ? `
      <div>
        <div class="font-bold text-[11px] text-rose-500 uppercase tracking-wider mb-1.5">💸 退款记录（最近 ${refundLogs.length} 次）</div>
        <div class="space-y-1">
          ${refundLogs.map((l) => `
          <div class="flex items-center justify-between bg-rose-50 border border-rose-100 px-3 py-2.5 rounded-xl">
            <div class="min-w-0 flex-1">
              <span class="font-bold text-slate-700">${l.courseName || '课程'}</span>
              <span class="font-bold text-rose-600 ml-1.5">退 ${l.refundLessons || 0} 节</span>
              ${l.remarks ? `<div class="text-[10px] text-slate-400 truncate mt-0.5">${l.remarks}</div>` : ''}
            </div>
            <div class="text-right shrink-0 ml-2">
              <div class="font-black text-rose-600">${fmtMoney(l.paymentAmount)}</div>
              <div class="text-[9px] text-slate-400">${logDateText(l)}</div>
            </div>
          </div>`).join('')}
        </div>
      </div>` : ''}

      ${leaves.length ? `
      <div>
        <div class="font-bold text-[11px] text-slate-500 uppercase tracking-wider mb-1.5">🏖️ 请假记录（最近 ${leaves.length} 次）</div>
        <div class="space-y-1">
          ${leaves.map((s) => `
          <div class="flex items-center justify-between bg-slate-50 px-3 py-2 rounded-xl text-[11px]">
            <span class="text-slate-600">${s.date} ${s.startTime || ''}</span>
            <div class="flex items-center gap-1.5">
              <span class="text-slate-500">${s.subject || ''}</span>
              ${isPendingMakeup(s) ? '<span class="text-[9px] font-bold px-1.5 py-0.5 rounded bg-[#fff2f4] text-[#d5304f]">待补课</span>' : isMakeupDone(s) ? '<span class="text-[9px] font-bold px-1.5 py-0.5 rounded bg-[#e8f2f4] text-[#2E5D68]">已补课</span>' : ''}
            </div>
          </div>`).join('')}
        </div>
      </div>` : ''}
    `;

    const rechargeBtn = body.querySelector('#mDetailRechargeBtn');
    if (rechargeBtn) rechargeBtn.addEventListener('click', () => {
      hideModal('modalMobileStudentDetail');
      setTimeout(() => openMobileRechargeModal(student), 280);
    });

    // 退款入口：与「充值」同层（详情页是退款唯一入口，不再另开第二个）
    const refundBtn = body.querySelector('#mDetailRefundBtn');
    if (refundBtn) refundBtn.addEventListener('click', () => {
      if (!refundableCourses(student).length) {
        showToast('该学员没有可退的课时（余额为 0 或欠课）');
        return;
      }
      hideModal('modalMobileStudentDetail');
      setTimeout(() => openMobileRefundModal(student), 280);
    });

    // 课时总结图（发给家长）
    const summaryBtn = body.querySelector('#mDetailSummaryBtn');
    if (summaryBtn) summaryBtn.addEventListener('click', () => {
      hideModal('modalMobileStudentDetail');
      setTimeout(() => openMobileLessonSummaryModal(student), 280);
    });

    // 归档（结课 / 停课）→ 历史学员库
    const archiveBtn = body.querySelector('#mDetailArchiveBtn');
    if (archiveBtn) archiveBtn.addEventListener('click', () => {
      const goingArchive = !isArchivedSt(student);
      hideModal('modalMobileStudentDetail');
      setTimeout(() => toggleMobileStudentArchive(student, goingArchive), 260);
    });

    // 消课记录「查看全部 / 收起」：整块重渲染，展开状态存在 detailLogExpanded
    const toggleBtn = body.querySelector('#mDetailLogToggle');
    if (toggleBtn) toggleBtn.addEventListener('click', () => {
      detailLogExpanded = !detailLogExpanded;
      renderMobileStudentDetail(student.id);
    });

    // 点某条消课记录 → 直达那节课的操作菜单（能撤销/退还）。
    // 用 onxxx 赋值而不是 addEventListener：body 是常驻节点，重渲染时监听器会叠加。
    body.onclick = (e) => {
      const row = e.target.closest('[data-detail-log-sch]');
      if (!row) return;
      const sid = row.getAttribute('data-detail-log-sch');
      if (!sid) { showToast('这条记录没有关联排课'); return; }
      const sch = schedules.find((s) => s.id === sid);
      if (!sch) { showToast('这节课的排课已被删除，只剩流水记录'); return; }
      hideModal('modalMobileStudentDetail');
      setTimeout(() => openMobileScheduleActionMenu(sch), 280);
    };
  }

  // ==========================================
  // 课时总结图（发给家长看的那张卡）
  // 纯 Canvas 手绘：PWA 没有构建步骤，引第三方截图库 = 多一份离线失效的风险
  // ==========================================
  const SUMMARY_MAX_ROWS = 40;   // 超过这个数一张图会长到看不清，要求分批生成
  const SUMMARY_FONT_STACK = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Hiragino Sans GB",sans-serif';
  const SUMMARY_WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function summaryFont(size, weight) {
    return `${weight || 400} ${size}px ${SUMMARY_FONT_STACK}`;
  }

  // Canvas 的 roundRect 是 Chrome 99+，老内核回退成手画（别指望 CSS 的 border-radius）
  function summaryRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') { ctx.roundRect(x, y, w, h, r); return; }
    const rr = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  // Canvas 没有 truncate，超宽只能自己量
  function summaryFit(ctx, text, maxW) {
    const t = String(text == null ? '' : text);
    if (ctx.measureText(t).width <= maxW) return t;
    let out = t;
    while (out.length > 1 && ctx.measureText(out + '…').width > maxW) out = out.slice(0, -1);
    return out + '…';
  }

  // 一个学员常常报了不止一门课（声乐 + 钢琴 + 乐理），总结图必须能按课程分开出
  // 选项来源 = 课程包 ∪ 消课流水里出现过的课程名（历史改名/已删课程包也能选到）
  function summaryCourseNames(student, logs) {
    const names = [];
    const push = (n) => { if (n && names.indexOf(n) < 0) names.push(n); };
    (student.courses || []).forEach((c) => push(c && c.name));
    logs.forEach((l) => push(l.courseName));
    return names;
  }

  function summaryEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function buildSummaryRows(logs) {
    return logs.map((l) => {
      const sch = l.scheduleId ? schedules.find((s) => s.id === l.scheduleId) : null;
      const fullDate = logDateText(l);
      const d = new Date(fullDate + 'T00:00:00');
      return {
        fullDate,
        dateText: fullDate.slice(5) || fullDate,          // 10-09（头部已给出年份范围）
        weekText: isNaN(d.getTime()) ? '' : SUMMARY_WEEK[d.getDay()],
        clockText: logClock(l),
        courseName: l.courseName || '课程',
        teacherName: l.teacherName || '',
        lessons: Number(l.deductedLessons) || 0,
        amount: Number(l.paymentAmount) || 0,
        isMakeup: isMakeupLesson(sch),
      };
    });
  }

  function buildSummaryMeta(student, rows, allLogs, opts) {
    const course = opts.course || '';
    const sumLessons = rows.reduce((a, r) => a + r.lessons, 0);
    const sumAmount = rows.reduce((a, r) => a + r.amount, 0);
    // 选了课程就只算这个课程包的剩余（家长问的是「这门课还剩几节」，不是全科合计）
    // 课程包找不到时给 —（别拿 0 节骗人，历史流水里的课程名可能已经没有对应课程包）
    const packs = (student.courses || []).filter((c) => !course || c.name === course);
    const hasPack = !course || packs.length > 0;
    const remain = packs.reduce((a, c) => a + (Number(c.remainingLessons) || 0), 0);
    const byCourse = [];
    rows.forEach((r) => {
      const hit = byCourse.find((x) => x.name === r.courseName);
      if (hit) hit.n += r.lessons; else byCourse.push({ name: r.courseName, n: r.lessons });
    });
    const dates = rows.map((r) => r.fullDate).filter(Boolean).sort();
    const clipped = opts.count > 0 ? false : rows.length >= SUMMARY_MAX_ROWS && allLogs.length > rows.length;
    const scope = opts.count > 0
      ? `最近 ${rows.length} 节`
      : (clipped ? `最近 ${rows.length} 节（共 ${allLogs.length} 节记录）` : `全部 ${rows.length} 节`);
    return {
      titleText: course ? `课时总结 · ${course}` : '课时总结',
      lessonCount: sumLessons,
      amountText: sumAmount > 0 ? fmtMoney(sumAmount) : '—',
      remain,
      remainText: !hasPack ? '—' : (remain < 0 ? `欠 ${-remain} 节` : `${remain} 节`),
      remainOwed: hasPack && remain < 0,
      subjectText: byCourse.map((x) => `${x.name} ${x.n} 节`).join(' · '),
      rangeText: dates.length ? `${dates[0]} ~ ${dates[dates.length - 1]} · ${scope}` : scope,
      generatedAt: `生成于 ${formatDate(new Date())}`,
      footText: '如对课时有疑问，请随时联系老师核对',
    };
  }

  function buildLessonSummaryCanvas(student, rows, meta) {
    const W = 1080;
    const PAD = 60;
    const CW = W - PAD * 2;
    const KPI_TOP = 300;
    const KPI_H = 190;
    const LIST_TITLE_TOP = 552;
    const LIST_TOP = 640;
    const ROW_H = 96;
    const listH = rows.length ? rows.length * ROW_H : 150;
    const FOOT_TOP = LIST_TOP + listH + 44;
    const H = FOOT_TOP + 96;

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    // 底色 + 顶部橙带（和家长对话里一眼能认出是课程消息）
    ctx.fillStyle = '#faf7f2';
    ctx.fillRect(0, 0, W, H);
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#fe4c02');
    grad.addColorStop(1, '#ff9a62');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, 12);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = summaryFont(30, 700);
    ctx.fillStyle = '#fe4c02';
    // 按课程出图时标题要带上课程名，否则同一学员的多张图在微信里分不清
    ctx.fillText(summaryFit(ctx, meta.titleText || '课时总结', CW - 250), PAD, 108);
    ctx.textAlign = 'right';
    ctx.font = summaryFont(26, 400);
    ctx.fillStyle = '#a8a29e';
    ctx.fillText(meta.generatedAt, W - PAD, 108);
    ctx.textAlign = 'left';

    ctx.font = summaryFont(64, 700);
    ctx.fillStyle = '#1c1917';
    ctx.fillText(summaryFit(ctx, student.name, CW), PAD, 200);

    ctx.font = summaryFont(28, 400);
    ctx.fillStyle = '#78716c';
    ctx.fillText(summaryFit(ctx, meta.rangeText, CW), PAD, 258);

    // KPI 卡
    summaryRoundRect(ctx, PAD, KPI_TOP, CW, KPI_H, 28);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#f2ece4';
    ctx.lineWidth = 2;
    ctx.stroke();

    const cells = [
      { label: '本期上课', value: `${meta.lessonCount} 节`, color: '#fe4c02' },
      { label: '本期课时费', value: meta.amountText, color: '#1c1917' },
      { label: '当前剩余课时', value: meta.remainText, color: meta.remainOwed ? '#d5304f' : '#1c1917' },
    ];
    cells.forEach((c, i) => {
      const cx = PAD + (CW / 3) * (i + 0.5);
      if (i > 0) {
        ctx.beginPath();
        ctx.moveTo(PAD + (CW / 3) * i, KPI_TOP + 44);
        ctx.lineTo(PAD + (CW / 3) * i, KPI_TOP + KPI_H - 44);
        ctx.strokeStyle = '#f2ece4';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.textAlign = 'center';
      ctx.font = summaryFont(26, 400);
      ctx.fillStyle = '#a8a29e';
      ctx.fillText(c.label, cx, KPI_TOP + 68);
      ctx.font = summaryFont(54, 700);
      ctx.fillStyle = c.color;
      ctx.fillText(c.value, cx, KPI_TOP + 142);
    });
    ctx.textAlign = 'left';

    // 明细标题 + 科目汇总
    ctx.font = summaryFont(34, 700);
    ctx.fillStyle = '#1c1917';
    ctx.fillText('上课明细', PAD, LIST_TITLE_TOP);
    ctx.textAlign = 'right';
    ctx.font = summaryFont(26, 400);
    ctx.fillStyle = '#a8a29e';
    ctx.fillText(`共 ${rows.length} 条记录`, W - PAD, LIST_TITLE_TOP);
    ctx.textAlign = 'left';
    if (meta.subjectText) {
      ctx.font = summaryFont(26, 400);
      ctx.fillStyle = '#78716c';
      ctx.fillText(summaryFit(ctx, meta.subjectText, CW), PAD, LIST_TITLE_TOP + 42);
    }

    // 明细卡
    summaryRoundRect(ctx, PAD, LIST_TOP, CW, listH, 28);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#f2ece4';
    ctx.lineWidth = 2;
    ctx.stroke();

    if (!rows.length) {
      ctx.textAlign = 'center';
      ctx.font = summaryFont(28, 400);
      ctx.fillStyle = '#a8a29e';
      ctx.fillText('该范围内没有消课记录', W / 2, LIST_TOP + listH / 2 + 10);
      ctx.textAlign = 'left';
    }

    const leftX = PAD + 36;
    const rightX = W - PAD - 36;
    rows.forEach((r, i) => {
      const top = LIST_TOP + i * ROW_H;
      if (i > 0) {
        ctx.beginPath();
        ctx.moveTo(leftX, top);
        ctx.lineTo(rightX, top);
        ctx.strokeStyle = '#f2ece4';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      const midY = top + ROW_H / 2;

      ctx.font = summaryFont(30, 700);
      ctx.fillStyle = '#1c1917';
      ctx.fillText(r.dateText, leftX, midY - 2);
      const dateW = ctx.measureText(r.dateText).width;
      if (r.weekText) {
        ctx.font = summaryFont(24, 400);
        ctx.fillStyle = '#a8a29e';
        ctx.fillText(r.weekText, leftX + dateW + 10, midY - 2);
      }
      if (r.clockText) {
        ctx.font = summaryFont(24, 400);
        ctx.fillStyle = '#a8a29e';
        ctx.fillText(r.clockText, leftX, midY + 30);
      }

      const midX = leftX + 220;
      const midW = rightX - 170 - midX;
      ctx.font = summaryFont(32, 700);
      ctx.fillStyle = '#1c1917';
      const courseTxt = summaryFit(ctx, r.courseName, midW);
      ctx.fillText(courseTxt, midX, midY + 2);
      if (r.isMakeup) {
        const tw = ctx.measureText(courseTxt).width;
        const bw = 76, bh = 34, bx = midX + tw + 12, by = midY - 26;
        summaryRoundRect(ctx, bx, by, bw, bh, 8);
        ctx.fillStyle = '#e8f2f4';
        ctx.fill();
        ctx.font = summaryFont(22, 700);
        ctx.fillStyle = '#2E5D68';
        ctx.textAlign = 'center';
        ctx.fillText('补课', bx + bw / 2, by + 25);
        ctx.textAlign = 'left';
      }
      if (r.teacherName) {
        ctx.font = summaryFont(24, 400);
        ctx.fillStyle = '#78716c';
        ctx.fillText(summaryFit(ctx, r.teacherName, midW), midX, midY + 33);
      }

      ctx.textAlign = 'right';
      ctx.font = summaryFont(32, 700);
      ctx.fillStyle = '#1c1917';
      ctx.fillText(`${r.lessons} 节`, rightX, midY + 2);
      if (r.amount > 0) {
        ctx.font = summaryFont(24, 400);
        ctx.fillStyle = '#78716c';
        ctx.fillText(fmtMoney(r.amount), rightX, midY + 33);
      }
      ctx.textAlign = 'left';
    });

    ctx.textAlign = 'center';
    ctx.font = summaryFont(26, 400);
    ctx.fillStyle = '#a8a29e';
    ctx.fillText(meta.footText, W / 2, FOOT_TOP + 40);
    ctx.textAlign = 'left';

    return canvas;
  }

  // 保存 / 分享：手机优先走系统分享（能直接发微信），不支持再回退成下载
  async function exportSummaryImage(canvas, student, course) {
    const name = `课时总结_${student.name}${course ? '_' + course : ''}_${formatDate(new Date())}.png`;
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) { showToast('图片生成失败，试试缩小范围'); return; }
    const file = new File([blob], name, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: '课时总结' });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;   // 用户自己取消，不算失败
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast('图片已保存到相册/下载目录');
  }

  function openMobileLessonSummaryModal(student) {
    if (!student) return;
    normalizeStudent(student);
    const allLogs = checkInLogs
      .filter((l) => l.studentId === student.id && !isRefundLog(l))
      .slice()
      .sort((a, b) => (b.checkInTime || '').localeCompare(a.checkInTime || ''));

    const titleEl = document.getElementById('mobileLessonSummaryTitle');
    if (titleEl) titleEl.textContent = `${student.name} · 课时总结`;
    const body = document.getElementById('mobileLessonSummaryBody');
    if (!body) return;

    // 多课程学员默认让用户选一门再出图；只有一门课就直接出，别多一步
    const courseNames = summaryCourseNames(student, allLogs);
    const courseBlock = courseNames.length > 1 ? `
      <div>
        <div class="font-bold text-[11px] text-slate-500 mb-1.5">按课程</div>
        <select id="mSummaryCourse" class="w-full px-3 py-3 border border-slate-200 rounded-xl font-bold text-slate-800 outline-none bg-white">
          <option value="">全部课程（合并成一张）</option>
          ${courseNames.map((n) => `<option value="${summaryEsc(n)}">${summaryEsc(n)}</option>`).join('')}
        </select>
        <div class="text-[10px] text-slate-400 mt-1">选一门课只统计这门课的记录，剩余课时也只算这个课程包。</div>
      </div>` : '';

    body.innerHTML = `
      <div class="text-[11px] text-slate-500 leading-relaxed">生成一张图片直接发微信给家长：本期上了哪些课、几节、多少钱、还剩多少节。</div>
      ${allLogs.length === 0 ? '<div class="text-[11px] text-slate-400 py-6 text-center bg-slate-50 rounded-2xl">该学员还没有消课记录，先消课再来生成</div>' : `
      ${courseBlock}
      <div>
        <div class="font-bold text-[11px] text-slate-500 mb-1.5">取多少节</div>
        <select id="mSummaryCount" class="w-full px-3 py-3 border border-slate-200 rounded-xl font-bold text-slate-800 outline-none bg-white">
          <option value="10" selected>最近 10 节</option>
          <option value="5">最近 5 节</option>
          <option value="20">最近 20 节</option>
          <option value="30">最近 30 节</option>
          <option value="0">全部（最多 ${SUMMARY_MAX_ROWS} 节）</option>
        </select>
        <div class="text-[10px] text-slate-400 mt-1">一张图最多 ${SUMMARY_MAX_ROWS} 节，再长就看不清了；更长的区间用下面的日期分批生成。</div>
      </div>
      <div>
        <div class="font-bold text-[11px] text-slate-500 mb-1.5">日期范围（可选）</div>
        <div class="flex items-center gap-2">
          <input id="mSummaryFrom" type="date" class="flex-1 min-w-0 px-3 py-3 border border-slate-200 rounded-xl text-slate-600 outline-none" />
          <span class="text-slate-300">~</span>
          <input id="mSummaryTo" type="date" class="flex-1 min-w-0 px-3 py-3 border border-slate-200 rounded-xl text-slate-600 outline-none" />
        </div>
      </div>
      <button type="button" id="mSummaryGenerate" class="w-full py-3.5 rounded-2xl lm-btn-fin text-sm">生成图片</button>
      <div id="mSummaryPreview" class="hidden">
        <div class="max-h-[46vh] overflow-y-auto rounded-2xl border border-slate-200">
          <img id="mSummaryImg" class="w-full" alt="课时总结预览" />
        </div>
        <button type="button" id="mSummarySave" class="w-full mt-2 py-3.5 rounded-2xl bg-white border border-slate-200 text-slate-700 font-bold text-sm flex items-center justify-center gap-1.5 active:bg-slate-50 transition">
          <i class="fa-solid fa-download"></i> 保存 / 分享图片
        </button>
      </div>`}
    `;
    showModal('modalMobileLessonSummary');

    if (!allLogs.length) return;

    const courseSel = body.querySelector('#mSummaryCourse');
    const countSel = body.querySelector('#mSummaryCount');
    const fromInput = body.querySelector('#mSummaryFrom');
    const toInput = body.querySelector('#mSummaryTo');
    const previewBox = body.querySelector('#mSummaryPreview');
    const previewImg = body.querySelector('#mSummaryImg');
    let pendingCanvas = null;
    let pendingCourse = '';

    body.querySelector('#mSummaryGenerate').addEventListener('click', () => {
      const course = courseSel ? courseSel.value : '';
      const count = parseInt(countSel.value, 10) || 0;
      const from = fromInput.value || '';
      const to = toInput.value || '';
      // 先按课程收窄，再按节数/日期收窄 —— 「最近 10 节」的口径是「这门课最近 10 节」
      const scoped = course ? allLogs.filter((l) => (l.courseName || '课程') === course) : allLogs;
      if (!scoped.length) {
        // 上一张图还留在预览区会让人把旧图发出去，失败时一并收起来
        pendingCanvas = null;
        previewBox.classList.add('hidden');
        showToast(`「${course}」还没有消课记录`);
        return;
      }
      let picked = scoped.slice();
      if (from) picked = picked.filter((l) => logDateText(l) >= from);
      if (to) picked = picked.filter((l) => logDateText(l) <= to);
      picked = count > 0 ? picked.slice(0, count) : picked.slice(0, SUMMARY_MAX_ROWS);
      if (!picked.length) {
        pendingCanvas = null;
        previewBox.classList.add('hidden');
        showToast('该范围内没有消课记录');
        return;
      }
      const rows = buildSummaryRows(picked);
      pendingCanvas = buildLessonSummaryCanvas(student, rows, buildSummaryMeta(student, rows, scoped, { count, from, to, course }));
      pendingCourse = course;
      previewImg.src = pendingCanvas.toDataURL('image/png');
      previewBox.classList.remove('hidden');
      previewBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    body.querySelector('#mSummarySave').addEventListener('click', () => {
      if (!pendingCanvas) { showToast('先点「生成图片」'); return; }
      exportSummaryImage(pendingCanvas, student, pendingCourse);
    });

    // 改了课程/节数/日期就收起上一张图：否则预览里挂着的是旧条件的图，很容易直接发出去
    [courseSel, countSel, fromInput, toInput].forEach((el) => {
      if (!el) return;
      el.addEventListener('change', () => {
        pendingCanvas = null;
        previewBox.classList.add('hidden');
      });
    });
  }

  // ==========================================
  // 导入历史消课（使用 LessonMate 之前上过的课）
  // ==========================================
  // 与桌面 `js/app.js` 第 14b 节**同名同语义**（双端各一份实现是本项目惯例），改一处必须两边一起改。
  // 三条硬约束见 AGENTS 第 42 条：一行 N 节要拆成 N 条 1 节、checkInTime 取本地中午 12:00、
  // 重导同一份文件必须幂等（去重键 studentId+date+course+金额）。
  // ==========================================
  // 14b-0. 最小 XLSX 读写（无依赖，只服务历史导入模板）
  // ==========================================
  // 为什么自己写：本项目是纯静态 PWA，不引 npm 包；模板要「学员 / 消课记录」两个工作表，
  // CSV 装不下两个表，只能上 xlsx。xlsx 本质 = ZIP + 一堆 XML：
  //   读 = 解 zip（要 raw inflate）+ 解析 sharedStrings / styles / sheet；
  //   写 = 打 zip（只存不压缩，STORE）+ 拼 XML，不需要 deflate。
  // 只覆盖导入用得到的子集：共享字符串、内联字符串、数字、日期序列号。
  // 单元格里的日期是「序列号 + 数字格式」，必须靠 xl/styles.xml 的 cellXfs 判断，
  // 否则 2026-03-05 读出来是 46086 这种天文数字。
  const XLSX_CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function xlsxCrc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = XLSX_CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // raw deflate（RFC1951）。bitbuf 最多攒 32 位、单次取位 ≤16 位，不会溢出。
  function xlsxInflate(input) {
    const src = input;
    let pos = 0; let bitbuf = 0; let bitcnt = 0;
    let out = new Uint8Array(Math.max(1024, src.length * 5));
    let olen = 0;
    const grow = (n) => {
      if (olen + n <= out.length) return;
      let cap = out.length || 1024;
      while (cap < olen + n) cap *= 2;
      const nb = new Uint8Array(cap);
      nb.set(out.subarray(0, olen));
      out = nb;
    };
    const bits = (n) => {
      if (!n) return 0;
      while (bitcnt < n) {
        if (pos >= src.length) throw new Error('压缩数据不完整');
        bitbuf |= src[pos++] << bitcnt;
        bitcnt += 8;
      }
      const v = bitbuf & ((1 << n) - 1);
      bitbuf >>>= n;
      bitcnt -= n;
      return v;
    };
    const buildHuff = (lens) => {
      let maxBits = 0;
      for (let i = 0; i < lens.length; i++) if (lens[i] > maxBits) maxBits = lens[i];
      const cnt = new Array(maxBits + 1).fill(0);
      for (let i = 0; i < lens.length; i++) if (lens[i]) cnt[lens[i]]++;
      const next = new Array(maxBits + 1).fill(0);
      let code = 0;
      for (let b = 1; b <= maxBits; b++) { code = (code + cnt[b - 1]) << 1; next[b] = code; }
      const map = new Map();
      for (let s = 0; s < lens.length; s++) {
        const l = lens[s];
        if (!l) continue;
        map.set((l << 16) | next[l]++, s);
      }
      return { map, maxBits };
    };
    const decode = (h) => {
      let code = 0;
      for (let l = 1; l <= h.maxBits; l++) {
        code = (code << 1) | bits(1);
        const s = h.map.get((l << 16) | code);
        if (s !== undefined) return s;
      }
      throw new Error('压缩数据损坏');
    };
    const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
    const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
    const FIX_LIT = new Uint8Array(288);
    for (let i = 0; i < 288; i++) FIX_LIT[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
    let final = 0;
    while (!final) {
      final = bits(1);
      const type = bits(2);
      if (type === 0) {
        bitbuf = 0; bitcnt = 0;                       // 存储块要按字节对齐
        const len = src[pos] | (src[pos + 1] << 8);
        const nlen = src[pos + 2] | (src[pos + 3] << 8);
        if ((len ^ 0xFFFF) !== nlen) throw new Error('压缩数据损坏');
        pos += 4;
        grow(len);
        out.set(src.subarray(pos, pos + len), olen);
        olen += len; pos += len;
        continue;
      }
      let litH; let distH;
      if (type === 1) {
        litH = buildHuff(FIX_LIT);
        distH = buildHuff(new Uint8Array(30).fill(5));
      } else if (type === 2) {
        const hlit = bits(5) + 257;
        const hdist = bits(5) + 1;
        const hclen = bits(4) + 4;
        const clLens = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) clLens[CL_ORDER[i]] = bits(3);
        const clH = buildHuff(clLens);
        const lens = new Uint8Array(hlit + hdist);
        let i = 0;
        while (i < lens.length) {
          const sym = decode(clH);
          if (sym < 16) { lens[i++] = sym; continue; }
          let rep = 0; let val = 0;
          if (sym === 16) { if (!i) throw new Error('压缩数据损坏'); val = lens[i - 1]; rep = 3 + bits(2); }
          else if (sym === 17) { rep = 3 + bits(3); }
          else { rep = 11 + bits(7); }
          while (rep-- > 0 && i < lens.length) lens[i++] = val;
        }
        litH = buildHuff(lens.subarray(0, hlit));
        distH = buildHuff(lens.subarray(hlit));
      } else {
        throw new Error('不支持的压缩方式');
      }
      for (;;) {
        const sym = decode(litH);
        if (sym === 256) break;
        if (sym < 256) { grow(1); out[olen++] = sym; continue; }
        const li = sym - 257;
        if (li >= 29) throw new Error('压缩数据损坏');
        const len = LEN_BASE[li] + bits(LEN_EXTRA[li]);
        const di = decode(distH);
        if (di >= 30) throw new Error('压缩数据损坏');
        const dist = DIST_BASE[di] + bits(DIST_EXTRA[di]);
        if (dist > olen) throw new Error('压缩数据损坏');
        grow(len);
        for (let k = 0; k < len; k++) { out[olen] = out[olen - dist]; olen++; }
      }
    }
    return out.subarray(0, olen);
  }

  // 读 ZIP 中央目录，按需取条目（兼容 Excel 的 data descriptor：大小以中央目录为准）
  function xlsxUnzip(buf) {
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    const td = new TextDecoder('utf-8');
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= 0 && i >= buf.byteLength - 65558; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 xlsx');
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const entries = new Map();
    for (let i = 0; i < count; i++) {
      if (off + 46 > buf.byteLength || dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const compSize = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const cmtLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = td.decode(u8.subarray(off + 46, off + 46 + nameLen));
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      entries.set(name, { method, compSize, start: localOff + 30 + lNameLen + lExtraLen });
      off += 46 + nameLen + extraLen + cmtLen;
    }
    return {
      text(name) {
        const e = entries.get(name);
        if (!e) return '';
        const raw = u8.subarray(e.start, e.start + e.compSize);
        const bytes = e.method === 0 ? raw : e.method === 8 ? xlsxInflate(raw) : null;
        if (!bytes) throw new Error('xlsx 用了不支持的压缩方式');
        return td.decode(bytes);
      },
    };
  }

  function xlsxUnescape(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&amp;/g, '&');
  }

  function xlsxAttr(tag, name) {
    const m = String(tag).match(new RegExp('\\s' + name + '\\s*=\\s*"([^"]*)"'));
    return m ? xlsxUnescape(m[1]) : '';
  }

  // 内置日期格式号 + 自定义格式串（yyyy-mm-dd / m"月"d"日"）都要认
  const XLSX_DATE_FMT_IDS = [14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57];

  function xlsxIsDateFormat(code) {
    const s = String(code || '')
      .replace(/"[^"]*"/g, '')       // 去掉 "年" 这类字面量
      .replace(/\[[^\]]*\]/g, '')    // 去掉 [$-409] / [红色]
      .replace(/\\/g, '');
    return /[ymd]/i.test(s) && !/^[#0.,%\s]+$/.test(s);
  }

  // Excel 序列号 → YYYY-MM-DD（1900 系统要处理那个不存在的 2 月 29 日：<60 的用 12-31 起算）
  function xlsxSerialToDate(serial, date1904) {
    const days = Math.floor(serial);
    const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, days > 59 ? 30 : 31);
    const d = new Date(base + days * 86400000);
    const y = d.getUTCFullYear();
    if (y < 1900 || y > 2200) return '';
    return `${y}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  // "AB12" → 1（0 基）
  function xlsxColIndex(ref) {
    const m = String(ref || '').match(/^([A-Z]+)/i);
    if (!m) return -1;
    const s = m[1].toUpperCase();
    let n = 0;
    for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n - 1;
  }

  // 读整本工作簿 → [{ name, rows: [[单元格文本, ...], ...] }]
  function xlsxRead(buf) {
    const zip = xlsxUnzip(buf);
    const wbXml = zip.text('xl/workbook.xml');
    if (!wbXml) throw new Error('不是有效的 xlsx');
    const relsXml = zip.text('xl/_rels/workbook.xml.rels');
    const relMap = new Map();
    (relsXml.match(/<Relationship\b[^>]*>/g) || []).forEach((tag) => {
      const id = xlsxAttr(tag, 'Id');
      let target = xlsxAttr(tag, 'Target');
      if (!id || !target) return;
      target = target.replace(/^\/?xl\//, '').replace(/^\.\//, '');
      relMap.set(id, 'xl/' + target);
    });

    // 共享字符串：<si> 里可能有多个 <t>（富文本分段），必须拼起来
    const sst = [];
    const sstXml = zip.text('xl/sharedStrings.xml');
    (sstXml.match(/<si\b[^>]*\/>|<si\b[\s\S]*?<\/si>/g) || []).forEach((si) => {
      const parts = si.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) || [];
      sst.push(parts.map((t) => xlsxUnescape(t.replace(/<[^>]+>/g, ''))).join(''));
    });

    // 样式：cellXfs 里的 numFmtId 决定这格是不是日期
    const stylesXml = zip.text('xl/styles.xml');
    const customFmt = new Map();
    (stylesXml.match(/<numFmt\b[^>]*>/g) || []).forEach((tag) => {
      customFmt.set(xlsxAttr(tag, 'numFmtId'), xlsxAttr(tag, 'formatCode'));
    });
    const xfs = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
    const xfDate = [];
    if (xfs) {
      (xfs[1].match(/<xf\b[^>]*>/g) || []).forEach((tag) => {
        const id = parseInt(xlsxAttr(tag, 'numFmtId') || '0', 10);
        xfDate.push(XLSX_DATE_FMT_IDS.indexOf(id) >= 0
          || (customFmt.has(String(id)) && xlsxIsDateFormat(customFmt.get(String(id)))));
      });
    }
    const date1904 = /date1904\s*=\s*"(1|true)"/.test(wbXml);

    const sheets = [];
    (wbXml.match(/<sheet\b[^>]*>/g) || []).forEach((tag, i) => {
      const name = xlsxAttr(tag, 'name');
      const rid = xlsxAttr(tag, 'r:id') || xlsxAttr(tag, 'id');
      const xml = zip.text((rid && relMap.get(rid)) || ('xl/worksheets/sheet' + (i + 1) + '.xml'));
      if (!xml) return;
      const rows = [];
      (xml.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) || []).forEach((rowXml) => {
        const cells = [];
        (rowXml.match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) || []).forEach((cXml) => {
          const open = (cXml.match(/^<c\b[^>]*>/) || [cXml])[0];
          const t = xlsxAttr(open, 't');
          const s = parseInt(xlsxAttr(open, 's') || '-1', 10);
          let val = '';
          if (t === 'inlineStr') {
            const parts = cXml.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) || [];
            val = parts.map((x) => xlsxUnescape(x.replace(/<[^>]+>/g, ''))).join('');
          } else {
            const vm = cXml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
            const raw = vm ? xlsxUnescape(vm[1]) : '';
            if (t === 's') val = sst[parseInt(raw, 10)] || '';
            else if (t === 'str' || t === 'b' || t === 'e') val = raw;
            else if (raw !== '') {
              const num = Number(raw);
              val = (s >= 0 && xfDate[s] && Number.isFinite(num)) ? (xlsxSerialToDate(num, date1904) || raw) : raw;
            }
          }
          const ci = xlsxColIndex(xlsxAttr(open, 'r'));
          const idx = ci >= 0 ? ci : cells.length;
          while (cells.length < idx) cells.push('');
          cells[idx] = val;
        });
        rows.push(cells);
      });
      sheets.push({ name, rows });
    });
    return sheets;
  }

  // 写工作簿（只 STORE，不压缩 —— 模板只有几十行，体积无所谓，省掉 deflate 实现）
  function xlsxWrite(sheets) {
    const enc = new TextEncoder();
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const colName = (i) => {
      let s = '';
      let n = i + 1;
      while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
      return s;
    };
    const sstMap = new Map();
    const sstList = [];
    const sstIndex = (v) => {
      if (!sstMap.has(v)) { sstMap.set(v, sstList.length); sstList.push(v); }
      return sstMap.get(v);
    };
    const files = [];
    const add = (name, text) => files.push({ name, data: enc.encode(text) });
    const sheetPaths = [];

    sheets.forEach((s, i) => {
      const body = s.rows.map((cells, ri) => {
        const cs = cells.map((v, ci) => {
          const ref = colName(ci) + (ri + 1);
          if (v === '' || v == null) return `<c r="${ref}"/>`;
          return `<c r="${ref}" t="s"><v>${sstIndex(String(v))}</v></c>`;
        }).join('');
        return `<row r="${ri + 1}">${cs}</row>`;
      }).join('');
      const p = `xl/worksheets/sheet${i + 1}.xml`;
      add(p, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + `<sheetData>${body}</sheetData></worksheet>`);
      sheetPaths.push(p);
    });

    add('xl/sharedStrings.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sstList.length}" uniqueCount="${sstList.length}">`
      + sstList.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')
      + '</sst>');

    add('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets>' + sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets>'
      + '</workbook>');

    add('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`
      + '</Relationships>');

    // fills 至少两个（none + gray125）、cellStyles 要有 Normal，否则 Excel 会提示"修复"
    add('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
      + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
      + '<borders count="1"><border/></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
      + '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
      + '</styleSheet>');

    add('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + sheetPaths.map((p) => `<Override PartName="/${p}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '</Types>');

    add('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>');

    // ---- 打包（STORE）----
    const chunks = [];
    const central = [];
    let offset = 0;
    files.forEach((f) => {
      const nameBytes = enc.encode(f.name);
      const crc = xlsxCrc32(f.data);
      const lh = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true);         // 文件名 UTF-8
      dv.setUint16(8, 0, true);              // STORE
      dv.setUint32(14, crc, true);
      dv.setUint32(18, f.data.length, true);
      dv.setUint32(22, f.data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      lh.set(nameBytes, 30);
      chunks.push(lh, f.data);
      central.push({ nameBytes, crc, size: f.data.length, offset });
      offset += lh.length + f.data.length;
    });
    const cdStart = offset;
    central.forEach((c) => {
      const ch = new Uint8Array(46 + c.nameBytes.length);
      const dv = new DataView(ch.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 20, true);
      dv.setUint16(8, 0x0800, true);
      dv.setUint16(10, 0, true);             // STORE
      dv.setUint32(16, c.crc, true);
      dv.setUint32(20, c.size, true);
      dv.setUint32(24, c.size, true);
      dv.setUint16(28, c.nameBytes.length, true);
      dv.setUint32(42, c.offset, true);
      ch.set(c.nameBytes, 46);
      chunks.push(ch);
      offset += ch.length;
    });
    const eocd = new Uint8Array(22);
    const edv = new DataView(eocd.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(8, central.length, true);
    edv.setUint16(10, central.length, true);
    edv.setUint32(12, offset - cdStart, true);
    edv.setUint32(16, cdStart, true);
    chunks.push(eocd);
    return new Blob(chunks, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  const HISTORY_HEADER_ALIASES = {
    date: ['日期', '上课日期', '上课时间', '课次日期', 'date'],
    student: ['学员', '学生', '姓名', '学员姓名', '学生姓名', 'student', 'name'],
    course: ['课程', '科目', '课程名称', '课程名', 'course', 'subject'],
    lessons: ['节数', '课时', '课次', '扣课', '扣课时', 'lessons'],
    amount: ['金额', '课时费', '收费', '费用', '收入', 'amount', 'fee'],
    teacher: ['老师', '教师', '授课老师', '任课老师', 'teacher'],
    remarks: ['备注', '说明', 'note', 'remark', 'memo'],
    // 加入时间（学员属性，不是上课日期）：同一个学员每行写一样就行，导入时取最早的那天
    joinDate: ['加入时间', '加入日期', '入学时间', '入学日期', '报名时间', '报名日期', '开课日期', 'joindate', 'enroll'],
  };

  function historySplitLines(text) {
    return String(text || '')
      .replace(/^\uFEFF/, '')
      .split(/\r\n|\r|\n/)
      .filter((l) => l.trim() !== '');
  }

  function historyDetectDelimiter(line) {
    if (line.indexOf('\t') >= 0) return '\t';
    if (line.indexOf(',') >= 0) return ',';
    if (line.indexOf('，') >= 0) return '，';
    if (line.indexOf(';') >= 0) return ';';
    return ',';
  }

  function historySplitCells(line, delim) {
    const cells = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else { quoted = false; }
        } else { cur += ch; }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === delim) {
        cells.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    cells.push(cur);
    return cells;
  }

  function historyMapHeader(cells) {
    const norm = cells.map((c) => String(c || '').trim().replace(/\s+/g, '').toLowerCase());
    const map = {};
    Object.keys(HISTORY_HEADER_ALIASES).forEach((key) => {
      const aliases = HISTORY_HEADER_ALIASES[key].map((a) => a.toLowerCase());
      for (let i = 0; i < norm.length; i++) {
        if (!norm[i]) continue;
        if (aliases.some((a) => norm[i] === a || norm[i].indexOf(a) === 0)) { map[key] = i; break; }
      }
    });
    const hit = ['date', 'student', 'course'].filter((k) => map[k] !== undefined).length;
    return hit >= 2 ? map : null;
  }

  function historyParseDate(raw) {
    let s = String(raw == null ? '' : raw).trim().replace(/\u3000/g, ' ');
    if (!s) return '';
    s = s.replace(/[年月]/g, '-').replace(/日/g, '').replace(/[./]/g, '-').replace(/\s+/g, ' ').split(' ')[0];
    let m;
    let y; let mo; let d;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else return '';
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return '';
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  function historyParseAmount(raw) {
    const s = String(raw == null ? '' : raw).replace(/[¥￥$元,，\s]/g, '');
    if (!s) return 0;
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
  }

  function historyParseLessons(raw) {
    const s = String(raw == null ? '' : raw).replace(/[节课时次\s]/g, '');
    if (!s) return 1;
    const n = parseInt(s, 10);
    if (!Number.isFinite(n) || n < 1) return NaN;
    return Math.min(n, 20);
  }

  // ---------- 名单工作表（学员：姓名 + 加入时间） ----------
  const ROSTER_HEADER_ALIASES = {
    name: ['姓名', '学员', '学生', '学员姓名', '学生姓名', 'name', 'student'],
    joinDate: ['加入时间', '加入日期', '入学时间', '入学日期', '报名时间', '报名日期', '开课日期', 'joindate', 'enroll'],
  };

  // 二维表 → 行对象。CSV 和 xlsx 共用这一套，保证两条入口解析口径完全一致
  function historyParseMatrix(matrix, lineNos) {
    const clean = [];
    const nos = [];
    matrix.forEach((r, i) => {
      if (r && r.some((c) => String(c == null ? '' : c).trim() !== '')) {
        clean.push(r);
        nos.push(lineNos ? lineNos[i] : i + 1);
      }
    });
    if (!clean.length) return { rows: [], hasHeader: false, error: '文件是空的' };
    const headMap = historyMapHeader(clean[0]);
    const idx = headMap || { date: 0, student: 1, course: 2, lessons: 3, amount: 4, teacher: 5, remarks: 6, joinDate: 7 };
    const rows = [];
    for (let i = headMap ? 1 : 0; i < clean.length; i++) {
      rows.push(historyRowFromCells(clean[i], idx, nos[i]));
    }
    if (!rows.length) return { rows: [], hasHeader: !!headMap, error: headMap ? '只有表头，没有数据行' : '没有数据行' };
    return { rows, hasHeader: !!headMap, error: '' };
  }

  function historyRowFromCells(cells, idx, lineNo) {
    const at = (k) => (idx[k] === undefined ? '' : String(cells[idx[k]] == null ? '' : cells[idx[k]]).trim());
    const joinRaw = at('joinDate');
    const row = {
      line: lineNo,
      date: historyParseDate(at('date')),
      student: at('student').replace(/\s+/g, ''),
      course: at('course'),
      lessons: historyParseLessons(at('lessons')),
      amount: historyParseAmount(at('amount')),
      teacher: at('teacher'),
      remarks: at('remarks'),
      joinDate: historyParseDate(joinRaw),
      // 加入时间看不懂只提醒、不废掉这一行 —— 它只是个附加信息，不该因为一个日期
      // 把整条已经上过的课（和钱）丢掉
      joinDateBad: !!joinRaw && !historyParseDate(joinRaw),
      err: '',
    };
    if (!row.date) row.err = '日期看不懂';
    else if (!row.student) row.err = '缺学员姓名';
    else if (!row.course) row.err = '缺课程名';
    else if (!Number.isFinite(row.lessons)) row.err = '节数看不懂';
    else if (!Number.isFinite(row.amount)) row.err = '金额看不懂';
    return row;
  }

  function parseHistoryCsv(text) {
    const raw = String(text || '').replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
    const lines = [];
    const nos = [];
    raw.forEach((l, i) => { if (l.trim() !== '') { lines.push(l); nos.push(i + 1); } });
    if (!lines.length) return { rows: [], roster: [], hasHeader: false, error: '文件是空的' };
    const delim = historyDetectDelimiter(lines[0]);
    const matrix = lines.map((l) => historySplitCells(l, delim));
    const res = historyParseMatrix(matrix, nos);
    return { rows: res.rows, roster: [], hasHeader: res.hasHeader, error: res.error };
  }

  // 名单：姓名 + 加入时间（也认一行里多出来的列，用不到的忽略）
  function parseHistoryRoster(rows) {
    const clean = (rows || []).filter((r) => r && r.some((c) => String(c == null ? '' : c).trim() !== ''));
    if (!clean.length) return [];
    const head = clean[0].map((c) => String(c == null ? '' : c).trim().replace(/\s+/g, '').toLowerCase());
    const map = {};
    Object.keys(ROSTER_HEADER_ALIASES).forEach((k) => {
      const aliases = ROSTER_HEADER_ALIASES[k];
      for (let i = 0; i < head.length; i++) {
        if (head[i] && aliases.some((a) => head[i] === a || head[i].indexOf(a) === 0)) { map[k] = i; break; }
      }
    });
    // 认不到表头就按 [姓名, 加入时间] 的列序读（和模板一致）
    const hasHead = map.name !== undefined;
    const idx = hasHead ? map : { name: 0, joinDate: 1 };
    const out = [];
    for (let i = hasHead ? 1 : 0; i < clean.length; i++) {
      const cells = clean[i];
      const name = String(cells[idx.name] == null ? '' : cells[idx.name]).replace(/\s+/g, '');
      if (!name) continue;
      const jraw = idx.joinDate === undefined ? '' : String(cells[idx.joinDate] == null ? '' : cells[idx.joinDate]).trim();
      out.push({ name, joinDate: historyParseDate(jraw), joinDateBad: !!jraw && !historyParseDate(jraw) });
    }
    return out;
  }

  // 工作表分工：先看表名，再看表头（用户可能把表改名成「Sheet1」）
  function historyPickSheets(sheets) {
    const find = (re) => sheets.find((s) => re.test(String(s.name || '')));
    let records = find(/消课|上课|课次|流水|记录|record|lesson/i);
    let roster = find(/学员|学生|名单|roster|student/i);
    if (!records && !roster) {
      sheets.forEach((s) => {
        const head = (s.rows[0] || []).map((c) => String(c || ''));
        const looksRecords = head.some((h) => /节数|课时|课次/.test(h));
        const looksRoster = head.some((h) => /姓名|学员|学生/.test(h));
        if (looksRecords && !records) records = s;
        else if (looksRoster && !roster) roster = s;
      });
    }
    if (!records && !roster) records = sheets[0] || null;
    if (records && roster === records) roster = null;
    return { records, roster };
  }

  function parseHistoryWorkbook(buf) {
    const sheets = xlsxRead(buf);
    if (!sheets.length) return { rows: [], roster: [], error: 'Excel 里没有工作表' };
    const picked = historyPickSheets(sheets);
    const rec = picked.records ? historyParseMatrix(picked.records.rows) : { rows: [], hasHeader: true, error: '' };
    const roster = picked.roster ? parseHistoryRoster(picked.roster.rows) : [];
    return {
      rows: rec.rows,
      roster,
      hasHeader: !!rec.hasHeader,
      // 只有名单、没有消课记录也是合法输入（名单本身有价值），所以不当错误
      error: rec.error && !roster.length ? rec.error : '',
    };
  }

  // 统一入口：xlsx / csv 都从这里进，返回 { rows, roster, hasHeader, error }
  async function readHistoryFile(file) {
    if (/\.xlsx$/i.test(file.name || '')) {
      try {
        return parseHistoryWorkbook(await file.arrayBuffer());
      } catch (err) {
        const why = (err && err.message) || '文件可能已损坏';
        return { rows: [], roster: [], error: 'Excel 读取失败（' + why + '），可以另存为 CSV 再导入' };
      }
    }
    const text = await new Promise((resolve, reject) => {
      const rd = new FileReader();
      rd.onload = () => resolve(String(rd.result || ''));
      rd.onerror = () => reject(new Error('读取失败'));
      rd.readAsText(file, 'UTF-8');
    });
    return parseHistoryCsv(text);
  }

  function expandHistoryRow(row) {
    const n = Math.max(1, Math.round(row.lessons));
    const per = Math.round((row.amount / n) * 100) / 100;
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({
        date: row.date,
        student: row.student,
        course: row.course,
        amount: i === n - 1 ? Math.round((row.amount - per * (n - 1)) * 100) / 100 : per,
        teacher: row.teacher,
        remarks: row.remarks,
        joinDate: row.joinDate || '',
        line: row.line,
      });
    }
    return out;
  }

  function historyDedupKey(studentId, date, course, amount) {
    return [studentId, date, course, Math.round((Number(amount) || 0) * 100)].join('|');
  }

  // 生成「可执行计划」：预览和真正导入用的是同一份结果，不会出现"预览 42 条、实际导 45 条"
  function buildHistoryPlan(rows, roster) {
    const rosterList = (roster || []).filter((r) => r && r.name);
    const plan = {
      errors: [],
      accepted: [],
      skippedDuplicate: 0,
      newStudents: [],
      newCourses: [],
      totalRows: rows.length,
      rosterCount: rosterList.length,   // 名单页给了几个人
      rosterOnly: 0,                    // 其中只有名单、一节课记录都没有的新学员
      joinDates: new Map(),             // studentId -> 加入时间（同一个人多行时取最早那天）
      joinDateCount: 0,                 // 会写入加入时间的人数（新建 / 原本为空 / 换日期）
      joinDateUpdate: 0,                // 其中会改掉已有日期的人数
      joinDateWarn: 0,                  // 填了加入时间但看不懂的行数
      archiveNew: true,                 // 新建的学员是否直接进历史学员库（弹层勾选，默认开）
    };
    {
      const el = document.getElementById('mHistoryArchiveNew');
      plan.archiveNew = el ? !!el.checked : true;
    }
    const drafts = [];
    rows.forEach((r) => {
      if (r.err) { plan.errors.push({ line: r.line, msg: r.err }); return; }
      if (r.joinDateBad) plan.joinDateWarn++;
      expandHistoryRow(r).forEach((d) => drafts.push(Object.assign({}, d, { studentId: '', isNewStudent: false })));
    });

    // 学员：按名字匹配（全角/半角空格一律忽略），匹配不到就在计划里排一个新建
    const byName = new Map();
    students.forEach((st) => { if (st && st.name) byName.set(String(st.name).replace(/\s+/g, ''), st.id); });
    const ensureStudent = (rawName) => {
      const name = String(rawName || '').replace(/\s+/g, '');
      if (!byName.has(name)) {
        const id = 'stu_hist_' + (plan.newStudents.length + 1) + '_' + Math.random().toString(36).slice(2, 7);
        byName.set(name, id);
        plan.newStudents.push({ id, name });
      }
      return byName.get(name);
    };
    drafts.forEach((d) => {
      d.studentId = ensureStudent(d.student);
      d.studentName = String(d.student).replace(/\s+/g, '');
      d.isNewStudent = plan.newStudents.some((x) => x.id === d.studentId);
    });

    // 课程包：不存在则计划新建（余额默认 0 —— 历史课都已经上完了，凭空给节数会虚增存量）
    const newCourseKey = new Set();
    drafts.forEach((d) => {
      const st = students.find((s) => s.id === d.studentId);
      const has = st && (st.courses || []).some((c) => c.name === d.course);
      if (has || newCourseKey.has(d.studentId + '|' + d.course)) return;
      newCourseKey.add(d.studentId + '|' + d.course);
      plan.newCourses.push({ studentId: d.studentId, course: d.course });
    });

    // 去重：系统里已有的同键流水先"消耗"掉，多出来的才导 —— 重导同一份文件是幂等的
    const existing = new Map();
    checkInLogs.forEach((l) => {
      if (isRefundLog(l)) return;
      const k = historyDedupKey(l.studentId, logDateText(l), l.courseName || '课程', l.paymentAmount);
      existing.set(k, (existing.get(k) || 0) + 1);
    });
    const used = new Map();
    drafts.forEach((d) => {
      const k = historyDedupKey(d.studentId, d.date, d.course, d.amount);
      const have = existing.get(k) || 0;
      const taken = used.get(k) || 0;
      used.set(k, taken + 1);
      if (taken < have) { plan.skippedDuplicate++; return; }
      plan.accepted.push(d);
    });

    plan.lessons = plan.accepted.length;
    plan.amount = Math.round(plan.accepted.reduce((a, d) => a + d.amount, 0) * 100) / 100;
    plan.studentsInFile = new Set(plan.accepted.map((d) => d.studentId)).size;
    plan.coursesInFile = new Set(plan.accepted.map((d) => d.course)).size;

    // 加入时间（老 CSV 的行内列）：同一个人多行写不同值 → 取最早那天。
    // 用 drafts 而不是 accepted：该行课因重复被跳过时，带来的加入时间仍然有效
    drafts.forEach((d) => {
      if (!d.joinDate) return;
      const cur = plan.joinDates.get(d.studentId);
      if (!cur || d.joinDate < cur) plan.joinDates.set(d.studentId, d.joinDate);
    });

    // 名单页：先保证人存在（哪怕一节记录都没有），再让它的加入时间**盖掉**行内的 ——
    // 名单就是专门放学员属性的那一页，比在每节课后面重复写更可信
    rosterList.forEach((r) => {
      const sid = ensureStudent(r.name);
      if (r.joinDateBad) plan.joinDateWarn++;
      if (r.joinDate) plan.joinDates.set(sid, r.joinDate);
    });
    plan.rosterOnly = plan.newStudents
      .filter((ns) => !plan.accepted.some((d) => d.studentId === ns.id)).length;

    plan.joinDates.forEach((date, sid) => {
      plan.joinDateCount++;                                                  // 会写入的学员数
      const st = students.find((s) => s.id === sid);
      if (st && st.joinDate && st.joinDate !== date) plan.joinDateUpdate++;   // 其中会改掉已有日期的
    });
    return plan;
  }

  function applyHistoryPlan(plan, opts) {
    const seedRemaining = !!(opts && opts.seedRemaining);
    const batchId = 'hist_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const totals = new Map();   // studentId|course -> 合计节数（只在勾了"历史合计作初始余额"时用）

    // 新学员：课程包必须在 normalizeStudent **之前**就带好 ——
    // 空数组会被补一个「基础课程 10 节」的默认包，等于凭空给历史学员 10 节存量（财务会虚高）。
    // 只有名单、一节记录都没有的学员本来就是「还没买课」的状态：打 noDefaultCourse，
    // 否则下次 loadData 又会被补默认包。
    plan.newStudents.forEach((ns, si) => {
      const courses = plan.newCourses
        .filter((c) => c.studentId === ns.id)
        .map((c, ci) => ({ id: 'course_hist_' + Date.now() + '_' + si + '_' + ci, name: c.course, remainingLessons: 0, unitPrice: 0 }));
      const st = {
        id: ns.id,
        name: ns.name,
        colorTheme: 'amber',
        phone: '',
        courses,
        importedAt: new Date().toISOString(),
      };
      if (courses.length) normalizeStudent(st); else st.noDefaultCourse = true;
      if (plan.archiveNew) setStudentArchived(st, true, '历史导入');
      students.push(st);
    });

    // 已有学员：只补他还没有的课程包（余额同样给 0）
    plan.newCourses.forEach((nc, i) => {
      if (plan.newStudents.some((ns) => ns.id === nc.studentId)) return;
      const st = students.find((s) => s.id === nc.studentId);
      if (!st) return;
      st.courses.push({ id: 'course_hist_' + Date.now() + '_' + i, name: nc.course, remainingLessons: 0, unitPrice: 0 });
    });

    // 加入时间**以文件为准**（覆盖）：表格是这个字段的唯一来源，也只有这样才能改掉导错的日期
    plan.joinDates.forEach((date, sid) => {
      const st = students.find((s) => s.id === sid);
      if (st && date) st.joinDate = date;
    });

    plan.accepted.forEach((d, i) => {
      const parts = d.date.split('-');
      const local = new Date(+parts[0], +parts[1] - 1, +parts[2], 12, 0, 0);
      const key = d.studentId + '|' + d.course;
      totals.set(key, (totals.get(key) || 0) + 1);
      checkInLogs.push({
        id: 'cil_hist_' + Date.now() + '_' + i + '_' + Math.random().toString(36).slice(2, 5),
        scheduleId: '',
        studentId: d.studentId,
        studentName: d.studentName,
        courseName: d.course,
        deductedLessons: 1,
        paymentAmount: d.amount,
        checkInTime: local.toISOString(),
        date: d.date,
        remarks: '历史导入' + (d.remarks ? ' · ' + d.remarks : ''),
        teacherName: d.teacher || '',
        source: 'history',
        batchId,
      });
    });

    if (seedRemaining) {
      totals.forEach((n, key) => {
        const [sid, course] = key.split('|');
        const st = students.find((s) => s.id === sid);
        const pack = st && (st.courses || []).find((c) => c.name === course);
        if (pack) pack.remainingLessons = (Number(pack.remainingLessons) || 0) + n;
      });
    }

    return { batchId, count: plan.accepted.length, students: plan.newStudents.length, courses: plan.newCourses.length };
  }

  function historyImportLogs() {
    return checkInLogs.filter((l) => l && l.source === 'history');
  }

  function removeHistoryLogs(batchId) {
    const before = checkInLogs.length;
    checkInLogs = checkInLogs.filter((l) => !(l && l.source === 'history' && (!batchId || l.batchId === batchId)));
    return before - checkInLogs.length;
  }

  // 模板：一个 Excel 两个工作表 —— 「学员」放姓名+加入时间，「消课记录」放每节课
  function downloadHistoryTemplate() {
    const sheets = [
      {
        name: '学员',
        rows: [
          ['姓名', '加入时间'],
          ['陈小雨', '2025-09-01'],
          ['周小满', '2024-09-01'],
        ],
      },
      {
        name: '消课记录',
        rows: [
          ['日期', '学员', '课程', '节数', '金额', '老师', '备注'],
          ['2026-03-05', '陈小雨', '声乐', '1', '180', '张老师', '示例行，导入前请删掉'],
          ['2026-03-12', '陈小雨', '声乐', '2', '360', '张老师', '连上两节就写节数 2，金额会自动均摊'],
          ['2026-03-08', '周小满', '声乐', '1', '180', '张老师', ''],
        ],
      },
      {
        name: '说明',
        rows: [
          ['怎么填（这页只是说明，导入时会跳过）'],
          ['1. 「学员」页：一个人一行，写姓名 + 加入时间。加入时间留空也行。'],
          ['2. 「消课记录」页：一行一节课。连上两节写节数 2，系统会拆成两条 1 节、金额自动均摊。'],
          ['3. 日期 2026-03-05 / 2026/3/5 / 2026年3月5日 都认；Excel 里把列设成日期格式最省事。'],
          ['4. 「学员」页没写的人，只要在消课记录里出现也会自动建；只写名单、没有记录也能导入。'],
          ['5. 示例行请删掉再导入。同一份文件重复导入不会重复记账（按 学员+日期+课程+金额 去重）。'],
          ['6. 只补历史消课记录，不改已有排课、不动已有课时余额。'],
        ],
      },
    ];
    const blob = xlsxWrite(sheets);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'LessonMate_历史消课模板.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast('模板已下载：学员 / 消课记录两个工作表');
  }

  let historyPlanCache = null;

  function renderMobileHistoryPreview() {
    const box = document.getElementById('mHistoryPreview');
    if (!box) return;
    const plan = historyPlanCache;
    if (!plan) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');

    const warn = [];
    if (plan.errors.length) warn.push(`${plan.errors.length} 行有误`);
    if (plan.skippedDuplicate) warn.push(`${plan.skippedDuplicate} 条已存在`);
    if (plan.joinDateWarn) warn.push(`${plan.joinDateWarn} 行加入时间看不懂`);

    const rowsHtml = plan.accepted.slice(0, 6).map((d) => `
      <div class="flex items-center justify-between py-1.5 border-t border-slate-100 first:border-0">
        <div class="min-w-0">
          <div class="font-semibold text-slate-800 truncate">${summaryEsc(d.studentName)} · ${summaryEsc(d.course)}</div>
          <div class="text-[10px] text-slate-400">${d.date}${d.teacher ? ' · ' + summaryEsc(d.teacher) : ''}</div>
        </div>
        <div class="shrink-0 text-slate-600 font-semibold">${d.amount > 0 ? fmtMoney(d.amount) : '—'}</div>
      </div>`).join('');

    const errHtml = plan.errors.slice(0, 4).map((e) => `<div class="text-[10px] text-rose-500">第 ${e.line} 行：${e.msg}</div>`).join('')
      + (plan.errors.length > 4 ? `<div class="text-[10px] text-rose-400">…还有 ${plan.errors.length - 4} 行</div>` : '');

    box.innerHTML = `
      <div class="rounded-2xl border border-slate-200 overflow-hidden">
        <div class="bg-slate-50 px-3 py-2 flex items-center justify-between">
          <span class="font-bold text-slate-700">解析结果</span>
          <span class="text-[10px] text-slate-400">${plan.totalRows} 行${warn.length ? ' · ' + warn.join(' · ') : ''}</span>
        </div>
        <div class="px-3 py-2 space-y-0.5 text-[11px] text-slate-600">
          <div>可导入 <b class="text-[#ff5600]">${plan.accepted.length}</b> 条 · 学员 <b class="text-slate-800">${plan.studentsInFile}</b> 人${plan.newStudents.length ? `（新建 ${plan.newStudents.length}）` : ''}</div>
          ${plan.newStudents.length && plan.archiveNew ? `<div>新建的 ${plan.newStudents.length} 人 → <b class="text-slate-800">历史学员库</b></div>` : ''}
          ${plan.rosterCount ? `<div>名单 <b class="text-slate-800">${plan.rosterCount}</b> 人${plan.rosterOnly ? `（${plan.rosterOnly} 人暂无消课记录）` : ''}</div>` : ''}
          <div>课程 <b class="text-slate-800">${plan.coursesInFile}</b> 门${plan.newCourses.length ? `（新建 ${plan.newCourses.length} 个课程包）` : ''} · 合计 <b class="text-slate-800">${plan.amount > 0 ? fmtMoney(plan.amount) : '—'}</b></div>
          ${plan.joinDateCount ? `<div>加入时间 <b class="text-slate-800">${plan.joinDateCount}</b> 人${plan.joinDateUpdate ? `（${plan.joinDateUpdate} 人将更新）` : ''}</div>` : ''}
        </div>
        ${plan.accepted.length ? `<div class="px-3 pb-2">${rowsHtml}${plan.accepted.length > 6 ? `<div class="text-[10px] text-slate-400 py-1">…下面是另 ${plan.accepted.length - 6} 条</div>` : ''}</div>` : (plan.rosterCount ? '<div class="px-3 pb-2 text-[11px] text-slate-500">本次只导入学员名单，没有消课记录</div>' : '<div class="px-3 pb-2 text-[11px] text-rose-500">没有可导入的行</div>')}
        ${errHtml ? `<div class="px-3 py-2 border-t border-slate-100 space-y-0.5">${errHtml}</div>` : ''}
      </div>`;
  }

  function refreshMobileHistoryClearBtn() {
    const btn = document.getElementById('mClearHistoryLogs');
    if (!btn) return;
    const n = historyImportLogs().length;
    btn.classList.toggle('hidden', n === 0);
    btn.textContent = `清空历史导入（${n} 条）`;
  }

  function openMobileHistoryImport() {
    historyPlanCache = null;
    const fileInput = document.getElementById('mHistoryFileInput');
    if (fileInput) fileInput.value = '';
    const nameEl = document.getElementById('mHistoryFileName');
    if (nameEl) nameEl.textContent = '未选择文件';
    const seedEl = document.getElementById('mHistorySeedRemaining');
    if (seedEl) seedEl.checked = false;
    // 每次打开回到默认口径：新建学员直接进历史学员库
    const archEl = document.getElementById('mHistoryArchiveNew');
    if (archEl) {
      archEl.checked = true;
      if (!archEl.__lmBound) {
        archEl.__lmBound = true;
        archEl.addEventListener('change', () => {
          if (historyPlanCache) {
            historyPlanCache.archiveNew = archEl.checked;
            renderMobileHistoryPreview();
          }
        });
      }
    }
    const preview = document.getElementById('mHistoryPreview');
    if (preview) { preview.innerHTML = ''; preview.classList.add('hidden'); }
    const btn = document.getElementById('mConfirmHistoryImport');
    if (btn) btn.disabled = true;
    refreshMobileHistoryClearBtn();
    showModal('modalMobileHistoryImport');
  }

  async function handleMobileHistoryFileChange(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const nameEl = document.getElementById('mHistoryFileName');
    if (nameEl) nameEl.textContent = file.name;
    const btn = document.getElementById('mConfirmHistoryImport');
    let parsed;
    try {
      parsed = await readHistoryFile(file);
    } catch (err) {
      historyPlanCache = null;
      renderMobileHistoryPreview();
      if (btn) btn.disabled = true;
      showToast('文件读取失败，请重试');
      return;
    }
    if (parsed.error) {
      historyPlanCache = null;
      renderMobileHistoryPreview();
      if (btn) btn.disabled = true;
      showToast(parsed.error);
      return;
    }
    historyPlanCache = buildHistoryPlan(parsed.rows, parsed.roster);
    renderMobileHistoryPreview();
    // 只有名单、没有消课记录也允许导入（新建学员本身就有价值）
    if (btn) btn.disabled = !historyPlanCache.accepted.length && !historyPlanCache.newStudents.length;
    if (!parsed.hasHeader) {
      showToast(parsed.roster.length
        ? '「学员」页没认到表头，按「姓名,加入时间」的列序读的'
        : '没认到表头，按「日期,学员,课程,节数,金额,老师,备注」的列序读的');
    }
  }

  function handleConfirmMobileHistoryImport() {
    if (!historyPlanCache || (!historyPlanCache.accepted.length && !historyPlanCache.newStudents.length)) {
      showToast('先选一个 Excel 或 CSV 文件');
      return;
    }
    const seedEl = document.getElementById('mHistorySeedRemaining');
    const res = applyHistoryPlan(historyPlanCache, { seedRemaining: !!(seedEl && seedEl.checked) });
    saveData();
    refreshMobileAll();
    historyPlanCache = null;
    hideModal('modalMobileHistoryImport');
    showToast(`已导入 ${res.count} 条历史消课记录${res.students ? `，新建 ${res.students} 位学员` : ''}`);
  }

  function handleClearMobileHistoryLogs() {
    const n = historyImportLogs().length;
    if (!n) return;
    if (!confirm(`确定清空全部 ${n} 条历史导入的消课记录吗？\n（真实消课、退款记录不受影响；导入时新建的学员和课程包会保留）`)) return;
    const removed = removeHistoryLogs('');
    saveData();
    refreshMobileAll();
    refreshMobileHistoryClearBtn();
    showToast(`已清空 ${removed} 条历史导入记录`);
  }

  // 手机端充值课时弹窗（与桌面 purchaseCoursePack 同一数据逻辑，自动抵扣欠课）
  // 新购/充值课时包（自动抵扣同课程名欠课）——与桌面端逻辑一致的双端实现
  function purchaseCoursePack(studentId, courseName, lessons, unitPrice) {
    const student = students.find((st) => st.id === studentId);
    if (!student) return;
    normalizeStudent(student);
    migrateStudentCourses(student);

    let remark = '';
    const debtBefore = debts.find((x) => x.studentId === studentId && x.courseName === courseName && x.amount > 0);
    const owedBefore = debtBefore ? debtBefore.amount : 0;

    const existing = (student.courses || []).find((c) => c.name === courseName);
    if (existing) {
      existing.remainingLessons += lessons;
      if (unitPrice > 0) existing.unitPrice = unitPrice;
    } else {
      student.courses.push({
        id: 'course_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        name: courseName,
        remainingLessons: lessons,
        unitPrice,
      });
    }

    // 充值全额计入余额后，按新余额重算欠课（余额转正则欠课自动清除）
    syncDebtForCourse(studentId, courseName, existing ? existing.remainingLessons : lessons);
    const debtAfter = debts.find((x) => x.studentId === studentId && x.courseName === courseName && x.amount > 0);
    const owedAfter = debtAfter ? debtAfter.amount : 0;
    const repaid = Math.max(0, owedBefore - owedAfter);
    if (repaid > 0) remark = ` (自动抵扣欠课 ${repaid} 节)`;

    saveData();
  }

  // ==========================================
  // 退款（F12）—— 与 js/app.js 同语义同字段（两端必须一致）
  // ==========================================
  // 把「学员预交、但没上」的课时退掉，并把钱从当月收入里减出来。
  // 记账复用 checkInLogs（全站唯一的财务痕迹），靠三个字段表达，**零数据层改动**：
  //   · deductedLessons = 0   → 退的是没上过的课，不该动「本月课消节数」
  //   · paymentAmount   = -金额 → 「课消价值 / 收入 / 环比 / 明细」全部自动被扣减
  //   · type            = 'refund' → 与消课记录区分（老数据没有该字段，缺省按消课处理）
  // 撤销快照、云同步、跨标签同步、老师视角过滤因此都是现成路径，不用按 7 处 × 2 文件去抄。
  function isRefundLog(l) { return !!(l && l.type === 'refund'); }

  function recordRefundLog(student, course, lessons, amount, remarks) {
    const now = new Date();
    checkInLogs.push({
      id: 'cil_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      type: 'refund',
      scheduleId: '',
      studentId: student.id,
      studentName: student.name,
      courseName: course.name,
      deductedLessons: 0,
      paymentAmount: -Math.abs(amount || 0),
      refundLessons: lessons,
      checkInTime: now.toISOString(),
      date: formatDate(now),
      remarks: remarks || '',
      teacherName: '',
    });
  }

  // 可退的课程包：余额 > 0 才可退（欠课 / 已用光的不让退，否则会退出一个负余额的假账）
  function refundableCourses(student) {
    if (!student) return [];
    normalizeStudent(student);
    migrateStudentCourses(student);
    return (student.courses || []).filter((c) => (Number(c.remainingLessons) || 0) > 0);
  }

  // 退款主流程。金额由调用方给出（弹窗里默认 = 节数 × 单价，允许手改）。
  // 注意：退款只会让余额朝 0 变小 → 不需要碰欠课账（故不调 syncAllDebts）。
  function executeRefund(studentId, courseKey, lessons, amount, remarks) {
    const student = students.find((st) => st.id === studentId);
    if (!student) return false;
    normalizeStudent(student);
    migrateStudentCourses(student);

    const courses = student.courses || [];
    const course = courses.find((c) => c.id === courseKey) || courses.find((c) => c.name === courseKey);
    if (!course) { showToast('找不到该课程包'); return false; }

    const n = Math.floor(Number(lessons) || 0);
    if (!(n > 0)) { showToast('退款节数至少 1 节'); return false; }
    const left = Number(course.remainingLessons) || 0;
    if (left <= 0) { showToast(`「${course.name}」没有可退课时（当前 ${left} 节）`); return false; }
    if (n > left) { showToast(`「${course.name}」最多可退 ${left} 节`); return false; }

    const money = Math.max(0, Number(amount) || 0);

    pushUndo(`退款 ${student.name}`);
    course.remainingLessons = left - n;
    recordRefundLog(student, course, n, money, remarks);
    saveData();
    refreshMobileAll();
    offerUndo(`💸 已为 ${student.name} 退款「${course.name}」${n} 节 · ¥${money.toFixed(0)}`, `退款 ${student.name}`);
    return true;
  }

  // 金额显示：负数统一写成 -¥1400（而不是 ¥-1400）
  function fmtMoney(v) {
    const n = Number(v) || 0;
    return (n < 0 ? '-¥' : '¥') + Math.abs(n).toFixed(0);
  }

  // ==========================================
  // 低课时续费预警（F1）—— 与桌面端 app.js 同名同语义，改一处必须改两处
  // ==========================================
  const LOW_LESSON_THRESHOLD = 2;

  // 低课时预警行：余额落在 [0, 阈值] 才算「该续费了」（余 0 节也提醒，就是「已用完」）。
  // 欠课（负数）**不进预警** —— 它们归「欠课名单」，两处同时列同一个人会让老师以为要退钱。
  // 排序：剩余节数升序（最该续费的排最前），同数按学员名。
  function lowLessonRows(studentsScope, courseOf) {
    const rows = [];
    (studentsScope || students).forEach((st) => {
      if (isArchivedSt(st)) return; // 历史学员不补课，不能占着课时预警
      normalizeStudent(st);
      const courses = (courseOf ? courseOf(st) : st.courses) || [];
      courses.forEach((c) => {
        const left = Number(c.remainingLessons) || 0;
        if (left >= 0 && left <= LOW_LESSON_THRESHOLD) rows.push({ student: st, course: c, left });
      });
    });
    return rows.sort((a, b) => a.left - b.left || String(a.student.name || '').localeCompare(String(b.student.name || '')));
  }

  // 行内文案：0 节说「已用完」比「剩 0 节」更像人话
  function lowLessonText(left) { return left === 0 ? '已用完' : `剩 ${left} 节`; }

  function openMobileRechargeModal(student, presetCourseName) {
    normalizeStudent(student);
    migrateStudentCourses(student);

    const old = document.getElementById('mobileRechargeModal');
    if (old) old.remove();

    const pre = presetCourseName ? (student.courses || []).find((c) => c.name === presetCourseName) : null;
    const courseOptions = (student.courses || [])
      .map((c) => `<option value="${c.name}"${c === pre ? ' selected' : ''}>${c.name}（余 ${c.remainingLessons}）</option>`)
      .join('');

    const firstCourse = pre || (student.courses || [])[0];

    const modal = document.createElement('div');
    modal.id = 'mobileRechargeModal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.className = 'fixed inset-0 bg-slate-900/40 backdrop-blur-xs z-50 flex items-end justify-center';
    modal.innerHTML = `
      <div class="bg-white rounded-t-3xl shadow-2xl w-full p-5 space-y-3 text-xs transform modal-box">
        <div class="flex items-center justify-between pb-2 border-b border-slate-100">
          <div class="font-bold text-sm text-slate-800"><i class="fa-solid fa-circle-plus text-emerald-500 mr-1"></i> 为 ${student.name} 充值课时</div>
          <button type="button" aria-label="关闭" id="mRechargeClose" class="text-slate-400 hover:text-slate-700 transition"><i class="fa-solid fa-xmark text-xl"></i></button>
        </div>
        <div>
          <label class="block text-[11px] font-semibold text-slate-500 mb-1">课程</label>
          <select id="mRechargeCourseSelect" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-xs font-bold outline-none focus:ring-2 focus:ring-emerald-300 bg-white">
            ${courseOptions}
            <option value="__new__">➕ 新课程包...</option>
          </select>
        </div>
        <div id="mRechargeNewNameWrap" class="hidden">
          <label class="block text-[11px] font-semibold text-slate-500 mb-1">新课程名称</label>
          <input type="text" id="mRechargeNewName" placeholder="如：美术一对一" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-xs outline-none focus:ring-2 focus:ring-emerald-300">
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-[11px] font-semibold text-slate-500 mb-1">充值节数</label>
            <input type="number" min="1" inputmode="numeric" id="mRechargeLessons" value="10" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-xs font-bold outline-none focus:ring-2 focus:ring-emerald-300">
          </div>
          <div>
            <label class="block text-[11px] font-semibold text-slate-500 mb-1">单价 (元/节)</label>
            <input type="number" min="0" step="0.01" inputmode="decimal" id="mRechargePrice" value="${firstCourse && firstCourse.unitPrice > 0 ? firstCourse.unitPrice : ''}" placeholder="如 200" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-xs font-bold outline-none focus:ring-2 focus:ring-emerald-300">
          </div>
        </div>
        <div class="text-[10px] text-slate-400">💡 若该课程有欠课，充值会自动抵扣</div>
        <div class="flex gap-2 pt-1">
          <button id="mRechargeCancel" class="flex-1 py-3 rounded-xl text-slate-600 bg-slate-100 font-bold text-xs active:bg-slate-200">取消</button>
          <button id="mRechargeConfirm" class="flex-1 py-3 rounded-xl bg-emerald-500 text-white font-bold text-xs active:bg-emerald-600">确认充值</button>
        </div>
      </div>
    `;

    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
    showModal('mobileRechargeModal');

    const courseSelect = modal.querySelector('#mRechargeCourseSelect');
    courseSelect.addEventListener('change', () => {
      modal.querySelector('#mRechargeNewNameWrap').classList.toggle('hidden', courseSelect.value !== '__new__');
      if (courseSelect.value !== '__new__') {
        const c = student.courses.find((x) => x.name === courseSelect.value);
        if (c && c.unitPrice > 0) modal.querySelector('#mRechargePrice').value = c.unitPrice;
      }
    });
    modal.querySelector('#mRechargeClose').addEventListener('click', () => modal.remove());
    modal.querySelector('#mRechargeCancel').addEventListener('click', () => modal.remove());
    modal.querySelector('#mRechargeConfirm').addEventListener('click', () => {
      const lessons = parseFloat(modal.querySelector('#mRechargeLessons').value) || 0;
      const price = parseFloat(modal.querySelector('#mRechargePrice').value) || 0;
      if (lessons <= 0) { showToast('请输入有效的充值节数'); return; }
      let courseName = courseSelect.value;
      if (courseName === '__new__') {
        courseName = (modal.querySelector('#mRechargeNewName').value || '').trim();
        if (!courseName) { showToast('请填写新课程名称'); return; }
      }
      modal.remove();
      purchaseCoursePack(student.id, courseName, lessons, price);
      showToast(`💳 ${student.name} 充值「${courseName}」${lessons} 节`);
      renderMobileStudents();
      renderCalendar();
    });
  }

  // 退款弹窗（部分退款：按课时退，金额默认 = 节数 × 单价，可手改）—— 与桌面端同交互
  function openMobileRefundModal(student) {
    normalizeStudent(student);
    migrateStudentCourses(student);

    const old = document.getElementById('mobileRefundModal');
    if (old) old.remove();

    const courses = refundableCourses(student);
    if (!courses.length) { showToast('该学员没有可退的课时（余额为 0 或欠课）'); return; }

    const courseOptions = courses
      .map((c) => `<option value="${c.id}">${c.name}（余 ${c.remainingLessons} 节${c.unitPrice > 0 ? ` · ¥${c.unitPrice}/节` : ''}）</option>`)
      .join('');

    const modal = document.createElement('div');
    modal.id = 'mobileRefundModal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.className = 'fixed inset-0 bg-slate-900/40 backdrop-blur-xs z-50 flex items-end justify-center';
    modal.innerHTML = `
      <div class="bg-white rounded-t-3xl shadow-2xl w-full p-5 space-y-3 text-xs transform modal-box">
        <div class="flex items-center justify-between pb-2 border-b border-slate-100">
          <div class="font-bold text-sm text-slate-800"><i class="fa-solid fa-circle-minus mr-1" style="color:#d5304f;"></i> 为 ${student.name} 退款 / 退课时</div>
          <button type="button" aria-label="关闭" id="mRefundClose" class="text-slate-400 hover:text-slate-700 transition"><i class="fa-solid fa-xmark text-xl"></i></button>
        </div>
        <div>
          <label class="block text-[11px] font-semibold text-slate-500 mb-1">课程包</label>
          <select id="mRefundCourseSelect" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-xs font-bold outline-none focus:ring-2 focus:ring-rose-200 bg-white">
            ${courseOptions}
          </select>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-[11px] font-semibold text-slate-500 mb-1">退款节数</label>
            <input type="number" min="1" step="1" inputmode="numeric" id="mRefundLessons" value="1" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-xs font-bold outline-none focus:ring-2 focus:ring-rose-200">
          </div>
          <div>
            <label class="block text-[11px] font-semibold text-slate-500 mb-1">退款金额 (元)</label>
            <input type="number" min="0" step="0.01" inputmode="decimal" id="mRefundAmount" value="0" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-xs font-bold outline-none focus:ring-2 focus:ring-rose-200">
          </div>
        </div>
        <div>
          <label class="block text-[11px] font-semibold text-slate-500 mb-1">原因 / 备注（可选）</label>
          <input type="text" id="mRefundRemarks" placeholder="如：搬家停课" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-xs outline-none focus:ring-2 focus:ring-rose-200">
        </div>
        <div id="mRefundHint" class="text-[10px] text-slate-400"></div>
        <div class="flex gap-2 pt-1">
          <button id="mRefundCancel" class="flex-1 py-3 rounded-xl text-slate-600 bg-slate-100 font-bold text-xs active:bg-slate-200">取消</button>
          <button id="mRefundConfirm" class="flex-1 py-3 rounded-xl text-white font-bold text-xs" style="background:#d5304f;">确认退款</button>
        </div>
      </div>
    `;

    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
    showModal('mobileRefundModal');

    const sel = modal.querySelector('#mRefundCourseSelect');
    const lessonsEl = modal.querySelector('#mRefundLessons');
    const amountEl = modal.querySelector('#mRefundAmount');
    const hintEl = modal.querySelector('#mRefundHint');

    const curCourse = () => courses.find((c) => c.id === sel.value) || courses[0];
    const syncHint = () => {
      const c = curCourse();
      const left = Number(c.remainingLessons) || 0;
      const n = Math.floor(Number(lessonsEl.value) || 0);
      hintEl.textContent = `「${c.name}」当前剩 ${left} 节 → 退后剩 ${left - n} 节 · 金额 ¥${Number(amountEl.value || 0).toFixed(0)}`;
    };
    // 节数一变就把金额按「节数 × 单价」重算（用户随后可手改金额；换课程包则整体重置）
    const syncByLessons = () => {
      const c = curCourse();
      const left = Number(c.remainingLessons) || 0;
      let n = Math.floor(Number(lessonsEl.value) || 0);
      if (n < 1) n = 1;
      if (n > left) n = left;
      lessonsEl.value = String(n);
      amountEl.value = String((Number(c.unitPrice) || 0) * n);
      syncHint();
    };

    sel.addEventListener('change', () => { lessonsEl.value = '1'; syncByLessons(); });
    lessonsEl.addEventListener('input', syncByLessons);
    amountEl.addEventListener('input', syncHint);
    syncByLessons();

    modal.querySelector('#mRefundClose').addEventListener('click', () => modal.remove());
    modal.querySelector('#mRefundCancel').addEventListener('click', () => modal.remove());
    modal.querySelector('#mRefundConfirm').addEventListener('click', () => {
      const lessons = Math.floor(Number(lessonsEl.value) || 0);
      const amount = Number(amountEl.value) || 0;
      const remarks = (modal.querySelector('#mRefundRemarks').value || '').trim();
      const done = executeRefund(student.id, sel.value, lessons, amount, remarks);
      if (done) {
        modal.remove();
        // 退款后把详情重新打开：课时余额与退款记录都得当场看到变化
        setTimeout(() => openMobileStudentDetail(student.id), 320);
      }
    });
  }

  function addDebt(studentId, courseName, amount) {
    if (amount <= 0) return;
    let d = debts.find((x) => x.studentId === studentId && x.courseName === courseName);
    if (d) {
      d.amount += amount;
    } else {
      d = { id: 'debt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4), studentId, courseName, amount };
      debts.push(d);
    }
  }

  // 同步某学员某课程的欠课账 = max(0, -remainingLessons)
  function syncDebtForCourse(studentId, courseName, remainingLessons) {
    const owed = Math.max(0, -(remainingLessons || 0));
    const d = debts.find((x) => x.studentId === studentId && x.courseName === courseName);
    if (owed > 0) {
      if (d) {
        d.amount = owed;
      } else {
        debts.push({ id: 'debt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4), studentId, courseName, amount: owed });
      }
    } else if (d) {
      debts = debts.filter((x) => x !== d);
    }
  }

  // 全量校准：把负课时（手动填的欠课）同步进欠课账
  function syncAllDebts() {
    students.forEach((st) => {
      (st.courses || []).forEach((c) => syncDebtForCourse(st.id, c.name, c.remainingLessons));
    });
  }

  // ============ 历史账目校准：一节课 = 1 节（与 js/app.js 同语义，见 AGENTS 第 37 条）============
  // 旧版 getLessonCost 按 durationMinutes 折算（手机 /45、桌面 /60），90 分钟的课被记成 2 节：
  // 流水 deductedLessons = 2 / paymentAmount = 2 × 单价 / 课程包 remainingLessons 多扣。
  // 消课流水节数只可能是 1（正常）或 0（退款），**>1 的必定是旧折算产物** → 回正后天然幂等。
  let lessonUnitsFixed = 0;
  let lessonUnitsNoticeQueued = false;
  function migrateLessonUnits() {
    let fixed = 0;
    checkInLogs.forEach((l) => {
      if (!l || isRefundLog(l)) return;
      const oldUnits = Number(l.deductedLessons) || 0;
      if (oldUnits <= 1) return;
      const delta = oldUnits - 1;
      const sch = l.scheduleId ? schedules.find((s) => s.id === l.scheduleId) : null;
      const student = students.find((st) => st.id === l.studentId);
      const course = student
        ? (student.courses || []).find((c) => (sch && sch.courseId && c.id === sch.courseId) || c.name === l.courseName)
        : null;
      if (course) course.remainingLessons = (Number(course.remainingLessons) || 0) + delta;
      l.paymentAmount = Math.round((Number(l.paymentAmount) || 0) / oldUnits);
      l.deductedLessons = 1;
      l.remarks = (l.remarks ? l.remarks + '；' : '') + `历史校准：旧口径记的 ${oldUnits} 节已回正为 1 节`;
      fixed++;
    });
    if (fixed > 0) {
      lessonUnitsFixed += fixed;
      if (!lessonUnitsNoticeQueued) {
        lessonUnitsNoticeQueued = true;
        setTimeout(() => showToast(`📐 已校准 ${lessonUnitsFixed} 条历史消课记录：一节就是 1 节，多扣的课时已加回`), 900);
      }
    }
    return fixed;
  }

  function repayDebt(studentId, courseName, amount) {
    const d = debts.find((x) => x.studentId === studentId && x.courseName === courseName);
    if (!d || d.amount <= 0) return 0;
    const repaid = Math.min(d.amount, amount);
    d.amount -= repaid;
    if (d.amount <= 0.0001) {
      debts = debts.filter((x) => x.id !== d.id);
    }
    return repaid;
  }

  function getStudentDebts(studentId) {
    return debts.filter((d) => d.studentId === studentId && d.amount > 0);
  }

  // 一节课永远 = 1 节（与 js/app.js 同口径，见 AGENTS 第 37 条）。
  // 旧实现是 Math.round(durationMinutes / 45)：45 分钟=1 节、90 分钟=2 节 ——
  // 与电脑端（/60）还不一致，同一节课在两端扣的节数都可能不同。时长与计费无关，别改回去。
  function getLessonCost() {
    return 1;
  }

  // ============ 补课链路（F11） ============
  // 语义：**请假时由用户二选一**「需要补课 / 不用补课」——不是每次请假都要补。
  // 只有 needMakeup 的请假才进「待补池」，之后可以安排补课，补课消课后核销。
  // 数据只落三个字段（不新增集合，避开「7 处 × 2 文件」那套高风险改动）：
  //   · 源请假课 needMakeup (bool)  —— 缺省 false：历史请假数据不能凭空冒出一堆待补
  //   · 补课课次 makeupOfId (id)    —— 指向它补的那节源请假课
  //   · 源请假课 madeUpById (id)    —— 指向把它补上的那节补课课（仅当补课已消课）
  function isMakeupLesson(s) { return !!(s && s.makeupOfId); }

  // 把 "HH:MM" 吸附到 5 分钟整（排课表单的时间框是 step=300）。
  // 排补课会预填源请假课的时间，而历史/导入数据的分钟位不一定是 5 的倍数 ——
  // 那种值填进去会让表单原生校验直接失败，用户点保存却毫无反应（也看不出哪个字段有问题）。
  function snapTo5Min(hm) {
    const parts = String(hm || '').split(':').map(Number);
    if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return hm;
    const total = Math.round((parts[0] * 60 + parts[1]) / 5) * 5;
    return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }

  // 待补：请假 + 标记了要补 + 还没补上
  function isPendingMakeup(s) {
    return !!s && s.status === SCHEDULE_STATUS.STUDENT_LEAVE && !!s.needMakeup && !s.madeUpById;
  }

  // 已补完的请假课（补课消课核销过了）
  function isMakeupDone(s) {
    return !!s && s.status === SCHEDULE_STATUS.STUDENT_LEAVE && !!s.madeUpById;
  }

  // 双向标记一致性：由「节次状态」反推，任何状态变更后调一次即可。
  // 不变量：madeUpById 只在「源课仍是请假」且「补课课次已消课」时存在。
  // 这样「撤销消课 / 请假课被还原 / 补课被删」都能自动把课退回待补，不用到处写 if。
  function syncMakeupLink(sch) {
    if (!sch) return;
    if (sch.makeupOfId) {
      const src = schedules.find((s) => s.id === sch.makeupOfId);
      if (!src) { sch.makeupOfId = null; return; }
      const done = sch.status === SCHEDULE_STATUS.COMPLETED && src.status === SCHEDULE_STATUS.STUDENT_LEAVE;
      src.madeUpById = done ? sch.id : null;
      return;
    }
    if (sch.madeUpById) {
      const mk = schedules.find((s) => s.id === sch.madeUpById);
      const keep = !!mk && mk.status === SCHEDULE_STATUS.COMPLETED && sch.status === SCHEDULE_STATUS.STUDENT_LEAVE;
      if (!keep) {
        if (mk) mk.makeupOfId = null;
        sch.madeUpById = null;
      }
    }
  }

  // 删除节次时断链路：被删的可能是「源请假课」，也可能是「补课课次」
  function cleanupMakeupLinks(schId) {
    schedules.forEach((s) => {
      if (s.id === schId) return;
      if (s.makeupOfId === schId) s.makeupOfId = null;   // 被删的是它补的源课
      if (s.madeUpById === schId) s.madeUpById = null;   // 被删的是核销它的补课
    });
  }

  // 待补池的回溯窗口：含今天在内的最近 7 天（「一周内」）。
  // 今日行上的「排补课」只覆盖今天 —— 三天前请的假没补上，首页就再也看不见了，
  // 时间一长就变成没人记得的死账。所以首页/看板另开一块，把口子放到整周。
  const MAKEUP_WINDOW_DAYS = 7;

  // 近 7 天待补清单：请假 + 需补 + 未核销，按「日期+时间」升序（早请假的排前面，先补最容易烂的那节）。
  // scopeFn 用于老师视角过滤（手机端传 inScope，电脑端传 null = 全量）。
  function pendingMakeupList(scopeFn) {
    const today = new Date();
    const from = new Date(today);
    from.setDate(from.getDate() - (MAKEUP_WINDOW_DAYS - 1));
    const fromStr = formatDate(from);
    const toStr = formatDate(today);
    return schedules
      .filter((s) => (!scopeFn || scopeFn(s)) && isPendingMakeup(s) && s.date >= fromStr && s.date <= toStr)
      .sort((a, b) => ((a.date || '') + (a.startTime || '')).localeCompare((b.date || '') + (b.startTime || '')));
  }

  // 「这假请了几天了」——今天请的=0。给拖久的待补课加一点着急感（前端只负责显示，不参与判定）。
  function makeupDaysAgo(dateStr) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const d = new Date(`${dateStr}T00:00:00`);
    if (isNaN(d.getTime())) return 0;
    return Math.max(0, Math.round((today - d) / 86400000));
  }

  // 待补条的「多久了」文案 + 拖过 3 天给的暖黄小标（两端同一份口径，避免各写各的）
  function makeupAgeLabel(dateStr) {
    const days = makeupDaysAgo(dateStr);
    const text = days === 0 ? '今天' : (days === 1 ? '昨天' : `${days}天前`);
    const chip = days >= 3
      ? `<span class="text-[10px] font-bold rounded-full ml-1.5" style="background:#FEF3C7;color:#7C4A03;padding:1px 6px">已拖 ${days} 天</span>`
      : '';
    return { days, text, chip };
  }

  // 返回值语义（三态按钮依赖它）：true = 真的消了课，false = 被业务拦下（已消课/请假）。
  // uiAnim.runAsyncButton 靠这个决定是「转圈 → 绿底打勾」还是「静默回到初态」。
  function executeCheckIn(scheduleId, remarks, opts) {
    const skipRefresh = !!(opts && opts.skipRefresh);
    const sch = schedules.find((s) => s.id === scheduleId);
    if (!sch) return false;
    if (sch.status === SCHEDULE_STATUS.COMPLETED) {
      showToast('该课程已消课，无需重复操作');
      return false;
    }
    if (sch.status === SCHEDULE_STATUS.STUDENT_LEAVE) {
      showToast('该课程为请假状态，请先撤销请假');
      return false;
    }

    const student = students.find((st) => st.id === sch.studentId);
    const deducted = getLessonCost(sch);
    let payment = 0;
    let finalRemarks = remarks || '';
    if (student) {
      const course = (student.courses || []).find((c) => c.id === sch.courseId || c.name === sch.subject || c.name === sch.courseName);
      if (course) {
        if (course.unitPrice > 0) payment = deducted * course.unitPrice;
        // 消课时扣除课时（App 语义：排课不扣，消课才扣）
        // 快照必须在任何数据变更前拍（下面会改课时、写流水、可能转欠课）
        pushUndo(`消课 ${sch.studentName}`, sch.id);
        course.remainingLessons -= deducted;
        // 扣成负数（超上）→ 转正式欠课账
        if (course.remainingLessons < 0) {
          addDebt(student.id, course.name, -course.remainingLessons);
          finalRemarks = (finalRemarks ? finalRemarks + '；' : '') + '超上' + -course.remainingLessons + '节转欠课';
        }
      }
    }

    sch.status = SCHEDULE_STATUS.COMPLETED;
    recordCheckInLog(sch, deducted, payment, finalRemarks);
    // 补课消课 = 把这节请假课补上了 → 核销源课（源课从「待补」变「已补」）
    syncMakeupLink(sch);
    saveData();
    // skipRefresh：三态动效进行中先别重建 DOM —— 按钮节点一被换掉，动效就整个消失。
    // 等动效跑完由 onDone 调 refreshMobileAll 统一刷新（与桌面看板同一套配合方式）。
    if (!skipRefresh) refreshMobileAll();
    offerUndo(`✅ 已消课：${sch.studentName} · ${sch.subject || sch.courseName || ''}（${deducted}节）${sch.makeupOfId ? ' · 补课' : ''}`, `消课 ${sch.studentName}`);
    if (window.uiAnim) window.uiAnim.flashSchedule(sch.id);
    return true;
  }

  // 学员请假（不限课程时间，已消课的也可改为请假）
  // App 语义：请假本不扣课时；只有已消课改请假时，才把消课扣掉的课时退回
  // needMakeup：由用户在请假时**明确选择**——true 才进待补池（不是每次请假都要补）
  function markStudentLeave(scheduleId, needMakeup) {
    const sch = schedules.find((s) => s.id === scheduleId);
    if (!sch) return;
    if (sch.status === SCHEDULE_STATUS.STUDENT_LEAVE) {
      showToast('该课程已是请假状态');
      return;
    }
    pushUndo(`请假 ${sch.studentName}`, sch.id);
    let leaveMsg = '';

    if (sch.status === SCHEDULE_STATUS.COMPLETED) {
      // 已消课 → 改为请假：删除消课流水（回滚财务）+ 退还消课时扣掉的课时
      checkInLogs = checkInLogs.filter((l) => l.scheduleId !== sch.id);
      const student = students.find((st) => st.id === sch.studentId);
      const deducted = getLessonCost(sch);
      if (student) {
        const course = (student.courses || []).find((c) => c.id === sch.courseId || c.name === sch.subject || c.name === sch.courseName);
        if (course) course.remainingLessons += deducted;
      }
      leaveMsg = `🏖️ 已消课的课程改为请假，退还 ${deducted} 节课时`;
    } else {
      leaveMsg = '🏖️ 已为 ' + sch.studentName + ' 办理请假';
    }

    sch.status = SCHEDULE_STATUS.STUDENT_LEAVE;
    sch.needMakeup = !!needMakeup;
    // 这节本身如果是补课课次，改请假就等于「这节补课没上成」→ 源课退回待补
    syncMakeupLink(sch);
    leaveMsg += needMakeup ? ' · 已转入待补课' : ' · 不补课';
    saveData();
    // 首页今日列表：让这一行滑到请假区（pendingReorderId 由 renderMobileHome 消费一次）
    // 放在其它重渲染之前 —— 万一它们抛错，用户看到的滑动也已经发生了
    pendingReorderId = sch.id;
    if (typeof renderMobileHome === 'function') renderMobileHome();
    renderCalendar();
    renderMobileStudents();
    offerUndo(leaveMsg, `请假 ${sch.studentName}`);
    if (window.uiAnim) window.uiAnim.flashSchedule(sch.id);
  }

  // 请假课「要不要补」的后续开关（请假后再改主意时用）
  function setNeedMakeup(scheduleId, needMakeup) {
    const sch = schedules.find((s) => s.id === scheduleId);
    if (!sch || sch.status !== SCHEDULE_STATUS.STUDENT_LEAVE) return;
    if (sch.madeUpById && !needMakeup) {
      showToast('该请假课已被补课核销，请先撤销那节补课');
      return;
    }
    pushUndo(`改补课标记 ${sch.studentName}`, sch.id);
    sch.needMakeup = !!needMakeup;
    syncMakeupLink(sch);
    saveData();
    refreshMobileAll();
    offerUndo(needMakeup ? '📌 已加入待补课' : '已取消补课标记', `补课标记 ${sch.studentName}`);
    if (window.uiAnim) window.uiAnim.flashSchedule(sch.id);
  }

  function revertScheduleStatus(scheduleId) {
    const sch = schedules.find((s) => s.id === scheduleId);
    if (!sch || sch.status === SCHEDULE_STATUS.SCHEDULED) return;

    pushUndo(`还原 ${sch.studentName} 的课`, sch.id);

    if (sch.status === SCHEDULE_STATUS.COMPLETED) {
      // 撤销消课：删流水 + 退还消课扣掉的课时
      checkInLogs = checkInLogs.filter((l) => l.scheduleId !== sch.id);
      const student = students.find((st) => st.id === sch.studentId);
      const deducted = getLessonCost(sch);
      if (student) {
        const course = (student.courses || []).find((c) => c.id === sch.courseId || c.name === sch.subject || c.name === sch.courseName);
        if (course) course.remainingLessons += deducted;
      }
    }
    // 请假撤销：App 语义下请假本不扣课时，直接还原状态即可

    sch.status = SCHEDULE_STATUS.SCHEDULED;
    // 还原成待上课：这节不请假了，补课标记与核销关系一起清掉
    sch.needMakeup = false;
    sch.madeUpById = null;
    syncMakeupLink(sch);
    saveData();
    // 撤销请假：同一套 FLIP，让这一行滑回时间序里原来的位置
    pendingReorderId = sch.id;
    if (typeof renderMobileHome === 'function') renderMobileHome();
    renderCalendar();
    renderMobileStudents();
    offerUndo('已撤销状态，还原为待上课', `还原 ${sch.studentName} 的课`);
    if (window.uiAnim) window.uiAnim.flashSchedule(sch.id);
  }

  function loadData() {
    const rawStudents =
      localStorage.getItem(STORAGE_KEY_STUDENTS) ||
      localStorage.getItem('edu_scheduler_students_v1') ||
      localStorage.getItem('edu_scheduler_students');

    const rawSchedules =
      localStorage.getItem(STORAGE_KEY_SCHEDULES) ||
      localStorage.getItem('edu_scheduler_schedules_v1') ||
      localStorage.getItem('edu_scheduler_schedules');

    const rawTeachers =
      localStorage.getItem(STORAGE_KEY_TEACHERS) ||
      localStorage.getItem('edu_scheduler_teachers_v1') ||
      localStorage.getItem('edu_scheduler_teachers');

    const rawCourseTypes = localStorage.getItem(STORAGE_KEY_COURSE_TYPES);
    const rawCheckInLogs = localStorage.getItem(STORAGE_KEY_CHECKIN_LOGS);
    const rawDebts = localStorage.getItem(STORAGE_KEY_DEBTS);

    if (rawTeachers !== null) {
      try {
        teachers = JSON.parse(rawTeachers);
      } catch (e) {
        teachers = [];
      }
    } else {
      teachers = [
        { id: 't1', name: '张老师', subject: '钢琴', colorTheme: 'amber' },
        { id: 't2', name: '王老师', subject: '小提琴', colorTheme: 'emerald' },
        { id: 't3', name: '李老师', subject: '声乐/视唱', colorTheme: 'sky' },
        { id: 't4', name: '赵老师', subject: '吉他', colorTheme: 'purple' },
        { id: 't5', name: '陈老师', subject: '架子鼓', colorTheme: 'rose' },
      ];
    }

    if (rawStudents !== null) {
      try {
        students = JSON.parse(rawStudents).map(normalizeStudent);
      } catch (e) {
        students = [];
      }
    } else {
      students = []; // 新设备登录默认留空！
    }

    students.forEach((st) => {
      migrateStudentCourses(st);
      normalizeStudent(st);
    });

    if (rawCourseTypes !== null) {
      try { courseTypes = JSON.parse(rawCourseTypes); } catch (e) { courseTypes = []; }
    }
    ensureDefaultCourseTypes();

    if (rawCheckInLogs !== null) {
      try { checkInLogs = JSON.parse(rawCheckInLogs); } catch (e) { checkInLogs = []; }
    } else {
      checkInLogs = [];
    }
    if (rawDebts !== null) {
      try { debts = JSON.parse(rawDebts).map(normalizeDebt); } catch (e) { debts = []; }
    } else {
      debts = [];
    }

    if (rawSchedules !== null) {
      try {
        schedules = JSON.parse(rawSchedules);
      } catch (e) {
        schedules = [];
      }
    } else {
      schedules = []; // 新设备登录默认留空！
    }

    schedules = schedules.map(normalizeSchedule);
    migrateSeriesIds();

    // 历史账目校准：旧口径把长课时记成多节 → 先回正节数/金额/课时余额，再对欠课账
    migrateLessonUnits();

    // 欠课账校准：负课时（手动填的欠课）同步进欠课账
    syncAllDebts();

    saveDataLocalOnly();
  }

  // 云端同步改走同源 /api/sync 代理（凭据由服务端函数持有，前端不再暴露 token）
  // 服务端实现见 netlify/functions/sync.js —— 读取 UPSTASH_REST_URL / UPSTASH_REST_TOKEN 环境变量
  const CLOUD_SYNC_ENDPOINT = '/api/sync';

  let schoolSyncKey = localStorage.getItem('edu_scheduler_school_key') || '';
  // 本页实例标识：BroadcastChannel 会把消息投递给同上下文里的其他 channel 对象
  // （只排除发送者本身，而 push 每次都 new 一个新对象），自己的广播会回声到自己的
  // onmessage → 多余的一次全量重渲染，会把正在播的动效冲掉。据此过滤掉自己的回声。
  const LM_CTX = 'ctx-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
  let isPushingToCloud = false;
  let isPullingFromCloud = false;
  let cloudSyncFailedOnce = false; // 只提醒一次，避免弹窗轰炸

  async function pushToCloudSync() {
    saveDataLocalOnly();
    if (!schoolSyncKey) return;

    try {
      isPushingToCloud = true;
      const now = Date.now();

      const payload = {
        key: schoolSyncKey,
        updatedAt: now,
        __ctx: LM_CTX, // 来源标识：本页的 onmessage 据此忽略自己的回声
        students,
        schedules,
        teachers,
        courseTypes,
        checkInLogs,
        debts,
      };

      localStorage.setItem('edu_scheduler_last_sync_time', String(now));

      if ('BroadcastChannel' in window) {
        try {
          new BroadcastChannel('edu_scheduler_broadcast').postMessage(payload);
        } catch (e) {}
      }

      const valStr = JSON.stringify(payload);
      const pushRes = await fetch(`${CLOUD_SYNC_ENDPOINT}?key=${encodeURIComponent(schoolSyncKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: valStr
      });
      if (!pushRes.ok) throw new Error(`cloud push failed: ${pushRes.status}`);
      cloudSyncFailedOnce = false;
    } catch (err) {
      console.warn('Cloud sync push:', err);
      if (!cloudSyncFailedOnce) {
        cloudSyncFailedOnce = true;
        showToast('⚠️ 云同步不可用：数据仅保存在本机。请通过部署后的网址访问以启用跨设备同步。');
      }
    } finally {
      isPushingToCloud = false;
    }
  }

  async function pullFromCloudSync(force = false) {
    if (!schoolSyncKey || isPullingFromCloud || isPushingToCloud) return;

    try {
      isPullingFromCloud = true;
      const res = await fetch(`${CLOUD_SYNC_ENDPOINT}?key=${encodeURIComponent(schoolSyncKey)}`, {
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) return;

      const raw = await res.json();
      if (raw) {
        // 兼容服务端返回 {result: <payload>} 或直接返回 payload 对象两种格式
        const remoteData = raw.result
          ? (typeof raw.result === 'string' ? JSON.parse(raw.result) : raw.result)
          : raw;
        if (remoteData && remoteData.updatedAt) {
          const localTime = parseInt(localStorage.getItem('edu_scheduler_last_sync_time') || '0', 10);
          if (force || remoteData.updatedAt > localTime) {
            students = remoteData.students || [];
            schedules = (remoteData.schedules || []).map(normalizeSchedule);
            migrateSeriesIds();
            teachers = mergeTeachersKeepPin(remoteData.teachers, teachers);
            courseTypes = remoteData.courseTypes || courseTypes;
            checkInLogs = remoteData.checkInLogs || [];
            debts = (remoteData.debts || []).map(normalizeDebt);

            // 云端拿回来的仍可能是旧口径数据 → 每次覆盖后都校准一次（幂等）
            migrateLessonUnits();

            // 欠课账校准：负课时（欠课）同步进欠课账
            syncAllDebts();

            localStorage.setItem('edu_scheduler_last_sync_time', String(remoteData.updatedAt));
            saveDataLocalOnly();
            renderMobileTeacherSelect();
            renderCalendar();
            renderMobileStudents();

            if (!force) {
              showToast('⚡ 已实时同步最新课表！');
            }
          }
        }
      }
    } catch (err) {
      // 离线忽略
    } finally {
      isPullingFromCloud = false;
    }
  }

  if ('BroadcastChannel' in window) {
    try {
      const bc = new BroadcastChannel('edu_scheduler_broadcast');
      bc.onmessage = (event) => {
        // 自己发的广播不处理：数据已在内存里，再走一遍全量重渲染只会打断进行中的动效
        if (event.data && event.data.__ctx === LM_CTX) return;
        if (event.data && event.data.updatedAt) {
          students = event.data.students || students;
          schedules = (event.data.schedules || schedules).map(normalizeSchedule);
          teachers = mergeTeachersKeepPin(event.data.teachers, teachers);
          courseTypes = event.data.courseTypes || courseTypes;
          checkInLogs = event.data.checkInLogs || [];
          debts = (event.data.debts || []).map(normalizeDebt);
          saveDataLocalOnly();
          renderMobileTeacherSelect();
          renderCalendar();
          renderMobileStudents();
        }
      };
    } catch (e) {}
  }

  // ---- 轻量轮询：先探版本号，变了才拉全量 ----
  // 旧写法 setInterval(pullFromCloudSync, 2000) 每 2 秒 GET 整份快照（含历史流水近 300 KB）：
  // 单标签页 ≈ 490 MB/小时 → 2026-10 把 Upstash 免费额度 10 GB/月 打满并停库（存储只占 516 KB）。
  // 现在：15 秒问一句 key:ver（几十字节），远端真的变了才 pullFromCloudSync()；后台完全不动。
  const SYNC_POLL_MS = 15000;
  const SYNC_POLL_MAX_MS = 300000; // 连续失败最多退避 5 分钟
  let syncPollTimer = null;
  let syncPollDelay = SYNC_POLL_MS;

  async function probeCloudVersion() {
    if (!schoolSyncKey) return true;
    try {
      const res = await fetch(`${CLOUD_SYNC_ENDPOINT}?key=${encodeURIComponent(schoolSyncKey)}&meta=1`, {
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) return false;
      const meta = await res.json();
      // 老服务端不认识 meta，会把整份快照吐回来 → 直接当成一次全量结果处理
      if (meta && (meta.students || meta.schedules || meta.checkInLogs)) {
        await pullFromCloudSync();
        return true;
      }
      const remoteVer = Number(meta && meta.v) || 0;
      if (!remoteVer) return true;
      const localTime = parseInt(localStorage.getItem('edu_scheduler_last_sync_time') || '0', 10);
      if (remoteVer > localTime) await pullFromCloudSync();
      return true;
    } catch (e) {
      return false;
    }
  }

  function scheduleSyncPoll(delay) {
    clearTimeout(syncPollTimer);
    syncPollTimer = setTimeout(async () => {
      if (document.hidden) { scheduleSyncPoll(syncPollDelay); return; }
      const ok = await probeCloudVersion();
      syncPollDelay = ok ? SYNC_POLL_MS : Math.min(syncPollDelay * 2, SYNC_POLL_MAX_MS);
      scheduleSyncPoll(syncPollDelay);
    }, delay == null ? syncPollDelay : delay);
  }

  // 回前台立刻对一次（手机上切走再切回来不用等下一个周期）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    syncPollDelay = SYNC_POLL_MS;
    probeCloudVersion();
    scheduleSyncPoll(SYNC_POLL_MS);
  });

  scheduleSyncPoll(SYNC_POLL_MS);

  function saveData() {
    pushToCloudSync();
  }

  function saveDataLocalOnly() {
    if (window.__lmFixtures) return; // break-ui 压测模式：测试数据绝不写入 localStorage
    localStorage.setItem(STORAGE_KEY_STUDENTS, JSON.stringify(students));
    localStorage.setItem(STORAGE_KEY_SCHEDULES, JSON.stringify(schedules));
    localStorage.setItem(STORAGE_KEY_TEACHERS, JSON.stringify(teachers));
    localStorage.setItem(STORAGE_KEY_COURSE_TYPES, JSON.stringify(courseTypes));
    localStorage.setItem(STORAGE_KEY_CHECKIN_LOGS, JSON.stringify(checkInLogs));
    localStorage.setItem(STORAGE_KEY_DEBTS, JSON.stringify(debts));
  }

  function checkUrlSyncData() {
    try {
      const hashData = location.hash.substring(1);
      const queryParams = new URLSearchParams(location.search);
      const rawData = queryParams.get('sync') || hashData;

      if (rawData) {
        const decoded = decodeURIComponent(rawData);
        const data = JSON.parse(decoded);
        if (data && (data.students || data.schedules)) {
          students = data.students || [];
          schedules = (data.schedules || []).map(normalizeSchedule);
          migrateSeriesIds();
          teachers = mergeTeachersKeepPin(data.teachers, teachers);
          saveDataLocalOnly();
          showToast('⚡ 扫码同步成功！已载入电脑端最新课表！');
          history.replaceState(null, '', location.pathname);
        }
      }
    } catch (e) {
      console.warn('URL sync error:', e);
    }
  }

  // 新设备首次访问：必须先创建或登录云同步码（机构级账号），否则不进入应用
  function randomSyncKey() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return 'LM' + s;
  }

  function applySyncKey(val) {
    schoolSyncKey = val;
    localStorage.setItem('edu_scheduler_school_key', val);
  }

  // 探测云端该同步码下是否已有数据（同步码大小写敏感，用来做容错而不静默改写用户输入）
  async function cloudHasData(key) {
    if (!key) return false;
    try {
      const res = await fetch(`${CLOUD_SYNC_ENDPOINT}?key=${encodeURIComponent(key)}`, {
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) return false;
      const raw = await res.json();
      if (!raw) return false;
      const remoteData = raw.result
        ? (typeof raw.result === 'string' ? JSON.parse(raw.result) : raw.result)
        : raw;
      return !!(remoteData && remoteData.updatedAt);
    } catch (e) {
      return false;
    }
  }

  // 同步码大小写容错：优先用用户输入的原文；只有原文在云端查不到、而大写形式能查到时，才退回大写
  async function normalizeSyncKeyInput(raw) {
    const val = (raw || '').trim();
    if (!val) return val;
    const upper = val.toUpperCase();
    if (upper === val) return val;
    if (await cloudHasData(val)) return val;
    if (await cloudHasData(upper)) return upper;
    return val;
  }

  function showSyncGate() {
    const ov = document.createElement('div');
    ov.id = 'syncGateOverlay';
    ov.className = 'fixed inset-0 z-[95] bg-slate-900/60 backdrop-blur-sm flex items-end justify-center';
    ov.innerHTML = `
      <div class="bg-white w-full rounded-t-3xl p-6 space-y-4" style="padding-bottom: calc(2rem + env(safe-area-inset-bottom))">
        <div class="text-center">
          <div class="w-14 h-14 mx-auto rounded-2xl bg-[#ff5600] text-white font-bold flex items-center justify-center text-xl">课</div>
          <div class="font-bold text-base text-slate-800 mt-3">欢迎使用 LessonMate</div>
          <div class="text-[11px] text-slate-400 mt-1">先设置机构同步码，多设备才能互通课表</div>
        </div>
        <button id="gateCreate" class="w-full py-3.5 rounded-2xl lm-btn-fin text-sm">🎬 我是新机构，创建同步码</button>
        <div class="flex items-center gap-2">
          <input id="gateKeyInput" type="text" placeholder="输入已有同步码加入机构" autocapitalize="none" autocomplete="off" autocorrect="off" spellcheck="false" class="flex-1 min-w-0 px-3 py-3 border border-slate-200 rounded-2xl text-center font-bold tracking-wider outline-none focus:ring-1 focus:ring-[#ff5600]/30" style="text-transform:none">
          <button id="gateJoin" class="shrink-0 px-5 py-3 rounded-2xl bg-slate-900 text-white text-sm font-bold active:opacity-80">登录</button>
        </div>
      </div>`;
    ov.addEventListener('click', async (e) => {
      if (e.target.closest('#gateCreate')) {
        const code = randomSyncKey();
        applySyncKey(code);
        ov.remove();
        saveData(); // 把本机初始数据推上云，其他设备凭此码即可加入
        if (typeof renderMobileHome === 'function') renderMobileHome();
        showToast(`同步码 ${code} 已创建，可在 设置 → 实时云同步 查看`);
      } else if (e.target.closest('#gateJoin')) {
        const el = document.getElementById('gateKeyInput');
        // 保留用户输入的原文大小写（旧版强制 toUpperCase，会把手输的小写码改掉导致登空）
        const val = await normalizeSyncKeyInput(el ? el.value : '');
        if (!val || val.length < 4) { showToast('请输入正确的同步码'); return; }
        applySyncKey(val);
        await pullFromCloudSync(true);
        ov.remove();
        if (typeof renderMobileHome === 'function') renderMobileHome();
        showToast(`已登录机构 ${val}`);
      }
    });
    document.body.appendChild(ov);
  }

  // ==========================================
  // break-ui 压测模式（dev-only，与桌面端同款）
  // URL 带 ?lmData=worst / ?lmData=demo：worst=把「最坏但真实」的数据灌进内存渲染手机课表卡，
  // demo=常态对照组。只在内存里换数据：不落盘、不云同步、不动 localStorage。
  // ==========================================
  const LM_FIXTURE_MODE = (location.search.match(/[?&]lmData=(worst|demo)/) || [])[1] || '';

  function lmDay(offset) {
    const mon = getMonday(new Date());
    return formatDate(addDays(mon, offset));
  }

  function lmFixtureStudents() {
    return [
      { id: 's1', name: '丁一', colorTheme: 'amber' },
      { id: 's2', name: '欧阳梓萱', colorTheme: 'emerald' },
      { id: 's3', name: 'Anastasia Kowalczyk-Wiśniewska', colorTheme: 'sky' },
      { id: 's4', name: 'Christopher', colorTheme: 'purple' },
      { id: 's5', name: '李', colorTheme: 'rose' },
      { id: 's6', name: 'Nguyễn Thị Minh Khai', colorTheme: 'amber' },
      { id: 's7', name: '🎵林晓彤', colorTheme: 'emerald' },
      { id: 's8', name: '司马相如', colorTheme: 'mint' },
    ];
  }
  function lmFixtureTeachers() {
    return [
      { id: 't1', name: '欧阳老师', subject: '钢琴', colorTheme: 'amber' },
      { id: 't2', name: '司马老师', subject: '小提琴', colorTheme: 'emerald' },
      { id: 't3', name: '王老师', subject: '声乐', colorTheme: 'sky' },
    ];
  }
  function lmFixtureScheduleSet() {
    let n = 0;
    const S = (o) => ({ id: 'mf' + ++n, status: 'scheduled', durationMinutes: 60, ...o });
    // 手机默认从「今天」起显示 3 日：样本铺在今天起的窗口，保证一定在屏幕上
    const todayIdx = Math.round((new Date() - getMonday(new Date())) / 86400000);
    const base = [0, 1, 2].map((k) => todayIdx + k);
    return [
      S({ date: lmDay(base[0]), startTime: '08:00', durationMinutes: 30, studentId: 's1', studentName: '丁一', subject: '钢琴' }),
      S({ date: lmDay(base[0]), startTime: '09:00', durationMinutes: 60, studentId: 's2', studentName: '欧阳梓萱', subject: '成人零基础钢琴速成班（VIP一对一）', teacherId: 't1', teacherName: '欧阳老师', assistantTeacherId: 't2', assistantTeacherName: '司马老师', room: '音乐教室A-301（三角钢琴房）' }),
      // 四节同段重叠：34px 窄列极限
      S({ date: lmDay(base[0]), startTime: '10:00', durationMinutes: 45, studentId: 's2', studentName: '欧阳梓萱', subject: '钢琴', teacherId: 't1', teacherName: '欧阳老师', room: 'A-301' }),
      S({ date: lmDay(base[0]), startTime: '10:15', durationMinutes: 45, studentId: 's3', studentName: 'Anastasia Kowalczyk-Wiśniewska', subject: 'Violin Masterclass Grade 8', teacherId: 't1', teacherName: '欧阳老师', room: 'A-301' }),
      S({ date: lmDay(base[0]), startTime: '10:30', durationMinutes: 60, studentId: 's4', studentName: 'Christopher', subject: '声乐', teacherId: 't1', teacherName: '欧阳老师', room: 'A-301' }),
      S({ date: lmDay(base[0]), startTime: '10:45', durationMinutes: 30, studentId: 's7', studentName: '🎵林晓彤', subject: '架子鼓', teacherId: 't1', teacherName: '欧阳老师', room: 'A-301' }),
      S({ date: lmDay(base[0]), startTime: '13:00', durationMinutes: 120, studentId: 's7', studentName: '🎵林晓彤', subject: '架子鼓', teacherId: 't1', teacherName: '欧阳老师', room: 'A-301' }),
      // 两节并排：53px 列宽 + 两种状态角标
      S({ date: lmDay(base[0]), startTime: '17:00', durationMinutes: 60, studentId: 's2', studentName: '欧阳梓萱', subject: '成人零基础钢琴速成班（VIP）', teacherId: 't1', teacherName: '欧阳老师', room: 'A-301', status: 'completed' }),
      S({ date: lmDay(base[0]), startTime: '17:00', durationMinutes: 60, studentId: 's3', studentName: 'Anastasia Kowalczyk-Wiśniewska', subject: 'Violin Masterclass Grade 8', teacherId: 't1', teacherName: '欧阳老师', room: 'A-301', status: 'student_leave' }),
      S({ date: lmDay(base[1]), startTime: '09:00', durationMinutes: 60, studentId: 's3', studentName: 'Anastasia Kowalczyk-Wiśniewska', subject: 'Violin Masterclass Grade 8', teacherId: 't2', teacherName: '司马老师', room: 'B-205' }),
      S({ date: lmDay(base[1]), startTime: '14:00', durationMinutes: 60, studentId: 's6', studentName: 'Nguyễn Thị Minh Khai', subject: 'Ghi-ta cổ điển', teacherId: 't3', teacherName: '王老师', room: 'C-102' }),
      S({ date: lmDay(base[2]), startTime: '10:00', durationMinutes: 60, studentId: 's5', studentName: '李', subject: '声乐', teacherId: 't3', teacherName: '王老师', room: 'C-102' }),
      S({ date: lmDay(base[2]), startTime: '15:00', durationMinutes: 45, studentId: 's8', studentName: '司马相如', subject: '小提琴', teacherId: 't2', teacherName: '司马老师' }),
    ];
  }
  function lmDemoScheduleSet() {
    let n = 0;
    const S = (o) => ({ id: 'md' + ++n, status: 'scheduled', durationMinutes: 60, ...o });
    const todayIdx = Math.round((new Date() - getMonday(new Date())) / 86400000);
    return [
      S({ date: lmDay(todayIdx), startTime: '09:00', durationMinutes: 60, studentId: 's1', studentName: '丁一', subject: '钢琴', teacherId: 't1', teacherName: '欧阳老师', room: 'A-301' }),
      S({ date: lmDay(todayIdx), startTime: '15:00', durationMinutes: 45, studentId: 's2', studentName: '欧阳梓萱', subject: '声乐', teacherId: 't3', teacherName: '王老师' }),
      S({ date: lmDay(todayIdx + 1), startTime: '10:00', durationMinutes: 60, studentId: 's3', studentName: 'Anastasia Kowalczyk', subject: '小提琴', teacherId: 't2', teacherName: '司马老师', room: 'B-205' }),
      S({ date: lmDay(todayIdx + 2), startTime: '14:00', durationMinutes: 30, studentId: 's4', studentName: 'Christopher', subject: '吉他', teacherId: 't3', teacherName: '王老师', room: 'C-102' }),
    ];
  }

  function applyLmFixtures() {
    if (!LM_FIXTURE_MODE) return;
    window.__lmFixtures = true;
    if (LM_FIXTURE_MODE === 'worst') {
      students = lmFixtureStudents();
      schedules = lmFixtureScheduleSet();
    } else {
      students = lmFixtureStudents().slice(0, 4);
      schedules = lmDemoScheduleSet();
    }
    // teachers 不动：压测只换学员与排课。老师的 accessPin 是本地字段，
    // 替换它会让已登录的老师会话失效 → 平白弹出访问码登录门
    if (!teachers || teachers.length === 0) teachers = lmFixtureTeachers();
    schedules.forEach((s) => { if (!s.status) s.status = SCHEDULE_STATUS.SCHEDULED; });
    schoolSyncKey = ''; // 双保险：压测数据严禁写云端
    console.info(`[break-ui] lmData=${LM_FIXTURE_MODE} 已注入（仅内存，不落盘）`);
  }

  function renderLmFixtureToggle() {
    if (!LM_FIXTURE_MODE) return;
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;bottom:calc(96px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);z-index:9999;background:#fff;border:1px solid #e5e0d5;border-radius:999px;padding:3px;display:flex;gap:2px;box-shadow:0 4px 14px rgba(0,0,0,.14);font-size:12px;font-family:inherit;';
    [
      ['demo', '示例数据'],
      ['worst', '最坏数据'],
    ].forEach(([key, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      const active = key === LM_FIXTURE_MODE;
      b.style.cssText = `border:0;border-radius:999px;padding:5px 12px;cursor:pointer;font:inherit;${active ? 'background:#111;color:#fff;font-weight:700;' : 'background:transparent;color:#626260;'}`;
      b.onclick = () => {
        const u = new URL(location.href);
        u.searchParams.set('lmData', key);
        location.href = u.toString();
      };
      bar.appendChild(b);
    });
    document.body.appendChild(bar);
  }

  function initMobileApp() {
    checkUrlSyncData();
    loadData();
    applyLmFixtures();
    syncScheduleColors();
    loadTeacherSession();
    if (typeof updateHeaderIdentity === 'function') updateHeaderIdentity();
    setupMobileEvents();
    setupTeacherLoginGate();
    mRenderCourseTypesDatalist();
    bindSeriesHintUpdates();
    renderMobileTeacherSelect();
    renderCalendar();
    renderMobileStudents();
    pullFromCloudSync(true).then(() => {
      if (typeof renderMobileHome === 'function') renderMobileHome();
    });
    // 新设备无同步码 → 弹出创建/登录引导（最高层，处理完才能用）
    if (!schoolSyncKey && !LM_FIXTURE_MODE) showSyncGate();
    renderLmFixtureToggle();
  }

  // 老师访问码登录门：有未过期会话则不拦；无会话则先遮住页面再等输入
  function setupTeacherLoginGate() {
    const gate = document.getElementById('teacherLoginGate');
    if (!gate) return;
    if (teacherSession) { gate.classList.add('hidden'); return; }
    gate.classList.remove('hidden');
    const input = document.getElementById('teacherPinInput');
    const err = document.getElementById('teacherPinError');
    const go = () => {
      const t = tryTeacherLogin(input.value);
      if (!t) { err.textContent = '访问码不对，请重试'; input.value = ''; return; }
      err.textContent = '';
      gate.classList.add('hidden');
      showToast(`欢迎，${t.name.endsWith('老师') ? t.name : t.name + '老师'}`);
      renderCalendar();
      renderMobileStudents();
      if (typeof renderMobileHome === 'function') renderMobileHome();
      if (typeof renderMobileFinance === 'function') renderMobileFinance();
      if (typeof updateHeaderIdentity === 'function') updateHeaderIdentity();
    };
    const btn = document.getElementById('btnTeacherPinGo');
    if (btn) btn.addEventListener('click', go);
    if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    // 管理员直通：机主本人不需要 PIN
    const adminBtn = document.getElementById('btnAdminBypass');
    if (adminBtn) adminBtn.addEventListener('click', () => {
      gate.classList.add('hidden');
      renderCalendar();
      renderMobileStudents();
      if (typeof renderMobileFinance === 'function') renderMobileFinance();
      if (typeof updateHeaderIdentity === 'function') updateHeaderIdentity();
    });
    setTimeout(() => input && input.focus(), 100);
  }

  // 顶部右侧身份显示：管理员=老师筛选框；老师=名字徽章
  // showBadge=true 时老师显示徽章；false 时（课表视图）管理员显示筛选框
  function updateHeaderIdentity(showBadge) {
    const adminWrap = document.getElementById('adminTeacherFilterWrap');
    const badge = document.getElementById('teacherNameBadge');
    const nameEl = document.getElementById('teacherNameText');
    if (!adminWrap || !badge) return;
    if (typeof showBadge !== 'boolean') showBadge = true;
    // 老师视角：课表页显示筛选框（默认自己可切换），其余页面显示名字徽章
    if (isTeacherView()) {
      const onSchedule = !showBadge; // 课表视图传入 false
      adminWrap.classList.toggle('hidden', !onSchedule);
      badge.classList.toggle('hidden', onSchedule);
      if (!onSchedule && nameEl) nameEl.textContent = teacherSession.name;
    } else if (showBadge) {
      adminWrap.classList.add('hidden');
      badge.classList.add('hidden');
    } else {
      adminWrap.classList.remove('hidden');
      badge.classList.add('hidden');
    }
  }

  function safeBind(id, eventName, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(eventName, handler);
  }

  function setupMobileEvents() {
    // 云同步入口已移至 设置 分页（msetCloudSync），顶栏不再放按钮
    safeBind('btnCloseSyncModal', 'click', () => hideModal('modalSyncKey'));
    safeBind('btnCancelSyncModal', 'click', () => hideModal('modalSyncKey'));

    safeBind('btnSaveSyncKey', 'click', async () => {
      const el = document.getElementById('inputSyncKey');
      // 与门禁同一套大小写容错：保留原文，只有原文查不到、大写能查到时才退回大写
      const val = await normalizeSyncKeyInput(el ? el.value : '');
      if (!val) { showToast('请输入同步码'); return; }
      schoolSyncKey = val;
      localStorage.setItem('edu_scheduler_school_key', val);
      hideModal('modalSyncKey');
      pullFromCloudSync(true).then(() => {
        showToast(`已开启云同步！同步码: ${val}`);
      });
    });

    safeBind('btnCopyQuickSyncCode', 'click', () => {
      const payloadStr = JSON.stringify({ students, schedules, teachers, updatedAt: Date.now() });
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(payloadStr).then(() => {
          showToast('已复制排课代码！通过微信发送即可');
        }).catch(() => {
          prompt('请复制以下排课同步代码：', payloadStr);
        });
      } else {
        prompt('请复制以下排课同步代码：', payloadStr);
      }
    });

    safeBind('btnPasteQuickSyncCode', 'click', async () => {
      try {
        let text = '';
        if (navigator.clipboard && navigator.clipboard.readText) {
          try { text = await navigator.clipboard.readText(); } catch (e) {}
        }
        if (!text) {
          text = prompt('请粘贴发过来的排课同步代码：');
        }
        if (!text || !text.trim()) return;

        const data = JSON.parse(text.trim());
        if (data && (data.students || data.schedules)) {
          students = data.students || [];
          schedules = (data.schedules || []).map(normalizeSchedule);
          migrateSeriesIds();
          teachers = mergeTeachersKeepPin(data.teachers, teachers);
          saveData();
          renderMobileTeacherSelect();
          renderCalendar();
          renderMobileStudents();
          hideModal('modalSyncKey');
          showToast('⚡ 排课代码解析成功，已同步！');
        } else {
          alert('无效的同步代码，请重新复制粘贴！');
        }
      } catch (e) {
        alert('解析同步代码失败，请确认内容是否完整！');
      }
    });

    safeBind('btnMobilePrev', 'click', () => {
      if (calView === 'day3') { mobileStartDate = addDays(mobileStartDate, -3); renderCalendar(); return; }
      shiftCalPage(-1);
    });

    safeBind('btnMobileNext', 'click', () => {
      if (calView === 'day3') { mobileStartDate = addDays(mobileStartDate, 3); renderCalendar(); return; }
      shiftCalPage(1);
    });

    safeBind('btnMobileToday', 'click', () => {
      // 两个游标一起回今天：3日窗口起点 + 周/月档选中日
      mobileStartDate = getToday();
      calSelected = formatDate(getToday());
      renderCalendar();
    });

    // 三档视图切换：分段控件 / 手势切换线 / 键盘共用同一个入口 setCalView
    document.querySelectorAll('[data-calview]').forEach((btn) => {
      btn.addEventListener('click', () => setCalView(btn.getAttribute('data-calview')));
    });
    syncCalViewChrome(); // 首帧同步分段控件选中态与翻页文案

    // ============ 周/月切换线（拖动条）：上下拖动切换 周 ↔ 月 ============
    // 用 Pointer Events（触摸/鼠标/笔同一套，桌面调试也能直接拖）。
    // 跟手原理：高度即位移 —— applyCalGridHeight(单一标量) 同时决定容器裁剪高度
    // 与网格纵向位移，所以拖动就是逐帧写这一个数，松手交给 GSAP 从当前位置补间。
    // 方向：滑条贴在日历底边，**往下拖 = 把整月拉出来**（下拉展开、上推收起），
    // 与"拉窗口下沿"的直觉一致。
    (function setupCalGrabber() {
      const bar = document.getElementById('calGrabber');
      if (!bar) return;
      let active = null;   // { id, y0, h0, t0, moved }

      const begin = (e) => {
        if (calView === 'day3' || !calGridGeom) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        active = { id: e.pointerId, y0: e.clientY, h0: readCalGridHeight(), t0: performance.now(), moved: false };
        calDrag = active;
        killCalGridTween();               // 手指优先，运行中的补间让位
        bar.classList.add('is-dragging');
        try { bar.setPointerCapture(e.pointerId); } catch (_) { /* 老浏览器忽略 */ }
      };

      const move = (e) => {
        if (!active || e.pointerId !== active.id) return;
        const dy = e.clientY - active.y0;
        if (!active.moved && Math.abs(dy) < 4) return;   // 手指微抖不算拖动
        active.moved = true;
        applyCalGridHeight(active.h0 + dy);              // 下滑 = 正位移 = 变高（展开整月）
        e.preventDefault();
      };

      const end = (e) => {
        if (!active || (e && e.pointerId !== active.id)) return;
        const drag = active;
        active = null;
        calDrag = null;
        bar.classList.remove('is-dragging');
        try { bar.releasePointerCapture(drag.id); } catch (_) { /* 可能已释放 */ }

        const dy = (e ? e.clientY : drag.y0) - drag.y0;
        const v = dy / Math.max(1, performance.now() - drag.t0);   // px/ms，正=下滑
        let want;
        if (!drag.moved || Math.abs(dy) < 8) {
          want = calView === 'month' ? 'week' : 'month';           // 轻点：翻档
        } else if (v > 0.5) want = 'month';                        // 快速下滑 → 展开
        else if (v < -0.5) want = 'week';                          // 快速上推 → 收起
        else {
          const g = calGridGeom;
          const range = Math.max(1, g.fullH - g.collapsedH);
          want = (readCalGridHeight() - g.collapsedH) / range > 0.5 ? 'month' : 'week';
        }
        if (want !== calView) setCalView(want);
        else settleCalGridHeight();                                // 没换档 → 回弹到本档稳定态
      };

      bar.addEventListener('pointerdown', begin);
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', end);
      bar.addEventListener('pointercancel', end);

      // 键盘可达：回车/空格翻档，下键展开、上键收起（与拖动方向一致）
      bar.addEventListener('keydown', (e) => {
        const k = e.key;
        if (k !== 'Enter' && k !== ' ' && k !== 'ArrowUp' && k !== 'ArrowDown') return;
        e.preventDefault();
        const want = k === 'ArrowDown' ? 'month'
          : k === 'ArrowUp' ? 'week'
            : (calView === 'month' ? 'week' : 'month');
        if (want !== calView) setCalView(want);
        else settleCalGridHeight();
      });
    })();

    // ============ 周/月日历：当日列表点击（翻页走日期条/滑动手势） ============
    const calListEl = document.getElementById('calDayList');
    if (calListEl) calListEl.onclick = (e) => {
      const item = e.target.closest('[data-cal-item]');
      if (!item) return;
      const sch = schedules.find((x) => x.id === item.getAttribute('data-cal-item'));
      if (sch) openMobileScheduleActionMenu(sch);
    };

    // 周/月日历的左右滑动手势（收起切换单日 / 展开翻月）
    (function setupCalSwipe() {
      const view = document.getElementById('viewCalweek');
      if (!view) return;
      const THRESHOLD = 48;
      let sx = 0, sy = 0, st = 0, swiping = false;
      view.addEventListener('touchstart', (e) => {
        if (e.touches.length > 1) { swiping = false; return; }
        sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now(); swiping = false;
      }, { passive: true });
      view.addEventListener('touchmove', (e) => {
        if (e.touches.length > 1) return;
        const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
        if (!swiping && Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy)) swiping = true;
      }, { passive: true });
      view.addEventListener('touchend', (e) => {
        if (!swiping) return;
        swiping = false;
        const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
        if (Date.now() - st > 900) return;
        if (Math.abs(dx) < THRESHOLD || Math.abs(dx) < Math.abs(dy) * 1.2) return;
        shiftCalPage(dx < 0 ? 1 : -1);
        const grid = document.getElementById('calGridWrap');
        if (grid && typeof window.gsap !== 'undefined') {
          try {
            window.gsap.killTweensOf(grid); // 连滑时旧 tween 会跟新的抢同一属性
            window.gsap.fromTo(grid, { x: (dx < 0 ? 1 : -1) * 28, opacity: 0.6 },
              { x: 0, opacity: 1, duration: 0.26, ease: 'power2.out', clearProps: 'opacity,transform' });
          } catch (_) { /* 动画失败不影响翻页 */ }
        }
      }, { passive: true });
    })();

    // ============ 课表日历：左右滑动切换 3 日窗口 ============
    // 判定规则：横向位移 > 48px，且明显大于纵向位移（避免与竖向滚动冲突）
    (function setupCalendarSwipe() {
      const view = document.getElementById('viewSchedule');
      if (!view) return;
      const THRESHOLD = 48;
      let sx = 0, sy = 0, st = 0, swiping = false, justSwiped = false;

      view.addEventListener('touchstart', (e) => {
        if (e.touches.length > 1) { swiping = false; return; }
        sx = e.touches[0].clientX;
        sy = e.touches[0].clientY;
        st = Date.now();
        swiping = false;
      }, { passive: true });

      view.addEventListener('touchmove', (e) => {
        if (e.touches.length > 1) return;
        const dx = e.touches[0].clientX - sx;
        const dy = e.touches[0].clientY - sy;
        // 一旦判定为横向手势就锁定，避免滑动过程中反复判定
        if (!swiping && Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy)) swiping = true;
      }, { passive: true });

      view.addEventListener('touchend', (e) => {
        if (!swiping) return;
        swiping = false;
        const dx = e.changedTouches[0].clientX - sx;
        const dy = e.changedTouches[0].clientY - sy;
        if (Date.now() - st > 900) return;                     // 慢速拖动不算滑动
        if (Math.abs(dx) < THRESHOLD || Math.abs(dx) < Math.abs(dy) * 1.2) return;

        const dir = dx < 0 ? 1 : -1;                            // 左滑看后面，右滑看前面
        mobileStartDate = addDays(mobileStartDate, dir * 3);
        justSwiped = true;
        renderCalendar();

        // 轻微位移反馈：新窗口从滑动方向滑入
        const scroller = document.getElementById('mobileCalendarScroll');
        if (scroller && typeof window.gsap !== 'undefined') {
          try {
            window.gsap.killTweensOf(scroller);
            window.gsap.fromTo(scroller, { x: dir * 28, opacity: 0.6 },
              { x: 0, opacity: 1, duration: 0.26, ease: 'power2.out', clearProps: 'opacity,transform' });
          } catch (_) { /* 动画失败不影响翻页 */ }
        }
      }, { passive: true });

      // 滑动结束后吞掉紧接着的那次 click，避免误触发"点空白新建排课"
      view.addEventListener('click', (e) => {
        if (!justSwiped) return;
        justSwiped = false;
        e.stopPropagation();
        e.preventDefault();
      }, true);
    })();

    safeBind('mobileTeacherSelect', 'change', (e) => {
      selectedTeacherFilter = e.target.value;
      renderCalendar();
    });

    // ============ 四视图切换（课表/学员/财务/设置） ============
    const MOBILE_VIEWS = ['home', 'schedule', 'students', 'finance', 'settings'];

    // ---- 岛台玻璃胶囊滑块：切换时滑向新 tab，途中沿移动方向拉长，到位弹性回弹 ----
    const navGlider = document.getElementById('navGlider');
    // 实时跟随系统开关：会话中途改设置也要生效（原来只在加载时取一次快照）
    const rmQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let RM = rmQuery.matches;
    if (rmQuery.addEventListener) rmQuery.addEventListener('change', (e) => { RM = e.matches; });
    let gliderLastX = null;
    let gliderAnim = null;
    function positionNavGlider(animate) {
      if (!navGlider) return;
      const island = navGlider.parentElement;
      const active =
        island.querySelector('.nav-tab.font-bold') ||
        island.querySelector('.nav-tab');
      if (!active) return;
      const ir = island.getBoundingClientRect();
      const tr = active.getBoundingClientRect();
      const x = tr.left - ir.left;
      const w = tr.width;
      // 起点取「当前真实位置」（含进行中的动画）→ 连续快速切换时从眼前的位置继续，不会跳
      const curX = navGlider.getBoundingClientRect().left - ir.left;
      const dx = x - curX;
      navGlider.style.left = '0px'; // 位置一律交给 transform
      navGlider.style.width = w + 'px';
      // 直接落位（首次 / 无位移 / 窗口尺寸变化 / 用户要求减少动效）
      if (!animate || gliderLastX === null || Math.abs(dx) < 1 || RM) {
        navGlider.style.transform = 'translateX(' + x + 'px)';
        gliderLastX = x;
        return;
      }
      const dir = dx > 0 ? 1 : -1;
      const stretch = Math.min(8, Math.abs(dx) * 0.22); // 拉长幅度收小
      const k = (w + stretch) / w;
      // 中段：前缘先行 → 沿移动方向拉长（origin 设在后缘）
      const midX = curX + dx * 0.5;
      const overX = x + dir * 3; // 过冲收小到 3px
      navGlider.style.transformOrigin = dir > 0 ? 'left center' : 'right center';
      navGlider.style.transform = 'translateX(' + x + 'px)';
      if (gliderAnim) gliderAnim.cancel();
      gliderAnim = navGlider.animate(
        [
          { transform: 'translateX(' + curX + 'px) scaleX(1)', offset: 0, easing: 'cubic-bezier(.45,0,.55,1)' },
          { transform: 'translateX(' + midX + 'px) scaleX(' + k + ')', offset: 0.55, easing: 'cubic-bezier(.3,0,.2,1)' },
          { transform: 'translateX(' + overX + 'px) scaleX(1)', offset: 0.82, easing: 'cubic-bezier(.34,1.56,.64,1)' },
          { transform: 'translateX(' + x + 'px) scaleX(1)', offset: 1 }
        ],
        { duration: 300, fill: 'both' }
      );
      gliderLastX = x;
    }
    window.addEventListener('resize', () => positionNavGlider(false));
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => positionNavGlider(false)).catch(() => {});
    }

    function switchMobileView(view) {
      MOBILE_VIEWS.forEach((v) => {
        const el = document.getElementById('view' + v.charAt(0).toUpperCase() + v.slice(1));
        if (el) el.classList.toggle('hidden', v !== view);
      });
      // 课表三档视图是同一 tab 的不同档位：按 calView 决定显示哪个容器，离开课表时一并隐藏
      const calweekEl = document.getElementById('viewCalweek');
      const vsEl = document.getElementById('viewSchedule');
      const timelineOn = calView === 'day3';
      if (calweekEl) calweekEl.classList.toggle('hidden', view !== 'schedule' || timelineOn);
      if (vsEl) vsEl.classList.toggle('hidden', view !== 'schedule' || !timelineOn);
      // 底部 tab 切换不做整页淡入（高频操作，且整页动画撞在重渲染开销最大的时刻）
      if (view === 'settings' && typeof updateIdentityDesc === 'function') updateIdentityDesc();
      document.querySelectorAll('.nav-tab').forEach((tab) => {
        const active = tab.getAttribute('data-view') === view;
        // 岛台样式：选中=炭黑文字+font-bold（CSS 借 font-bold 渲染白色高亮胶囊）；图标保留分区功能色
        tab.classList.toggle('text-[#111111]', active);
        tab.classList.toggle('font-bold', active);
        tab.classList.toggle('text-slate-400', !active);
        tab.classList.toggle('font-medium', !active);
        const icon = tab.querySelector('i.fa-solid');
        if (icon) icon.classList.toggle('is-active', active);
      });
      // 玻璃胶囊滑块滑到新选中的 tab（animate=有无位移都做动画，首帧自动直落）
      positionNavGlider(true);
      // 日期导航栏与左下角新增排课悬浮按钮只在课表视图显示
      const dateBar = document.getElementById('mobileDateBar');
      if (dateBar) dateBar.classList.toggle('hidden', view !== 'schedule');
      const fabAdd = document.getElementById('btnMobileAddSchedule');
      if (fabAdd) fabAdd.classList.toggle('hidden', view !== 'schedule');
      // 顶部右侧：课表视图=老师筛选框（管理员），其余视图=老师名字徽章
      if (typeof updateHeaderIdentity === 'function') updateHeaderIdentity(view !== 'schedule');
      // 课表：进 tab 时重渲染一次 —— 日历网格的高度几何要趁容器可见时量准
      if (view === 'schedule') renderCalendar();
      if (view === 'students') renderMobileStudents();
      if (view === 'finance') renderMobileFinance();
      if (view === 'home' && typeof renderMobileHome === 'function') renderMobileHome();
    }

    switchMobileView('home'); // 默认进首页（此处与函数同作用域）
    // 桥接给外层函数（renderMobileHome 等）使用
    window.__switchMobileView = switchMobileView;

    safeBind('navTabHome', 'click', () => switchMobileView('home'));
    safeBind('navTabSchedule', 'click', () => switchMobileView('schedule'));
    safeBind('navTabStudents', 'click', () => switchMobileView('students'));
    safeBind('navTabFinance', 'click', () => switchMobileView('finance'));
    safeBind('navTabSettings', 'click', () => switchMobileView('settings'));

    // 设置页按钮
    safeBind('msetCloudSync', 'click', () => {
      const el = document.getElementById('inputSyncKey');
      if (el) el.value = schoolSyncKey;
      showModal('modalSyncKey');
    });
    safeBind('msetManageTeachers', 'click', () => {
      renderMobileTeacherManager();
      showModal('modalMobileTeachers');
    });
    safeBind('msetCourseTypes', 'click', openMobileCourseTypesModal);
    safeBind('btnCloseMobileCourseTypes', 'click', () => hideModal('modalMobileCourseTypes'));
    safeBind('formMobileAddCourseType', 'submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('mobileCourseTypeNameInput');
      const name = input ? input.value.trim() : '';
      if (!name) return;
      if (!mAddCourseType(name)) {
        showToast(`「${name}」已经在课程类型里了`);
        return;
      }
      input.value = '';
      saveData();
      mRenderCourseTypesList();
      showToast(`已添加课程类型「${name}」`);
    });
    safeBind('btnMobileOpenCourseMerge', 'click', openMobileCourseMergeModal);
    safeBind('btnCloseMobileCourseMerge', 'click', () => hideModal('modalMobileCourseMerge'));
    safeBind('btnCancelMobileCourseMerge', 'click', () => hideModal('modalMobileCourseMerge'));
    safeBind('btnApplyMobileCourseMerge', 'click', applyMobileCourseMerge);
    // 选课程包时，科目框若为空就自动带出同名科目
    safeBind('selectMobileCourse', 'change', (e) => {
      const opt = e.target.options[e.target.selectedIndex];
      const subjectEl = document.getElementById('inputMobileSubject');
      if (!opt || !subjectEl) return;
      if (!subjectEl.value.trim()) subjectEl.value = opt.getAttribute('data-name') || '';
    });
    // 上课提醒：ICS 日历订阅链接（每位老师一条专属链接）
    safeBind('msetIcsCalendar', 'click', () => {
      const buildLink = (id) => {
        const base = location.origin && location.origin.startsWith('http') ? location.origin : 'https://lesson-mate.pages.dev';
        return `${base}/api/ics?key=${encodeURIComponent(schoolSyncKey)}&teacher=${encodeURIComponent(id)}`;
      };
      const ov = document.createElement('div');
      ov.className = 'fixed inset-0 bg-slate-900/40 backdrop-blur-xs z-[70] flex items-end justify-center';
      const items = teachers.map((t) => `
        <div class="flex items-center justify-between gap-2 bg-[#faf6ef] rounded-2xl px-3 py-2.5">
          <div class="min-w-0">
            <div class="font-bold text-xs text-slate-800 truncate">${t.name}${t.subject ? ' · ' + t.subject : ''}</div>
            <div class="text-[9.5px] text-slate-400 truncate">${buildLink(t.id)}</div>
          </div>
          <button data-ics-copy="${t.id}" class="shrink-0 px-3 py-2 lm-btn-fin text-[11px] rounded-xl">复制链接</button>
        </div>`).join('');
      ov.innerHTML = `
        <div class="bg-white w-full rounded-t-3xl p-5 space-y-2.5 max-h-[85dvh] overflow-y-auto" style="padding-bottom: calc(2rem + env(safe-area-inset-bottom))">
          <div class="font-bold text-sm text-slate-800 pb-2 border-b border-slate-100">上课提醒 · 日历订阅</div>
          <div class="text-[10px] text-slate-400 leading-relaxed">复制老师链接 → iPhone 设置 → 日历 → 账户 → 其他 → 添加订阅日历 → 粘贴。再把该日历默认提醒设为"提前15分钟"，每节课自动提醒。</div>
          ${teachers.length === 0 ? '<div class="text-center text-slate-400 py-5 text-xs">还没有老师，先到「教师管理」添加</div>' : items}
          <button data-role="close" class="w-full py-2 text-xs text-slate-400">关闭</button>
        </div>`;
      ov.addEventListener('click', (e) => {
        if (e.target === ov) { ov.remove(); return; }
        const copyBtn = e.target.closest('[data-ics-copy]');
        if (copyBtn) {
          const t = teachers.find((x) => x.id === copyBtn.getAttribute('data-ics-copy'));
          if (!t) return;
          const link = buildLink(t.id);
          const done = () => showToast(`已复制 ${t.name} 的订阅链接`);
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(link).then(done).catch(() => prompt('长按复制：', link));
          } else {
            prompt('长按复制：', link);
          }
          return;
        }
        if (e.target.closest('[data-role="close"]')) ov.remove();
      });
      document.body.appendChild(ov);
    });
    // 账号身份切换：管理员 ↔ 老师视角（弹选择抽屉）
    safeBind('msetIdentity', 'click', () => {
      const ov = document.createElement('div');
      ov.className = 'fixed inset-0 bg-slate-900/40 backdrop-blur-xs z-[70] flex items-end justify-center';
      ov.innerHTML = `
        <div class="bg-white w-full rounded-t-3xl p-5 space-y-2.5" style="padding-bottom: calc(2rem + env(safe-area-inset-bottom))">
          <div class="font-bold text-sm text-slate-800 pb-2 border-b border-slate-100">切换账号身份</div>
          <button data-role="admin" class="w-full py-3 rounded-xl text-sm font-bold ${isTeacherView() ? 'bg-slate-100 text-slate-700' : 'bg-indigo-500 text-white'} active:opacity-80">
            <i class="fa-solid fa-user-shield mr-1.5"></i>管理员（全校数据 + 财务总览）
          </button>
          <div class="text-[10px] text-slate-400 pt-1">老师身份（输入访问码进入）：</div>
          <div class="flex gap-2">
            <input id="identityPinInput" type="tel" inputmode="numeric" maxlength="4" placeholder="4位访问码" class="flex-1 px-3 py-2.5 border border-slate-200 rounded-xl text-center font-bold tracking-widest outline-none focus:ring-1 focus:ring-[#ff5600]/30">
            <button data-role="teacher" class="shrink-0 px-4 py-2.5 lm-btn-fin text-sm">进入</button>
          </div>
          <button data-role="cancel" class="w-full py-2 text-xs text-slate-400">取消</button>
        </div>`;
      ov.addEventListener('click', (e) => {
        if (e.target === ov) { ov.remove(); return; }
        const btn = e.target.closest('[data-role]');
        if (!btn) return;
        const role = btn.getAttribute('data-role');
        if (role === 'cancel') { ov.remove(); return; }
        if (role === 'admin') {
          if (!isTeacherView()) { ov.remove(); return; }
          teacherLogout();
          ov.remove();
          renderMobileHomeCard();
          renderMobileStudents();
          if (typeof renderMobileFinance === 'function') renderMobileFinance();
          updateIdentityDesc();
      if (typeof updateHeaderIdentity === 'function') updateHeaderIdentity();
          // 身份换了，课表范围也跟着换：管理员=全校，筛选框与课表立刻同步
          renderMobileTeacherSelect();
          renderCalendar();
          showToast('已切换到管理员身份');
          return;
        }
        // teacher：验证 PIN
        const pinEl = document.getElementById('identityPinInput');
        const t = tryTeacherLogin(pinEl ? pinEl.value : '');
        if (!t) { showToast('访问码不对，请重试'); return; }
        ov.remove();
        renderMobileHomeCard();
        renderMobileStudents();
        if (typeof renderMobileFinance === 'function') renderMobileFinance();
        updateIdentityDesc();
      if (typeof updateHeaderIdentity === 'function') updateHeaderIdentity();
        // 老师身份 = 课表默认只看自己的课，切换后立刻生效。
        // 这里要显式清掉"已应用"标记：老师A → 老师B 是换了人，不能沿用上一位的范围
        // （同一位老师重进也按"重新进入这个身份"处理，语义更可预期）。
        teacherFilterAutoApplied = false;
        renderMobileTeacherSelect();
        renderCalendar();
        showToast(`已切换到 ${t.name} 老师视角`);
      });
      document.body.appendChild(ov);
      setTimeout(() => document.getElementById('identityPinInput')?.focus(), 100);
    });
    safeBind('btnCloseMobileTeachers', 'click', () => hideModal('modalMobileTeachers'));
    safeBind('formMobileAddTeacher', 'submit', (e) => {
      e.preventDefault();
      const nameEl = document.getElementById('mobileTeacherNameInput');
      const subEl = document.getElementById('mobileTeacherSubjectInput');
      const name = nameEl.value.trim();
      if (!name) return;
      teachers.push({
        id: 't_' + Date.now(),
        name,
        subject: subEl.value.trim() || '通用科目',
        colorTheme: getRandomColorTheme(),
      });
      saveData();
      nameEl.value = ''; subEl.value = '';
      renderMobileTeacherManager();
      renderMobileTeacherSelect();
      showToast(`已添加老师 [${name}]`);
    });
    safeBind('msetExport', 'click', () => {
      const payload = JSON.stringify({ students, schedules, teachers, checkInLogs, debts, updatedAt: Date.now() });
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(payload).then(() => {
          showToast('已复制全部数据到剪贴板，可粘贴到电脑版导入');
        }).catch(() => {
          showToast('复制失败，请用电脑版导出');
        });
      } else {
        showToast('当前浏览器不支持复制，请用电脑版导出');
      }
    });

    safeBind('msetHistoryImport', 'click', openMobileHistoryImport);
    safeBind('btnCloseMobileHistoryImport', 'click', () => hideModal('modalMobileHistoryImport'));
    safeBind('mSelectHistoryFile', 'click', () => document.getElementById('mHistoryFileInput')?.click());
    safeBind('mHistoryFileInput', 'change', handleMobileHistoryFileChange);
    safeBind('mHistoryTemplate', 'click', downloadHistoryTemplate);
    safeBind('mConfirmHistoryImport', 'click', handleConfirmMobileHistoryImport);
    safeBind('mClearHistoryLogs', 'click', handleClearMobileHistoryLogs);

    // 课表日期栏的新增排课按钮（导航加号已移除，此为唯一快捷新增入口）
    safeBind('btnMobileAddSchedule', 'click', () => {
      openMobileScheduleModalForNew();
    });

    // ============ 手机端 新增/编辑学员 ============
    safeBind('btnCloseMobileStudent', 'click', closeMobileStudentModal);
    safeBind('btnCancelMobileStudent', 'click', closeMobileStudentModal);
    safeBind('formMobileStudent', 'submit', handleSaveMobileStudent);
    safeBind('btnDeleteMobileStudent', 'click', handleDeleteMobileStudent);
    safeBind('btnAddMobileCourseRow', 'click', () => addMobileCourseRow());
    safeBind('btnMobileAddStudent', 'click', () => openMobileStudentModal());

    safeBind('btnCloseMobileSchedule', 'click', closeMobileScheduleModal);
    safeBind('btnCancelMobileSchedule', 'click', closeMobileScheduleModal);
    safeBind('formMobileSchedule', 'submit', handleSaveMobileSchedule);
    safeBind('btnDeleteMobileSchedule', 'click', handleDeleteMobileSchedule);

    // 重复排课选择联动
    safeBind('selectMobileRepeatRule', 'change', (e) => {
      const endWrap = document.getElementById('mobileRepeatEndDateWrap');
      const hint = document.getElementById('mobileRepeatHint');
      const on = e.target.value !== 'none';
      if (endWrap) endWrap.classList.toggle('hidden', !on);
      if (hint) hint.classList.toggle('hidden', !on);
    });

    // 学员详情弹窗关闭
    safeBind('btnCloseMobileStudentDetail', 'click', () => hideModal('modalMobileStudentDetail'));
    safeBind('btnCloseMobileLessonSummary', 'click', () => hideModal('modalMobileLessonSummary'));

    safeBind('selectMobileStudent', 'change', (e) => {
      const stId = e.target.value;
      const st = students.find((x) => x.id === stId);
      updateMobileCourseDropdown(st);
      syncMobileSubjectFromCourse();
    });

    safeBind('mobileSearchStudent', 'input', renderMobileStudents);
    safeBind('mobileStudentTeacherFilter', 'change', renderMobileStudents);
    safeBind('mobileStudentCourseFilter', 'change', renderMobileStudents);

    document.querySelectorAll('.mobile-student-filter').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const clicked = e.currentTarget;
        const wasActive = clicked.classList.contains('active');
        // 统一重置为未选中（ghost）样式
        document.querySelectorAll('.mobile-student-filter').forEach((b) => {
          b.classList.remove('active', 'lm-btn-ink', 'bg-slate-100', 'text-slate-600');
          b.classList.add('lm-btn-ghost');
        });
        // 再点一次已选中的按钮 = 取消筛选，恢复完整列表
        if (!wasActive) {
          clicked.classList.add('active', 'lm-btn-ink');
          clicked.classList.remove('lm-btn-ghost');
        }
        renderMobileStudents();
      });
    });
  }

  function renderMobileTeacherSelect() {
    const select = document.getElementById('mobileTeacherSelect');
    if (!select) return;
    select.innerHTML = `<option value="all">全校老师 (全部)</option>`;
    teachers.forEach((t) => {
      select.innerHTML += `<option value="${t.id}">👩‍🏫 ${t.name}</option>`;
    });
    select.value = selectedTeacherFilter;
  }

  // 个人主页条：管理员=全校概览；老师=我的今日课/待消课/预警待办
  function renderMobileHomeCard() {
    const el = document.getElementById('mobileHomeCard');
    if (!el) return;
    const todayStr = formatDate(new Date());

    if (!isTeacherView()) {
      // 管理员：紧凑概览
      const todayCount = schedules.filter((s) => s.date === todayStr && s.status === SCHEDULE_STATUS.SCHEDULED).length;
      const lowStudents = activeStudentsOf().filter((st) => !isArchivedSt(st) && (st.courses || []).some((c) => c.remainingLessons <= 2)).length;
      el.innerHTML = `
        <div class="lm-card px-4 py-3 flex items-center justify-between">
          <div>
            <div class="text-[10px] text-[#9c9fa5] font-medium">LessonMate 管理台</div>
            <div class="text-sm font-bold text-[#111111] mt-0.5">今日待上 ${todayCount} 节 · 预警 ${lowStudents} 人</div>
          </div>
          <i class="fa-solid fa-chart-simple text-[#c9c4bc]"></i>
        </div>`;
      return;
    }

    // 老师个人主页
    const myToday = schedules.filter((s) => s.date === todayStr && (s.teacherId === teacherSession.teacherId || s.assistantTeacherId === teacherSession.teacherId));
    const myUpcoming = myToday.filter((s) => s.status === SCHEDULE_STATUS.SCHEDULED).sort((a, b) => a.startTime.localeCompare(b.startTime));
    const myLow = students
      .filter(studentRelatedToTeacher)
      .flatMap((st) => (isTeacherView() ? (st.courses || []).filter((c) => c.remainingLessons <= 2 && courseRelatedToTeacher(st, c.name)) : (st.courses || []).filter((c) => c.remainingLessons <= 2)).map((c) => ({ st, c })));
    const nextClass = myUpcoming[0];
    el.innerHTML = `
      <div class="lm-card px-4 py-3">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-[10px] text-[#9c9fa5] font-medium">${teacherSession.name} 老师的工作台</div>
            <div class="text-sm font-bold text-[#111111] mt-0.5">今日 ${myUpcoming.length} 节课${nextClass ? ` · 下一节 ${nextClass.startTime}` : ' · 今天没课 🎉'}</div>
          </div>
          <button id="btnTeacherExit" class="text-[11px] bg-[#f1ece3] rounded-full px-2.5 py-1 font-bold text-[#626260]">退出</button>
        </div>
        ${myLow.length ? `
        <div class="mt-2 bg-[#fff2f4] rounded-xl px-3 py-2 text-[11px] font-semibold text-[#d5304f]">
          <i class="fa-solid fa-triangle-exclamation mr-1"></i>待办：${myLow.length} 个课时预警（${[...new Set(myLow.map((x) => x.st.name))].slice(0, 3).join('、')}${myLow.length > 3 ? '…' : ''}）
        </div>` : ''}
      </div>`;
    const exitBtn = document.getElementById('btnTeacherExit');
    if (exitBtn) exitBtn.addEventListener('click', () => {
      if (!confirm('退出老师身份，回到管理员入口？')) return;
      teacherLogout();
      location.reload();
    });
  }

  // 设置页身份描述跟随当前视角
  function updateIdentityDesc() {
    const el = document.getElementById('msetIdentityDesc');
    if (!el) return;
    el.textContent = isTeacherView()
      ? `当前：${teacherSession.name} 老师（财务只显示本人课程）`
      : '当前：管理员（全校数据）';
  }

  // 手机端教师管理：列表渲染（含访问码生成/换码/删除）
  // ==========================================
  // 课程类型（courseTypes）：统一科目名 + 历史课程名归并
  // ==========================================

  function mEscAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function mEnsureCourseTypes() {
    if (!Array.isArray(courseTypes)) courseTypes = [];
    if (courseTypes.length === 0) {
      courseTypes = ['钢琴', '美术', '乐理', '吉他'].map((n) => ({ id: 'ct_' + n, name: n }));
    }
  }

  function mAddCourseType(name) {
    const n = (name || '').trim();
    if (!n) return false;
    mEnsureCourseTypes();
    if (courseTypes.some((ct) => ct.name === n)) return false;
    courseTypes.push({ id: 'ct_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), name: n });
    return true;
  }

  function mRenderCourseTypesDatalist() {
    const dl = document.getElementById('courseTypesListMobile');
    if (!dl) return;
    mEnsureCourseTypes();
    dl.innerHTML = courseTypes.map((ct) => `<option value="${mEscAttr(ct.name)}"></option>`).join('');
  }

  function mCourseTypeUsage(name) {
    let packages = 0;
    let lessons = 0;
    students.forEach((s) => {
      (s.courses || []).forEach((c) => {
        if (c.name === name) packages += 1;
      });
    });
    schedules.forEach((s) => {
      if ((s.subject || '') === name) lessons += 1;
    });
    return { packages, lessons };
  }

  function mRenderCourseTypesList() {
    const container = document.getElementById('mobileCourseTypesList');
    if (!container) return;
    mEnsureCourseTypes();
    mRenderCourseTypesDatalist();
    container.innerHTML = '';

    if (courseTypes.length === 0) {
      container.innerHTML = `<div class="lm-t3 text-center py-4">还没有课程类型，先在下面添加</div>`;
      return;
    }

    courseTypes.forEach((ct) => {
      const u = mCourseTypeUsage(ct.name);
      const item = document.createElement('div');
      item.className = 'flex items-center justify-between p-2.5 lm-section rounded-xl';
      item.innerHTML = `
        <div class="min-w-0">
          <div class="font-bold lm-t1 truncate">${mEscAttr(ct.name)}</div>
          <div class="text-[10px] lm-t2">${u.packages} 个课程包 · ${u.lessons} 节排课在用</div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button class="btn-rename-ct lm-t3 px-2 py-2" title="改名"><i class="fa-solid fa-pen"></i></button>
          <button class="btn-del-ct lm-t3 px-2 py-2" title="删除"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      `;

      item.querySelector('.btn-rename-ct').addEventListener('click', () => {
        const next = prompt(`把「${ct.name}」改名为：`, ct.name);
        if (next === null) return;
        const n = next.trim();
        if (!n || n === ct.name) return;
        if (courseTypes.some((x) => x.name === n)) {
          alert(`「${n}」已经存在了`);
          return;
        }
        ct.name = n;
        saveData();
        mRenderCourseTypesList();
        showToast(`已改名为「${n}」`);
      });

      item.querySelector('.btn-del-ct').addEventListener('click', () => {
        const used = u.packages + u.lessons;
        const warn = used > 0
          ? `「${ct.name}」目前有 ${u.packages} 个课程包、${u.lessons} 节排课在用。\n删除只是不再出现在下拉里，已有数据不会改。确定删除吗？`
          : `确定删除课程类型「${ct.name}」吗？`;
        if (!confirm(warn)) return;
        courseTypes = courseTypes.filter((x) => x.id !== ct.id);
        saveData();
        mRenderCourseTypesList();
        showToast('已删除课程类型');
      });

      container.appendChild(item);
    });
  }

  function openMobileCourseTypesModal() {
    mRenderCourseTypesList();
    showModal('modalMobileCourseTypes');
  }

  function mCollectCourseNameStats() {
    const map = new Map();
    const bump = (name, kind) => {
      const n = (name || '').trim();
      if (!n) return;
      if (!map.has(n)) map.set(n, { name: n, packages: 0, lessons: 0, debts: 0 });
      map.get(n)[kind] += 1;
    };
    students.forEach((s) => (s.courses || []).forEach((c) => bump(c.name, 'packages')));
    schedules.forEach((s) => bump(s.subject, 'lessons'));
    debts.forEach((d) => bump(d.courseName, 'debts'));
    return [...map.values()].sort((a, b) => (b.packages + b.lessons) - (a.packages + a.lessons));
  }

  function openMobileCourseMergeModal() {
    const list = document.getElementById('mobileCourseMergeList');
    if (!list) return;
    mEnsureCourseTypes();
    mRenderCourseTypesDatalist();

    const known = new Set(courseTypes.map((c) => c.name));
    const rows = mCollectCourseNameStats().filter((s) => !known.has(s.name));

    if (rows.length === 0) {
      list.innerHTML = `<div class="lm-t3 text-center py-6">数据里的课程名都已是标准课程类型，没有需要归并的 👍</div>`;
      showModal('modalMobileCourseMerge');
      return;
    }

    const options = courseTypes.map((c) => `<option value="${mEscAttr(c.name)}">${mEscAttr(c.name)}</option>`).join('');
    list.innerHTML = rows.map((r) => `
      <div class="merge-row flex items-center gap-2 p-2 lm-section rounded-xl" data-old="${mEscAttr(r.name)}">
        <input type="checkbox" class="merge-check rounded border-slate-300 shrink-0" checked>
        <div class="min-w-0 flex-1">
          <div class="font-bold lm-t1 truncate">${mEscAttr(r.name)}</div>
          <div class="text-[10px] lm-t3">${r.packages} 个课程包 · ${r.lessons} 节排课${r.debts ? ` · ${r.debts} 条欠课` : ''}</div>
        </div>
        <select class="merge-target px-2 py-1.5 border border-slate-200 rounded-lg text-xs font-semibold shrink-0 max-w-[7.5rem]">
          <option value="">（选目标）</option>
          ${options}
        </select>
      </div>
    `).join('');

    showModal('modalMobileCourseMerge');
  }

  function applyMobileCourseMerge() {
    const rows = document.querySelectorAll('#mobileCourseMergeList .merge-row');
    const mapping = {};
    let picked = 0;
    rows.forEach((row) => {
      const chk = row.querySelector('.merge-check');
      const sel = row.querySelector('.merge-target');
      if (!chk || !sel || !chk.checked) return;
      const from = row.getAttribute('data-old');
      const to = (sel.value || '').trim();
      if (!from || !to || from === to) return;
      mapping[from] = to;
      picked += 1;
    });

    if (picked === 0) {
      alert('请至少勾选一行，并选好要归并到的目标类型');
      return;
    }

    const summary = Object.keys(mapping).map((k) => `「${k}」→「${mapping[k]}」`).join('\n');
    if (!confirm(`即将归并 ${picked} 个课程名：\n\n${summary}\n\n会同步改动：学员课程包名、排课科目、欠课账。\n历史消课流水里的科目名保持原样。\n\n确定应用吗？`)) return;

    pushUndo(`课程名归并 ${picked} 项`);

    let touchedPackages = 0;
    let touchedLessons = 0;
    students.forEach((s) => {
      (s.courses || []).forEach((c) => {
        if (mapping[c.name]) {
          c.name = mapping[c.name];
          touchedPackages += 1;
        }
      });
    });
    schedules.forEach((s) => {
      if (mapping[s.subject]) {
        s.subject = mapping[s.subject];
        touchedLessons += 1;
      }
    });
    debts.forEach((d) => {
      if (mapping[d.courseName]) d.courseName = mapping[d.courseName];
    });
    const merged = new Map();
    debts.forEach((d) => {
      const key = `${d.studentId}|${d.courseName}`;
      if (merged.has(key)) {
        merged.get(key).amount += d.amount;
      } else {
        merged.set(key, d);
      }
    });
    debts = [...merged.values()];

    Object.values(mapping).forEach((n) => mAddCourseType(n));
    saveData();
    hideModal('modalMobileCourseMerge');
    mRenderCourseTypesList();
    renderCalendar();
    renderMobileStudents();
    offerUndo(`已归并 ${picked} 个课程名（${touchedPackages} 个课程包 / ${touchedLessons} 节排课）`, `课程名归并 ${picked} 项`);
  }

  function renderMobileTeacherManager() {
    const box = document.getElementById('mobileTeacherList');
    if (!box) return;
    box.innerHTML = teachers.length === 0
      ? '<div class="text-center text-slate-400 py-5">暂无老师，先添加一位</div>'
      : '';
    teachers.forEach((t) => {
      const item = document.createElement('div');
      item.className = 'flex items-center justify-between bg-[#faf6ef] rounded-2xl px-3 py-2.5';
      item.innerHTML = `
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-8 h-8 rounded-full bg-emerald-500 text-white font-bold flex items-center justify-center text-[11px] shrink-0">${t.name.substring(0, 1)}</div>
          <div class="min-w-0">
            <div class="font-bold text-slate-800 truncate">${t.name}</div>
            <div class="text-[10px] text-slate-500">${t.subject || '全科'}${t.accessPin ? ` · 访问码 <b class="text-emerald-700">${t.accessPin}</b>` : ' · 未开通访问'}</div>
          </div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button class="btn-mt-edit text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-slate-200 text-slate-600 active:bg-slate-300">编辑</button>
          <button class="btn-mt-pin text-[10px] font-bold px-2.5 py-1.5 rounded-lg ${t.accessPin ? 'bg-slate-200 text-slate-600 active:bg-slate-300' : 'bg-sky-100 text-sky-700 active:bg-sky-200'}">${t.accessPin ? '换码' : '发访问码'}</button>
          <button class="btn-mt-del text-slate-400 active:text-rose-600 px-1.5 py-1.5" title="删除"><i class="fa-solid fa-trash-can text-[11px]"></i></button>
        </div>`;
      item.querySelector('.btn-mt-edit').addEventListener('click', () => {
        const ov = document.createElement('div');
        ov.className = 'fixed inset-0 z-[60] flex items-end justify-center';
        ov.innerHTML = `
          <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-xs" data-mtedit-close></div>
          <div class="relative bg-white lm-sheet w-full p-5 space-y-3 text-xs rounded-t-3xl" style="padding-bottom: calc(1.5rem + env(safe-area-inset-bottom))">
            <div class="flex items-center justify-between pb-2 border-b border-slate-100">
              <h3 class="font-bold text-base text-slate-800">编辑老师</h3>
              <button aria-label="关闭" data-mtedit-close class="text-slate-400 active:text-slate-700"><i class="fa-solid fa-xmark text-xl"></i></button>
            </div>
            <input id="mtEditName" type="text" value="${(t.name || '').replace(/"/g, '&quot;')}" placeholder="老师姓名" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-emerald-400">
            <input id="mtEditSubject" type="text" value="${(t.subject || '').replace(/"/g, '&quot;')}" placeholder="主讲科目" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-emerald-400">
            <button id="mtEditSave" class="w-full py-3 bg-emerald-500 text-white rounded-xl font-bold text-sm active:bg-emerald-600">保存</button>
          </div>`;
        document.body.appendChild(ov);
        ov.querySelectorAll('[data-mtedit-close]').forEach((el) => el.addEventListener('click', () => ov.remove()));
        const nameI = ov.querySelector('#mtEditName'), subI = ov.querySelector('#mtEditSubject');
        setTimeout(() => { nameI.focus(); nameI.select(); }, 100);
        const save = () => {
          const newName = nameI.value.trim();
          if (!newName) { showToast('姓名不能为空'); return; }
          t.name = newName;
          t.subject = subI.value.trim() || '通用科目';
          saveData();
          ov.remove();
          renderMobileTeacherManager();
          renderMobileTeacherSelect();
          if (typeof updateHeaderIdentity === 'function') updateHeaderIdentity();
          showToast(`已更新老师信息`);
        };
        ov.querySelector('#mtEditSave').addEventListener('click', save);
        [nameI, subI].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); }));
      });
      item.querySelector('.btn-mt-pin').addEventListener('click', () => {
        t.accessPin = String(Math.floor(1000 + Math.random() * 9000));
        saveData();
        renderMobileTeacherManager();
        showToast(`${t.name} 老师访问码：${t.accessPin}（请微信私发给她）`);
      });
      item.querySelector('.btn-mt-del').addEventListener('click', () => {
        if (!confirm(`确定删除 [${t.name}] 老师？`)) return;
        teachers = teachers.filter((x) => x.id !== t.id);
        saveData();
        renderMobileTeacherManager();
        renderMobileTeacherSelect();
        showToast('已删除老师');
      });
      box.appendChild(item);
    });
  }

  /* ------------------------------------------------------------------------
     今日课程列表：请假 / 撤销后的重排动画（FLIP）
     目的：空间一致性 —— 被标记请假的那一行要「走」到请假区，
           而不是在这里消失、又在下面凭空出现。
     工具：WAAPI（要先量新旧位置，且可能被连续操作打断）；只动 transform + opacity；
     曲线：位移用 --ease-move（ease-in-out），260ms；减弱动效时退化成 160ms 淡入。
     ------------------------------------------------------------------------ */
  const MOVE_EASE = (() => {
    try {
      return (getComputedStyle(document.documentElement).getPropertyValue('--ease-move') || '').trim()
        || 'cubic-bezier(0.77, 0, 0.175, 1)';
    } catch (_) { return 'cubic-bezier(0.77, 0, 0.175, 1)'; }
  })();
  const FLIP_MS = 260;
  const FLIP_MAX_DY = 420; // 超过这个距离就别飞了（会显得滑稽），改淡入
  const prefersReduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------------------
     首页统计数字渐变（hero 大数字 + 数据卡小数字）
     hero 与数据卡每次整块重建 innerHTML，元素都是新节点 —— 上一次的值没法挂在
     元素上（desktop 那套 data-lm-val 在这里会丢），所以只能存在闭包里。
     首帧不滚（没得从哪滚），值没变也不滚：只有真的变了才给滚动反馈。
     ------------------------------------------------------------------------ */
  const homeNumPrev = new Map();
  // 模板里先写「上一次的值」，随后 rollHomeNumbers 再滚到新值；
  // 若直接写新值，会先闪一下新数字再滚回来（回跳）。
  const homeNumText = (key, value) => {
    const prev = homeNumPrev.get(key);
    return (prev === undefined || prev === value) ? String(value) : String(prev);
  };
  const rollHomeNumbers = (container, pairs) => {
    if (!container) return;
    for (const [key, value] of pairs) {
      const el = container.querySelector(`[data-roll="${key}"]`);
      const prev = homeNumPrev.get(key);
      homeNumPrev.set(key, value);
      if (!el || prev === undefined || prev === value) continue;
      if (window.uiAnim && window.uiAnim.number) window.uiAnim.number(el, prev, value, 0, '');
    }
  };

  // 重排前：记下每行当前位置（含分隔条，用固定 key）
  function snapshotTodayRows(box) {
    const map = new Map();
    if (!box) return map;
    box.querySelectorAll('[data-today-row]').forEach((el) => {
      map.set(el.getAttribute('data-today-row'), el.getBoundingClientRect());
    });
    if (box.querySelector('[data-today-divider]')) map.set('__divider__', true);
    return map;
  }

  // 重排后：从旧位置补一段位移回新位置（First-Last-Invert-Play）
  function playTodayRowFlip(box, prev, highlightId) {
    if (!box || !prev.size) return; // 首次渲染（无旧位置）不播
    const reduce = prefersReduced();
    box.querySelectorAll('[data-today-row]').forEach((el) => {
      const id = el.getAttribute('data-today-row');
      const old = prev.get(id);
      if (!old) return;
      const now = el.getBoundingClientRect();
      const dx = old.left - now.left;
      const dy = old.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      if (reduce || Math.abs(dy) > FLIP_MAX_DY) {
        el.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
        return;
      }
      const isHero = id === highlightId;
      if (isHero) { el.style.position = 'relative'; el.style.zIndex = '5'; }
      const anim = el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0px, 0px)' }],
        { duration: FLIP_MS, easing: MOVE_EASE }
      );
      if (isHero) anim.finished.then(() => { el.style.position = ''; el.style.zIndex = ''; }).catch(() => {});
    });
    // 请假区分隔条首次出现 → 淡入，避免硬生生冒出来
    if (highlightId && !prev.has('__divider__')) {
      const div = box.querySelector('[data-today-divider]');
      if (div) div.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
    }
  }

  // 首页：hero 工作台卡 + 数据看板卡（今天/明天课数、欠费、待续费）+ 今日课程列表
  function renderMobileHome() {
    const hero = document.getElementById('mobileHomeHero');
    const cards = document.getElementById('mobileHomeCards');
    const todayBox = document.getElementById('mobileHomeToday');
    if (!hero || !cards || !todayBox) return;
    const todayStr = formatDate(new Date());
    const d = new Date(); d.setDate(d.getDate() + 1);
    const tomorrowStr = formatDate(d);

    // 视角内的排课集合
    const inScope = (s) => !isTeacherView() || s.teacherId === teacherSession.teacherId || s.assistantTeacherId === teacherSession.teacherId;

    // ---- Hero（Intercom 风白卡大标题） ----
    // 本周范围（周一~周日）
    const nowD = new Date();
    const dow = (nowD.getDay() + 6) % 7; // 周一=0
    const mon = new Date(nowD); mon.setDate(nowD.getDate() - dow); mon.setHours(0, 0, 0, 0);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6); sun.setHours(23, 59, 59, 999);
    const fmt = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const wkStart = fmt(mon), wkEnd = fmt(sun);
    if (!isTeacherView()) {
      const weekAll = schedules.filter((s) => inScope(s) && s.date >= wkStart && s.date <= wkEnd);
      const weekDone = weekAll.filter((s) => s.status === SCHEDULE_STATUS.COMPLETED).length;
      const todayAllH = schedules.filter((s) => s.date === todayStr && inScope(s));
      const tomorrowAllH = schedules.filter((s) => s.date === tomorrowStr && inScope(s));
      const todayDoneH = todayAllH.filter((s) => s.status === SCHEDULE_STATUS.COMPLETED).length;
      const todayPendH = todayAllH.filter((s) => s.status === SCHEDULE_STATUS.SCHEDULED).length;
      // 今日课时不计请假：请假那节实际没上课，算进总数会把「今天要上多少节」报多
      const todayLeaveH = todayAllH.filter((s) => s.status === SCHEDULE_STATUS.STUDENT_LEAVE).length;
      const todayCountH = todayAllH.length - todayLeaveH;
      const leaveTag = todayLeaveH ? ` · 请假 ${todayLeaveH}` : '';
      const nowHM = `${String(nowD.getHours()).padStart(2, '0')}:${String(nowD.getMinutes()).padStart(2, '0')}`;
      const nextUpH = todayPendH ? todayAllH.filter((s) => s.status === SCHEDULE_STATUS.SCHEDULED && s.startTime > nowHM).sort((a, b) => a.startTime.localeCompare(b.startTime))[0] : null;
      hero.innerHTML = `
        <div class="lm-card lm-hero" style="border-radius:22px 22px 0 0;position:relative;z-index:2;padding:20px 20px 12px">
          <div class="lm-eyebrow">今日课时</div>
          <div class="lm-bignum"><span data-roll="heroCount">${homeNumText('heroCount', todayCountH)}</span><small>节课 · 已消 ${todayDoneH}${leaveTag}</small></div>
          ${nextUpH ? `
          <div class="mt-2 pt-1.5" style="border-top:1px solid #f0ebe2;display:flex;align-items:center;gap:8px">
            <span class="text-[11px] font-medium text-[#9c9fa5]" style="flex-shrink:0">下一节</span>
            <span class="text-[12.5px] font-bold text-[#111111]">${nextUpH.startTime} ${nextUpH.studentName || ''} · ${nextUpH.subject || nextUpH.courseName || ''}</span>
          </div>` : ''}
        </div>
        <div style="position:relative;z-index:1;margin-top:-22px;padding-top:22px">
          <div style="background:linear-gradient(180deg,#F3ECDF 0%,rgba(243,236,223,0) 100%);border-radius:0 0 20px 20px;padding:12px 20px 7px;box-shadow:0 12px 20px -6px rgba(17,17,17,.08);display:flex;align-items:flex-end;justify-content:space-between;position:relative">
            <div style="position:absolute;top:0;left:0;right:0;height:18px;background:linear-gradient(180deg,rgba(17,17,17,.07),rgba(17,17,17,0));border-radius:0 0 8px 8px;pointer-events:none"></div>
            <div class="text-[11px] font-semibold text-[#626260] flex items-center gap-1.5">
              <span class="inline-block rounded-full" style="width:6px;height:6px;background:#9c9fa5"></span> 明天
              <span class="text-[12.5px] font-bold text-[#111111]">${tomorrowAllH.length} 节课</span>
            </div>
            <div class="text-[11px] font-medium text-[#9c9fa5]">${tomorrowAllH.length ? '最早 ' + tomorrowAllH.map((s) => s.startTime).sort()[0] : '暂无安排'}</div>
          </div>
        </div>`;
      rollHomeNumbers(hero, [['heroCount', todayCountH]]);
    } else {
      const myToday = schedules.filter((s) => s.date === todayStr && inScope(s)).sort((a, b) => a.startTime.localeCompare(b.startTime));
      const myTodayDone = myToday.filter((s) => s.status === SCHEDULE_STATUS.COMPLETED).length;
      // 同上：今日课时不含请假（请假节次单独在右侧标出）
      const myTodayLeave = myToday.filter((s) => s.status === SCHEDULE_STATUS.STUDENT_LEAVE).length;
      const myTodayCount = myToday.length - myTodayLeave;
      const myLeaveTag = myTodayLeave ? ` · 请假 ${myTodayLeave}` : '';
      const nowHM = `${String(nowD.getHours()).padStart(2, '0')}:${String(nowD.getMinutes()).padStart(2, '0')}`;
      const myNext = myToday.filter((s) => s.status === SCHEDULE_STATUS.SCHEDULED && s.startTime > nowHM)[0] || null;
      const myTomorrow = schedules.filter((s) => s.date === tomorrowStr && inScope(s)).sort((a, b) => a.startTime.localeCompare(b.startTime));
      hero.innerHTML = `
        <div class="lm-card lm-hero" style="border-radius:22px 22px 0 0;position:relative;z-index:2;padding:20px 20px 12px">
          <div class="flex items-center justify-between">
            <div class="lm-eyebrow" style="margin-bottom:0">${teacherSession.name.endsWith('老师') ? teacherSession.name : teacherSession.name + '老师'} · 今日课时</div>
            <button id="btnTeacherExitHome" class="text-[11px] bg-white rounded-full px-2.5 py-1 font-bold text-[#626260] shadow-xs active:bg-[#f1ece3]">退出</button>
          </div>
          <div class="lm-bignum mt-1.5"><span data-roll="heroCount">${homeNumText('heroCount', myTodayCount)}</span><small>节课 · 已消 ${myTodayDone}${myLeaveTag}</small></div>
          ${myNext ? `
          <div class="mt-2 pt-1.5" style="border-top:1px solid #f0ebe2;display:flex;align-items:center;gap:8px">
            <span class="text-[11px] font-medium text-[#9c9fa5]" style="flex-shrink:0">下一节</span>
            <span class="text-[12.5px] font-bold text-[#111111]">${myNext.startTime} ${myNext.studentName || ''} · ${myNext.subject || myNext.courseName || ''}</span>
          </div>` : ''}
        </div>
        <div style="position:relative;z-index:1;margin-top:-22px;padding-top:22px">
          <div style="background:linear-gradient(180deg,#F3ECDF 0%,rgba(243,236,223,0) 100%);border-radius:0 0 20px 20px;padding:12px 20px 7px;box-shadow:0 12px 20px -6px rgba(17,17,17,.08);display:flex;align-items:flex-end;justify-content:space-between;position:relative">
            <div style="position:absolute;top:0;left:0;right:0;height:18px;background:linear-gradient(180deg,rgba(17,17,17,.07),rgba(17,17,17,0));border-radius:0 0 8px 8px;pointer-events:none"></div>
            <div class="text-[11px] font-semibold text-[#626260] flex items-center gap-1.5">
              <span class="inline-block rounded-full" style="width:6px;height:6px;background:#9c9fa5"></span> 明天
              <span class="text-[12.5px] font-bold text-[#111111]">${myTomorrow.length} 节课</span>
            </div>
            <div class="text-[11px] font-medium text-[#9c9fa5]">${myTomorrow.length ? '最早 ' + myTomorrow[0].startTime : '暂无安排'}</div>
          </div>
        </div>`;
      rollHomeNumbers(hero, [['heroCount', myTodayCount]]);
    }

    // ---- 看板卡 ----
    const todayAll = schedules.filter((s) => s.date === todayStr && inScope(s));
    const tomorrowAll = schedules.filter((s) => s.date === tomorrowStr && inScope(s));
    const todayPending = todayAll.filter((s) => s.status === SCHEDULE_STATUS.SCHEDULED).length;
    const tomorrowPending = tomorrowAll.filter((s) => s.status === SCHEDULE_STATUS.SCHEDULED).length;
    const todayDone = todayAll.filter((s) => s.status === SCHEDULE_STATUS.COMPLETED).length;
    // 本周剩余待上课数（周一~周日，老师视角含范围过滤）
    const weekLeft = schedules.filter((s) => inScope(s) && s.date >= wkStart && s.date <= wkEnd && s.status === SCHEDULE_STATUS.SCHEDULED).length;
    const weekDoneCnt = schedules.filter((s) => inScope(s) && s.date >= wkStart && s.date <= wkEnd && s.status === SCHEDULE_STATUS.COMPLETED).length;

    // 欠费学员（欠课账 > 0）
    const debtStudents = isTeacherView() ? [] : (debts || []).filter((x) => (x.amount || 0) > 0);
    const debtCount = debtStudents.length;
    const debtTotal = debtStudents.reduce((n, x) => n + (x.amount || 0), 0);

    // 待续费：剩余课时 ≤2 的学员-课程（老师视角只看自己课上的学员）
    const myStudentIds = new Set(schedules.filter((s) => inScope(s)).map((s) => s.studentId));
    const lowList = [];
    students.forEach((st) => (st.courses || []).forEach((c) => {
      if (isTeacherView() && !myStudentIds.has(st.id)) return;
      if (c.remainingLessons <= 2) lowList.push({ student: st.name, course: c.courseName || c.name || '', remaining: c.remainingLessons });
    }));
    const lowCount = lowList.length;
    // 老师视角的欠费统计（我的学员）
    const tDebtList = isTeacherView() ? (debts || []).filter((x) => (x.amount || 0) > 0 && myStudentIds.has(x.studentId)) : [];
    const tDebtCount = tDebtList.length;
    const tDebtTotal = tDebtList.reduce((n, x) => n + (x.amount || 0), 0);
    const tLowCount = isTeacherView() ? lowCount : 0;

    cards.innerHTML = `
      <div class="grid grid-cols-2 gap-3">
        <div class="lm-card px-4 py-4">
          <div class="text-[11px] font-medium text-[#9c9fa5] flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:#111"></span> 今天待消课</div>
          <div class="lm-stat-v mt-1"><span data-roll="todayPending">${homeNumText('todayPending', todayPending)}</span><span class="text-xs font-medium text-[#626260]"> 节</span></div>
          <div class="text-[11px] text-[#9c9fa5] mt-0.5">${todayPending ? '下一节 ' + (todayAll.filter((s) => s.status === SCHEDULE_STATUS.SCHEDULED).sort((a, b) => a.startTime.localeCompare(b.startTime))[0]?.startTime || '') : '全部完成 🎉'}</div>
        </div>
        <div class="lm-card px-4 py-4">
          <div class="text-[11px] font-medium text-[#9c9fa5] flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:#fe4c02"></span> 本周剩余</div>
          <div class="lm-stat-v mt-1 text-[#fe4c02]"><span data-roll="weekLeft">${homeNumText('weekLeft', weekLeft)}</span><span class="text-xs font-medium text-[#626260]"> 节</span></div>
          <div class="text-[11px] text-[#9c9fa5] mt-0.5">至周日 · 已消 ${weekDoneCnt} 节</div>
        </div>
        ${!isTeacherView() ? `
        <button id="homeCardDebt" class="lm-card px-4 py-4 text-left active:opacity-80">
          <div class="text-[11px] font-medium text-[#9c9fa5] flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:#ff2067"></span> 欠费学员</div>
          <div class="lm-stat-v mt-1 text-[#d5304f]"><span data-roll="debtCount">${homeNumText('debtCount', debtCount)}</span><span class="text-xs font-medium text-[#626260]"> 人</span></div>
          <div class="text-[11px] text-[#9c9fa5] mt-0.5">共欠 ${debtTotal} 节</div>
        </button>
        <button id="homeCardRenew" class="lm-card px-4 py-4 text-left active:opacity-80">
          <div class="text-[11px] font-medium text-[#9c9fa5] flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:#fe4c02"></span> 待续费提醒</div>
          <div class="lm-stat-v mt-1 text-[#fe4c02]"><span data-roll="lowCount">${homeNumText('lowCount', lowCount)}</span><span class="text-xs font-medium text-[#626260]"> 项</span></div>
          <div class="text-[11px] text-[#9c9fa5] mt-0.5">课时≤2 需跟进</div>
        </button>` : `
        <button id="homeCardDebt" class="lm-card px-4 py-4 text-left active:opacity-80">
          <div class="text-[11px] font-medium text-[#9c9fa5] flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:#ff2067"></span> 欠费学员</div>
          <div class="lm-stat-v mt-1 text-[#d5304f]"><span data-roll="debtCount">${homeNumText('debtCount', tDebtCount)}</span><span class="text-xs font-medium text-[#626260]"> 人</span></div>
          <div class="text-[11px] text-[#9c9fa5] mt-0.5">共欠 ${tDebtTotal} 节</div>
        </button>
        <button id="homeCardRenew" class="lm-card px-4 py-4 text-left active:opacity-80">
          <div class="text-[11px] font-medium text-[#9c9fa5] flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:#fe4c02"></span> 待续费提醒</div>
          <div class="lm-stat-v mt-1 text-[#fe4c02]"><span data-roll="lowCount">${homeNumText('lowCount', tLowCount)}</span><span class="text-xs font-medium text-[#626260]"> 项</span></div>
          <div class="text-[11px] text-[#9c9fa5] mt-0.5">我的学员 课时≤2</div>
        </button>`}
      </div>`;

    // 数据卡数字滚动：值真的变了才滚（首帧 / 值没变都不滚）
    rollHomeNumbers(cards, [
      ['todayPending', todayPending],
      ['weekLeft', weekLeft],
      ['debtCount', isTeacherView() ? tDebtCount : debtCount],
      ['lowCount', isTeacherView() ? tLowCount : lowCount],
    ]);

    // ---- 今日课程列表 ----
    // 排序：正常课按时间在前，请假课沉到最后（请假的不用盯，别混在时间轴里占位），
    // 两组之间插一条细分隔条，避免「为什么这节不按顺序」的困惑。
    const isLeaveSch = (s) => s.status === SCHEDULE_STATUS.STUDENT_LEAVE;
    const renderTodayRow = (s) => {
      // 状态口径与日历共用 resolveStatusKey：待上课(黑) → 正在上课(橙) → 待消课(黄)。
      // 首页是「今天」，所以 interactive=true：待消课=一键消课按钮（转圈→绿底打勾三态），
      // 待上课仍开操作菜单（课没到，先看选项比直接扣课时稳妥）。
      const badge = buildStatusBadge(s, { isToday: true, interactive: true });
      // 待补课的请假课：行内直接给「排补课」，不用先点开菜单
      const makeupBtn = isPendingMakeup(s)
        ? `<button class="lm-mini-btn" data-home-makeup="${s.id}">排补课</button>` : '';
      const chip = isMakeupLesson(s) ? '<span class="lm-chip-makeup">补课</span>' : '';
      return `
        <div class="lm-card px-5 py-4 flex items-center gap-3.5" data-today-row="${s.id}">
          <div class="text-center shrink-0 min-w-[52px]">
            <div class="font-bold text-[18px] text-[#111111]">${s.startTime}</div>
            <div class="text-[10.5px] text-[#9c9fa5] mt-0.5">${s.durationMinutes || 45}分钟</div>
          </div>
          <div class="flex-1 min-w-0" style="border-left:1px solid #f0ebe2;padding-left:14px">
            <div class="font-bold text-[14.5px] text-[#111111] truncate">${chip}${s.studentName || ''} <span class="text-[#9c9fa5] font-medium">· ${s.subject || ''}</span></div>
            <div class="text-[12px] text-[#9c9fa5] truncate mt-1">${s.teacherName ? s.teacherName : ''}${s.room ? ' · ' + s.room : ''}</div>
          </div>
          <div class="flex items-center gap-2 shrink-0">${makeupBtn}${badge}</div>
        </div>`;
    };
    const todaysAll = todayAll.slice().sort((a, b) => a.startTime.localeCompare(b.startTime));
    const todaysNormal = todaysAll.filter((s) => !isLeaveSch(s));
    const todaysLeave = todaysAll.filter(isLeaveSch);
    const todays = todaysNormal.concat(todaysLeave);
    const leaveDivider = todaysLeave.length
      ? `<div class="flex items-center gap-2 px-1 py-0.5" data-today-divider style="margin:2px 0">
           <span class="flex-1 h-px" style="background:#efe9e0"></span>
           <span class="text-[10px] font-semibold text-[#b3aea6] tracking-wide">请假 ${todaysLeave.length} 节</span>
           <span class="flex-1 h-px" style="background:#efe9e0"></span>
         </div>`
      : '';
    // 三态消课动效进行中：保住今日列表的 DOM —— 一旦重建，按钮节点被换掉动效就整个消失
    // （与桌面看板 dashBusy 同一道闸门）。动效结束由 onDone → refreshMobileAll 重新渲染。
    if (window.uiAnim && window.uiAnim.isBusy && window.uiAnim.isBusy()) {
      pendingReorderId = null;
      return;
    }
    // 先量旧位置，再换 DOM，最后把每行从旧位置滑到新位置（请假沉底时看得见「它去了哪」）
    const prevRowRects = snapshotTodayRows(todayBox);
    const reorderId = pendingReorderId;
    pendingReorderId = null;

    todayBox.innerHTML = `
      <div class="font-bold text-[13px] text-[#111111] px-1 pt-1">今日课程（${todays.length}）</div>
      ${todays.length === 0 ? '<div class="text-center text-[12px] text-[#9c9fa5] py-6 lm-card mt-1">今天没有课程安排</div>' : ''}
      ${todaysNormal.map(renderTodayRow).join('')}${leaveDivider}${todaysLeave.map(renderTodayRow).join('')}`;

    playTodayRowFlip(todayBox, prevRowRects, reorderId);

    // 续费跟进清单已移至财务页（renderMobileFinancePanel）
    void lowList; void lowCount;

    // ---- 事件（委托到 cards 容器；走 window 桥避免作用域错误）----
    // 今日课程徽章点击：待消课 = 一键消课（转圈 → 绿底打勾三态），其余 = 开操作菜单。
    // 与桌面看板同一条协作方式：work 里 skipRefresh，动效跑完再统一刷新。
    const handleHomeCheckinTap = (e) => {
      const tag = e.target.closest('[data-home-checkin]');
      if (!tag) return false;
      const sch = schedules.find((x) => x.id === tag.getAttribute('data-home-checkin'));
      if (!sch) return true;
      if (tag.classList.contains('lm-tag-due') && window.uiAnim && window.uiAnim.runAsyncButton) {
        window.uiAnim.runAsyncButton(
          tag,
          () => executeCheckIn(sch.id, '', { skipRefresh: true }),
          () => refreshMobileAll()
        );
        return true;
      }
      if (typeof openMobileScheduleActionMenu === 'function') openMobileScheduleActionMenu(sch);
      return true;
    };
    // 「排补课」统一入口（今日行 / 待补课区块共用）：
    // 预填源请假课的学员与时间，日期取**今天** —— 补课排的是接下来要上的课，不是回到请假那天去补。
    const openMakeupFor = (schId) => {
      const sch = schedules.find((x) => x.id === schId);
      if (!sch) return;
      openMobileScheduleModalForNew(students.find((x) => x.id === sch.studentId), formatDate(new Date()), sch.startTime, sch);
    };
    // 今日课程容器独立委托（badge 在 todayBox 不在 cards）
    const todayBoxEl = document.getElementById('mobileHomeToday');
    if (todayBoxEl) todayBoxEl.onclick = (e) => {
      // 行内「排补课」：直接开补课表单（预填源请假课）
      const mkBtn = e.target.closest('[data-home-makeup]');
      if (mkBtn) { openMakeupFor(mkBtn.getAttribute('data-home-makeup')); return; }
      const tag = e.target.closest('[data-home-checkin]');
      if (tag) { handleHomeCheckinTap(e); return; }
      // 点行内空白处 → 开操作菜单：徽章已经变成「一键消课」，请假/编辑/删除/撤销
      // 得另有入口，否则待消课的行就只剩下消课一个动作了。
      const row = e.target.closest('[data-today-row]');
      if (!row) return;
      const sch = schedules.find((x) => x.id === row.getAttribute('data-today-row'));
      if (sch && typeof openMobileScheduleActionMenu === 'function') openMobileScheduleActionMenu(sch);
    };
    cards.onclick = (e) => {
      // 今日课程状态胶囊 → 弹确认菜单（消课/请假二选一）
      const tag = e.target.closest('[data-home-checkin]');
      if (tag) { handleHomeCheckinTap(e); return; }
      const t = e.target.closest('#homeCardDebt, #homeCardRenew');
      if (!t) return;
      if (t.id === 'homeCardDebt') window.__switchMobileView('finance');
      if (t.id === 'homeCardRenew') { window.__switchMobileView('students'); setTimeout(() => {
        const f = document.getElementById('mobileStudentStatusFilter') || document.getElementById('filter-low');
        if (f) { f.value = 'low'; f.dispatchEvent(new Event('change')); }
      }, 250); }
    };
    // ---- 待补课（近 7 天请假 · 需补 · 未核销）----
    // 今日行的「排补课」只管今天：三天前请的假没补上，在今日列表里根本露不出来，
    // 只能翻回日历去找 —— 时间一长就成了没人记得的死账。这块把口子放到整周。
    // 只列「待办」：补完 / 当初选了不补 都会自动消失（清单空 = 这周的假都了结了）。
    const mkBox = document.getElementById('mobileHomeMakeup');
    if (mkBox) {
      const pendMakeups = pendingMakeupList(inScope);
      if (!pendMakeups.length) {
        mkBox.innerHTML = '';
      } else {
        mkBox.innerHTML = `
          <div class="flex items-center justify-between px-1 pt-1">
            <div class="font-bold text-[13px] text-[#111111]">待补课（${pendMakeups.length}）</div>
            <div class="text-[10.5px] font-semibold" style="color:#7C4A03">近 7 天请假未补</div>
          </div>
          ${pendMakeups.map((s) => {
            const age = makeupAgeLabel(s.date);
            const p = String(s.date || '').split('-');
            const dayLabel = p.length === 3 ? `${Number(p[1])}/${Number(p[2])}` : String(s.date || '');
            return `
            <div class="lm-card px-5 py-4 flex items-center gap-3.5" data-makeup-row="${s.id}">
              <div class="text-center shrink-0 min-w-[52px]">
                <div class="font-bold text-[15px] text-[#111111]">${dayLabel}</div>
                <div class="text-[10.5px] text-[#9c9fa5] mt-0.5">${s.startTime || '--'}</div>
              </div>
              <div class="flex-1 min-w-0" style="border-left:1px solid #f0ebe2;padding-left:14px">
                <div class="font-bold text-[14.5px] text-[#111111] truncate">${s.studentName || ''} <span class="text-[#9c9fa5] font-medium">· ${s.subject || ''}</span></div>
                <div class="text-[12px] text-[#9c9fa5] truncate mt-1">${age.text}请假${age.chip}</div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <button class="lm-mini-btn" data-home-makeup="${s.id}">排补课</button>
              </div>
            </div>`;
          }).join('')}`;
        mkBox.onclick = (e) => {
          const mkBtn = e.target.closest('[data-home-makeup]');
          if (!mkBtn) return;
          openMakeupFor(mkBtn.getAttribute('data-home-makeup'));
        };
      }
    }
    const exitBtn = document.getElementById('btnTeacherExitHome');
    if (exitBtn) exitBtn.onclick = () => {
      if (!confirm('退出老师身份，回到管理员入口？')) return;
      teacherLogout();
      location.reload();
    };
  }

  // ============ 课表三档共用逻辑（状态判定 / 老师筛选 / 圆点色） ============
  // 学员主题色圆点：色卡色的深化版（白底上可见；底色本身太浅）
  const CAL_DOT_COLORS = { amber: '#D9985F', emerald: '#7E9271', sky: '#4E93A8', purple: '#6F7C6C', rose: '#D08168', mint: '#7FA495' };

  // 老师范围筛选（3日时间轴 / 周条 / 整月格 共用一份口径）
  function filterByTeacher(list) {
    if (selectedTeacherFilter === 'all') return list;
    return list.filter((s) => s.teacherId === selectedTeacherFilter || s.assistantTeacherId === selectedTeacherFilter);
  }

  // 状态判定：done / leave / leavePend / leaveDone / live / due / todo（首页今日课时与日历共用一份口径）。
  // isToday=false（在看别的日期）时不标「待消课」——那些课只是还没走到，标了会误导。
  // 请假再分三态：待补（needMakeup 且未补）/ 已补（补课已核销）/ 普通请假（用户选了不补）。
  function resolveStatusKey(s, isToday) {
    if (s.status === SCHEDULE_STATUS.COMPLETED) return 'done';
    if (s.status === SCHEDULE_STATUS.STUDENT_LEAVE) {
      if (isPendingMakeup(s)) return 'leavePend';
      if (isMakeupDone(s)) return 'leaveDone';
      return 'leave';
    }
    const now = new Date();
    const nowHM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const [h, m] = (s.startTime || '00:00').split(':').map(Number);
    const end = new Date();
    end.setHours(h, m + (s.durationMinutes || 45), 0, 0);
    const endHM = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
    if (nowHM >= (s.startTime || '00:00') && nowHM < endHM) return 'live';
    if (isToday && nowHM >= endHM) return 'due';
    return 'todo';
  }

  const STATUS_BADGE_TEXT = { done: '已消课', leave: '请假', leavePend: '请假待补', leaveDone: '请假·已补', live: '正在上课', due: '待消课', todo: '待上课' };

  // 状态徽章 HTML。interactive=true 时「待消课 / 待上课」渲染成一键消课按钮（首页看板用）。
  function buildStatusBadge(s, opts) {
    opts = opts || {};
    const key = resolveStatusKey(s, opts.isToday);
    if (opts.interactive && (key === 'due' || key === 'todo')) {
      if (key === 'due') {
        return '<button class="lm-tag lm-tag-due lm-checkin-btn" data-home-checkin="' + s.id + '">' +
          '<span class="lm-cb-label">待消课 ›</span>' +
          '<span class="lm-cb-spinner" aria-hidden="true"></span>' +
          '<svg class="lm-cb-check" viewBox="0 0 24 24" aria-hidden="true"><path pathLength="100" d="M4.5 12.6 L9.7 17.8 L19.5 6.6"/></svg>' +
          '</button>';
      }
      return '<button class="lm-tag lm-tag-todo" data-home-checkin="' + s.id + '">待上课 ›</button>';
    }
    const dot = key === 'live' ? '<i class="lm-live-dot" aria-hidden="true"></i>' : '';
    return '<span class="lm-tag lm-tag-' + key + '">' + dot + STATUS_BADGE_TEXT[key] + '</span>';
  }

  // 日历圆点色：取前 3 节不同学员主题色（请假课不计圆点，与桌面月视图同口径）
  function dotColorsFor(list) {
    const themes = [];
    (list || []).forEach((s) => {
      if (s.status === SCHEDULE_STATUS.STUDENT_LEAVE) return;
      const t = resolveScheduleTheme(s);
      if (themes.length < 3 && !themes.includes(t)) themes.push(t);
    });
    return themes.map((t) => CAL_DOT_COLORS[t] || CAL_DOT_COLORS.amber);
  }

  // ============ 周/月网格：把「整月」裁剪成「一周」 ============
  // 网格永远按选中日所在整月渲染（周一开头、补足整周）。周档不是另一套网格，
  // 而是把它裁剪到选中日所在那一行 —— 于是「周 ↔ 月」是同一个标量的补间：
  // 容器裁剪高度 + 网格纵向位移由同一进度推出，手指拖动与补间动画共用一套几何，
  // 所以拖动可以无缝接管动画、动画也可以从任意半途位置接回来。
  function measureCalGrid(selDate, monthStart, weeks) {
    const grid = document.getElementById('calGrid');
    if (!grid) return null;
    const rect = grid.getBoundingClientRect().height;   // 视图隐藏（display:none）时为 0 → 回落到算式
    return {
      collapsedH: CAL_CELL_H,
      fullH: rect > 1 ? rect : weeks * CAL_CELL_H + Math.max(0, weeks - 1) * CAL_ROW_GAP,
      rowStep: CAL_CELL_H + CAL_ROW_GAP,
      rowIdx: Math.min(Math.max(0, weeks - 1),
        Math.max(0, Math.round((getMonday(selDate) - monthStart) / 604800000))),
    };
  }

  // 单一标量 → 容器裁剪高度 + 网格纵向位移 + 跨月日期弱化（拖动与补间都只调这一个函数）
  function applyCalGridHeight(h) {
    const wrap = document.getElementById('calGridWrap');
    const grid = document.getElementById('calGrid');
    const g = calGridGeom;
    if (!wrap || !grid || !g) return;
    const clamped = Math.min(g.fullH, Math.max(g.collapsedH, h));
    wrap.style.height = clamped + 'px';
    const range = g.fullH - g.collapsedH;
    const p = range > 0.5 ? (g.fullH - clamped) / range : 0;   // 0=整月 1=周条
    grid.style.transform = p > 0.002
      ? `translate3d(0, ${(-g.rowIdx * g.rowStep * p).toFixed(2)}px, 0)`
      : '';
    const wantMonth = p < 0.5;                                 // 过半才把跨月日期压暗
    if (grid.classList.contains('is-month') !== wantMonth) grid.classList.toggle('is-month', wantMonth);
  }

  function readCalGridHeight() {
    const wrap = document.getElementById('calGridWrap');
    if (!wrap) return 0;
    const inline = parseFloat(wrap.style.height);   // 拖动时走内联值，避免逐帧读布局
    if (Number.isFinite(inline)) return inline;
    const rect = wrap.getBoundingClientRect().height;
    return rect > 1 ? rect : 0;
  }

  function killCalGridTween() {
    if (!calGridTween) return;
    try { calGridTween.kill(); } catch (_) { /* 已结束或目标已卸载 */ }
    calGridTween = null;
  }

  // 高度补间：GSAP 只驱动一个数字，容器与网格都由它推导。
  // 取代原来写死在 mobile.html 上的 CSS max-height 过渡 —— 那条过渡没法跟手、
  // 也无法从中途接管，只能"从头播一遍"。
  function animateCalGridHeight(targetH) {
    if (!calGridGeom) return;
    const from = readCalGridHeight();
    const dist = Math.abs(targetH - from);
    const g = window.gsap;
    if (!g || reduceMotion() || dist < 1) {
      killCalGridTween();
      applyCalGridHeight(targetH);
      return;
    }
    killCalGridTween();
    const o = { h: from };   // 行程越大给得越久，一行↔整块的观感一致（上限 380ms）
    calGridTween = g.to(o, {
      h: targetH,
      duration: Math.min(0.38, 0.2 + dist / 1400),
      ease: 'power3.out',
      onUpdate: () => applyCalGridHeight(o.h),
      onComplete: () => { calGridTween = null; applyCalGridHeight(targetH); },
    });
  }

  // 回到当前档位的稳定态：手势没换档 / 拖动被取消 / 点击滑条时用
  function settleCalGridHeight() {
    if (!calGridGeom || calView === 'day3') return;
    animateCalGridHeight(isMonthView() ? calGridGeom.fullH : calGridGeom.collapsedH);
  }

  // dateBar 上的日期文案跟着档位走（周档 10/12 周一；月档 2026年10月）
  function syncCalDateText() {
    const el = document.getElementById('mobileDateText');
    if (!el) return;
    const selDate = new Date(calSelected + 'T00:00:00');
    el.textContent = isMonthView()
      ? `${selDate.getFullYear()}年${selDate.getMonth() + 1}月`
      : `${selDate.getMonth() + 1}/${selDate.getDate()} ${CAL_WEEKDAYS[selDate.getDay()]}`;
  }

  function renderCalGrid() {
    const grid = document.getElementById('calGrid');
    const wrap = document.getElementById('calGridWrap');
    const titleEl = document.getElementById('calTitle');
    const listEl = document.getElementById('calDayList');
    const dayTitleEl = document.getElementById('calDayTitle');
    if (!grid || !listEl || !wrap) return;

    const selDate = new Date(calSelected + 'T00:00:00');
    const todayStr = formatDate(getToday());
    if (titleEl) titleEl.textContent = `${selDate.getFullYear()}年${selDate.getMonth() + 1}月`;

    // 每天的课（按老师筛选；请假不计圆点，与桌面月视图同口径）
    const byDate = new Map();
    filterByTeacher(schedules).forEach((s) => {
      if (!byDate.has(s.date)) byDate.set(s.date, []);
      byDate.get(s.date).push(s);
    });

    // 网格范围固定为「选中日所在整月」：周档只是把它裁剪到一行，
    // 所以切档不需要重建 DOM（切档动画因此可中断、不会闪）。
    const monthStart = getMonday(new Date(selDate.getFullYear(), selDate.getMonth(), 1));
    const last = new Date(selDate.getFullYear(), selDate.getMonth() + 1, 0);
    const weeks = Math.ceil((Math.round((last - monthStart) / 86400000) + 1) / 7);
    const totalCells = weeks * 7;
    const anchorMonth = selDate.getMonth();

    killCalGridTween();
    const dragH = calDrag ? readCalGridHeight() : null;   // 拖动中重渲染：保住手指当前位置
    grid.innerHTML = '';

    for (let i = 0; i < totalCells; i++) {
      const d = addDays(monthStart, i);
      const dateStr = formatDate(d);
      const inMonth = d.getMonth() === anchorMonth;
      const isToday = dateStr === todayStr;
      const isSel = dateStr === calSelected;
      const dayLessons = byDate.get(dateStr) || [];

      // 圆点标课：取前 3 节的学员主题色，去重（请假课不计圆点，与桌面月视图同口径）
      const dots = dotColorsFor(dayLessons);

      const cell = document.createElement('button');
      cell.type = 'button';
      // 不带 Tailwind 的 `transition`：那是个 9 属性子集（含 transform/filter/backdrop-filter），
      // 拖过分界点让 14 个格子一起切 .is-month 时，等于同时重置一堆图层。
      // 需要的只有 background-color（按下反馈）和 opacity（跨月压暗），在 mobile-theme.css 里显式列。
      cell.className = 'cal-cell flex flex-col items-center justify-start rounded-xl select-none active:bg-black/5';
      cell.style.height = CAL_CELL_H + 'px';
      cell.setAttribute('data-date', dateStr);
      // 跨月日期不在这里压暗：周档看到的那一行可能整行跨月（月初/月末），
      // 压暗只该发生在"整月"态 —— 交给 .is-month 状态决定（见 mobile-theme.css）。
      if (!inMonth) cell.setAttribute('data-out', '1');

      let numCls;
      if (isSel) numCls = 'background:#111111;color:#fff;font-weight:800';
      else if (isToday) numCls = 'color:#fe4c02;font-weight:800;box-shadow:inset 0 0 0 1.5px rgba(254,76,2,.55)';
      else numCls = 'color:#111111;font-weight:700';
      cell.innerHTML = `
        <span class="w-8 h-8 rounded-full flex items-center justify-center text-[13.5px]" style="${numCls}">${d.getDate()}</span>
        <span class="flex items-center gap-[3px]" style="height:5px;margin-top:2px">${dots.map((c) => `<span class="rounded-full" style="width:4px;height:4px;background:${c}"></span>`).join('')}</span>
      `;
      cell.addEventListener('click', () => {
        if (calSelected === dateStr && !isMonthView()) return;
        calSelected = dateStr;
        renderCalGrid();
      });
      grid.appendChild(cell);
    }

    // 量几何 → 落到当前档位的稳定态（拖动中保高度，别把手指位置抽走）
    calGridGeom = measureCalGrid(selDate, monthStart, weeks);
    if (calGridGeom) {
      applyCalGridHeight(dragH != null ? dragH
        : (isMonthView() ? calGridGeom.fullH : calGridGeom.collapsedH));
    }

    // ---- 选中日的日程列表 ----
    const dayList = (byDate.get(calSelected) || []).slice()
      .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
    if (dayTitleEl) {
      const label = calSelected === todayStr ? '今日安排' : `${selDate.getMonth() + 1}月${selDate.getDate()}日 ${CAL_WEEKDAYS[selDate.getDay()]}`;
      dayTitleEl.innerHTML = `
        <span class="inline-block rounded-full" style="width:6px;height:6px;background:#111"></span>
        ${label} · ${dayList.length} 节课`;
    }

    if (dayList.length === 0) {
      listEl.innerHTML = `
        <div class="text-center py-10 text-[#9c9fa5]">
          <i class="fa-regular fa-calendar-check text-2xl mb-2 block"></i>
          <div class="text-xs">这一天还没有排课</div>
        </div>`;
    } else {
      listEl.innerHTML = dayList.map((s) => {
        const done = s.status === SCHEDULE_STATUS.COMPLETED;
        const badge = buildStatusBadge(s, { isToday: calSelected === todayStr });
        return `
        <div class="lm-card px-5 py-4 flex items-center gap-3.5 ${done ? 'opacity-60' : ''}" data-cal-item="${s.id}">
          <div class="text-center shrink-0 min-w-[52px]">
            <div class="font-bold text-[18px] text-[#111111]">${s.startTime}</div>
            <div class="text-[10.5px] text-[#9c9fa5] mt-0.5">${s.durationMinutes || 45}分钟</div>
          </div>
          <div class="flex-1 min-w-0" style="border-left:1px solid #f0ebe2;padding-left:14px">
            <div class="font-bold text-[14.5px] text-[#111111] truncate">${s.studentName || ''} <span class="text-[#9c9fa5] font-medium">· ${s.subject || s.courseName || ''}</span></div>
            <div class="text-[12px] text-[#9c9fa5] truncate mt-1">${[s.teacherName, s.room].filter(Boolean).join(' · ')}</div>
          </div>
          ${badge}
        </div>`;
      }).join('');
    }

    // dateBar 文字与标题同步
    syncCalDateText();

    // 选中日清单进场：点格子 / 翻页换了「哪一天」时，给下方清单一条空间线索。
    // 拖动中（calDrag）绝对不动 —— 那一刻整页在跟手改高度，再插一个补间会互相抢。
    if (!calDrag && window.uiAnim && window.uiAnim.listIn) window.uiAnim.listIn(listEl);
  }

  // 周/月翻页：周档**按天步进**；月档翻月（保持"选中日序号"尽量不变）
  //
  // ⚠️ 周档必须是 ±1 天，不是 ±7 天。这条被改坏过一次，别再改回去：
  //   66d87a4 明确做过「week-calendar swipe now steps one day (was a full week)」，
  //   之后 f7ed5ce（三档视图整合）把这里写回 dir * 7，手势就退化成"翻上下周"了。
  //   周档手势的真实语义是「换选中日」——网格本身渲染整月，靠裁剪+上移露出选中周，
  //   所以按天步进跨周时网格会自动上移一行，用户看到的就是"一格一格挪"。
  //   月档才该整月翻页，因为那才是"翻页"而不是"选日"。
  function shiftCalPage(dir) {
    const sel = new Date(calSelected + 'T00:00:00');
    if (isMonthView()) {
      const targetMonth = new Date(sel.getFullYear(), sel.getMonth() + dir, 1);
      const lastDay = new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0).getDate();
      const d = new Date(targetMonth.getFullYear(), targetMonth.getMonth(), Math.min(sel.getDate(), lastDay));
      calSelected = formatDate(d);
    } else {
      calSelected = formatDate(addDays(sel, dir));
    }
    renderCalGrid();
  }

  // 三档视图的唯一切换入口：分段控件 / 手势切换线 / 键盘都调它
  function setCalView(next) {
    if (!next || next === calView) return;
    if (calView === 'day3' || next === 'day3') {
      // 3 日与周/月是两套容器：游标接力（位置连续，不会跳回今天）+ 容器显隐 + 进场动画
      if (next === 'day3') mobileStartDate = new Date(calSelected + 'T00:00:00');
      else calSelected = formatDate(mobileStartDate);
      calView = next;
      applyCalViewUI();
      return;
    }
    // 周 ↔ 月：同一份网格，只补间裁剪高度 —— DOM 不重建，所以动画能从任意半途接管
    calView = next;
    syncCalViewChrome();
    syncCalDateText();
    if (!calGridGeom) renderCalGrid();
    else animateCalGridHeight(isMonthView() ? calGridGeom.fullH : calGridGeom.collapsedH);
  }

  // 分段控件外观同步：选中态 + 翻页按钮文案 + 手势滑条状态（不动容器显隐，避免与 tab 切换打架）
  function syncCalViewChrome() {
    document.querySelectorAll('[data-calview]').forEach((btn) => {
      const on = btn.getAttribute('data-calview') === calView;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const grab = document.getElementById('calGrabber');
    if (grab) {
      const isMonth = calView === 'month';
      grab.setAttribute('aria-expanded', isMonth ? 'true' : 'false');
      grab.setAttribute('aria-label', isMonth ? '上滑收起为周视图' : '下滑展开整月');
    }
    const p = document.getElementById('btnMobilePrev');
    const n = document.getElementById('btnMobileNext');
    // 文案必须与 shiftCalPage 的真实步长一致：周档按天（不是按周），
    // 否则按钮写着「前周」却只跳一天 —— 这种"文案骗人"比手势本身更费解。
    const prevLabel = calView === 'day3' ? '前3天' : (calView === 'week' ? '前一天' : '前月');
    const nextLabel = calView === 'day3' ? '后3天' : (calView === 'week' ? '后一天' : '后月');
    if (p) p.innerHTML = '<i class="fa-solid fa-chevron-left text-[10px]"></i> ' + prevLabel;
    if (n) n.innerHTML = nextLabel + ' <i class="fa-solid fa-chevron-right text-[10px]"></i>';
  }

  // 课表视图切换：3日时间轴 / 周条 / 整月格（分段控件驱动）
  function applyCalViewUI() {
    const vs = document.getElementById('viewSchedule');
    const vc = document.getElementById('viewCalweek');
    const isTimeline = calView === 'day3';
    if (vs) vs.classList.toggle('hidden', !isTimeline);
    if (vc) vc.classList.toggle('hidden', isTimeline);
    syncCalViewChrome();
    renderCalendar();
    // 视图切换进场：低频切换（一天几次），给一个轻微位移说明「换了一整套视图」。
    // 底部 tab 切换仍刻意不做整页淡入（高频操作 + 正撞重渲染开销最大的时刻）。
    const shown = isTimeline ? vs : vc;
    if (shown && window.uiAnim && window.uiAnim.viewIn) window.uiAnim.viewIn(shown);
  }

  // 老师视角：进课表默认只看自己的课（三档视图共用，所以必须放在门面里 ——
  // 默认档是「周」，写死在某个渲染器里就只对那一档生效，等于没做）。
  // 每次老师会话只应用一次：之后老师手动切到别的老师 / 全部老师都尊重其选择，
  // 不会被强行拉回来；退出老师身份（teacherLogout）后重置，下次登录再默认选中本人。
  function applyTeacherScopeDefault() {
    if (!isTeacherView()) { teacherFilterAutoApplied = false; return; }
    if (teacherFilterAutoApplied) return;
    teacherFilterAutoApplied = true;
    const sel = document.getElementById('mobileTeacherSelect');
    // 选项里没有这位老师（老师已被删 / 数据还没加载完）时不锁死，否则课表会空成一片
    const known = !sel || [...sel.options].some((o) => o.value === teacherSession.teacherId);
    selectedTeacherFilter = known ? teacherSession.teacherId : 'all';
    if (sel && known) {
      // 选项已在 renderMobileTeacherSelect 里建好，这里只同步选中值（重建 innerHTML 会白刷一遍）
      sel.value = selectedTeacherFilter;
    }
  }

  // 渲染门面：所有刷新点只认这一个入口，内部按 calView 分派到各自的渲染器
  function renderCalendar() {
    applyTeacherScopeDefault();
    renderMobileHomeCard();
    if (calView === 'day3') renderTimeline3();
    else renderCalGrid();
  }

  function renderTimeline3() {
    const headerContainer = document.getElementById('mobileHeaderDays');
    const gridContainer = document.getElementById('mobileGridColumns');
    if (!headerContainer || !gridContainer) return;
    headerContainer.innerHTML = '';
    gridContainer.innerHTML = '';

    const endDate = addDays(mobileStartDate, 2);
    const dateTextEl = document.getElementById('mobileDateText');
    if (dateTextEl) {
      // 紧凑格式，给右侧三档分段控件让宽度（日期栏在窄屏上很挤）
      // 同月省掉第二个月份（"10/12 - 14"），跨月才写全（"10/30 - 11/1"）
      const fromLabel = `${mobileStartDate.getMonth() + 1}/${mobileStartDate.getDate()}`;
      dateTextEl.textContent = mobileStartDate.getMonth() === endDate.getMonth()
        ? `${fromLabel} - ${endDate.getDate()}`
        : `${fromLabel} - ${endDate.getMonth() + 1}/${endDate.getDate()}`;
    }

    const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const todayStr = formatDate(new Date());

    const conflictsMap = detectScheduleConflicts();

    for (let i = 0; i < 3; i++) {
      const dayDate = addDays(mobileStartDate, i);
      const dateStr = formatDate(dayDate);
      const isToday = dateStr === todayStr;

      const colHeader = document.createElement('div');
      colHeader.className = `py-1.5 px-1 text-center transition ${isToday ? 'lm-today-col font-bold' : 'text-[#626260]'}`;
      colHeader.innerHTML = `
        <div class="text-[11px] ${isToday ? 'text-white/75 font-bold' : 'text-[#9c9fa5]'}">${weekdayNames[dayDate.getDay()]}</div>
        <div class="text-xs font-extrabold ${isToday ? 'text-white' : 'text-[#111111]'}">${dayDate.getMonth() + 1}/${dayDate.getDate()}</div>
      `;
      headerContainer.appendChild(colHeader);

      const dayColumn = document.createElement('div');
      dayColumn.className = 'calendar-day-column relative min-w-0';
      dayColumn.setAttribute('data-date', dateStr);

      dayColumn.addEventListener('click', (e) => {
        if (!e.target.closest('.schedule-event-card')) {
          const rect = dayColumn.getBoundingClientRect();
          const offsetY = Math.max(0, Math.min(832, e.clientY - rect.top));
          const totalMinutes = Math.floor((offsetY / 832) * (13 * 60));
          const roundedMinutes = Math.floor(totalMinutes / 5) * 5;

          const hour = Math.min(20, 8 + Math.floor(roundedMinutes / 60));
          const min = roundedMinutes % 60;
          const startTimeStr = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;

          openMobileScheduleModalForNew(null, dateStr, startTimeStr);
        }
      });

      const daySchedules = filterByTeacher(schedules.filter((s) => s.date === dateStr));

      const layoutItems = layoutOverlapEvents(daySchedules);
      layoutItems.forEach((sch) => {
        const conflictInfo = conflictsMap.get(sch.id);
        const card = createMobileScheduleCard(sch, conflictInfo);
        dayColumn.appendChild(card);
      });

      gridContainer.appendChild(dayColumn);
    }
  }

  function layoutOverlapEvents(schedulesList) {
    if (!schedulesList || schedulesList.length === 0) return [];
    const items = schedulesList.map((s) => {
      const [h, m] = s.startTime.split(':').map(Number);
      const startMins = (h - 8) * 60 + m;
      const endMins = startMins + s.durationMinutes;
      return { ...s, startMins, endMins, _colIndex: 0, _totalCols: 1 };
    });

    items.sort((a, b) => a.startMins - b.startMins || b.durationMinutes - a.durationMinutes);

    const clusters = [];
    let currentCluster = [];
    let clusterEndMins = -1;

    items.forEach((item) => {
      if (currentCluster.length === 0) {
        currentCluster.push(item);
        clusterEndMins = item.endMins;
      } else if (item.startMins < clusterEndMins) {
        currentCluster.push(item);
        clusterEndMins = Math.max(clusterEndMins, item.endMins);
      } else {
        clusters.push(currentCluster);
        currentCluster = [item];
        clusterEndMins = item.endMins;
      }
    });
    if (currentCluster.length > 0) clusters.push(currentCluster);

    clusters.forEach((cluster) => {
      const columns = [];
      cluster.forEach((item) => {
        let placed = false;
        for (let i = 0; i < columns.length; i++) {
          if (columns[i] <= item.startMins) {
            columns[i] = item.endMins;
            item._colIndex = i;
            placed = true;
            break;
          }
        }
        if (!placed) {
          item._colIndex = columns.length;
          columns.push(item.endMins);
        }
      });
      const maxCols = columns.length;
      cluster.forEach((item) => (item._totalCols = maxCols));
    });

    return items;
  }

  // 一次性迁移：把历史排课存的色值对齐为学员头像色（渲染已实时跟随，这一步只清历史脏值）
  function syncScheduleColors() {
    let changed = 0;
    schedules.forEach((s) => {
      const st = students.find((x) => x.id === s.studentId);
      if (!st || !st.colorTheme) return;
      if (s.colorTheme !== st.colorTheme) {
        s.colorTheme = st.colorTheme;
        changed += 1;
      }
    });
    if (changed > 0) saveData();
  }

  // 课卡颜色统一跟随学员头像色（schedule.colorTheme 已废弃，仅作历史数据兜底）
  function resolveScheduleTheme(schedule) {
    const st = students.find((s) => s.id === schedule.studentId);
    return (st && st.colorTheme) || schedule.colorTheme || 'amber';
  }

  function createMobileScheduleCard(schedule, conflictInfo) {
    const card = document.createElement('div');
    const themeClass = `event-${resolveScheduleTheme(schedule)}`;
    const hasConflict = !!conflictInfo;
    card.className = `schedule-event-card ${themeClass} ${hasConflict ? 'has-conflict' : ''}`;
    card.setAttribute('data-schedule-id', schedule.id);

    const [h, m] = schedule.startTime.split(':').map(Number);
    const startMins = (h - 8) * 60 + m;
    const topPx = (startMins / (13 * 60)) * 832;
    const heightPx = (schedule.durationMinutes / (13 * 60)) * 832;

    card.style.top = `${Math.max(0, topPx)}px`;
    card.style.height = `${Math.max(48, heightPx)}px`;

    const totalCols = schedule._totalCols || 1;
    const colIndex = schedule._colIndex || 0;
    const widthPercent = 100 / totalCols;
    const leftPercent = colIndex * widthPercent;

    card.style.left = `calc(${leftPercent}% + 2px)`;
    card.style.width = `calc(${widthPercent}% - 4px)`;

    const endMins = startMins + schedule.durationMinutes;
    const endHour = 8 + Math.floor(endMins / 60);
    const endMin = endMins % 60;
    const endTimeStr = `${String(endHour).padStart(2, '0')}:${String(endMin).padStart(2, '0')}`;

    // 方格上不再显示老师（窄列空间有限），老师/课室信息改为放进 title 与详情弹窗
    const tooltipParts = [schedule.studentName, schedule.subject || schedule.courseName || '课程', `${schedule.startTime}-${endTimeStr}`];
    const teacherLine = [schedule.teacherName, schedule.assistantTeacherName].filter(Boolean).join('&');
    if (teacherLine) tooltipParts.push(`老师:${teacherLine}`);
    if (schedule.room) tooltipParts.push(`课室:${schedule.room}`);
    card.setAttribute('title', tooltipParts.join(' · '));

    // 冲突拆分废弃前的旧写法保留在注释里：窄列放不下两行冲突文案，统一走「图标 + title」
    const conflictReasons = hasConflict ? conflictInfo.reasons : [];

    // 空间分层（与桌面端同一套策略，阈值按手机实际列宽重定）：
    //   手机 3 日视图：单列 ≈110px（只相当于桌面两节并排的卡宽）、两列 ≈53px、四列 ≈34px
    //   单列      → 姓名 + 课程（时间徽章退场，完整时间进 title）
    //   多列(≥2)  → 只留姓名（+冲突图标/状态单字），课程及以下全部退场
    //   矮卡(<56px) → 单行截断不换行；普通/高卡 → 姓名、课程各允许两行，尽量完整显示
    //   状态角标从绝对定位改内联——压测里「✓消/假」正好盖住姓名
    const isNarrow = totalCols >= 2;
    const isShort = heightPx < 56;
    const isTall = heightPx >= 96;
    const canWrap = !isNarrow && !isShort;
    const statusCompact = isNarrow || isShort;

    // 状态徽章内联化（紧凑态只留单字，完整文案走 title）
    let statusChip = '';
    if (schedule.status === SCHEDULE_STATUS.COMPLETED) {
      statusChip = `<span class="shrink-0 ${statusCompact ? 'text-[9px] px-0.5' : 'text-[8px] px-1'} font-black text-white bg-emerald-500 rounded-md leading-none py-[3px]" title="已消课">✓${statusCompact ? '' : ' 消'}</span>`;
      card.style.opacity = '0.65';
    } else if (schedule.status === SCHEDULE_STATUS.STUDENT_LEAVE) {
      // 请假再分三态：待补（假·）/ 已补（假✓）/ 普通请假（假）—— 窄卡只放得下两字
      const pend = isPendingMakeup(schedule);
      const dn = isMakeupDone(schedule);
      const leaveMark = pend ? (statusCompact ? '假!' : '假·待补') : (dn ? '假✓' : '假');
      const leaveTitle = pend ? '学员请假 · 待补课' : (dn ? '学员请假 · 已补课' : '学员请假');
      statusChip = `<span class="shrink-0 ${statusCompact ? 'text-[9px] px-0.5' : 'text-[8px] px-1'} font-black text-white ${pend ? 'bg-[#B98235]' : 'bg-rose-400'} rounded-md leading-none py-[3px]" title="${leaveTitle}">${leaveMark}</span>`;
      // 弱化交给 .is-leave（更透 + 去饱和 + 灰白字），不再用内联 opacity/灰度
      card.classList.add('is-leave');
    }
    // 补课课次：另加一枚「补」小标（不动状态角标，两者语义不同）
    if (isMakeupLesson(schedule)) {
      statusChip = '<span class="lm-chip-makeup" title="补课">补</span>' + statusChip;
    }

    // 冲突提示：多列/矮卡只留警示图标（34px 宽、48px 高都放不下整行文案）
    const conflictIcon = hasConflict
      ? `<span class="shrink-0 inline-flex items-center text-rose-700" title="${conflictReasons.join(' | ')}"><i class="lm-cf-warn fa-solid fa-triangle-exclamation text-rose-500 text-[9px]"></i></span>`
      : '';
    const conflictFull = hasConflict
      ? `<div class="text-[9px] font-bold text-rose-700 bg-rose-100/95 border border-rose-300 px-1 py-0.2 rounded truncate flex items-center gap-0.5 shadow-2xs shrink-0 mt-0.5" title="${conflictReasons.join(' | ')}">
           <i class="lm-cf-warn fa-solid fa-triangle-exclamation text-rose-500 shrink-0 text-[8px]"></i>
           <span class="truncate leading-normal min-w-0">${conflictReasons.join('; ')}</span>
         </div>`
      : '';

    // 课程：矮卡/多列用裸文本（省掉徽章边框的高度开销），单列普通卡保留徽章
    const subjectText = schedule.subject || schedule.courseName || '课程';
    const subjectPlain = `<span class="${canWrap ? 'line-clamp-2' : 'truncate'} opacity-90 text-[10px] font-semibold min-w-0">${subjectText}</span>`;
    const subjectBadge = `<span class="ev-chip text-[11px] font-bold px-1.5 py-0.5 rounded-md truncate min-w-0 max-w-full">${subjectText}</span>`;

    // 纵向分布：多列/矮卡居中收紧；高卡顶部起排（justify-between 会在中间拉出大空洞）
    const vDist = isNarrow ? 'justify-center' : (isShort ? 'justify-center gap-[2px]' : (isTall ? 'justify-start gap-1' : 'justify-between'));

    let bodyRows;
    if (isNarrow) {
      bodyRows = '';
    } else if (isShort) {
      bodyRows = `<div class="leading-none flex items-center gap-1 shrink-0 min-w-0">${subjectPlain}${conflictIcon}</div>`;
    } else {
      bodyRows = `<div class="leading-none flex items-center gap-1 min-w-0 shrink-0">${subjectBadge}</div>` + conflictFull;
    }

    card.innerHTML = `
      <div class="flex flex-col ${vDist} h-full pointer-events-none px-1.5 py-1 min-w-0">
        <div class="flex items-center justify-between gap-1 leading-tight shrink-0 min-w-0">
          <span class="event-name ${canWrap ? 'line-clamp-2' : 'truncate'} flex-1 min-w-0 font-extrabold text-[12px]">${schedule.studentName}</span>
          ${statusChip}
          ${isNarrow ? conflictIcon : ''}
        </div>
        ${bodyRows}
      </div>
    `;

    card.addEventListener('click', (e) => {
      e.stopPropagation();
      openMobileScheduleActionMenu(schedule);
    });

    return card;
  }

  // 请假的课不参与冲突判定：它不会真的发生，占用的资源实际是空的。
  // 状态字段可能是历史数据里缺失的，缺省按 scheduled 处理。
  function isLeaveStatus(sch) {
    return (sch.status || SCHEDULE_STATUS.SCHEDULED) === SCHEDULE_STATUS.STUDENT_LEAVE;
  }

  function detectScheduleConflicts() {
    const conflictsMap = new Map();
    const mapByDate = {};

    schedules.forEach((s) => {
      if (!mapByDate[s.date]) mapByDate[s.date] = [];
      const [h, m] = s.startTime.split(':').map(Number);
      const start = h * 60 + m;
      const end = start + s.durationMinutes;
      mapByDate[s.date].push({ ...s, start, end });
    });

    Object.keys(mapByDate).forEach((dateStr) => {
      const items = mapByDate[dateStr];
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i];
          const b = items[j];

          // 请假 = 这节课实际上不会发生：学员不来，老师和课室也没被真正占用。
          // 所以配对里只要有一节是请假，这一对就不构成冲突（两节都请假同理）。
          if (isLeaveStatus(a) || isLeaveStatus(b)) continue;

          if (a.start < b.end && a.end > b.start) {
            const reasonsA = [];
            const reasonsB = [];

            if (a.room && b.room && a.room.trim() === b.room.trim()) {
              // 只提示冲突类型，不再带课室名（卡片空间有限，避免文案被截断）
              reasonsA.push(`课室冲突`);
              reasonsB.push(`课室冲突`);
            }

            const teachersA = [a.teacherId, a.assistantTeacherId].filter(Boolean);
            const teachersB = [b.teacherId, b.assistantTeacherId].filter(Boolean);
            if (teachersA.some((t) => teachersB.includes(t))) {
              reasonsA.push(`老师撞课`);
              reasonsB.push(`老师撞课`);
            }

            if (a.studentId && b.studentId && a.studentId === b.studentId) {
              reasonsA.push(`学员撞课`);
              reasonsB.push(`学员撞课`);
            }

            if (reasonsA.length > 0) {
              if (!conflictsMap.has(a.id)) conflictsMap.set(a.id, { reasons: [] });
              if (!conflictsMap.has(b.id)) conflictsMap.set(b.id, { reasons: [] });

              reasonsA.forEach((r) => {
                if (!conflictsMap.get(a.id).reasons.includes(r)) conflictsMap.get(a.id).reasons.push(r);
              });
              reasonsB.forEach((r) => {
                if (!conflictsMap.get(b.id).reasons.includes(r)) conflictsMap.get(b.id).reasons.push(r);
              });
            }
          }
        }
      }
    });

    return conflictsMap;
  }

  // 按姓名稳定取色：同名学员永远同色，不同学员错开（定稿色卡六色，2026-10）
  const AVATAR_PALETTE = [
    { bg: 'bg-[#F3C3B2]', ring: 'ring-[#F3C3B2]/40',  solid: 'bg-[#F3C3B2]', text: 'text-[#7A4231]' },
    { bg: 'bg-[#99CDD8]', ring: 'ring-[#99CDD8]/40',  solid: 'bg-[#99CDD8]', text: 'text-[#2E5D68]' },
    { bg: 'bg-[#CFD6C4]', ring: 'ring-[#CFD6C4]/40',  solid: 'bg-[#CFD6C4]', text: 'text-[#47523C]' },
    { bg: 'bg-[#A7B2A4]', ring: 'ring-[#A7B2A4]/40',  solid: 'bg-[#A7B2A4]', text: 'text-[#2F3A2E]' },
    { bg: 'bg-[#FDE8D3]', ring: 'ring-[#FDE8D3]/40',  solid: 'bg-[#FDE8D3]', text: 'text-[#8A5A28]' },
    { bg: 'bg-[#DAE9E3]', ring: 'ring-[#DAE9E3]/40',  solid: 'bg-[#DAE9E3]', text: 'text-[#3F6257]' },
  ];
  // 学员自选 colorTheme → 头像色（与色卡主题一一对应）
  const THEME_TO_AVATAR = {
    amber: AVATAR_PALETTE[4], emerald: AVATAR_PALETTE[2], sky: AVATAR_PALETTE[1],
    purple: AVATAR_PALETTE[3], rose: AVATAR_PALETTE[0], mint: AVATAR_PALETTE[5],
  };
  function avatarColorFor(st) {
    if (st.colorTheme && THEME_TO_AVATAR[st.colorTheme]) return THEME_TO_AVATAR[st.colorTheme];
    const name = st.name || '';
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
  }
  // 课时状态色：充足>3 绿 / 紧张1-3 琥珀 / 用尽0或负 玫红
  function lessonsTone(total) {
    if (total <= 0) return { text: 'text-rose-600', bg: 'bg-rose-50', label: total <= 0 ? `欠${Math.abs(total)}` : '剩0' };
    if (total <= 3) return { text: 'text-[#fe4c02]', bg: 'bg-[#fff2f4]', label: `剩${total}` };
    return { text: 'text-emerald-700', bg: 'bg-emerald-50', label: `剩${total}` };
  }

  // 填充学员筛选下拉：老师选项来自 teachers，课程选项来自所有学员的课程名并集
  function populateMobileStudentFilters() {
    const tSel = document.getElementById('mobileStudentTeacherFilter');
    const cSel = document.getElementById('mobileStudentCourseFilter');
    if (tSel && !tSel.options.length) {
      // 首次填充（HTML 只带骨架）：老师视角默认"我的学员"，管理员视角"全部学员"+各老师
      if (isTeacherView()) {
        tSel.innerHTML = '<option value="mine">我的学员</option><option value="all">全部学员</option>';
        tSel.value = 'mine';
      } else {
        tSel.innerHTML = '<option value="all">全部学员</option>' +
          teachers.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
      }
    }
    if (cSel) {
      const prev = cSel.value;
      const names = [...new Set(students.flatMap((st) => (st.courses || []).map((c) => c.name)))].filter(Boolean);
      cSel.innerHTML = '<option value="all">全部课程</option>' +
        names.map((n) => `<option value="${n}">${n}</option>`).join('');
      if ([...cSel.options].some((o) => o.value === prev)) cSel.value = prev;
    }

    // 动效：3 日视图课卡错峰进场（含数量限流）
    if (window.uiAnim) {
      const gridHost = document.getElementById('mobileGridColumns');
      if (gridHost) window.uiAnim.cardsStagger(gridHost, '.schedule-event-card');
      window.uiAnim.emitRendered();
    }
  }

  // 学员页两个范围：在读 / 历史学员库（与桌面端同一套口径）
  function mobileStudentStats(studentId) {
    let total = 0, last = '';
    checkInLogs.forEach((l) => {
      if (l.studentId !== studentId || isRefundLog(l)) return;
      total += Number(l.deductedLessons) || 0;
      const d = logDateText(l);
      if (d && d > last) last = d;
    });
    return { total, last };
  }

  function syncMobileScopeTabs() {
    const tabs = document.getElementById('mStudentScopeTabs');
    if (!tabs) return;
    const activeN = activeStudentsOf().length;
    const archivedN = archivedStudentsOf().length;
    tabs.style.display = (archivedN === 0 && mobileStudentScope === 'active') ? 'none' : 'flex';
    tabs.querySelectorAll('[data-m-student-scope]').forEach((btn) => {
      const on = btn.getAttribute('data-m-student-scope') === mobileStudentScope;
      btn.className = 'px-3 py-1.5 rounded-full text-[11px] font-bold ' + (on ? 'lm-btn-ink text-white' : 'lm-btn-ghost');
      if (!btn.__lmBound) {
        btn.__lmBound = true;
        btn.addEventListener('click', () => {
          mobileStudentScope = btn.getAttribute('data-m-student-scope') || 'active';
          renderMobileStudents();
        });
      }
    });
    const ca = tabs.querySelector('[data-m-scope-count="active"]');
    const cr = tabs.querySelector('[data-m-scope-count="archived"]');
    if (ca) ca.textContent = activeN;
    if (cr) cr.textContent = archivedN;
  }

  function mobileArchivedCard(st) {
    const card = document.createElement('div');
    card.className = 'lm-card p-3 space-y-2';
    const av = avatarColorFor(st);
    const stat = mobileStudentStats(st.id);
    const meta = [
      st.joinDate ? `${st.joinDate} 加入` : '',
      stat.total ? `累计 ${stat.total} 节` : '',
      stat.last ? `最后 ${stat.last}` : '',
    ].filter(Boolean).join(' · ');
    card.innerHTML = `
      <div class="flex items-center space-x-2.5">
        <div class="w-9 h-9 rounded-full ${av.bg} text-white font-bold flex items-center justify-center text-xs shrink-0 opacity-80">${st.name.substring(0, 1)}</div>
        <div class="flex-1 min-w-0">
          <div class="font-bold text-xs text-[#111111] flex items-center gap-1.5">
            <span class="truncate">${st.name}</span>
            <span class="text-[9px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded-full font-semibold shrink-0">${st.archiveReason || '历史学员'}</span>
          </div>
          <div class="text-[10px] text-slate-400 truncate mt-0.5">${meta || '暂无消课记录'}</div>
        </div>
      </div>
      <div class="flex gap-2">
        <button type="button" class="flex-1 py-2 rounded-lg lm-btn-ghost text-[11px] font-bold btn-arch-detail"><i class="fa-solid fa-circle-info"></i> 详情</button>
        <button type="button" class="flex-1 py-2 rounded-lg lm-btn-ink text-white text-[11px] font-bold btn-arch-restore"><i class="fa-solid fa-rotate-left"></i> 移回在读</button>
      </div>`;
    card.querySelector('.btn-arch-detail').addEventListener('click', () => openMobileStudentDetail(st.id));
    card.querySelector('.btn-arch-restore').addEventListener('click', () => toggleMobileStudentArchive(st, false));
    return card;
  }

  function renderMobileStudents() {
    const container = document.getElementById('mobileStudentContainer');
    if (!container) return;
    container.innerHTML = '';
    populateMobileStudentFilters();
    syncMobileScopeTabs();

    const filterBtn = document.querySelector('.mobile-student-filter.active');
    const filter = filterBtn ? filterBtn.getAttribute('data-filter') : 'all';
    const searchEl = document.getElementById('mobileSearchStudent');
    const query = ((searchEl ? searchEl.value : '') || '').trim().toLowerCase();
    const tSel = document.getElementById('mobileStudentTeacherFilter');
    const cSel = document.getElementById('mobileStudentCourseFilter');
    // 老师视角默认"我的学员"：每次渲染下拉被重建后值可能回到第一项(mine)，但若用户之前选了"全部"则保留
    const teacherFilter = tSel ? (tSel.value || 'all') : 'all';
    const courseFilter = cSel ? cSel.value : 'all';

    const scopeArchived = mobileStudentScope === 'archived';
    let list = (scopeArchived ? archivedStudentsOf() : activeStudentsOf()).filter((st) => {
      normalizeStudent(st);
      const matchName = st.name.toLowerCase().includes(query) || (st.phone && st.phone.includes(query));
      const matchCourse = st.courses.some((c) => c.name.toLowerCase().includes(query));
      if (!matchName && !matchCourse) return false;
      // 历史学员只看搜索 + 课程："课时预警 / 我的学员"这些是在读口径，归档的人不参与
      if (scopeArchived) {
        if (courseFilter !== 'all' && !st.courses.some((c) => c.name === courseFilter)) return false;
        return true;
      }
      // 范围下拉：mine=我的学员（关联名单或排课相关）；all=全部；其他值=指定老师
      if (isTeacherView() && teacherFilter === 'mine') {
        const related = (st.teacherIds || []).includes(teacherSession.teacherId) ||
          schedules.some((s) => s.studentId === st.id && (s.teacherId === teacherSession.teacherId || s.assistantTeacherId === teacherSession.teacherId));
        if (!related) return false;
      }

      if (filter === 'low') {
        const total = st.courses.reduce((acc, c) => acc + c.remainingLessons, 0);
        return total <= 2 || st.courses.some((c) => c.remainingLessons <= 2);
      }
      // 按老师筛选：显式关联 或 排课记录里该老师（主讲或助教）上过/将上该学员的课
      if (teacherFilter !== 'all' && teacherFilter !== 'mine') {
        const explicit = (st.teacherIds || []).includes(teacherFilter);
        const viaSchedule = schedules.some((s) => s.studentId === st.id && (s.teacherId === teacherFilter || s.assistantTeacherId === teacherFilter));
        if (!explicit && !viaSchedule) return false;
      }
      // 按课程筛选：学员有该名字的课程
      if (courseFilter !== 'all') {
        if (!st.courses.some((c) => c.name === courseFilter)) return false;
      }
      return true;
    });

    if (list.length === 0) {
      const emptyText = scopeArchived
        ? '历史学员库是空的<br><span class="text-[10px]">在学员详情里点「移入历史库」，结课/停课的学员就会收在这里</span>'
        : (query || filter === 'low' ? '没有符合条件的学员' : '还没有学员，点击右上角"+ 新增"开始添加');
      container.innerHTML = `
        <div class="text-center py-10 text-slate-400 text-xs">
          <i class="fa-solid fa-user-ghost text-3xl mb-2 block opacity-40"></i>
          ${emptyText}
        </div>`;
      return;
    }

    list.forEach((st) => {
      if (scopeArchived) { container.appendChild(mobileArchivedCard(st)); return; }
      const card = document.createElement('div');
      card.className = 'lm-card p-3.5 flex items-center justify-between space-x-2';

      const total = st.courses.reduce((acc, c) => acc + c.remainingLessons, 0);
      const coursesStr = st.courses.map((c) => `${c.name}(剩${c.remainingLessons}课时${c.unitPrice > 0 ? ` ¥${c.unitPrice}/节` : ''})`).join(', ');
      const av = avatarColorFor(st);
      const tone = lessonsTone(total);

      card.innerHTML = `
        <div class="flex items-center space-x-2.5 flex-1 min-w-0">
          <div class="w-9 h-9 rounded-full ${av.bg} ring-2 ${av.ring} text-white font-bold flex items-center justify-center text-xs shrink-0">
            ${st.name.substring(0, 1)}
          </div>
          <div class="flex-1 min-w-0">
            <div class="font-bold text-xs text-[#111111] flex items-center gap-1.5">
              <span>${st.name}</span>
              <span class="text-[10px] ${tone.text} ${tone.bg} px-1.5 py-0.2 rounded-full font-semibold">${tone.label}课时</span>
            </div>
            <div class="text-[10.5px] text-[#9c9fa5] truncate mt-0.5">${coursesStr}</div>
          </div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button class="btn-detail-mobile-student px-2 py-1.5 bg-[#f1ece3] text-[#626260] text-xs rounded-full active:opacity-80" title="详情">
            <i class="fa-solid fa-circle-info"></i>
          </button>
          <button class="btn-edit-mobile-student px-2 py-1.5 bg-[#f1ece3] text-[#626260] text-xs rounded-full active:opacity-80" title="编辑学员">
            <i class="fa-solid fa-pen"></i>
          </button>
          <button class="btn-schedule-mobile px-3 py-1.5 lm-btn-fin text-[12px] shrink-0">
            排课
          </button>
        </div>
      `;

      card.querySelector('.btn-detail-mobile-student').addEventListener('click', () => {
        openMobileStudentDetail(st.id);
      });

      card.querySelector('.btn-edit-mobile-student').addEventListener('click', () => {
        openMobileStudentModal(st);
      });

      card.querySelector('.btn-schedule-mobile').addEventListener('click', () => {
        const tabEl = document.getElementById('navTabSchedule');
        if (tabEl) tabEl.click();
        openMobileScheduleModalForNew(st, formatDate(new Date()), '10:00');
      });

      container.appendChild(card);
    });
  }

  // makeupSrc：补课时传入「被补的那节请假课」，表单会预填它的学员/课程/老师/时长/课室，
  // 并把 id 写进隐藏域，保存时落成 schedule.makeupOfId（不填 = 普通排课）。
  function openMobileScheduleModalForNew(student = null, dateStr = formatDate(new Date()), startTimeStr = '10:00', makeupSrc = null) {
    const titleEl = document.getElementById('modalMobileScheduleTitle');
    if (titleEl) titleEl.textContent = makeupSrc ? '安排补课' : '安排新课程';

    const idEl = document.getElementById('inputMobileScheduleId');
    if (idEl) idEl.value = '';

    const makeupEl = document.getElementById('inputMobileMakeupOfId');
    if (makeupEl) makeupEl.value = makeupSrc ? makeupSrc.id : '';

    const banner = document.getElementById('mobileMakeupBanner');
    const bannerText = document.getElementById('mobileMakeupBannerText');
    if (banner) banner.classList.toggle('hidden', !makeupSrc);
    if (bannerText && makeupSrc) {
      bannerText.textContent = `补 ${makeupSrc.date} ${makeupSrc.startTime} 的课 · ${makeupSrc.studentName} · ${makeupSrc.subject || ''}`;
    }

    // 补课：学员/课程/科目/老师/时长/课室一律跟随源请假课，只让用户挑日期与时间
    const preset = makeupSrc || null;
    if (preset) { student = students.find((st) => st.id === preset.studentId) || student; dateStr = formatDate(new Date()); startTimeStr = snapTo5Min(preset.startTime || startTimeStr); }

    const stSelect = document.getElementById('selectMobileStudent');
    if (stSelect) {
      stSelect.innerHTML = '';
      let pickList = activeStudentsOf();
      if (student && !pickList.some((x) => x.id === student.id)) pickList = pickList.concat([student]);
      pickList.forEach((st) => {
        stSelect.innerHTML += `<option value="${st.id}">${st.name} (${st.courses.length}门课)</option>`;
      });
      const targetStudent = student || pickList[0];
      if (targetStudent) stSelect.value = targetStudent.id;
      updateMobileCourseDropdown(targetStudent, preset ? (preset.courseId || preset.subject || '') : '');
      if (preset && preset.subject !== undefined) {
        mRenderCourseTypesDatalist();
        const subjEl0 = document.getElementById('inputMobileSubject');
        if (subjEl0) subjEl0.value = preset.subject || '';
      } else {
        syncMobileSubjectFromCourse();
      }
    }

    const dateEl = document.getElementById('inputMobileDate');
    if (dateEl) dateEl.value = dateStr;

    const timeEl = document.getElementById('inputMobileStartTime');
    if (timeEl) timeEl.value = startTimeStr;

    // 兜底：源课时间被其它入口写脏时，保存前也吸附到 5 分钟整（否则原生校验静默拦下）
    if (timeEl && preset) timeEl.value = snapTo5Min(timeEl.value);

    const durEl = document.getElementById('selectMobileDuration');
    if (durEl) durEl.value = String(preset && preset.durationMinutes ? preset.durationMinutes : 45);

    const roomEl = document.getElementById('inputMobileRoom');
    if (roomEl) roomEl.value = (preset && preset.room) ? preset.room : '琴房 101';

    renderMobileTeacherDropdowns();
    if (preset) {
      const tEl = document.getElementById('selectMobileTeacher');
      if (tEl && preset.teacherId) tEl.value = preset.teacherId;
      const aEl = document.getElementById('selectMobileAssistant');
      if (aEl && preset.assistantTeacherId) aEl.value = preset.assistantTeacherId;
    }

    const delBtn = document.getElementById('btnDeleteMobileSchedule');
    if (delBtn) delBtn.classList.add('hidden');

    // 重复排课：仅新增时显示。补课是「一对一核销」，天然只排一节 → 直接藏掉，避免排出一个系列
    const repeatBlock = document.getElementById('mobileRepeatOptionsBlock');
    const ruleEl = document.getElementById('selectMobileRepeatRule');
    const endWrap = document.getElementById('mobileRepeatEndDateWrap');
    const endEl = document.getElementById('inputMobileRepeatEndDate');
    const hintEl = document.getElementById('mobileRepeatHint');
    if (repeatBlock) repeatBlock.classList.toggle('hidden', !!preset);
    if (ruleEl) ruleEl.value = 'none';
    if (endWrap) endWrap.classList.add('hidden');
    if (endEl) {
      const def = new Date();
      def.setMonth(def.getMonth() + 3);
      endEl.value = formatDate(def);
    }
    if (hintEl) hintEl.classList.add('hidden');

    // 新增模式：隐藏系列批量修改块
    const seriesBlockNew = document.getElementById('mobileSeriesEditBlock');
    if (seriesBlockNew) seriesBlockNew.classList.add('hidden');

    showModal('modalMobileSchedule');
  }

  function openMobileScheduleModalForEdit(schedule) {
    const titleEl = document.getElementById('modalMobileScheduleTitle');
    if (titleEl) titleEl.textContent = '修改课程排期';

    // 编辑不走补课模式：清掉补课隐藏域与提示条（否则上次排补课残留的 id 会被误写）
    const makeupEl = document.getElementById('inputMobileMakeupOfId');
    if (makeupEl) makeupEl.value = '';
    const banner = document.getElementById('mobileMakeupBanner');
    if (banner) banner.classList.add('hidden');

    const idEl = document.getElementById('inputMobileScheduleId');
    if (idEl) idEl.value = schedule.id;

    const stSelect = document.getElementById('selectMobileStudent');
    if (stSelect) {
      stSelect.innerHTML = '';
      students.forEach((st) => {
        stSelect.innerHTML += `<option value="${st.id}">${st.name}</option>`;
      });
      stSelect.value = schedule.studentId;
    }

    const st = students.find((x) => x.id === schedule.studentId);
    updateMobileCourseDropdown(st, schedule.courseId || schedule.subject);

    // 科目：编辑时回填已存的值，候选来自课程类型
    mRenderCourseTypesDatalist();
    const mSubjectEl = document.getElementById('inputMobileSubject');
    if (mSubjectEl) mSubjectEl.value = schedule.subject || '';

    const dateEl = document.getElementById('inputMobileDate');
    if (dateEl) dateEl.value = schedule.date;

    const timeEl = document.getElementById('inputMobileStartTime');
    if (timeEl) timeEl.value = schedule.startTime;

    const durEl = document.getElementById('selectMobileDuration');
    if (durEl) durEl.value = String(schedule.durationMinutes);

    const roomEl = document.getElementById('inputMobileRoom');
    if (roomEl) roomEl.value = schedule.room || '';

    renderMobileTeacherDropdowns();
    const tEl = document.getElementById('selectMobileTeacher');
    if (tEl && schedule.teacherId) tEl.value = schedule.teacherId;

    const aEl = document.getElementById('selectMobileAssistant');
    if (aEl && schedule.assistantTeacherId) aEl.value = schedule.assistantTeacherId;

    const delBtn = document.getElementById('btnDeleteMobileSchedule');
    if (delBtn) delBtn.classList.remove('hidden');

    // 编辑模式隐藏重复排课块，改为显示系列批量修改块（若属于系列）
    const repeatBlock = document.getElementById('mobileRepeatOptionsBlock');
    if (repeatBlock) repeatBlock.classList.add('hidden');

    const seriesBlock = document.getElementById('mobileSeriesEditBlock');
    const seriesChk = document.getElementById('chkApplyToSeriesMobile');
    const seriesHint = document.getElementById('seriesEditHintMobile');
    if (seriesChk) seriesChk.checked = false;
    if (seriesBlock) {
      const laterCount = seriesLaterSiblings(schedule).filter((s) => !s.status || s.status === 'scheduled').length;
      if (laterCount > 0) {
        seriesBlock.classList.remove('hidden');
        updateSeriesHint(); // 文案随日期框实时变化（含「周四 → 周五」的平移提示）
      } else {
        seriesBlock.classList.add('hidden');
      }
    }

    showModal('modalMobileSchedule');
  }

  function updateMobileCourseDropdown(student, selectedCourseIdOrName = '') {
    const cSelect = document.getElementById('selectMobileCourse');
    if (!cSelect) return;
    cSelect.innerHTML = '';
    if (!student || !student.courses) return;

    student.courses.forEach((c) => {
      const selected = c.id === selectedCourseIdOrName || c.name === selectedCourseIdOrName ? 'selected' : '';
      cSelect.innerHTML += `<option value="${c.id}" data-name="${c.name}" ${selected}>${c.name} (剩 ${c.remainingLessons} 课时)</option>`;
    });
  }

  // 新建 / 换学员时：科目框跟着当前课程包带出同名科目（用户可改）
  function syncMobileSubjectFromCourse() {
    mRenderCourseTypesDatalist();
    const subjectEl = document.getElementById('inputMobileSubject');
    if (!subjectEl) return;
    const cSel = document.getElementById('selectMobileCourse');
    const opt = cSel ? cSel.options[cSel.selectedIndex] : null;
    subjectEl.value = opt ? opt.getAttribute('data-name') || '' : '';
  }

  function renderMobileTeacherDropdowns() {
    const tSelect = document.getElementById('selectMobileTeacher');
    const aSelect = document.getElementById('selectMobileAssistant');

    if (tSelect) {
      tSelect.innerHTML = '';
      teachers.forEach((t) => {
        tSelect.innerHTML += `<option value="${t.id}">${t.name} - ${t.subject || '通用'}</option>`;
      });
    }

    if (aSelect) {
      aSelect.innerHTML = `<option value="">无 (单师授课)</option>`;
      teachers.forEach((t) => {
        aSelect.innerHTML += `<option value="${t.id}">${t.name} - ${t.subject || '通用'}</option>`;
      });
    }
  }

  function closeMobileScheduleModal() {
    hideModal('modalMobileSchedule');
  }

  function handleSaveMobileSchedule(e) {
    e.preventDefault();
    const idEl = document.getElementById('inputMobileScheduleId');
    const schId = idEl ? idEl.value : '';

    const stSelect = document.getElementById('selectMobileStudent');
    const studentId = stSelect ? stSelect.value : '';
    const student = students.find((st) => st.id === studentId);

    const cSelect = document.getElementById('selectMobileCourse');
    const courseId = cSelect ? cSelect.value : '';
    const courseOpt = cSelect ? cSelect.options[cSelect.selectedIndex] : null;
    const courseName = courseOpt ? courseOpt.getAttribute('data-name') : '通用课程';
    // 科目独立字段：留空则等于课程包名（兼容旧数据）
    const subjectInputEl = document.getElementById('inputMobileSubject');
    let subject = subjectInputEl ? subjectInputEl.value.trim() : '';
    if (!subject) subject = courseName;
    mAddCourseType(subject);

    const tSelect = document.getElementById('selectMobileTeacher');
    const teacherId = tSelect ? tSelect.value : '';
    const teacher = teachers.find((t) => t.id === teacherId);
    const teacherName = teacher ? teacher.name : '';

    const aSelect = document.getElementById('selectMobileAssistant');
    const assistantTeacherId = aSelect ? aSelect.value : '';
    const assistantTeacher = teachers.find((t) => t.id === assistantTeacherId);
    const assistantTeacherName = assistantTeacher ? assistantTeacher.name : '';

    const date = document.getElementById('inputMobileDate').value;
    const startTime = document.getElementById('inputMobileStartTime').value;
    // 时长校验：必须为 5 的倍数（5~240 分钟），默认 45 = 1 课时
    let durationMinutes = parseInt(document.getElementById('selectMobileDuration').value, 10);
    if (!Number.isFinite(durationMinutes) || durationMinutes < 5) durationMinutes = 45;
    durationMinutes = Math.min(240, Math.round(durationMinutes / 5) * 5);
    document.getElementById('selectMobileDuration').value = String(durationMinutes);
    const room = document.getElementById('inputMobileRoom').value.trim();

    if (schId) {
      const idx = schedules.findIndex((s) => s.id === schId);
      if (idx !== -1) {
        // 系列成员基于「修改前」的原始课计算，避免改完日期后把自己之后的课漏掉
        const prev = { ...schedules[idx] };
        const seriesList = seriesLaterSiblings(prev).filter((s) => !s.status || s.status === SCHEDULE_STATUS.SCHEDULED);
        const shiftDays = diffDays(prev.date, date);
        const applyToSeries = document.getElementById('chkApplyToSeriesMobile');
        const willSync = !!(applyToSeries && applyToSeries.checked);
        if (willSync) pushUndo('批量修改系列', schedules[idx].id);
        schedules[idx] = {
          ...schedules[idx],
          studentId,
          studentName: student ? student.name : '未知学生',
          courseId,
          subject,
          teacherId,
          teacherName,
          assistantTeacherId,
          assistantTeacherName,
          date,
          startTime,
          durationMinutes,
          room,
        };
        // 系列批量修改：勾选后同步本节之后的待上课系列成员（日期整体平移）
        const applyToSeriesChk = document.getElementById('chkApplyToSeriesMobile');
        if (applyToSeriesChk && applyToSeriesChk.checked) {
          let dateSkipped = 0;
          const excludeIds = new Set(seriesList.map((s) => s.id));
          seriesList.forEach((s) => {
            s.courseId = courseId;
            s.subject = subject;
            s.teacherId = teacherId;
            s.teacherName = teacherName;
            s.assistantTeacherId = assistantTeacherId;
            s.assistantTeacherName = assistantTeacherName;
            s.startTime = startTime;
            s.durationMinutes = durationMinutes;
            s.room = room;
            if (shiftDays !== 0) {
              const target = shiftDateStr(s.date, shiftDays);
              if (seriesShiftConflict(s, target, startTime, durationMinutes, teacherId, room, excludeIds)) {
                dateSkipped++;
              } else {
                s.date = target;
              }
            }
          });
          let msg = `已同步修改本节及之后共 ${seriesList.length + 1} 节课`;
          if (shiftDays !== 0) {
            msg += `，日期平移 ${shiftDays > 0 ? '+' : ''}${shiftDays} 天（${weekdayLabel(prev.date)} → ${weekdayLabel(date)}）`;
            if (dateSkipped > 0) msg += `，其中 ${dateSkipped} 节撞课未移动日期`;
          }
          offerUndo(msg, '批量修改系列');
        } else {
          showToast('修改成功！');
        }
      }
    } else {
      // 重复排课（seriesId 需先于 makeSchedule 声明）
      const ruleEl = document.getElementById('selectMobileRepeatRule');
      const endEl = document.getElementById('inputMobileRepeatEndDate');
      const rule = ruleEl ? ruleEl.value : 'none';
      const endDateStr = endEl ? endEl.value : '';
      const seriesId = rule !== 'none' && endDateStr ? 'ser_' + Date.now() : undefined;

      const makeSchedule = (id, d) => ({
        id,
        // 同桌面端：云端存原样 JSON，缺 status 会被 ICS 白名单漏掉（AGENTS 第 36 条）
        status: SCHEDULE_STATUS.SCHEDULED,
        studentId,
        studentName: student ? student.name : '未知学生',
        courseId,
        subject,
        teacherId,
        teacherName,
        assistantTeacherId,
        assistantTeacherName,
        date: d,
        startTime,
        durationMinutes,
        room,
        colorTheme: student ? student.colorTheme : 'amber',
        ...(seriesId ? { seriesId } : {}),
      });
      const firstId = 'sch_' + Date.now();
      schedules.push(makeSchedule(firstId, date));
      // 补课：把这一节挂到源请假课上（双向标记由 syncMakeupLink 统一维护）
      const makeupOfId = (() => { const el = document.getElementById('inputMobileMakeupOfId'); return el ? el.value : ''; })();
      if (makeupOfId) {
        const created = schedules.find((s) => s.id === firstId);
        const src = schedules.find((s) => s.id === makeupOfId);
        if (created && src && isPendingMakeup(src)) {
          created.makeupOfId = src.id;
          syncMakeupLink(created);
        } else if (created) {
          showToast('⚠ 原请假课状态已变，这节按普通排课保存');
        }
      }

      // 课时在消课时扣除（App 语义），排课不再扣——避免"排了又消"重复扣的困惑

      if (rule !== 'none' && endDateStr) {
        const stepDays = rule === 'biweekly' ? 14 : 7;
        const base = new Date(date + 'T00:00:00');
        const end = new Date(endDateStr + 'T00:00:00');
        let cursor = new Date(base);
        let created = 0;
        let skipped = 0;
        while (created < 52) {
          cursor.setDate(cursor.getDate() + stepDays);
          if (cursor > end) break;
          const dStr = formatDate(cursor);
          const clash = schedules.some((s) => s.date === dStr && s.startTime === startTime && (s.teacherId === teacherId || (assistantTeacherId && s.assistantTeacherId === assistantTeacherId)));
          if (clash) { skipped++; continue; }
          schedules.push(makeSchedule('sch_' + Date.now() + '_' + created, dStr));
          created++;
        }
        let msg = `已排 ${created + 1} 节课（含首次）`;
        if (skipped > 0) msg += `，${skipped} 节因冲突跳过`;
        showToast('📅 ' + msg);
      } else {
        showToast(`已成功为 [${student ? student.name : ''}] 排课！`);
      }
    }

    saveData();
    closeMobileScheduleModal();
    renderCalendar();
    // 首页也要刷：排补课排的就是「今天」，今日行的「补课」小标与 hero 统计都得跟上
    if (typeof renderMobileHome === 'function') renderMobileHome();
    // 保存后高亮刚改/刚建的那一节，让改动有落点
    const mobileSavedId = schId || (schedules.length ? schedules[schedules.length - 1].id : '');
    if (window.uiAnim && mobileSavedId) window.uiAnim.flashSchedule(mobileSavedId);
  }

  // 删除课程统一入口：有后续重复排课时弹"仅本次/本次及之后"双选（无则普通确认）
  function deleteMobileScheduleWithScope(sch, onDone) {
    const later = seriesLaterSiblings(sch).filter((s) => !s.status || s.status === 'scheduled');
    const laterCount = later.length;

    const doDelete = (ids, msg) => {
      // 删除是不可逆感最强的操作，撤销优先级最高
      pushUndo('删除排课', sch.id);
      ids.forEach((id) => {
        const target = schedules.find((s) => s.id === id);
        // 退还课时的唯一依据 = 这节课真实扣过的节数（消课流水之和），不按 status 猜。
        // 排课环节从不扣课时 → 删「待上课」不该退；删「已消课」要连流水带课时一起回滚。
        // 与桌面端 handleDeleteScheduleWithCleanup 同语义（见 AGENTS 第 38 条）。
        const deductedUnits = checkInLogs
          .filter((l) => l.scheduleId === id && !isRefundLog(l))
          .reduce((sum, l) => sum + (Number(l.deductedLessons) || 0), 0);
        checkInLogs = checkInLogs.filter((l) => l.scheduleId !== id);
        cleanupMakeupLinks(id);   // 断补课链路：源课没了/补课没了都要解绑
        if (target && deductedUnits > 0) {
          const student = students.find((st) => st.id === target.studentId);
          if (student) {
            const course = (student.courses || []).find((c) => c.id === target.courseId || c.name === target.subject || c.name === target.courseName);
            if (course) course.remainingLessons += deductedUnits;
          }
        }
      });
      schedules = schedules.filter((s) => !ids.includes(s.id));
      saveData();
      offerUndo(msg, '删除排课');
      if (onDone) onDone();
    };

    if (laterCount === 0) {
      // 文案要对得上真实语义：待上课本来就没扣课时，没什么可退；已消课的才回滚流水+退课时
      if (!confirm('确定删除该课程？已消课的记录会一并撤销，并退还对应课时。')) return;
      doDelete([sch.id], '已删除该课程');
      return;
    }

    // 系列存在 → 双选项弹窗（底部抽屉式）
    const ov = document.createElement('div');
    ov.className = 'fixed inset-0 bg-slate-900/40 backdrop-blur-xs z-[70] flex items-end justify-center';
    ov.innerHTML = `
      <div class="bg-white w-full rounded-t-3xl p-5 pb-8 space-y-2.5" style="padding-bottom: calc(2rem + env(safe-area-inset-bottom))">
        <div class="flex items-start gap-3 pb-3 border-b border-slate-100">
          <div class="w-9 h-9 rounded-full bg-rose-100 text-rose-500 flex items-center justify-center shrink-0"><i class="fa-solid fa-trash-can"></i></div>
          <div>
            <div class="font-bold text-sm text-slate-800">删除重复排课系列</div>
            <div class="text-[11px] text-slate-400 mt-0.5">${sch.studentName || ''} · ${sch.subject || ''} · ${sch.date} ${sch.startTime}<br>该时段之后还有 <b class="text-rose-500">${laterCount}</b> 节同样的排课</div>
          </div>
        </div>
        <button data-scope="this" class="w-full py-3 rounded-xl text-sm font-bold bg-slate-100 text-slate-700 active:bg-slate-200">
          <i class="fa-solid fa-scissors mr-1"></i> 仅删除本次（保留之后 ${laterCount} 节）
        </button>
        <button data-scope="all" class="w-full py-3 rounded-xl text-sm font-bold bg-rose-500 text-white active:bg-rose-600">
          <i class="fa-solid fa-trash-can mr-1"></i> 删除本次及之后所有（共 ${laterCount + 1} 节）
        </button>
        <button data-scope="cancel" class="w-full py-2 text-xs text-slate-400">取消</button>
      </div>`;
    ov.addEventListener('click', (e) => {
      if (e.target === ov) { ov.remove(); return; }
      const btn = e.target.closest('[data-scope]');
      if (!btn) return;
      const scope = btn.getAttribute('data-scope');
      ov.remove();
      if (scope === 'this') doDelete([sch.id], '已删除本次课程，后续排课已保留');
      else if (scope === 'all') {
        const ids = [sch.id, ...later.map((s) => s.id)];
        doDelete(ids, `已删除本次及之后共 ${ids.length} 节排课`);
      }
    });
    document.body.appendChild(ov);
  }

  function handleDeleteMobileSchedule() {
    const idEl = document.getElementById('inputMobileScheduleId');
    const schId = idEl ? idEl.value : '';
    if (!schId) return;
    const sch = schedules.find((s) => s.id === schId);
    if (!sch) return;
    deleteMobileScheduleWithScope(sch, () => {
      closeMobileScheduleModal();
      renderCalendar();
    });
  }

  // 弹窗动效由 CSS 单一系统驱动（@starting-style 提供进场起点，.lm-modal-closing 触发退场）。
  // 手机底部抽屉因此有了真正的上滑进场（此前被 CSS !important 终态压掉，是硬弹出）。
  function showModal(id) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.remove('lm-modal-closing');
      el.classList.remove('hidden');
      setTimeout(() => el.classList.add('opacity-100'), 10);
    }
  }

  function hideModal(id) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.remove('opacity-100');
      el.classList.add('lm-modal-closing'); // 抽屉下滑退出 200ms
      setTimeout(() => {
        el.classList.add('hidden');
        el.classList.remove('lm-modal-closing');
      }, 230);
    }
  }

  // 手机端财务视图渲染
  // 环比徽章：本月累计 vs **上月整月**合计（口径不按日截断，只给方向感）。
  // 与电脑端 js/app.js 的 momBadge 同语义同参数，**改口径必须两边一起改**。
  // 上月为 0 时不给百分比（除零算出来的是假数据）；位置在卡片标题行右上方（margin-left:auto 顶开）。
  function momBadge(cur, prev, unit, fmt, big) {
    const cls = `lm-mom${big ? ' is-lg' : ''}`;
    if (!(prev > 0)) return '';
    const pct = ((cur - prev) / prev) * 100;
    const tip = `上月整月 ${fmt(prev)}${unit} → 本月至今 ${fmt(cur)}${unit}`;
    if (Math.abs(pct) < 0.5) return `<span class="${cls} is-flat" style="margin-left:auto" title="${tip}">持平</span>`;
    const up = pct > 0;
    const abs = Math.abs(pct);
    const txt = abs >= 999 ? '999%+' : `${abs.toFixed(0)}%`;
    return `<span class="${cls} ${up ? 'is-up' : 'is-down'}" style="margin-left:auto" title="${tip}">${up ? '▲' : '▼'} ${txt}</span>`;
  }

  // 上月整月消课流水（跨年由 Date 自动回退）；老师视角由调用方再过滤
  function prevMonthLogs() {
    const now = new Date();
    const pm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const pfx = `${pm.getFullYear()}-${String(pm.getMonth() + 1).padStart(2, '0')}`;
    return checkInLogs.filter((l) => (l.checkInTime || '').startsWith(pfx));
  }

  function renderMobileFinance() {
    const container = document.getElementById('mobileFinanceContent');
    if (!container) return;

    const now = new Date();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // 老师视角：只统计自己课程的消课记录（管理员看全部）
    // 退款是机构层面的账（一笔退款不对应某一节课），若走 logRelatedToTeacher 的兜底分支，
    // 每个老师都会被同一笔退款重复扣一次 —— 故老师视角直接不摊分退款。
    let scopedLogs = checkInLogs.filter((l) => (l.checkInTime || '').startsWith(monthPrefix));
    if (isTeacherView()) scopedLogs = scopedLogs.filter((l) => !isRefundLog(l) && logRelatedToTeacher(l));
    const monthLogs = scopedLogs.slice().sort((a, b) => (b.checkInTime || '').localeCompare(a.checkInTime || ''));

    const monthLessons = monthLogs.reduce((acc, l) => acc + (l.deductedLessons || 0), 0);
    // 退款流水 deductedLessons=0 → 课消节数天然不受影响；paymentAmount 是负数 → 金额自动被扣减
    const monthValue = monthLogs.reduce((acc, l) => acc + (l.paymentAmount || 0), 0);
    const monthRefund = monthLogs.filter(isRefundLog).reduce((acc, l) => acc + Math.abs(l.paymentAmount || 0), 0);

    // 环比（与上月整月比）：只在能由消课流水直接推出的两项上放徽章；
    // 「待消存量 / 欠课学员」没有历史快照，硬算会出假数。老师视角按同一口径过滤。
    let prevScoped = prevMonthLogs();
    if (isTeacherView()) prevScoped = prevScoped.filter((l) => !isRefundLog(l) && logRelatedToTeacher(l));
    const prevLessons = prevScoped.reduce((acc, l) => acc + (l.deductedLessons || 0), 0);
    const prevValue = prevScoped.reduce((acc, l) => acc + (l.paymentAmount || 0), 0);

    // 老师视角：待消存量/欠课学员/续费清单只统计**自己授课科目**的课时；管理员看全部
    const relStudents = isTeacherView() ? students.filter((st) => !isArchivedSt(st) && studentRelatedToTeacher(st)) : activeStudentsOf();
    const myCoursesOf = (st) => isTeacherView() ? (st.courses || []).filter((c) => courseRelatedToTeacher(st, c.name)) : (st.courses || []);
    const totalRemaining = relStudents.reduce((acc, st) => acc + myCoursesOf(st).reduce((a, c) => a + Math.max(0, c.remainingLessons), 0), 0);
    const relIds = new Set(relStudents.map((s) => s.id));
    const debtors = isTeacherView()
      ? debts.filter((d) => d.amount > 0 && relIds.has(d.studentId) && relStudents.some((st) => st.id === d.studentId && courseRelatedToTeacher(st, d.courseName)))
      : debts.filter((d) => d.amount > 0 && relIds.has(d.studentId));

    // 续费预警（剩余课时落在 [0, 2]；老师视角只看自己授课科目）
    // 欠课（负数）不在这里 —— 它们进下方「欠课名单」，两处重复列同一个人会让老师以为要退钱
    const lowRows = lowLessonRows(relStudents, myCoursesOf);

    container.innerHTML = `
      <div class="grid grid-cols-2 gap-2.5">
        <div class="lm-card p-4">
          <div class="text-[11px] text-[#9c9fa5] font-medium flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:#111"></span> 本月课消${momBadge(monthLessons, prevLessons, ' 节', (n) => n.toFixed(1), true)}</div>
          <div class="lm-stat-v text-[#111111] mt-1">${monthLessons.toFixed(1)} <span class="text-[11px] font-medium">节</span></div>
        </div>
        <div class="lm-card p-4">
          <div class="text-[11px] text-[#9c9fa5] font-medium flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:#059669"></span> 课消价值${momBadge(monthValue, prevValue, ' 元', (n) => n.toFixed(0), true)}</div>
          <div class="lm-stat-v text-[#059669] mt-1">${fmtMoney(monthValue)}</div>
        </div>
        <div class="lm-card p-4">
          <div class="text-[11px] text-[#9c9fa5] font-medium flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:#0284c7"></span> 待消存量</div>
          <div class="lm-stat-v text-[#0284c7] mt-1">${totalRemaining.toFixed(1)} <span class="text-[11px] font-medium">节</span></div>
        </div>
        <div class="lm-card p-4">
          <div class="text-[11px] ${debtors.length ? 'text-[#9c9fa5]' : 'text-[#9c9fa5]'} font-medium flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:#ff2067"></span> 欠课学员</div>
          <div class="lm-stat-v ${debtors.length ? 'text-[#d5304f]' : 'text-[#c9c4bc]'} mt-1">${debtors.length} <span class="text-[11px] font-medium">人</span></div>
        </div>
      </div>

      <div class="lm-card p-4">
        <div class="font-bold text-[12px] text-[#111111] mb-2 flex items-center gap-1.5"><span class="inline-block w-2 h-2 rounded-full" style="background:#fe4c02"></span> 续费预警 <span class="text-[11px] font-medium text-[#9c9fa5]">剩余 ≤2 节${isTeacherView() ? ' · 我的学员' : ''}</span></div>
        ${lowRows.length === 0 ? '<div class="text-[12px] text-[#9c9fa5] py-3 text-center">暂无需要续费的学员 👍</div>' : `
        <div>
          ${lowRows.map((r) => `
          <button type="button" data-renew-student="${r.student.id}" data-renew-course="${r.course.name}" class="w-full flex items-center justify-between py-2 text-left active:opacity-60 transition" style="border-bottom:1px solid #f0ebe2">
            <div class="text-[11.5px] font-bold text-[#111111] truncate">${r.student.name} <span class="text-[#9c9fa5] font-medium">· ${r.course.name}</span></div>
            <div class="text-[11px] font-bold shrink-0 ml-2 ${r.left === 0 ? 'text-[#d5304f]' : 'text-[#fe4c02]'}">${lowLessonText(r.left)} <i class="fa-solid fa-circle-plus ml-0.5 opacity-60"></i></div>
          </button>`).join('')}
          <div class="text-[10px] text-[#9c9fa5] pt-1.5">💡 点一行直接为该课程充值</div>
        </div>`}
      </div>

      <div class="lm-card p-4">
        <div class="font-bold text-[13px] text-[#111111] mb-2 flex items-center gap-1.5"><i class="fa-solid fa-receipt text-[#ff5600]"></i> 本月${isTeacherView() ? '我的' : ''}收入明细${monthRefund > 0 ? ` <span class="text-[11px] font-medium text-[#d5304f]">已退 ¥${monthRefund.toFixed(0)}</span>` : ''}</div>
        ${monthLogs.length === 0 ? '<div class="text-[12px] text-[#9c9fa5] py-4 text-center">本月暂无消课记录</div>' : `
        <div class="space-y-1.5">
          ${monthLogs.map((l) => {
            // 退款行单独立样式（没有消课节数、金额是负数），别混在消课行里读
            const ref = isRefundLog(l);
            return `
            <div class="flex items-center justify-between text-[11.5px] ${ref ? 'bg-[#fff2f4]' : 'bg-[#faf6ef]'} px-3 py-2 rounded-xl">
              <div class="min-w-0">
                <span class="font-bold text-[#111111]">${l.studentName}</span>
                <span class="text-[#9c9fa5] ml-1">${l.courseName}</span>
                ${ref ? `<span class="font-bold text-[#d5304f] ml-1">退款 ${l.refundLessons || 0} 节</span>` : ''}
              </div>
              <div class="text-right shrink-0 ml-2">
                <div class="font-bold ${ref ? 'text-[#d5304f]' : 'text-[#626260]'}">${ref ? fmtMoney(l.paymentAmount) : `${l.deductedLessons}节${l.paymentAmount > 0 ? ` · ¥${l.paymentAmount.toFixed(0)}` : ''}`}</div>
                <div class="text-[10px] text-[#9c9fa5]">${(l.checkInTime || '').replace('T', ' ').slice(5, 16)}</div>
              </div>
            </div>`;}).join('')}
        </div>`}
      </div>

      <div class="lm-card p-4">
        <div class="font-bold text-[13px] text-[#111111] mb-2 flex items-center gap-1.5"><i class="fa-solid fa-triangle-exclamation text-[#d5304f]"></i> 欠课名单</div>
        ${debtors.length === 0 ? '<div class="text-[12px] text-[#9c9fa5] py-4 text-center">没有欠课学员 🎉</div>' : `
        <div class="space-y-1.5">
          ${debtors.map((d) => {
            const st = students.find((s) => s.id === d.studentId);
            return `
            <div class="flex items-center justify-between text-[11.5px] bg-[#fff2f4] px-3 py-2 rounded-xl">
              <span class="font-bold text-[#111111]">${st ? st.name : '未知学员'} · ${d.courseName}</span>
              <span class="font-bold text-[#d5304f]">欠 ${d.amount} 节</span>
            </div>`;}).join('')}
        </div>`}
      </div>
    `;

    // 续费预警行 → 直通充值（预选到该课程包，单价一并带出）
    container.querySelectorAll('[data-renew-student]').forEach((el) => {
      el.addEventListener('click', () => {
        const st = students.find((s) => s.id === el.getAttribute('data-renew-student'));
        if (st) openMobileRechargeModal(st, el.getAttribute('data-renew-course'));
      });
    });

    // 欠课红点
    const badge = document.getElementById('mobileNavDebtBadge');
    if (badge) badge.classList.toggle('hidden', debtors.length === 0);
  }

  function openMobileScheduleActionMenu(schedule) {
    const status = schedule.status || SCHEDULE_STATUS.SCHEDULED;
    const student = students.find((st) => st.id === schedule.studentId);
    // 防连点叠加：新开一张前先把旧的摘掉（否则遮罩会一层压一层）
    const prevMenu = document.getElementById('mobileScheduleActionMenu');
    if (prevMenu) prevMenu.remove();

    const menu = document.createElement('div');
    menu.id = 'mobileScheduleActionMenu';
    // 容器不再自带底色，让遮罩独立成一个子节点 —— 这样遮罩能单独淡入淡出，
    // 而面板单独上滑（一个节点身上挂两种过渡会互相牵制）。
    menu.className = 'fixed inset-0 z-50 flex items-end justify-center';

    const statusText = status === SCHEDULE_STATUS.COMPLETED ? '已消课 ✓'
      : status === SCHEDULE_STATUS.STUDENT_LEAVE
        ? (isPendingMakeup(schedule) ? '学员请假 🏖️ · 待补课' : (isMakeupDone(schedule) ? '学员请假 🏖️ · 已补课' : '学员请假 🏖️'))
        : (isMakeupLesson(schedule) ? '补课 · 待上课' : '待上课');
    const makeupSrc = isMakeupLesson(schedule) ? schedules.find((x) => x.id === schedule.makeupOfId) : null;
    const makeupDone = isMakeupDone(schedule) ? schedules.find((x) => x.id === schedule.madeUpById) : null;

    // 遮罩（独立子节点，可单独淡入淡出）+ 面板（上滑）。
    // 面板直接贴屏幕底部（与全站其它 lm-sheet 一致）：遮罩 z-50 本就盖住底部岛台
    // （岛台 z-40，点它也只会关弹层），所以**不能**给容器留出岛台高度的内边距，
    // 否则面板底边悬在半空，岛台那条半透明灰带会露在下面，看起来像一块空隙。
    // 与 home indicator 的间距由面板自身的 padding-bottom 负责。
    menu.innerHTML = `
      <div class="absolute inset-0 bg-slate-900/40" data-sheet-backdrop></div>
      <div class="lm-action-sheet relative bg-white rounded-t-3xl w-full p-5 space-y-2.5 shadow-2xl max-w-md mx-auto max-h-[88dvh] overflow-y-auto" style="padding-bottom: calc(1.5rem + env(safe-area-inset-bottom))">
        <div class="w-10 h-1 bg-slate-200 rounded-full mx-auto mb-1"></div>
        <div id="lmSheetBody" class="space-y-2.5"></div>
      </div>
    `;

    const panel = menu.querySelector('.lm-action-sheet');
    const body = menu.querySelector('#lmSheetBody');

    const headHtml = () => `
      <div class="lm-sheet-head pb-3 border-b border-slate-100">
        <button type="button" data-act="delete" class="lm-sheet-del" aria-label="删除该课程" title="删除该课程">
          <i class="fa-solid fa-trash-can"></i>
        </button>
        <div class="font-bold text-sm text-slate-800">${schedule.studentName} · ${schedule.subject}</div>
        <div class="text-[11px] text-slate-400 mt-0.5">${schedule.date} ${schedule.startTime} · ${schedule.durationMinutes}分钟 · ${statusText}</div>
        ${makeupSrc ? `<div class="text-[11px] mt-1 text-[#2E5D68]"><i class="fa-solid fa-arrows-rotate"></i> 补 ${makeupSrc.date} ${makeupSrc.startTime} 的课</div>` : ''}
        ${makeupDone ? `<div class="text-[11px] mt-1 text-[#2E5D68]"><i class="fa-solid fa-circle-check"></i> 已由 ${makeupDone.date} ${makeupDone.startTime} 的补课核销</div>` : ''}
        ${student && getStudentDebts(student.id).length ? `<div class="text-[10px] text-rose-500 mt-1">⚠ 欠课：${getStudentDebts(student.id).map(d => d.courseName + ' ' + d.amount + '节').join('、')}</div>` : ''}
      </div>`;

    const BTN = 'w-full py-3.5 rounded-xl font-bold text-sm flex items-center justify-center gap-2';
    const EDIT_BTN = `<button data-act="edit" class="${BTN} bg-slate-100 text-slate-700 active:bg-slate-200">
        <i class="fa-solid fa-pen-to-square"></i> 编辑课程信息
      </button>`;

    let actionsHtml = '';
    if (status !== SCHEDULE_STATUS.STUDENT_LEAVE) {
      actionsHtml += `
        ${status === SCHEDULE_STATUS.SCHEDULED ? `
        <button data-act="checkin" class="lm-checkin-btn w-full py-3.5 rounded-xl font-bold text-sm bg-emerald-500 text-white active:bg-emerald-600 flex items-center justify-center gap-2">
          <span class="lm-cb-label"><i class="fa-solid fa-circle-check"></i> 消课签到（${getLessonCost(schedule)}节）</span>
          <span class="lm-cb-spinner" aria-hidden="true"></span>
          <svg class="lm-cb-check" viewBox="0 0 24 24" aria-hidden="true"><path pathLength="100" d="M4.5 12.6 L9.7 17.8 L19.5 6.6"/></svg>
        </button>` : ''}
        <button data-act="leave" class="lm-btn-leave ${BTN}">
          <i class="fa-solid fa-person-walking-arrow-right"></i> 学员请假（退还${getLessonCost(schedule)}节）${status === SCHEDULE_STATUS.COMPLETED ? ' · 改请假' : ''}
        </button>
        ${status === SCHEDULE_STATUS.COMPLETED ? `
        <button data-act="revert" class="${BTN} lm-btn-ink">
          <i class="fa-solid fa-rotate-left"></i> 撤销消课（还原为待上课）
        </button>` : ''}
      `;
    } else {
      // 请假态：补课链路的主场（待补 → 排补课；不补 → 可加回；已补 → 只读提示）
      if (isPendingMakeup(schedule)) {
        actionsHtml += `
        <button data-act="makeup" class="lm-btn-makeup ${BTN}">
          <i class="fa-solid fa-calendar-plus"></i> 排补课
        </button>
        <button data-act="unneed" class="${BTN} bg-slate-100 text-slate-700 active:bg-slate-200">
          <i class="fa-solid fa-ban"></i> 这节课不用补了
        </button>`;
      } else if (!schedule.needMakeup) {
        actionsHtml += `
        <button data-act="need" class="lm-btn-makeup ${BTN}">
          <i class="fa-solid fa-calendar-plus"></i> 加入待补课
        </button>`;
      }
      actionsHtml += `
        <button data-act="revert" class="${BTN} lm-btn-ink">
          <i class="fa-solid fa-rotate-left"></i> 撤销状态（还原为待上课）
        </button>
      `;
    }
    actionsHtml += EDIT_BTN;

    // 请假二选一（第二屏）：**不是每次请假都要补课**，所以把选择摆成必须选的一步，
    // 而不是偷偷给个默认值 —— 漏选会直接错在账上（多出一节待补或漏掉一节该补的课）。
    // 用同一张面板换内容，不新开浮层：两层弹层叠加会互相牵制，退场也说不清谁先谁后。
    const askHtml = `
      <div class="pb-3 border-b border-slate-100">
        <div class="font-bold text-sm text-slate-800">这节需要补课吗？</div>
        <div class="text-[11px] text-slate-400 mt-1 leading-relaxed">
          ${schedule.studentName} · ${schedule.subject} · ${schedule.date} ${schedule.startTime}<br>
          需要补课 → 转入待补课清单，之后可以安排补课；不用补课 → 直接记为请假。
        </div>
      </div>
      <button data-ask="1" class="lm-btn-makeup ${BTN}">
        <i class="fa-solid fa-calendar-plus"></i> 需要补课（转入待补课）
      </button>
      <button data-ask="0" class="${BTN} bg-slate-100 text-slate-700 active:bg-slate-200">
        <i class="fa-solid fa-check"></i> 不用补课（直接记为请假）
      </button>
      <button data-act="back" class="w-full py-3 text-slate-400 text-xs">返回</button>`;

    const mainHtml = headHtml() + actionsHtml
      + `<button data-act="close" class="w-full py-3 text-slate-400 text-xs">取消</button>`;

    const renderBody = (view) => { body.innerHTML = view === 'ask' ? askHtml : mainHtml; };
    renderBody('main');

    // 唯一的关闭出口：下滑退场跑完再摘节点（RM / 无 GSAP 时立即摘）。
    // after 里的动作排在退场之后 —— 这样紧跟其后的弹窗/Toast 不会和退场动画挤在一起。
    const closeActionMenu = (after) => {
      const anim = window.uiAnim;
      if (anim && anim.sheetOut) anim.sheetOut(menu, panel, () => { menu.remove(); if (after) after(); });
      else { menu.remove(); if (after) after(); }
    };

    menu.addEventListener('click', (e) => {
      if (e.target === menu || e.target.hasAttribute('data-sheet-backdrop')) { closeActionMenu(); return; }
      // 请假二选一：先选，再落数据
      const askBtn = e.target.closest('[data-ask]');
      if (askBtn) {
        const need = askBtn.getAttribute('data-ask') === '1';
        closeActionMenu(() => markStudentLeave(schedule.id, need));
        return;
      }
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      // 消课：三态动效得在按钮上跑完，所以先别关菜单 —— 动效一结束立刻关菜单 + 刷新
      if (act === 'checkin') {
        if (!window.uiAnim || !window.uiAnim.runAsyncButton) {
          closeActionMenu(() => executeCheckIn(schedule.id));
          return;
        }
        window.uiAnim.runAsyncButton(
          btn,
          () => {
            const ok = executeCheckIn(schedule.id, '', { skipRefresh: true });
            if (!ok) closeActionMenu(); // 被拦下（状态守卫）：菜单别赖着不走
            return ok;
          },
          // 刷新排在退场之后：refreshMobileAll 是一次同步的整站重渲染（日历 35 格 + 名单 + 首页），
          // 和退场补间抢同一帧 —— 实测冷态下这段能造出 100ms+ 的长任务，正好砸在退场起步那几帧上。
          // 排在 done 里还有个额外好处：数据不会在面板底下"当场变脸"。
          () => { closeActionMenu(() => refreshMobileAll()); }
        );
        return;
      }
      if (act === 'close') { closeActionMenu(); return; }
      if (act === 'back') { renderBody('main'); return; }
      // 请假 → 切到二选一那一屏（不关面板）
      if (act === 'leave') { renderBody('ask'); return; }
      if (act === 'makeup') closeActionMenu(() => openMobileScheduleModalForNew(student, formatDate(new Date()), schedule.startTime, schedule));
      else if (act === 'need') closeActionMenu(() => setNeedMakeup(schedule.id, true));
      else if (act === 'unneed') closeActionMenu(() => setNeedMakeup(schedule.id, false));
      else if (act === 'revert') closeActionMenu(() => revertScheduleStatus(schedule.id));
      else if (act === 'edit') closeActionMenu(() => openMobileScheduleModalForEdit(schedule));
      else if (act === 'delete') {
        closeActionMenu(() => deleteMobileScheduleWithScope(schedule, () => {
          renderCalendar();
          renderMobileStudents();
        }));
      }
    });

    document.body.appendChild(menu);
    // 上滑进场：面板从屏幕下沿滑上来，动作按钮轻微错峰
    if (window.uiAnim && window.uiAnim.sheetIn) {
      window.uiAnim.sheetIn(menu, panel, { items: '[data-act]' });
    }
  }

  let toastTimer = null;
  // 撤销（Undo）：操作前整体快照，Toast 内 5 秒窗口一键回滚
  // 快照必须覆盖 4 个会被写入的集合 —— 漏掉 checkInLogs / debts
  // 会让回滚留下脏流水（财务对不上）
  let undoState = null;
  let undoTimer = null;

  function pushUndo(label, flashId) {
    undoState = {
      students: JSON.parse(JSON.stringify(students)),
      schedules: JSON.parse(JSON.stringify(schedules)),
      checkInLogs: JSON.parse(JSON.stringify(checkInLogs)),
      debts: JSON.parse(JSON.stringify(debts)),
      label: label || '上一次操作',
      flashId: flashId || '',
    };
  }

  function clearUndo() {
    undoState = null;
    if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
  }

  function refreshMobileAll() {
    renderCalendar();
    renderMobileStudents();
    if (typeof renderMobileHome === 'function') renderMobileHome();
  }

  function runUndo() {
    if (!undoState) return;
    const label = undoState.label;
    const flashId = undoState.flashId;
    students = undoState.students;
    schedules = undoState.schedules;
    checkInLogs = undoState.checkInLogs;
    debts = undoState.debts;
    clearUndo();
    saveData();
    pendingReorderId = flashId || null; // 撤销请假时这一行滑回原位
    refreshMobileAll();
    showToast(`↩️ 已撤销：${label}`);
    if (window.uiAnim && flashId) window.uiAnim.flashSchedule(flashId);
  }

  // 提示 + 撤销入口。调用前必须已经在数据变更前执行过 pushUndo(label)
  function offerUndo(msg, label) {
    if (!undoState) { showToast(msg); return; }
    if (label) undoState.label = label;
    showToast(msg, '撤销', () => runUndo());
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(clearUndo, 5200);
  }

  function hideToast() {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.style.opacity = '';
    toast.style.transform = '';
    toast.classList.add('translate-y-10', 'opacity-0', 'pointer-events-none');
    toast.classList.remove('translate-y-0', 'opacity-100');
    const actionBtn = document.getElementById('toastAction');
    if (actionBtn) { actionBtn.style.display = 'none'; actionBtn.onclick = null; }
  }

  function showToast(msg, actionLabel = '', onAction = null) {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toastMsg');
    if (toast && toastMsg) {
      toastMsg.textContent = msg;
      // 清掉 GSAP 动画残留的内联样式，否则 opacity-0 class 会被内联 opacity:1 压住，toast 永远不消失
      toast.style.opacity = '';
      toast.style.transform = '';
      toast.style.translate = '';
      toast.style.rotate = '';
      toast.style.scale = '';

      // 撤销按钮：按需动态挂载，不用时隐藏（避免误触上一次的回调）
      let actionBtn = document.getElementById('toastAction');
      if (actionLabel && typeof onAction === 'function') {
        if (!actionBtn) {
          actionBtn = document.createElement('button');
          actionBtn.id = 'toastAction';
          actionBtn.type = 'button';
          toast.appendChild(actionBtn);
        }
        actionBtn.textContent = actionLabel;
        actionBtn.style.display = '';
        actionBtn.onclick = () => { hideToast(); onAction(); };
      } else if (actionBtn) {
        actionBtn.style.display = 'none';
        actionBtn.onclick = null;
      }

      toast.classList.remove('translate-y-10', 'opacity-0', 'pointer-events-none');
      toast.classList.add('translate-y-0', 'opacity-100');
      // Toast 只走 CSS 过渡（见 styles.css #toast），不再叠 GSAP
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast.style.opacity = '';
        toast.style.transform = '';
        toast.classList.add('translate-y-10', 'opacity-0', 'pointer-events-none');
        toast.classList.remove('translate-y-0', 'opacity-100');
      }, 5000);
    }
  }

  // ============ 手机端 新增/编辑学员弹窗逻辑 ============
  function openMobileStudentModal(student = null) {
    const modal = document.getElementById('modalMobileStudent');
    const titleEl = document.getElementById('modalMobileStudentTitle');
    const editEl = document.getElementById('editMobileStudentId');
    const nameEl = document.getElementById('mobileStudentNameInput');
    const phoneEl = document.getElementById('mobileStudentPhoneInput');
    const colorEl = document.getElementById('mobileStudentColorSelect');
    const delBtn = document.getElementById('btnDeleteMobileStudent');
    const container = document.getElementById('mobileStudentCoursesContainer');
    if (!modal) return;

    if (editEl) editEl.value = student ? student.id : '';
    if (nameEl) nameEl.value = student ? student.name : '';
    if (phoneEl) phoneEl.value = student ? (student.phone || '') : '';
    if (colorEl) colorEl.value = student ? (student.colorTheme || 'amber') : 'amber';
    if (titleEl) titleEl.textContent = student ? '编辑学员' : '添加新学员';
    if (delBtn) delBtn.classList.toggle('hidden', !student);

    if (container) {
      container.innerHTML = '';
      const courses = student && student.courses && student.courses.length
        ? student.courses
        : [{ name: '', remainingLessons: 10 }];
      courses.forEach((c) => addMobileCourseRow(c));
    }

    // 关联老师胶囊：勾选状态来自 student.teacherIds
    const chipsBox = document.getElementById('mobileStudentTeacherChips');
    if (chipsBox) {
      const linked = new Set((student && student.teacherIds) || []);
      chipsBox.innerHTML = teachers.map((t) => `
        <button type="button" class="st-t-chip px-3 py-2 rounded-full text-[11px] font-bold border transition ${linked.has(t.id) ? 'bg-[#111111] text-white border-[#111111]' : 'bg-white text-[#626260] border-slate-200'}" data-tid="${t.id}">
          ${linked.has(t.id) ? '<i class="fa-solid fa-check mr-1 text-[10px]"></i>' : ''}${t.name}
        </button>`).join('') || '<span class="text-[11px] text-slate-400">还没有老师账号</span>';
      chipsBox.onclick = (e) => {
        const chip = e.target.closest('.st-t-chip');
        if (!chip) return;
        chip.classList.toggle('bg-[#111111]');
        chip.classList.toggle('text-white');
        chip.classList.toggle('border-[#111111]');
        chip.classList.toggle('bg-white');
        chip.classList.toggle('text-[#626260]');
        chip.classList.toggle('border-slate-200');
        const ic = chip.querySelector('i');
        if (chip.classList.contains('bg-[#111111]') && !ic) chip.insertAdjacentHTML('afterbegin', '<i class="fa-solid fa-check mr-1 text-[10px]"></i>');
        else if (!chip.classList.contains('bg-[#111111]') && ic) ic.remove();
      };
    }

    showModal('modalMobileStudent');
  }

  function closeMobileStudentModal() {
    hideModal('modalMobileStudent');
  }

  function addMobileCourseRow(course = null) {
    const container = document.getElementById('mobileStudentCoursesContainer');
    if (!container) return;
    mRenderCourseTypesDatalist();
    const row = document.createElement('div');
    row.className = 'mobile-course-row bg-white border border-slate-200 rounded-xl p-2 space-y-1.5';
    row.innerHTML = `
      <div class="flex items-center gap-2">
        <input type="text" list="courseTypesListMobile" class="m-course-name flex-1 min-w-0 px-3 py-2.5 border border-slate-200 rounded-xl text-xs font-medium outline-none focus:ring-2 focus:ring-[#ff5600]/30 bg-white"
               placeholder="课程名称（如：钢琴一对一）" value="${course ? course.name || '' : ''}" required>
        <button type="button" class="m-course-remove text-slate-300 hover:text-rose-500 px-1.5 py-2 transition shrink-0" title="删除该课程">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </div>
      <div class="flex items-center gap-2">
        <div class="flex items-center gap-1 shrink-0 bg-white border border-slate-200 rounded-xl px-2 py-1">
          <button type="button" class="m-course-debt-toggle w-6 h-6 rounded-lg text-[10px] font-bold transition ${course && course.remainingLessons < 0 ? 'bg-rose-500 text-white' : 'bg-slate-100 text-slate-400'}" title="点一下切换欠课">${course && course.remainingLessons < 0 ? '欠' : '＋'}</button>
          <input type="number" min="0" class="m-course-lessons w-12 text-center border-0 outline-none text-xs font-bold ${course && course.remainingLessons < 0 ? 'text-rose-600' : 'text-[#fe4c02]'}"
                 placeholder="0" value="${course ? Math.abs(course.remainingLessons ?? 10) : 10}" required>
          <span class="m-course-unit text-slate-400 text-[10px]">${course && course.remainingLessons < 0 ? '欠课' : '课时'}</span>
        </div>
        <div class="flex items-center gap-1 shrink-0 bg-white border border-slate-200 rounded-xl px-2 py-1 ml-auto">
          <span class="text-slate-400 text-[10px]">¥</span>
          <input type="number" min="0" step="0.01" inputmode="decimal" class="m-course-price w-14 text-center border-0 outline-none text-xs font-bold text-emerald-700" placeholder="单价" value="${course && course.unitPrice > 0 ? course.unitPrice : ''}" aria-label="课程单价（元/节）">
          <span class="text-slate-400 text-[10px]">/节</span>
        </div>
      </div>
    `;

    row.querySelector('.m-course-remove').addEventListener('click', () => {
      const rows = container.querySelectorAll('.mobile-course-row');
      if (rows.length > 1) {
        row.remove();
      } else {
        showToast('至少保留一门课程');
      }
    });

    // 欠课切换：＋→欠（数值取负），欠→＋（恢复正数）
    const debtBtn = row.querySelector('.m-course-debt-toggle');
    const lessonsEl = row.querySelector('.m-course-lessons');
    const unitEl = row.querySelector('.m-course-unit');
    debtBtn.addEventListener('click', () => {
      const isDebt = debtBtn.textContent.trim() === '欠';
      if (isDebt) {
        debtBtn.textContent = '＋';
        debtBtn.className = 'm-course-debt-toggle w-6 h-6 rounded-lg text-[10px] font-bold transition bg-slate-100 text-slate-400';
        lessonsEl.className = 'm-course-lessons w-12 text-center border-0 outline-none text-xs font-bold text-[#fe4c02]';
        unitEl.textContent = '课时';
        lessonsEl.value = Math.abs(parseInt(lessonsEl.value, 10) || 0);
      } else {
        debtBtn.textContent = '欠';
        debtBtn.className = 'm-course-debt-toggle w-6 h-6 rounded-lg text-[10px] font-bold transition bg-rose-500 text-white';
        lessonsEl.className = 'm-course-lessons w-12 text-center border-0 outline-none text-xs font-bold text-rose-600';
        unitEl.textContent = '欠课';
        const v = parseInt(lessonsEl.value, 10) || 0;
        lessonsEl.value = v > 0 ? -v : v;
      }
    });

    container.appendChild(row);
  }

  function handleSaveMobileStudent(e) {
    e.preventDefault();
    const editIdEl = document.getElementById('editMobileStudentId');
    const editId = editIdEl ? editIdEl.value : '';
    const nameEl = document.getElementById('mobileStudentNameInput');
    const name = nameEl ? nameEl.value.trim() : '';
    const phoneEl = document.getElementById('mobileStudentPhoneInput');
    const phone = phoneEl ? phoneEl.value.trim() : '';
    const colorEl = document.getElementById('mobileStudentColorSelect');
    const colorTheme = colorEl ? colorEl.value : 'amber';
    // 关联老师（多选）
    const teacherIds = [...document.querySelectorAll('#mobileStudentTeacherChips .st-t-chip')].filter((c) => c.classList.contains('bg-[#111111]')).map((c) => c.getAttribute('data-tid'));

    if (!name) {
      showToast('请填写学员姓名');
      return;
    }

    const courses = [];
    document.querySelectorAll('#mobileStudentCoursesContainer .mobile-course-row').forEach((row, idx) => {
      const nameInput = row.querySelector('.m-course-name');
      const lessonsInput = row.querySelector('.m-course-lessons');
      const cName = nameInput ? nameInput.value.trim() : '';
      // 欠课模式下输入框存的是负值（切换按钮负责正负），直接取实际值
      const rawLessons = lessonsInput ? parseInt(lessonsInput.value, 10) : 0;
      const isDebtMode = row.querySelector('.m-course-debt-toggle').textContent.trim() === '欠';
      const cLessons = isNaN(rawLessons) ? 0 : (isDebtMode && rawLessons > 0 ? -rawLessons : rawLessons);
      const cPrice = parseFloat(row.querySelector('.m-course-price')?.value) || 0;
      if (!cName && idx > 0) return;
      courses.push({
        id: 'c_m_' + (editId || 'st') + '_' + idx + '_' + Date.now(),
        name: cName || '通用课程',
        remainingLessons: cLessons,
        unitPrice: cPrice,
      });
      // 现场输入的课程名自动收录进课程类型
      mAddCourseType(cName);
    });

    if (courses.length === 0) {
      showToast('请至少填写一门课程');
      return;
    }

    if (editId) {
      const idx = students.findIndex((s) => s.id === editId);
      if (idx !== -1) {
        // 编辑：沿用原课程 id，保证历史排课记录的引用不断；单价留空时沿用原值不清零
        const oldCourses = students[idx].courses || [];
        students[idx] = {
          ...students[idx],
          name,
          phone,
          colorTheme,
          teacherIds,
          courses: courses.map((c, i) => ({
            ...c,
            id: oldCourses[i] ? oldCourses[i].id : c.id,
            unitPrice: !(c.unitPrice > 0) && oldCourses[i] && oldCourses[i].unitPrice > 0 ? oldCourses[i].unitPrice : c.unitPrice,
          })),
        };
        showToast('学员信息已更新');
      }
    } else {
      students.push({
        id: 'st_' + Date.now(),
        name,
        phone,
        colorTheme,
        teacherIds,
        courses,
      });
      showToast('成功添加新学员！');
    }

    // 欠课账校准：编辑/新增学员后，负课时（欠课）同步进欠课账，财务页即时可见
    syncAllDebts();

    saveData();
    closeMobileStudentModal();
    renderMobileStudents();
    renderCalendar();
  }

  function handleDeleteMobileStudent() {
    const editIdEl = document.getElementById('editMobileStudentId');
    const editId = editIdEl ? editIdEl.value : '';
    if (!editId) return;

    if (confirm('确定要删除该学员吗？其所有排课记录也会被清理。')) {
      const victim = students.find((s) => s.id === editId);
      pushUndo(`删除学员 ${victim ? victim.name : ''}`);
      students = students.filter((s) => s.id !== editId);
      schedules = schedules.filter((sch) => sch.studentId !== editId);
      // 历史财务流水按原语义保留，不动 checkInLogs / debts
      saveData();
      closeMobileStudentModal();
      renderMobileStudents();
      renderCalendar();
      offerUndo('已删除学员记录', `删除学员 ${victim ? victim.name : ''}`);
    }
  }

  // 可访问性：Esc 键关闭最上层弹窗（等价于点右上角 ✕）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const openOverlays = Array.from(document.querySelectorAll('.fixed[id^="modal"]:not(.hidden)'));
    const top = openOverlays[openOverlays.length - 1];
    if (!top) return;
    const closeBtn = top.querySelector('[id^="btnClose"]');
    if (closeBtn) closeBtn.click();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMobileApp);
  } else {
    initMobileApp();
  }

  // 首页时间敏感数据（下一节/待消课）分钟级自动刷新：页面停留时数据不僵化
  setInterval(() => {
    if (document.getElementById('viewHome') && !document.getElementById('viewHome').classList.contains('hidden') && typeof renderMobileHome === 'function') {
      try { renderMobileHome(); } catch (e) { /* 忽略刷新异常 */ }
    }
  }, 60000);
})();

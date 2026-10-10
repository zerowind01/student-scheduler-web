/**
 * 学生排课工作台 - 核心逻辑 App Engine
 * 支持：多课程/多科目管理、双师共上机制、同课室/同老师/同学员多维冲突检测、同一时段多课程并排列显示、JS/JSON课表数据导入导出、拖拽排课
 */

(function () {
  'use strict';

  // ==========================================
  // 1. 全局状态 & 存储 Key
  // ==========================================
  const STORAGE_KEY_STUDENTS = 'edu_scheduler_students_v2';
  const STORAGE_KEY_SCHEDULES = 'edu_scheduler_schedules_v2';
  const STORAGE_KEY_TEACHERS = 'edu_scheduler_teachers_v2';
  const STORAGE_KEY_COURSE_TYPES = 'edu_scheduler_course_types_v2';
  const STORAGE_KEY_CHECKIN_LOGS = 'edu_scheduler_checkin_logs_v2';
  const STORAGE_KEY_DEBTS = 'edu_scheduler_debts_v2';

  // 学员主题色：2026-10 定稿色卡六色（键名是数据层约定不能改，渲染色已全端换新）
  const COLOR_THEMES = ['amber', 'emerald', 'sky', 'purple', 'rose', 'mint'];

  function getRandomColorTheme() {
    return COLOR_THEMES[Math.floor(Math.random() * COLOR_THEMES.length)];
  }

  let students = [];
  let schedules = [];
  let teachers = [];
  let courseTypes = [];   // 课程类型（如 钢琴/美术/乐理）
  let checkInLogs = [];   // 消课流水（财务核心）
  let debts = [];         // 学员欠课账 { id, studentId, courseName, amount(节) }
  let selectedTeacherFilter = 'all'; // 筛选老师：all 或 teacherId
  let currentWeekStart = getMonday(new Date()); // 当前视图对应的周一
  let calendarViewMode = 'week';      // 'week' | 'month'（月历总览）
  let monthSelectedDate = null;       // 月视图当前选中日（对齐手机版：点格子选中，右栏出当日安排）
  let currentMonth = new Date();      // 月视图显示的月份（取该月任一日期）
  let draggedStudent = null; // 当前正在拖拽的学生
  let draggedSchedule = null; // 当前正在拖拽调整的现有课程
  let selectedStudentForTap = null; // 移动端/触摸屏点击选中的学员（点击排课模式）
  let currentFilter = 'unscheduled'; // 默认仅显示未排课学生（待排课）
  let searchQuery = ''; // 学生搜索关键字

  // 同步合并：远端 teachers 覆盖本地时保留本地 accessPin（PIN 不同步下发）
  function mergeTeachersKeepPin(remoteTeachers, localTeachers) {
    const pinById = new Map((localTeachers || []).filter((t) => t.accessPin).map((t) => [t.id, t.accessPin]));
    return (remoteTeachers || []).map((t) => (pinById.has(t.id) ? { ...t, accessPin: pinById.get(t.id) } : t));
  }

  function selectStudentForTap(student, cardElement) {
    document.querySelectorAll('.student-card').forEach((c) => c.classList.remove('lm-picked'));

    if (selectedStudentForTap && selectedStudentForTap.id === student.id) {
      clearStudentForTap();
      return;
    }

    selectedStudentForTap = student;
    if (cardElement) cardElement.classList.add('lm-picked');

    const banner = document.getElementById('mobileTapScheduleBanner');
    const nameEl = document.getElementById('tapStudentName');
    if (banner && nameEl) {
      nameEl.textContent = student.name;
      banner.classList.remove('hidden');
    }
  }

  function clearStudentForTap() {
    selectedStudentForTap = null;
    document.querySelectorAll('.student-card').forEach((c) => c.classList.remove('lm-picked'));
    const banner = document.getElementById('mobileTapScheduleBanner');
    if (banner) banner.classList.add('hidden');
  }

  // ==========================================
  // 2. 初始化与演示数据注入
  // ==========================================
  function openQrSyncModal() {
    const container = document.getElementById('qrcodeContainer');
    if (!container) return;
    container.innerHTML = '';

    const syncDataStr = JSON.stringify({ students, schedules, teachers, updatedAt: Date.now() });
    const encodedData = encodeURIComponent(syncDataStr);

    const baseUrl = `${location.protocol}//${location.host}${location.pathname.replace('index.html', '')}mobile.html`;
    const targetUrl = `${baseUrl}#${encodedData}`;

    if (window.QRCode) {
      new QRCode(container, {
        text: targetUrl,
        width: 180,
        height: 180,
        colorDark: '#1e293b',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.L,
      });
    } else {
      container.innerHTML = `<div class="p-3 text-xs text-rose-500 font-bold">二维码组件加载中，请复制同步码</div>`;
    }

    showModal('modalQrSync');
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
          // 欠课账校准：负课时（欠课）同步进欠课账
          syncAllDebts();
          saveDataLocalOnly();
          showToast('⚡ 扫码同步成功！已载入最新课表数据！', 'qrcode');
          history.replaceState(null, '', location.pathname);
        }
      }
    } catch (e) {
      console.warn('URL sync error:', e);
    }
  }

  function initApp() {
    checkUrlSyncData();
    loadData();
    applyLmFixtures();
    syncScheduleColors();
    setupEventListeners();
    bindPageNav();
    renderTeacherOptions();
    renderCourseTypesDatalist();
    renderWeekHeader();
    renderStudentList();
    renderCalendarGrid();
    updateStats();
    pullFromCloudSync(true);
    // 新设备无同步码 → 弹出创建/登录引导（最高层，处理完才能用）
    if (!schoolSyncKey && !LM_FIXTURE_MODE) openSyncGate();
    renderLmFixtureToggle();
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

  function normalizeStudent(st) {
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

  // ============ 教务扩展：数据迁移与规范化 ============
  // 排课状态：web 版语义（排课即扣课时）：
  //   scheduled  待上课（课时已在排课时扣除）
  //   completed  已消课（签到，记入财务流水）
  //   studentLeave 学员请假（退还排课时扣掉的课时）
  const SCHEDULE_STATUS = { SCHEDULED: 'scheduled', COMPLETED: 'completed', STUDENT_LEAVE: 'student_leave' };

  function normalizeSchedule(sch) {
    if (!sch.status) sch.status = SCHEDULE_STATUS.SCHEDULED;
    return sch;
  }

  // 系列课迁移：给没有 seriesId 的排课回溯分组。
  // 规则：同 学员+课程+开始时间+任课老师 的两节课，日期间隔恰为 7 或 14 天 → 同系列；
  // 用并查集合并，能自然处理"中途改过时间断了链"的情况（断链的各自成组）。
  function migrateSeriesIds() {
    const parent = new Map();
    const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    const byKey = new Map();
    schedules.forEach((s) => {
      if (s.seriesId) return; // 已有系列的不动
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

  // 与 sch 同一系列、且发生在 sch 之后（含同日更晚开始）的排课
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
  // 维度：同一学员 / 同一任课老师 / 同一课室；excludeIds 里的课（本系列正在一起平移的）互相不算冲突
  function seriesShiftConflict(self, targetDate, startTime, durationMinutes, teacherId, room, excludeIds) {
    const start = minutesOfDay(startTime);
    const end = start + (durationMinutes || 45);
    return schedules.some((o) => {
      if (o.id === self.id || excludeIds.has(o.id)) return false;
      if (o.date !== targetDate) return false;
      if (o.status && o.status !== SCHEDULE_STATUS.SCHEDULED) return false;
      const os = minutesOfDay(o.startTime);
      const oe = os + (o.durationMinutes || 45);
      if (start >= oe || end <= os) return false; // 时间不重叠
      const sameStudent = o.studentId === self.studentId;
      const sameTeacher = !!teacherId && !!o.teacherId && o.teacherId === teacherId;
      const sameRoom = !!room && !!o.room && o.room === room;
      return sameStudent || sameTeacher || sameRoom;
    });
  }

  // 系列批量修改提示文案：跟着日期框实时变化，让"星期几会变"这件事看得见
  function updateSeriesHint() {
    const block = document.getElementById('seriesEditBlock');
    const hint = document.getElementById('seriesEditHint');
    if (!block || !hint || block.classList.contains('hidden')) return;
    const idEl = document.getElementById('inputScheduleId');
    const dateEl = document.getElementById('inputCourseDate');
    const sch = schedules.find((s) => s.id === (idEl ? idEl.value : ''));
    const count = sch ? seriesLaterSiblings(sch).filter((s) => s.status === SCHEDULE_STATUS.SCHEDULED).length : 0;
    let shift = 0;
    if (sch && dateEl && dateEl.value) shift = diffDays(sch.date, dateEl.value);
    const base = `勾选后同步修改本节及之后的 ${count} 节课（日期 / 开始时间 / 时长 / 课室 / 老师 / 课程）`;
    hint.textContent = shift !== 0
      ? `${base}，日期整体平移 ${shift > 0 ? '+' : ''}${shift} 天：${weekdayLabel(sch.date)} → ${weekdayLabel(dateEl.value)}`
      : `${base}，日期保持不变`;
  }

  // 旧数据迁移：students[].courses[] (name+remainingLessons) 语义不变，
  // 补充单价 unitPrice（默认 0 = 未设置）与课程类型标记
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

  // 消课流水规范字段：
  // { id, scheduleId, studentId, studentName, courseName, deductedLessons, paymentAmount, checkInTime, remarks }
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
  function openStudentDetail(studentId) {
    const student = students.find((s) => s.id === studentId);
    if (!student) return;
    normalizeStudent(student);

    const titleEl = document.getElementById('studentDetailTitle');
    if (titleEl) titleEl.textContent = `${student.name} · 学员详情`;
    const body = document.getElementById('studentDetailBody');
    if (!body) return;

    const themeColor = getThemeBadgeStyle(student.colorTheme || 'amber');
    const studentDebts = getStudentDebts(student.id);
    const logs = checkInLogs
      .filter((l) => l.studentId === student.id)
      .slice()
      .sort((a, b) => (b.checkInTime || '').localeCompare(a.checkInTime || ''))
      .slice(0, 30);
    const leaves = schedules
      .filter((s) => s.studentId === student.id && s.status === SCHEDULE_STATUS.STUDENT_LEAVE)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, 10);

    const totalLessons = student.courses.reduce((acc, c) => acc + c.remainingLessons, 0);
    const totalOwed = studentDebts.reduce((acc, d) => acc + d.amount, 0);

    body.innerHTML = `
      <div class="flex items-center gap-3 lm-soft rounded-xl p-3">
        <div class="w-11 h-11 rounded-full ${themeColor.bg} ${themeColor.text} flex items-center justify-center font-bold text-base">${student.name.substring(0, 1)}</div>
        <div class="flex-1">
          <div class="font-bold text-sm lm-t1">${student.name}</div>
          <div class="text-[11px] lm-t2">${student.phone ? '<i class="fa-solid fa-phone text-[9px]"></i> ' + student.phone : '未填电话'}</div>
        </div>
        <div class="text-right">
          <div class="text-lg font-black ${totalOwed > 0 ? 'text-rose-600' : 'lm-t1'}">${totalLessons}</div>
          <div class="text-[9px] lm-t3 font-bold">总剩课时${totalOwed > 0 ? ' · 欠' + totalOwed + '节' : ''}</div>
        </div>
      </div>

      <div>
        <div class="font-bold text-[11px] lm-t2 uppercase tracking-wider mb-1.5">课程与课时</div>
        <div class="space-y-1.5">
          ${student.courses.map((c) => {
            const isDebt = c.remainingLessons < 0;
            const isLow = !isDebt && c.remainingLessons <= 2;
            return `
            <div class="flex items-center justify-between bg-white border ${isDebt ? 'border-rose-200 bg-rose-50/40' : isLow ? 'border-[#ffd9c7]' : 'lm-hairline'} rounded-xl px-3 py-2">
              <div>
                <span class="font-bold lm-t1">${c.name}</span>
                ${isDebt ? '<span class="text-[9px] font-bold text-rose-600 bg-rose-100 px-1.5 py-0.5 rounded ml-1.5">欠课</span>' : isLow ? '<span class="text-[9px] font-bold px-1.5 py-0.5 rounded ml-1.5" style="background:#fef2f2;color:var(--lm-orange);">课时不足</span>' : ''}
              </div>
              <div class="flex items-center gap-3 text-[11px]">
                ${c.unitPrice > 0 ? `<span class="lm-t2">¥${c.unitPrice}/节</span>` : ''}
                <span class="font-black ${isDebt ? 'text-rose-600' : isLow ? 'lm-warn' : 'lm-t1'}">${c.remainingLessons} 课时</span>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>

      ${studentDebts.length ? `
      <div>
        <div class="font-bold text-[11px] text-rose-500 uppercase tracking-wider mb-1.5"><i class="fa-solid fa-triangle-exclamation"></i> 欠课账</div>
        <div class="space-y-1.5">
          ${studentDebts.map((d) => `
          <div class="flex items-center justify-between bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">
            <span class="font-bold lm-t1">${d.courseName}</span>
            <span class="font-black text-rose-600">欠 ${d.amount} 节</span>
          </div>`).join('')}
        </div>
      </div>` : ''}

      <div>
        <div class="font-bold text-[11px] lm-t2 uppercase tracking-wider mb-1.5"><i class="fa-solid fa-clock-rotate-left"></i> 消课记录（最近 ${logs.length} 条）</div>
        ${logs.length === 0 ? '<div class="text-[11px] lm-t3 py-3 text-center lm-soft rounded-xl">暂无消课记录</div>' : `
        <div class="space-y-1 max-h-56 overflow-y-auto custom-scrollbar">
          ${logs.map((l) => `
          <div class="flex items-center justify-between lm-soft px-3 py-2 rounded-lg">
            <div>
              <span class="font-bold lm-t1">${l.courseName}</span>
              ${l.teacherName ? `<span class="lm-t3 ml-1.5">${l.teacherName}</span>` : ''}
              ${l.remarks ? `<span class="lm-t2 ml-1">${l.remarks}</span>` : ''}
            </div>
            <div class="text-right shrink-0 ml-2">
              <div class="font-bold lm-t2">${l.deductedLessons}节${l.paymentAmount > 0 ? ' ¥' + l.paymentAmount.toFixed(0) : ''}</div>
              <div class="text-[9px] lm-t3">${(l.date || (l.checkInTime || '').slice(0, 10))}</div>
            </div>
          </div>`).join('')}
        </div>`}
      </div>

      ${leaves.length ? `
      <div>
        <div class="font-bold text-[11px] lm-t2 uppercase tracking-wider mb-1.5"><i class="fa-solid fa-umbrella-beach"></i> 请假记录（最近 ${leaves.length} 次）</div>
        <div class="space-y-1">
          ${leaves.map((s) => `
          <div class="flex items-center justify-between lm-soft px-3 py-1.5 rounded-lg text-[11px]">
            <span class="lm-t2">${s.date} ${s.startTime || ''}</span>
            <span class="lm-t2">${s.subject || ''}</span>
          </div>`).join('')}
        </div>
      </div>` : ''}
    `;

    showModal('modalStudentDetail');
  }

  // 欠课账：按 学员+课程名 归并累加（与 App 的 studentCourseTypeDebts 语义对齐）
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
  // （手动填负课时/消课扣成负数后调用，保证财务页欠课名单与课时一致）
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

  // 全量校准：把所有负课时学员的欠课账与课时对齐（数据加载后调用，兼容历史手动填的负课时）
  function syncAllDebts() {
    students.forEach((st) => {
      (st.courses || []).forEach((c) => syncDebtForCourse(st.id, c.name, c.remainingLessons));
    });
  }

  // 归还欠课（新购/充值时自动抵扣）：返回实际抵扣掉的节数
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

    // 课程类型
    if (rawCourseTypes !== null) {
      try { courseTypes = JSON.parse(rawCourseTypes); } catch (e) { courseTypes = []; }
    }
    ensureDefaultCourseTypes();

    // 消课流水 + 欠课账
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

    // 欠课账校准：负课时（手动填的欠课）同步进欠课账，保证财务页欠课名单完整
    syncAllDebts();

    saveDataLocalOnly();
  }

  // ==========================================
  // 云端实时跨设备同步引擎
  // ==========================================
  let schoolSyncKey = localStorage.getItem('edu_scheduler_school_key') || '';
  // 本页实例标识：BroadcastChannel 会把消息投递给同上下文里的其他 channel 对象
  // （只排除发送者本身，而 push 每次都 new 一个新对象），所以自己的广播会回声到自己的
  // onmessage → 触发一次多余的 refreshView，把正在播的按钮动效冲掉。加个来源标识过滤掉。
  const LM_CTX = 'ctx-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
  let isPushingToCloud = false;
  let isPullingFromCloud = false;
  let cloudSyncFailedOnce = false; // 只提醒一次，避免弹窗轰炸

  // 云端同步改走同源 /api/sync 代理（凭据由服务端函数持有，前端不再暴露 token）
  // 服务端实现见 netlify/functions/sync.js —— 读取 UPSTASH_REST_URL / UPSTASH_REST_TOKEN 环境变量
  const CLOUD_SYNC_ENDPOINT = '/api/sync';

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
        showToast('⚠️ 云同步不可用：当前通过 file:// 直接打开或网络异常，数据仅保存在本机。请通过部署后的网址访问以启用跨设备同步。', 'cloud-slash');
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
          // 只有远端确实更新才覆盖本地，防止轮询把刚做的本地改动回滚
          if (force || remoteData.updatedAt > localTime) {
            students = remoteData.students || [];
            schedules = (remoteData.schedules || []).map(normalizeSchedule);
            migrateSeriesIds();
            teachers = mergeTeachersKeepPin(remoteData.teachers, teachers);
            courseTypes = remoteData.courseTypes || courseTypes;
            checkInLogs = remoteData.checkInLogs || [];
            debts = (remoteData.debts || []).map(normalizeDebt);

            // 欠课账校准：负课时（欠课）同步进欠课账
            syncAllDebts();

            localStorage.setItem('edu_scheduler_last_sync_time', String(remoteData.updatedAt));
            saveDataLocalOnly();
            renderTeacherOptions();
            refreshView();

            if (!force) {
              showToast('⚡ 已实时同步最新课表数据！', 'bolt');
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
        // 自己发的广播不处理：数据本就在内存里，再走一遍全量重渲染只会打断进行中的动效
        if (event.data && event.data.__ctx === LM_CTX) return;
        if (event.data && event.data.updatedAt) {
          students = event.data.students || students;
          schedules = (event.data.schedules || schedules).map(normalizeSchedule);
          migrateSeriesIds();
          teachers = mergeTeachersKeepPin(event.data.teachers, teachers);
          courseTypes = event.data.courseTypes || courseTypes;
          checkInLogs = event.data.checkInLogs || [];
          debts = (event.data.debts || []).map(normalizeDebt);
          saveDataLocalOnly();
          renderTeacherOptions();
          refreshView();
        }
      };
    } catch (e) {}
  }

  setInterval(pullFromCloudSync, 2000);

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

  function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
  }

  function safeBind(id, eventName, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(eventName, handler);
  }

  // ==========================================
  // 教务核心操作（移植自 Teacher-manager App）
  // ==========================================

  // 从排课推导扣费节数（与排课时的扣课逻辑一致：1小时=1节，最低1节）
  function getLessonCost(schedule) {
    return Math.max(1, Math.round((schedule.durationMinutes || 60) / 60));
  }

  // 消课（签到确认）：状态→completed，记财务流水；课时不足部分记欠课账
  // 返回布尔值供按钮三态动画判断走向；
  // opts.skipRefresh / opts.silentToast：给「看板一键消课」用，把重渲染推迟到成功动画播完之后，
  // 否则按钮 DOM 会在洒勾的瞬间被列表重渲染替换掉，动画白做。
  function executeCheckIn(scheduleId, remarks, opts) {
    const o = opts || {};
    const sch = schedules.find((s) => s.id === scheduleId);
    if (!sch) return false;
    if (sch.status === SCHEDULE_STATUS.COMPLETED) {
      showToast('该课程已消课，无需重复操作', 'circle-info');
      return false;
    }
    if (sch.status === SCHEDULE_STATUS.STUDENT_LEAVE) {
      showToast('该课程为请假状态，请先撤销请假', 'circle-info');
      return false;
    }

    // 快照必须在任何数据变更前拍（下面会改课时、写流水、可能转欠课）
    pushUndo(`消课 ${sch.studentName}`);

    const student = students.find((st) => st.id === sch.studentId);
    const deducted = getLessonCost(sch);
    let payment = 0;
    let finalRemarks = remarks || '';

    if (student) {
      const course = (student.courses || []).find((c) => c.id === sch.courseId || c.name === sch.subject);
      if (course) {
        if (course.unitPrice > 0) {
          payment = deducted * course.unitPrice;
        }
        // 消课时扣除课时（App 语义：排课不扣，消课才扣）
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
    saveData();
    if (!o.skipRefresh) refreshView();
    if (!o.silentToast) offerUndo(`✅ 已消课：${sch.studentName} · ${sch.subject}（${deducted}节）`, 'circle-check', `消课 ${sch.studentName}`);
    if (window.uiAnim) window.uiAnim.flashSchedule(sch.id);
    return true;
  }

  // 学员请假（不限课程时间，已消课的也可改为请假）
  // App 语义：请假本不扣课时；只有已消课改请假时，才把消课扣掉的课时退回
  function markStudentLeave(scheduleId) {
    const sch = schedules.find((s) => s.id === scheduleId);
    if (!sch) return;
    if (sch.status === SCHEDULE_STATUS.STUDENT_LEAVE) {
      showToast('该课程已是请假状态', 'circle-info');
      return;
    }
    pushUndo(`请假 ${sch.studentName}`);
    let leaveMsg = '';

    if (sch.status === SCHEDULE_STATUS.COMPLETED) {
      // 已消课 → 改为请假：删除消课流水（回滚财务）+ 退还消课时扣掉的课时
      checkInLogs = checkInLogs.filter((l) => l.scheduleId !== sch.id);
      const student = students.find((st) => st.id === sch.studentId);
      const deducted = getLessonCost(sch);
      if (student) {
        const course = (student.courses || []).find((c) => c.id === sch.courseId || c.name === sch.subject);
        if (course) course.remainingLessons += deducted;
      }
      leaveMsg = `🏖️ 已消课的课程改为请假，退还 ${deducted} 节课时`;
    } else {
      leaveMsg = `🏖️ 已为 ${sch.studentName} 办理请假`;
    }

    sch.status = SCHEDULE_STATUS.STUDENT_LEAVE;
    saveData();
    refreshView();
    offerUndo(leaveMsg, 'circle-check', `请假 ${sch.studentName}`);
    if (window.uiAnim) window.uiAnim.flashSchedule(sch.id);
  }

  // 撤销状态（completed/student_leave → scheduled）
  function revertScheduleStatus(scheduleId) {
    const sch = schedules.find((s) => s.id === scheduleId);
    if (!sch || sch.status === SCHEDULE_STATUS.SCHEDULED) return;

    pushUndo(`还原 ${sch.studentName} 的课`);

    if (sch.status === SCHEDULE_STATUS.COMPLETED) {
      // 撤销消课：删流水 + 退还消课扣掉的课时
      checkInLogs = checkInLogs.filter((l) => l.scheduleId !== sch.id);
      const student = students.find((st) => st.id === sch.studentId);
      const deducted = getLessonCost(sch);
      if (student) {
        const course = (student.courses || []).find((c) => c.id === sch.courseId || c.name === sch.subject);
        if (course) course.remainingLessons += deducted;
      }
    }
    // 请假撤销：App 语义下请假本不扣课时，直接还原状态即可

    sch.status = SCHEDULE_STATUS.SCHEDULED;
    saveData();
    refreshView();
    offerUndo('已撤销状态，还原为待上课', 'rotate-left', `还原 ${sch.studentName} 的课`);
    if (window.uiAnim) window.uiAnim.flashSchedule(sch.id);
  }

  // 删除排课时同步清理流水
  function handleDeleteScheduleWithCleanup(schId) {
    const sch = schedules.find((s) => s.id === schId);
    checkInLogs = checkInLogs.filter((l) => l.scheduleId !== schId);
    schedules = schedules.filter((s) => s.id !== schId);
    if (sch && sch.status === SCHEDULE_STATUS.SCHEDULED) {
      // 待上课的课程删除时退还课时（保持"课时只随消课消耗"的一致性）
      const student = students.find((st) => st.id === sch.studentId);
      if (student) {
        const course = (student.courses || []).find((c) => c.id === sch.courseId || c.name === sch.subject);
        if (course) course.remainingLessons += getLessonCost(sch);
      }
    }
    saveData();
  }

  // 新购/充值课时包（自动抵扣同课程名欠课）
  function purchaseCoursePack(studentId, courseName, lessons, unitPrice) {
    const student = students.find((st) => st.id === studentId);
    if (!student) return;
    normalizeStudent(student);
    migrateStudentCourses(student);

    let remaining = lessons;
    let remark = '';
    const repaid = repayDebt(studentId, courseName, lessons);
    if (repaid > 0) {
      remaining -= repaid;
      remark = ` (自动抵扣欠课 ${repaid} 节)`;
    }

    const existing = (student.courses || []).find((c) => c.name === courseName);
    if (existing) {
      existing.remainingLessons += remaining;
      if (unitPrice > 0) existing.unitPrice = unitPrice;
    } else {
      student.courses.push({
        id: 'course_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        name: courseName,
        remainingLessons: remaining,
        unitPrice,
      });
    }

    saveData();
    refreshView();
    showToast(`💳 ${student.name} 充值「${courseName}」${lessons} 节${remark}`, 'circle-check');
  }

  // ==========================================
  // 3. 安全防崩溃事件监听配置
  // ==========================================
  // 排课日期改动时刷新系列批量修改的提示（事件委托，避免重复绑定）
  function bindSeriesHintUpdates() {
    ['input', 'change'].forEach((evt) => {
      document.addEventListener(evt, (e) => {
        if (e.target && e.target.id === 'inputCourseDate') updateSeriesHint();
      });
    });
  }

  function setupEventListeners() {
    bindSeriesHintUpdates();
    // 翻周方向感：dirX = -1 上一周 / 1 下一周 / 0 回今天
    function weekSlide(dirX) {
      if (!window.uiAnim || calendarViewMode === 'month') return;
      const body = document.getElementById('calendarBodyScroll');
      if (body) window.uiAnim.viewIn(body, dirX);
    }

    safeBind('btnPrevWeek', 'click', () => {
      currentWeekStart = addDays(currentWeekStart, -7);
      refreshView();
      weekSlide(-1);
    });

    safeBind('btnNextWeek', 'click', () => {
      currentWeekStart = addDays(currentWeekStart, 7);
      refreshView();
      weekSlide(1);
    });

    safeBind('btnToday', 'click', () => {
      currentWeekStart = getMonday(new Date());
      if (calendarViewMode === 'month') currentMonth = new Date();
      refreshView();
      weekSlide(0);
    });

    // 月历总览切换
    safeBind('btnMonthView', 'click', () => {
      if (calendarViewMode === 'month') {
        setCalendarViewMode('week');
      } else {
        currentMonth = new Date(currentWeekStart);
        setCalendarViewMode('month');
      }
    });
    safeBind('btnMonthPrev', 'click', () => { currentMonth.setMonth(currentMonth.getMonth() - 1); renderMonthView(); });
    safeBind('btnMonthNext', 'click', () => { currentMonth.setMonth(currentMonth.getMonth() + 1); renderMonthView(); });
    safeBind('btnMonthToday', 'click', () => { currentMonth = new Date(); monthSelectedDate = formatDate(getToday()); renderMonthView(); });

    // 月视图右栏：点课卡弹操作菜单；「查看周课表」跳到选中日所在周
    const monthDayList = document.getElementById('monthDayList');
    if (monthDayList) monthDayList.onclick = (e) => {
      const item = e.target.closest('[data-month-sch]');
      if (!item) return;
      const sch = schedules.find((x) => x.id === item.getAttribute('data-month-sch'));
      if (sch) openScheduleActionMenu(sch);
    };
    safeBind('btnMonthGotoWeek', 'click', () => {
      const sel = monthSelectedDate ? new Date(monthSelectedDate + 'T00:00:00') : new Date();
      currentWeekStart = getMonday(sel);
      setCalendarViewMode('week');
      refreshView();
    });

    safeBind('filterTeacherSelect', 'change', (e) => {
      selectedTeacherFilter = e.target.value;
      renderCalendarGrid();
      updateStats();
    });

    safeBind('btnQrSync', 'click', openQrSyncModal);
    safeBind('btnCloseQrModal', 'click', () => hideModal('modalQrSync'));

    safeBind('btnCloudSync', 'click', () => {
      const el = document.getElementById('inputSyncKey');
      if (el) el.value = schoolSyncKey;
      showModal('modalSyncKey');
    });

    safeBind('btnCloseSyncModal', 'click', () => hideModal('modalSyncKey'));
    safeBind('btnCancelSyncModal', 'click', () => hideModal('modalSyncKey'));
    safeBind('btnSaveSyncKey', 'click', async () => {
      const el = document.getElementById('inputSyncKey');
      // 与门禁同一套大小写容错：保留原文，只有原文查不到、大写能查到时才退回大写
      const val = await normalizeSyncKeyInput(el ? el.value : '');
      if (!val) { showToast('请输入同步码', 'circle-info'); return; }
      schoolSyncKey = val;
      localStorage.setItem('edu_scheduler_school_key', val);
      hideModal('modalSyncKey');
      pullFromCloudSync(true).then(() => {
        showToast(`已开启云同步！同步码: ${val}`, 'cloud-arrow-up');
      });
    });

    safeBind('btnCopyQuickSyncCode', 'click', () => {
      const payloadStr = JSON.stringify({ students, schedules, teachers, updatedAt: Date.now() });
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(payloadStr).then(() => {
          showToast('已复制排课同步代码！通过微信发给手机粘贴即可', 'copy');
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
          renderTeacherOptions();
          refreshView();
          hideModal('modalSyncKey');
          showToast('⚡ 排课代码解析成功，已同步最新界面！', 'check');
        } else {
          alert('无效的同步代码，请重新复制粘贴！');
        }
      } catch (e) {
        alert('解析同步代码失败，请确认剪贴板内容是否完整！');
      }
    });

    safeBind('btnManageTeachers', 'click', openTeacherModal);
    safeBind('btnCloseTeacherModal', 'click', closeTeacherModal);
    safeBind('formAddTeacher', 'submit', handleAddTeacher);

    safeBind('searchStudentInput', 'input', (e) => {
      searchQuery = e.target.value.trim().toLowerCase();
      renderStudentList();
    });

    safeBind('studentTeacherFilter', 'change', renderStudentList);
    safeBind('studentCourseFilter', 'change', renderStudentList);

    document.querySelectorAll('.filter-student-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.filter-student-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.filter-student-btn').forEach((b) => b.classList.add('lm-t2'));
        e.target.classList.add('active');
        e.target.classList.remove('lm-t2');
        currentFilter = e.target.getAttribute('data-filter');
        renderStudentList();
      });
    });

    safeBind('btnNewStudent', 'click', () => openStudentModal());
    safeBind('btnCloseStudentModal', 'click', closeStudentModal);
    safeBind('btnCancelStudentModal', 'click', closeStudentModal);
    safeBind('formStudent', 'submit', handleSaveStudent);
    safeBind('btnDeleteStudent', 'click', handleDeleteStudent);
    safeBind('btnAddStudentCourseRow', 'click', () => addCourseRowToStudentModal());

    safeBind('btnCloseScheduleModal', 'click', closeScheduleModal);
    safeBind('btnCancelScheduleModal', 'click', closeScheduleModal);
    safeBind('formSchedule', 'submit', handleSaveSchedule);
    safeBind('btnDeleteSchedule', 'click', handleDeleteSchedule);

    // 重复排课选择联动
    safeBind('selectRepeatRule', 'change', (e) => {
      const endWrap = document.getElementById('repeatEndDateWrap');
      const hint = document.getElementById('repeatHint');
      const on = e.target.value !== 'none';
      if (endWrap) endWrap.classList.toggle('hidden', !on);
      if (hint) hint.classList.toggle('hidden', !on);
    });

    // 学员详情弹窗
    safeBind('btnCloseStudentDetail', 'click', () => hideModal('modalStudentDetail'));

    safeBind('btnImport', 'click', openImportModal);
    safeBind('btnCloseImportModal', 'click', closeImportModal);
    safeBind('btnCancelImportModal', 'click', closeImportModal);
    safeBind('btnSelectImportFile', 'click', () => {
      const el = document.getElementById('importFileInput');
      if (el) el.click();
    });
    safeBind('importFileInput', 'change', handleImportFileChange);
    safeBind('btnConfirmImport', 'click', handleConfirmImport);

    safeBind('btnClearAllData', 'click', () => {
      if (confirm('确定要清空当前所有学员与排课记录，开启全新的空白课表吗？')) {
        students = [];
        schedules = [];
        saveData();
        renderTeacherOptions();
        refreshView();
        showToast('已清空全部学员和排课数据！', 'trash-can');
      }
    });

    safeBind('btnResetData', 'click', () => {
      if (confirm('确定要恢复为演示数据吗？当前保存的数据将被重置。')) {
        localStorage.clear();
        loadData();
        renderTeacherOptions();
        refreshView();
        showToast('演示数据已成功重置！', 'check');
      }
    });

    safeBind('btnExport', 'click', exportScheduleData);
    safeBind('btnCancelTapSchedule', 'click', clearStudentForTap);

    const sidebar = document.getElementById('sidebarStudent');
    const btnBatchSchedule = document.getElementById('btnBatchSchedule');
    const batchBackdrop = document.getElementById('batchSidebarBackdrop');

    function collapseSidebar() {
      if (sidebar) {
        sidebar.classList.add('hidden');
        sidebar.classList.remove('flex');
      }
      if (batchBackdrop) batchBackdrop.classList.add('hidden');
    }

    function expandSidebar() {
      if (sidebar) {
        sidebar.classList.remove('hidden');
        sidebar.classList.add('flex');
      }
      if (batchBackdrop) batchBackdrop.classList.remove('hidden');
    }

    if (btnBatchSchedule) btnBatchSchedule.addEventListener('click', () => {
      if (sidebar && !sidebar.classList.contains('hidden')) {
        collapseSidebar();
      } else {
        expandSidebar();
      }
    });
    safeBind('btnCloseBatchSidebar', 'click', collapseSidebar);
    if (batchBackdrop) batchBackdrop.addEventListener('click', collapseSidebar);
  }

  function refreshView() {
    renderWeekHeader();
    renderStudentList();
    renderCalendarGrid();
    if (calendarViewMode === 'month') renderMonthView();
    updateStats();
    renderPageStudents();
    renderPageFinance();
    updateDebtBadges();
    // 看板可见时才重渲染：消课后「今日时间轴」的行状态要跟着变。
    // 之前这里漏了，导致在看板一键消课后按钮复位成「消课」而不是「已消课」。
    const dashPage = document.getElementById('pageDashboard');
    if (dashPage && !dashPage.classList.contains('hidden')) renderDashboard();
  }

  // ==========================================
  // 9.5 月历总览视图（圆点标课）
  // ==========================================
  function setCalendarViewMode(mode) {
    calendarViewMode = mode;
    const monthWrap = document.getElementById('monthViewWrap');
    const weekHeader = document.getElementById('weekHeaderRow');
    const weekBody = document.getElementById('calendarBodyScroll');
    const btnMonth = document.getElementById('btnMonthView');
    const isMonth = mode === 'month';
    if (monthWrap) { monthWrap.classList.toggle('hidden', !isMonth); monthWrap.classList.toggle('flex', isMonth); }
    if (weekHeader) weekHeader.classList.toggle('hidden', isMonth);
    if (weekBody) weekBody.classList.toggle('hidden', isMonth);
    const batchBtn = document.getElementById('btnBatchSchedule');
    if (batchBtn) batchBtn.classList.toggle('hidden', isMonth);
    if (btnMonth) {
      btnMonth.classList.toggle('bg-white', isMonth);
      btnMonth.classList.toggle('shadow-2xs', isMonth);
      btnMonth.classList.toggle('text-[#44403c]', isMonth);
    }
    if (isMonth) {
      renderMonthView();
      if (window.uiAnim) {
        window.uiAnim.viewIn(monthWrap);
        const grid = document.getElementById('monthViewGrid');
        if (grid) window.uiAnim.cardsStagger(grid, '#monthViewGrid > *');
      }
    } else if (window.uiAnim) {
      // 从月视图切回周视图时给周视图一个轻量进场，避免硬切
      const weekBody = document.getElementById('calendarBodyScroll');
      if (weekBody) window.uiAnim.viewIn(weekBody);
    }
  }

  function renderMonthView() {
    const wrap = document.getElementById('monthViewWrap');
    if (!wrap || wrap.classList.contains('hidden')) return;
    const grid = document.getElementById('monthViewGrid');
    const titleEl = document.getElementById('monthViewTitle');
    if (!grid) return;

    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    if (titleEl) titleEl.textContent = `${year}年${month + 1}月`;

    // 按周一起排：本月1号所在周的周一
    const first = new Date(year, month, 1);
    const cursor0 = getMonday(first);
    // 覆盖到本月最后一天，并补足整周
    const last = new Date(year, month + 1, 0);
    const spanDays = Math.round((last - cursor0) / 86400000) + 1;
    const totalCells = Math.ceil(spanDays / 7) * 7;

    const todayStr = formatDate(new Date());
    if (!monthSelectedDate) monthSelectedDate = todayStr;
    const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

    // 每天的课程（按老师筛选；含请假课——列表要显示请假标签，圆点才排除）
    const shown = selectedTeacherFilter === 'all' ? schedules : schedules.filter((s) => s.teacherId === selectedTeacherFilter || s.assistantTeacherId === selectedTeacherFilter);
    const byDate = new Map();
    shown.forEach((s) => {
      if (!byDate.has(s.date)) byDate.set(s.date, []);
      byDate.get(s.date).push(s);
    });

    // 学员主题色圆点（与手机版同款：前 3 节去重，请假课不计）
    // 学员主题色圆点：色卡色的深化版（5px 小点在白底上必须够深才可见，底色本身太浅）
    const CAL_DOT_COLORS = { amber: '#D9985F', emerald: '#7E9271', sky: '#4E93A8', purple: '#6F7C6C', rose: '#D08168', mint: '#7FA495' };

    grid.innerHTML = '';
    for (let i = 0; i < totalCells; i++) {
      const d = addDays(cursor0, i);
      const dateStr = formatDate(d);
      const inMonth = d.getMonth() === month;
      const isToday = dateStr === todayStr;
      const isSel = dateStr === monthSelectedDate;
      const dayLessons = byDate.get(dateStr) || [];

      const themes = [];
      dayLessons.forEach((s) => {
        if (s.status === SCHEDULE_STATUS.STUDENT_LEAVE) return;
        const t = resolveScheduleTheme(s);
        if (themes.length < 3 && !themes.includes(t)) themes.push(t);
      });

      const cell = document.createElement(inMonth ? 'button' : 'div');
      if (inMonth) cell.type = 'button';
      // 表格线格子：暖发丝内框（末列去右边线、末行去下边线，避免与外框叠加）
      const isLastCol = i % 7 === 6;
      const isLastRow = i >= totalCells - 7;
      cell.className = 'flex flex-col items-center pt-1.5 pb-1 transition select-none border-[#efe9e0] ' +
        (isLastCol ? '' : 'border-r ') +
        (isLastRow ? '' : 'border-b ') +
        (inMonth ? 'cursor-pointer hover:bg-[#faf8f3] ' : '') +
        (isSel ? ' bg-[#faf8f3]' : '') +
        (inMonth ? '' : ' opacity-30');

      // 数字三态：选中=炭黑圆底白字；今天=橙字+橙描边圈；普通=炭黑
      let numCls;
      if (isSel) numCls = 'background:#111111;color:#ffffff;font-weight:800';
      else if (isToday) numCls = 'color:#fe4c02;font-weight:800;box-shadow:inset 0 0 0 1.5px rgba(254,76,2,.55)';
      else numCls = inMonth ? 'color:#111111;font-weight:700' : 'color:#a8a29e;font-weight:500';

      cell.innerHTML = `
        <span class="w-8 h-8 rounded-full flex items-center justify-center text-[13.5px]" style="${numCls}">${d.getDate()}</span>
        <span class="flex items-center gap-[3px]" style="height:5px;margin-top:3px">${themes.map((t) => `<span class="rounded-full" style="width:5px;height:5px;background:${CAL_DOT_COLORS[t] || CAL_DOT_COLORS.amber}"></span>`).join('')}</span>
      `;

      if (inMonth) {
        cell.title = `${dateStr} ${WEEKDAY_LABELS[i % 7]} · ${dayLessons.length} 节课`;
        cell.addEventListener('click', () => {
          monthSelectedDate = dateStr;
          renderMonthView();
        });
      }
      grid.appendChild(cell);
    }

    renderMonthDayList(byDate, todayStr, WEEKDAY_LABELS);
  }

  // 月视图右栏：选中日的安排列表（卡片样式对齐手机版当日列表）
  function renderMonthDayList(byDate, todayStr, WEEKDAY_LABELS) {
    const titleEl = document.getElementById('monthDayTitle');
    const listEl = document.getElementById('monthDayList');
    if (!listEl) return;
    const selDate = new Date(monthSelectedDate + 'T00:00:00');
    const dayList = (byDate.get(monthSelectedDate) || []).slice()
      .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));

    if (titleEl) {
      const label = monthSelectedDate === todayStr ? '今日安排' : `${selDate.getMonth() + 1}月${selDate.getDate()}日 ${WEEKDAY_LABELS[(selDate.getDay() + 6) % 7]}`;
      titleEl.innerHTML = `<span class="inline-block rounded-full align-middle mr-1.5" style="width:6px;height:6px;background:#111111"></span>${label} · ${dayList.length} 节课`;
    }

    if (dayList.length === 0) {
      listEl.innerHTML = `
        <div class="text-center py-12 text-[#a8a29e]">
          <i class="fa-regular fa-calendar-check text-3xl mb-2 block"></i>
          <div class="text-sm">这一天还没有排课</div>
        </div>`;
      return;
    }

    listEl.innerHTML = dayList.map((s) => {
      const done = s.status === SCHEDULE_STATUS.COMPLETED;
      const leave = s.status === SCHEDULE_STATUS.STUDENT_LEAVE;
      const [h, m] = (s.startTime || '00:00').split(':').map(Number);
      const endMins = h * 60 + m + (s.durationMinutes || 45);
      const endHM = `${String(Math.floor(endMins / 60)).padStart(2, '0')}:${String(endMins % 60).padStart(2, '0')}`;
      const badge = done
        ? '<span class="text-[10px] font-bold px-2.5 py-1 rounded-full bg-[#f5f2ec] text-[#78716c] shrink-0">已消课</span>'
        : leave
          ? '<span class="text-[10px] font-bold px-2.5 py-1 rounded-full bg-rose-50 text-rose-500 shrink-0">请假</span>'
          : '<span class="text-[10px] font-bold px-2.5 py-1 rounded-full bg-[#111111] text-white shrink-0">待上课</span>';
      return `
      <button type="button" data-month-sch="${s.id}" class="w-full text-left bg-white border border-[#efe9e0] rounded-2xl p-3.5 flex items-center gap-3.5 hover:border-[#e3dbd0] transition">
        <div class="text-center shrink-0">
          <div class="text-base font-black text-[#111111]">${s.startTime}</div>
          <div class="text-[10px] lm-t3 mt-0.5">${endHM}</div>
        </div>
        <div class="w-px self-stretch bg-[#f2ece4]"></div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-bold text-[#111111] truncate">${s.studentName || ''} · ${s.subject || ''}</div>
          <div class="text-[11px] lm-t3 mt-1 truncate">${s.teacherName || ''} · ${s.room || '—'}</div>
        </div>
        ${badge}
      </button>`;
    }).join('');
  }

  // ==========================================
  // 分页导航（课表/学员/财务/设置）
  // ==========================================
  const PAGE_IDS = ['pageDashboard', 'pageSchedule', 'pageStudents', 'pageFinance', 'pageSettings'];

    // ---- 桌面侧栏选中滑块（动效对齐手机版：滑动+沿方向拉伸+过冲回弹） ----
    const navGliderD = document.getElementById('navGliderDesktop');
    // 实时跟随系统开关：会话中途改设置也要生效（原来只在加载时取一次快照）
    const rmQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let RM = rmQuery.matches;
    if (rmQuery.addEventListener) rmQuery.addEventListener('change', (e) => { RM = e.matches; });
    let gliderDLastTop = null;
    let gliderDAnim = null;
    function positionNavGliderD(animate) {
      if (!navGliderD) return;
      const island = navGliderD.parentElement;
      const active = island.querySelector('.nav-page-btn.active') || island.querySelector('.nav-page-btn');
      if (!active) return;
      const ir = island.getBoundingClientRect();
      const tr = active.getBoundingClientRect();
      const x = tr.left - ir.left;
      const w = tr.width;
      const toTop = tr.top - ir.top + 3;      // 色块高度比按钮缩小（上下各缩 3px）
      const toH = tr.height - 6;
      // 起点取「当前真实位置」（含进行中的动画）→ 连续快速切页时从眼前的位置继续，不会跳
      const curTop = navGliderD.getBoundingClientRect().top - ir.top;
      const dy = toTop - curTop;
      navGliderD.style.left = x + 'px';
      navGliderD.style.width = w + 'px';
      navGliderD.style.height = toH + 'px';
      // 直接落位（首次 / 无位移 / 窗口尺寸变化 / 用户要求减少动效）
      if (!animate || gliderDLastTop === null || Math.abs(dy) < 1 || RM) {
        navGliderD.style.transform = 'translateY(' + toTop + 'px)';
        gliderDLastTop = toTop;
        return;
      }
      const dir = dy > 0 ? 1 : -1;
      const stretch = Math.min(10, Math.abs(dy) * 0.22); // 拉长幅度收小：装饰性位移不该抢戏
      const k = (toH + stretch) / toH;
      // 中段：前缘先行 → 沿移动方向拉长（origin 设在后缘，拉伸只朝前进方向长）
      const midTop = curTop + dy * 0.5;
      const overTop = toTop + dir * 3; // 过冲收小到 3px
      navGliderD.style.transformOrigin = dir > 0 ? 'top center' : 'bottom center';
      navGliderD.style.transform = 'translateY(' + toTop + 'px)';
      if (gliderDAnim) gliderDAnim.cancel();
      gliderDAnim = navGliderD.animate(
        [
          { transform: 'translateY(' + curTop + 'px) scaleY(1)', offset: 0, easing: 'cubic-bezier(.45,0,.55,1)' },
          { transform: 'translateY(' + midTop + 'px) scaleY(' + k + ')', offset: 0.55, easing: 'cubic-bezier(.3,0,.2,1)' },
          { transform: 'translateY(' + overTop + 'px) scaleY(1)', offset: 0.82, easing: 'cubic-bezier(.34,1.56,.64,1)' },
          { transform: 'translateY(' + toTop + 'px) scaleY(1)', offset: 1 }
        ],
        { duration: 300, fill: 'both' }
      );
      gliderDLastTop = toTop;
    }
    window.addEventListener('resize', () => positionNavGliderD(false));
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => positionNavGliderD(false)).catch(() => {});
    }
    // 初始落位：HTML 默认激活项（课表）在首帧就摆好滑块，保证首次切换也有滑动动画
    requestAnimationFrame(() => positionNavGliderD(false));

  function switchPage(page) {
    PAGE_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', id !== 'page' + page.charAt(0).toUpperCase() + page.slice(1));
    });
    // 顶栏只在课表视图保留（品牌已整合进侧边栏；手机端不受影响）
    const topbar = document.getElementById('mainTopbar');
    if (topbar) topbar.classList.toggle('header-hide-desktop', page !== 'schedule');
    // 桌面侧栏按钮高亮：只切 active，配色统一由 css/desktop-theme.css 负责
    document.querySelectorAll('.nav-page-btn[data-page]').forEach((btn) => {
      const active = btn.getAttribute('data-page') === page;
      btn.classList.toggle('active', active);
      const icon = btn.querySelector('i.fa-solid');
      if (icon) icon.classList.toggle('is-active', active);
    });
    // 桌面侧栏滑块滑到新选中项（首帧自动直落）
    positionNavGliderD(true);

    // 手机底部导航高亮
    document.querySelectorAll('.mnav-btn').forEach((btn) => {
      const active = btn.getAttribute('data-page') === page;
      btn.classList.toggle('lm-t1', active);
      btn.classList.toggle('font-bold', active);
      btn.classList.toggle('lm-t2', !active);
    });

    // 切页不做整页淡入：切页是高频操作（tens/day），整页 transform+opacity 又正好撞在
    // 重渲染开销最大的时刻。翻周/翻月仍有方向感动画（见 weekSlide / renderMonthView）。
    // 课表页隐藏手机浮动栏（因为课表有自己的操作），其他页显示
    const bottomNav = document.getElementById('mobileBottomNav');
    if (bottomNav) bottomNav.classList.toggle('hidden', page === 'schedule');

    if (page === 'students') renderPageStudents();
    if (page === 'finance') renderPageFinance();
    if (page === 'dashboard') renderDashboard();
  }

  // ==========================================
  // 校务看板（电脑端首页）
  // ==========================================
  let dashWeekOffset = 0; // 0 = 本周，-1 = 上周

  function renderDashWeekBars() {
    const weekBars = document.getElementById('dashWeekBars');
    const weekSummary = document.getElementById('dashWeekSummary');
    if (!weekBars || !weekSummary) return;
    const names = ['一', '二', '三', '四', '五', '六', '日'];
    const start = addDays(currentWeekStart, dashWeekOffset * 7);
    const counts = [];
    let weekTotal = 0;
    for (let i = 0; i < 7; i++) {
      const dstr = formatDate(addDays(start, i));
      const n = checkInLogs.filter((l) => l.date === dstr).reduce((acc, l) => acc + (l.deductedLessons || 0), 0);
      counts.push(n);
      weekTotal += n;
    }
    const max = Math.max(...counts, 1);
    weekSummary.innerHTML = `${dashWeekOffset === 0 ? '本周' : '上周'}合计 <b class="text-[#44403c]">${weekTotal} 节</b>`;
    // 列高由 h-full 撑满 h-32 容器，柱子的百分比高度才有参照（否则高度塌成 0）
    weekBars.innerHTML = counts.map((n, i) => {
      const h = n > 0 ? Math.max(8, Math.round((n / max) * 100)) : 4;
      const active = n > 0;
      return `<div class="flex-1 h-full flex flex-col items-center gap-1.5">
        <div class="w-full flex-1 flex items-end">
          <div class="w-full rounded-md ${active ? 'bg-gradient-to-b from-[#ff8a3d] to-[#ff5600]' : 'bg-[#f0ebe2]'}" style="height:${h}%"></div>
        </div>
        <span class="text-[10px] font-bold ${active ? 'text-[#44403c]' : 'text-[#a8a29e]'}">${names[i]} ${n}</span>
      </div>`;
    }).join('');
  }

  function renderDashboard() {
    const todayStr = formatDate(new Date());
    const dateLabel = document.getElementById('dashDateLabel');
    if (dateLabel) {
      const week = ['日', '一', '二', '三', '四', '五', '六'][new Date().getDay()];
      dateLabel.textContent = `${new Date().getMonth() + 1}月${new Date().getDate()}日 星期${week}`;
    }

    // ---- KPI 行 ----
    const todaySchedules = schedules.filter((s) => s.date === todayStr);
    const todayDone = todaySchedules.filter((s) => s.status === SCHEDULE_STATUS.COMPLETED).length;
    const todayPending = todaySchedules.filter((s) => s.status === SCHEDULE_STATUS.SCHEDULED).length;
    // 今日课时不计请假：请假那节实际没上课，算进总数会虚高
    const todayLeave = todaySchedules.filter((s) => s.status === SCHEDULE_STATUS.STUDENT_LEAVE).length;
    const todayLessonCount = todaySchedules.length - todayLeave;
    const todayLeaveTag = todayLeave ? ` · 请假 ${todayLeave}` : '';
    const monthPrefix = todayStr.slice(0, 7);
    const monthLogs = checkInLogs.filter((l) => (l.checkInTime || '').startsWith(monthPrefix));
    const monthLessons = monthLogs.reduce((acc, l) => acc + (l.deductedLessons || 0), 0);
    const monthValue = monthLogs.reduce((acc, l) => acc + (l.paymentAmount || 0), 0);
    const debtors = debts.filter((d) => d.amount > 0);
    const debtTotal = debtors.reduce((n, d) => n + d.amount, 0);

    const kpiRow = document.getElementById('dashKpiRow');
    if (kpiRow) {
      kpiRow.innerHTML = `
        <div class="bg-white border border-[#efe9e0] rounded-2xl p-5">
          <div class="text-[11px] text-[#a8a29e] font-bold">今日课程</div>
          <div class="text-3xl font-black text-[#111111] mt-1.5">${todayLessonCount} <span class="text-sm font-bold text-[#a8a29e]">节</span></div>
          <div class="text-[11px] font-semibold mt-1.5 text-[#78716c]"><i class="fa-solid fa-circle-check mr-1"></i>已消 ${todayDone}${todayLeaveTag} · 待上 ${todayPending}</div>
        </div>
        <div class="bg-white border border-[#efe9e0] rounded-2xl p-5">
          <div class="text-[11px] text-[#a8a29e] font-bold">本月课消</div>
          <div class="text-3xl font-black text-[#111111] mt-1.5">${monthLessons.toFixed(0)} <span class="text-sm font-bold text-[#a8a29e]">节</span></div>
          <div class="text-[11px] font-semibold mt-1.5 text-[#a8a29e]">${monthLogs.length} 条消课记录</div>
        </div>
        <div class="bg-white border border-[#efe9e0] rounded-2xl p-5">
          <div class="text-[11px] text-[#a8a29e] font-bold">本月收入</div>
          <div class="text-3xl font-black text-[#111111] mt-1.5">¥${monthValue.toFixed(0)}</div>
          <div class="text-[11px] font-semibold mt-1.5 text-[#a8a29e]">课消价值合计</div>
        </div>
        <div class="bg-white border ${debtors.length ? 'border-rose-200' : 'border-[#efe9e0]'} rounded-2xl p-5">
          <div class="text-[11px] font-bold ${debtors.length ? 'text-rose-500' : 'text-[#a8a29e]'}">欠费预警</div>
          <div class="text-3xl font-black mt-1.5 ${debtors.length ? 'text-rose-600' : 'text-[#d6d3d1]'}">${debtors.length} <span class="text-sm font-bold ${debtors.length ? 'text-rose-300' : 'text-[#d6d3d1]'}">人</span></div>
          <div class="text-[11px] font-semibold mt-1.5 ${debtors.length ? 'text-rose-500' : 'text-[#d6d3d1]'}">共欠 ${debtTotal} 节${debtors.length ? ' · 需跟进' : ''}</div>
        </div>`;
    }

    // ---- 今日时间轴 ----
    const pendingBadge = document.getElementById('dashPendingBadge');
    if (pendingBadge) {
      pendingBadge.classList.toggle('hidden', todayPending === 0);
      if (todayPending) pendingBadge.textContent = `${todayPending} 节待消课`;
    }
    const todayList = document.getElementById('dashTodayList');
    // 消课按钮的三段动效进行中时，任何一次重渲染都会换掉按钮节点、让动效整个消失
    // （云同步轮询 / BroadcastChannel / 撤销都可能在途中触发 refreshView）。
    // 这段时间里保住「今日时间轴」的 DOM，等动效结束由 onDone 的 refreshView 统一刷新。
    const dashBusy = !!(window.uiAnim && window.uiAnim.isBusy && window.uiAnim.isBusy());
    if (todayList && !dashBusy) {
      const sorted = todaySchedules.slice().sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
      if (!sorted.length) {
        todayList.innerHTML = `<div class="text-center py-10 text-[#a8a29e] text-xs"><i class="fa-solid fa-mug-hot text-2xl mb-2 block opacity-40"></i>今天没有排课</div>`;
      } else {
        todayList.innerHTML = sorted.map((s) => {
          const done = s.status === SCHEDULE_STATUS.COMPLETED;
          const isLeave = s.status === SCHEDULE_STATUS.STUDENT_LEAVE;
          const dot = done ? '#10b981' : isLeave ? '#9ca3af' : '#475569';
          const statusHtml = done
            ? '<span class="text-[11px] font-bold text-emerald-600 shrink-0">已消课</span>'
            : isLeave
              ? '<span class="text-[10px] font-bold px-2 py-1 rounded-full bg-[#f5f2ec] text-[#78716c] shrink-0">请假待补</span>'
              : `<button class="lm-checkin-btn dash-checkin-btn shrink-0 text-[11px] font-bold px-3.5 py-1.5 rounded-full bg-[#111111] text-white transition" data-id="${s.id}">
                   <span class="lm-cb-label">消课</span>
                   <span class="lm-cb-spinner" aria-hidden="true"></span>
                   <svg class="lm-cb-check" viewBox="0 0 24 24" aria-hidden="true"><path pathLength="100" d="M4.5 12.6 L9.7 17.8 L19.5 6.6"/></svg>
                 </button>`;
          const student = students.find((st) => st.id === s.studentId);
          const debtTag = student ? (debts.find((d) => d.studentId === student.id && d.amount > 0) ? '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-600 ml-1.5">欠课</span>' : '') : '';
          return `<div class="flex items-center justify-between px-5 py-3 border-t border-[#f2ece4]">
            <div class="flex items-center gap-3 min-w-0">
              <span class="w-2 h-2 rounded-full shrink-0" style="background:${dot}"></span>
              <div class="text-[13px] font-bold text-[#111111] truncate">${s.startTime || '--'} ${s.subject || ''} · ${s.studentName || ''}${debtTag}</div>
            </div>
            ${statusHtml}
          </div>`;
        }).join('');
      }
      todayList.querySelectorAll('.dash-checkin-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const sch = schedules.find((x) => x.id === btn.getAttribute('data-id'));
          if (!sch) return;
          // 一键直消：这条路径原本要先弹操作菜单再点一次，而 executeCheckIn 自带
          // 状态守卫 + offerUndo 撤销窗口，误触可在 Toast 里撤回，不需要二次确认。
          if (!window.uiAnim || !window.uiAnim.runAsyncButton) {
            executeCheckIn(sch.id);
            return;
          }
          window.uiAnim.runAsyncButton(
            btn,
            () => executeCheckIn(sch.id, '', { skipRefresh: true }),
            () => refreshView()
          );
        });
      });
    }

    // ---- 课时预警 ----
    const lowList = document.getElementById('dashLowList');
    if (lowList) {
      const lowStudents = students
        .map((st) => {
          normalizeStudent(st);
          const lowCourses = (st.courses || []).filter((c) => c.remainingLessons <= 2);
          return { st, lowCourses };
        })
        .filter((x) => x.lowCourses.length);
      if (!lowStudents.length) {
        lowList.innerHTML = `<div class="text-center py-8 text-[#a8a29e] text-xs"><i class="fa-solid fa-shield-heart text-2xl mb-2 block opacity-40"></i>暂无课时预警</div>`;
      } else {
        lowList.innerHTML = lowStudents.slice(0, 8).map(({ st, lowCourses }) => {
          const min = Math.min(...lowCourses.map((c) => c.remainingLessons));
          return `<div class="flex items-center justify-between px-5 py-3 border-t border-[#f2ece4] cursor-pointer hover:bg-[#faf8f3] transition dash-low-student" data-id="${st.id}">
            <span class="text-[13px] font-bold text-[#111111] truncate">${st.name} <span class="text-[11px] text-[#a8a29e] font-semibold">· ${lowCourses.map((c) => c.name).join('、')}</span></span>
            <span class="text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0 ml-2 ${min < 0 ? 'bg-rose-100 text-rose-700' : 'bg-rose-50 text-rose-600'}">剩 ${min} 节</span>
          </div>`;
        }).join('');
        lowList.querySelectorAll('.dash-low-student').forEach((el) => {
          el.addEventListener('click', () => {
            switchPage('students');
            setTimeout(() => openStudentDetail(el.getAttribute('data-id')), 150);
          });
        });
      }
    }

    // ---- 本周课消趋势 ----
    renderDashWeekBars();

    // ---- 本月老师课时 ----
    const tStats = document.getElementById('dashTeacherStats');
    if (tStats) {
      const byTeacher = {};
      monthLogs.forEach((l) => {
        const name = l.teacherName || '未指定老师';
        if (!byTeacher[name]) byTeacher[name] = { lessons: 0, value: 0 };
        byTeacher[name].lessons += l.deductedLessons || 0;
        byTeacher[name].value += l.paymentAmount || 0;
      });
      const rows = Object.entries(byTeacher).sort((a, b) => b[1].lessons - a[1].lessons);
      if (!rows.length) {
        tStats.innerHTML = `<div class="text-center py-8 text-[#a8a29e] text-xs"><i class="fa-solid fa-chalkboard-user text-2xl mb-2 block opacity-40"></i>本月暂无消课</div>`;
      } else {
        tStats.innerHTML = rows.map(([name, v]) => `
          <div class="flex items-center justify-between px-5 py-3 border-t border-[#f2ece4]">
            <span class="text-[13px] font-bold text-[#111111]">${name}</span>
            <div class="flex items-center gap-2">
              <span class="text-[13px] font-black text-[#111111]">${v.lessons} 节</span>
              ${v.value > 0 ? `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#faf8f3] text-[#44403c]">¥${v.value.toFixed(0)}</span>` : ''}
            </div>
          </div>`).join('');
      }
    }
  }

  function bindPageNav() {
    document.querySelectorAll('.nav-page-btn[data-page], .mnav-btn[data-page]').forEach((btn) => {
      btn.addEventListener('click', () => switchPage(btn.getAttribute('data-page')));
    });
    // 每次刷新/进入默认显示看板页（顶栏隐藏、滑块落位）
    switchPage('dashboard');
    // 看板：本周 / 上周消课趋势切换
    document.querySelectorAll('.dash-week-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        dashWeekOffset = btn.getAttribute('data-week') === 'prev' ? -1 : 0;
        document.querySelectorAll('.dash-week-tab').forEach((b) => {
          const on = b === btn;
          b.classList.toggle('bg-[#111111]', on);
          b.classList.toggle('text-white', on);
          b.classList.toggle('bg-[#f5f2ec]', !on);
          b.classList.toggle('text-[#78716c]', !on);
        });
        renderDashWeekBars();
      });
    });
    // 看板：新增排课 / 预警直通
    safeBind('btnDashNewSchedule', 'click', () => { switchPage('schedule'); setTimeout(() => openScheduleModalForNew(), 200); });
    // 课表页右下角 FAB：先选学员再进排课弹窗（桌面弹窗需绑定学员）
    safeBind('fabNewSchedule', 'click', toggleFabStudentPicker);
    safeBind('fabStudentPickerBackdrop', 'click', hideFabStudentPicker);
    safeBind('btnDashGotoLow', 'click', () => switchPage('students'));
    // 底部导航"学员"按钮沿用原 btnMobileOpenStudents id
    safeBind('btnMobileOpenStudents', 'click', () => switchPage('students'));
    safeBind('btnMobileNewStudent', 'click', () => openStudentModal(null));
    safeBind('btnPageNewStudent', 'click', () => openStudentModal(null));
    // 设置页
    safeBind('btnPageCloudSync', 'click', () => {
      const el = document.getElementById('inputSyncKey');
      if (el) el.value = schoolSyncKey;
      showModal('modalSyncKey');
    });
    safeBind('btnPageQrSync', 'click', openQrSyncModal);
    safeBind('btnPageManageTeachers', 'click', openTeacherModal);
    safeBind('btnPageCourseTypes', 'click', openCourseTypesModal);
    safeBind('btnCloseCourseTypesModal', 'click', () => hideModal('modalCourseTypes'));
    safeBind('formAddCourseType', 'submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('courseTypeNameInput');
      const name = input ? input.value.trim() : '';
      if (!name) return;
      if (!addCourseType(name)) {
        showToast(`「${name}」已经在课程类型里了`, 'circle-info');
        return;
      }
      input.value = '';
      saveData();
      renderCourseTypesList();
      showToast(`已添加课程类型「${name}」`, 'tags');
    });
    safeBind('btnOpenCourseMerge', 'click', openCourseMergeModal);
    safeBind('btnCloseCourseMergeModal', 'click', () => hideModal('modalCourseMerge'));
    safeBind('btnCancelCourseMerge', 'click', () => hideModal('modalCourseMerge'));
    safeBind('btnApplyCourseMerge', 'click', applyCourseMerge);
    safeBind('chkMergeSelectAll', 'change', (e) => {
      document.querySelectorAll('#courseMergeList .merge-check').forEach((c) => {
        c.checked = e.target.checked;
      });
    });
    // 选课程包时，科目框若还是空的就自动带出同名科目（避免多填一次）
    safeBind('selectStudentCourse', 'change', (e) => {
      const opt = e.target.options[e.target.selectedIndex];
      const subjectEl = document.getElementById('inputSubject');
      if (!opt || !subjectEl) return;
      if (!subjectEl.value.trim()) subjectEl.value = opt.getAttribute('data-name') || '';
    });
    safeBind('btnPageIcsCalendar', 'click', openIcsModal);
    safeBind('btnCloseIcsModal', 'click', () => hideModal('modalIcsCalendar'));
    safeBind('btnPageImport', 'click', () => {
      const el = document.getElementById('btnImport');
      if (el) el.click();
    });
    safeBind('btnPageExport', 'click', exportScheduleData);
    safeBind('btnPageClearAll', 'click', () => {
      const el = document.getElementById('btnClearAllData');
      if (el) el.click();
    });
  }

  // 上课提醒：ICS 日历订阅链接（每位老师一条专属链接，手机日历订阅后可设提前15分钟提醒）
  function buildIcsLink(teacherId) {
    const base = location.origin && location.origin.startsWith('http') ? location.origin : 'https://lesson-mate.pages.dev';
    return `${base}/api/ics?key=${encodeURIComponent(schoolSyncKey)}&teacher=${encodeURIComponent(teacherId)}`;
  }

  function openIcsModal() {
    const box = document.getElementById('icsTeacherList');
    if (!box) return;
    if (teachers.length === 0) {
      box.innerHTML = '<div class="text-center py-6 lm-t3">还没有老师，先到「教师管理」添加</div>';
    } else {
      box.innerHTML = teachers.map((t) => `
        <div class="lm-section p-3 rounded-xl flex items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="font-bold" style="color:var(--lm-ink);">${t.name}${t.subject ? ' · ' + t.subject : ''}</div>
            <div class="text-[10px] truncate lm-t3">${buildIcsLink(t.id)}</div>
          </div>
          <button type="button" data-ics-copy="${t.id}" class="lm-btn-ink shrink-0 px-3 py-1.5 font-bold rounded-xl transition"><i class="fa-solid fa-copy"></i> 复制链接</button>
        </div>`).join('');
      box.querySelectorAll('[data-ics-copy]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const t = teachers.find((x) => x.id === btn.getAttribute('data-ics-copy'));
          if (!t) return;
          const link = buildIcsLink(t.id);
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(link).then(() => showToast(`已复制 ${t.name} 的订阅链接`)).catch(() => prompt('长按复制：', link));
          } else {
            prompt('长按复制：', link);
          }
        });
      });
    }
    showModal('modalIcsCalendar');
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

  function openSyncGate() {
    document.getElementById('btnGateCreate').onclick = () => {
      const code = randomSyncKey();
      applySyncKey(code);
      hideModal('modalSyncGate');
      saveData(); // 把本机初始数据推上云，其他设备凭此码即可加入
      showToast(`同步码 ${code} 已创建，可在 设置 → 实时云同步 查看`, 'circle-check');
    };
    document.getElementById('btnGateJoin').onclick = async () => {
      const el = document.getElementById('gateKeyInput');
      // 保留用户输入的原文大小写（旧版强制 toUpperCase，会把手输的小写码改掉导致登空）
      const val = await normalizeSyncKeyInput(el ? el.value : '');
      if (!val || val.length < 4) { showToast('请输入正确的同步码', 'circle-info'); return; }
      applySyncKey(val);
      await pullFromCloudSync(true);
      hideModal('modalSyncGate');
      showToast(`已登录机构 ${val}`, 'circle-check');
    };
    showModal('modalSyncGate');
  }

  function updateDebtBadges() {
    const hasDebt = debts.some((d) => d.amount > 0);
    ['navDebtBadge', 'mnavDebtBadge'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', !hasDebt);
    });
  }

  // 学员管理分页：完整版卡片（含课时/欠课/操作）
  function renderPageStudents() {
    const container = document.getElementById('pageStudentsList');
    if (!container) return;
    if (students.length === 0) {
      container.innerHTML = `<div class="col-span-full text-center py-16 lm-t3 text-sm">还没有学员，点击右上角"新建学员"开始</div>`;
      return;
    }
    container.innerHTML = students.map((student) => {
      normalizeStudent(student);
      migrateStudentCourses(student);
      const totalLessons = student.courses.reduce((acc, c) => acc + c.remainingLessons, 0);
      const isLow = totalLessons <= 2;
      const themeColor = getThemeBadgeStyle(student.colorTheme || 'amber');
      const studentDebts = getStudentDebts(student.id);
      return `
      <div class="lm-stat-card p-4 space-y-2" data-student-page-id="${student.id}">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            <div class="w-9 h-9 rounded-full ${themeColor.bg} ${themeColor.text} flex items-center justify-center font-bold text-sm shrink-0">${student.name.substring(0, 1)}</div>
            <div>
              <div class="font-bold text-sm lm-t1">${student.name}</div>
              <div class="text-[10px] lm-t3"><i class="fa-solid fa-phone text-[9px]"></i> ${student.phone || '无电话'}</div>
            </div>
          </div>
        </div>
        ${studentDebts.length ? `<div class="text-[10px] text-rose-600 bg-rose-50 border border-rose-200 px-2 py-1 rounded-lg"><i class="fa-solid fa-triangle-exclamation"></i> 欠课: ${studentDebts.map((d) => `${d.courseName} ${d.amount}节`).join('、')}</div>` : ''}
        <div class="space-y-1">
          ${student.courses.map((c) => `
            <div class="flex items-center justify-between text-[11px] lm-soft px-2.5 py-1.5 rounded-lg lm-hairline">
              <span class="font-semibold lm-t1">${c.name}</span>
              <span class="font-bold ${c.remainingLessons <= 2 ? 'text-rose-600' : 'lm-t2'}">剩${c.remainingLessons}课时${c.unitPrice > 0 ? ` · ¥${c.unitPrice}/节` : ''}</span>
            </div>`).join('')}
        </div>
        <div class="flex gap-2 pt-1">
          <button class="flex-1 py-2 rounded-lg btn-quiet text-[11px] font-bold transition page-detail-student" data-id="${student.id}"><i class="fa-solid fa-circle-info"></i> 详情</button>
          <button class="flex-1 py-2 rounded-lg btn-quiet text-[11px] font-bold transition page-edit-student" data-id="${student.id}"><i class="fa-solid fa-pen-to-square"></i> 编辑</button>
          <button class="flex-1 py-2 rounded-lg lm-btn-ink text-white text-[11px] font-bold transition page-recharge-student" data-id="${student.id}"><i class="fa-solid fa-circle-plus"></i> 充值</button>
        </div>
      </div>`;
    }).join('');

    container.querySelectorAll('.page-detail-student').forEach((btn) => {
      btn.addEventListener('click', () => {
        const st = students.find((s) => s.id === btn.getAttribute('data-id'));
        if (st) openStudentDetail(st.id);
      });
    });
    container.querySelectorAll('.page-edit-student').forEach((btn) => {
      btn.addEventListener('click', () => {
        const st = students.find((s) => s.id === btn.getAttribute('data-id'));
        if (st) openStudentModal(st);
      });
    });
    container.querySelectorAll('.page-recharge-student').forEach((btn) => {
      btn.addEventListener('click', () => {
        const st = students.find((s) => s.id === btn.getAttribute('data-id'));
        if (st) openRechargeModal(st);
      });
    });
  }

  // 财务分页：完整经营面板（本月课消/收入明细/欠课名单）
  function renderPageFinance() {
    const container = document.getElementById('pageFinanceContent');
    if (!container) return;

    const now = new Date();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthLogs = checkInLogs.filter((l) => (l.checkInTime || '').startsWith(monthPrefix)).slice().sort((a, b) => (b.checkInTime || '').localeCompare(a.checkInTime || ''));

    const monthLessons = monthLogs.reduce((acc, l) => acc + (l.deductedLessons || 0), 0);
    const monthValue = monthLogs.reduce((acc, l) => acc + (l.paymentAmount || 0), 0);
    const totalRemaining = students.reduce((acc, st) => acc + (st.courses || []).reduce((a, c) => a + Math.max(0, c.remainingLessons), 0), 0);
    const totalStockValue = students.reduce((acc, st) => acc + (st.courses || []).reduce((a, c) => a + Math.max(0, c.remainingLessons) * (c.unitPrice || 0), 0), 0);
    const debtors = debts.filter((d) => d.amount > 0);

    const kpiCard = (icon, iconStyle, label, valueHtml, extraAttr) => `
      <div class="lm-stat-card rounded-2xl p-4" ${extraAttr || ''}>
        <div class="flex items-center gap-1.5 text-[11px] font-bold lm-t3"><i class="fa-solid ${icon}" style="${iconStyle}"></i> ${label}</div>
        <div class="text-2xl font-black lm-t1 mt-1.5">${valueHtml}</div>
      </div>`;

    container.innerHTML = `
      <div class="grid grid-cols-2 xl:grid-cols-4 gap-3">
        ${kpiCard('fa-chart-simple', 'color:#111111;', '本月课消', `${monthLessons.toFixed(1)} <span class="text-xs font-bold lm-t3">节</span>`)}
        ${kpiCard('fa-coins', 'color:#ff5600;', '课消价值', `¥${monthValue.toFixed(0)}`)}
        ${kpiCard('fa-layer-group', 'color:#111111;', '待消存量', `${totalRemaining.toFixed(1)} <span class="text-xs font-bold lm-t3">节</span>`)}
        ${kpiCard('fa-triangle-exclamation', 'color:#d5304f;', '欠课学员', `${debtors.length} <span class="text-xs font-bold lm-t3">人</span>`, debtors.length ? 'style="background:#fff1f2;"' : '')}
      </div>

      <div class="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
        <!-- 本月收入明细：桌面表格 -->
        <div class="lm-stat-card rounded-2xl xl:col-span-2">
          <div class="flex items-center justify-between px-4 pt-4 pb-2">
            <div class="font-bold text-xs lm-t1 flex items-center gap-1.5"><i class="fa-solid fa-receipt" style="color:#ff5600;"></i> 本月收入明细（消课流水）</div>
            <div class="text-[11px] font-bold lm-t2">${monthLogs.length} 笔 · ${monthLessons.toFixed(1)} 节 · ¥${monthValue.toFixed(0)}</div>
          </div>
          ${monthLogs.length === 0 ? '<div class="text-[11px] lm-t3 py-8 text-center">本月暂无消课记录</div>' : `
          <div class="max-h-[480px] overflow-y-auto custom-scrollbar px-2 pb-2">
            <table class="w-full text-xs">
              <thead class="sticky top-0 bg-white">
                <tr class="text-left text-[10px] lm-t3 border-b border-[#efe9e0]">
                  <th class="font-bold py-2.5 pl-2">学员</th>
                  <th class="font-bold py-2.5">课程</th>
                  <th class="font-bold py-2.5">备注</th>
                  <th class="font-bold py-2.5 text-right">节数</th>
                  <th class="font-bold py-2.5 text-right">金额</th>
                  <th class="font-bold py-2.5 text-right pr-2">时间</th>
                </tr>
              </thead>
              <tbody>
                ${monthLogs.map((l) => `
                <tr class="border-b border-[#f2ece4] hover:bg-[#faf8f3] transition">
                  <td class="py-3 pl-2 font-bold lm-t1 whitespace-nowrap">${l.studentName}</td>
                  <td class="py-3 lm-t2 whitespace-nowrap">${l.courseName}</td>
                  <td class="py-3 lm-t3 max-w-[180px] truncate" title="${l.remarks || ''}">${l.remarks || '—'}</td>
                  <td class="py-3 text-right lm-t2 whitespace-nowrap">${l.deductedLessons} 节</td>
                  <td class="py-3 text-right font-bold ${l.paymentAmount > 0 ? 'lm-t1' : 'lm-t3'} whitespace-nowrap">${l.paymentAmount > 0 ? `¥${l.paymentAmount.toFixed(0)}` : '—'}</td>
                  <td class="py-3 text-right lm-t3 whitespace-nowrap pr-2">${(l.checkInTime || '').replace('T', ' ').slice(5, 16)}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>`}
        </div>

        <!-- 右栏：欠课名单 + 课时存量价值 -->
        <div class="space-y-4">
          <div class="lm-stat-card rounded-2xl p-4">
            <div class="font-bold text-xs lm-t1 mb-2 flex items-center gap-1.5"><i class="fa-solid fa-triangle-exclamation" style="color:var(--lm-pink);"></i> 欠课名单</div>
            ${debtors.length === 0 ? '<div class="text-[11px] lm-t3 py-4 text-center">没有欠课学员，太棒了 🎉</div>' : `
            <div class="space-y-1.5">
              ${debtors.map((d) => {
                const st = students.find((s) => s.id === d.studentId);
                return `
                <div class="flex items-center justify-between text-xs bg-rose-50/60 px-3 py-2 rounded-lg">
                  <span class="font-bold lm-t1">${st ? st.name : '未知学员'} <span class="lm-t3 font-medium">· ${d.courseName}</span></span>
                  <span class="font-black text-rose-600">欠 ${d.amount} 节</span>
                </div>`;}).join('')}
              <div class="text-[10px] lm-t3 pt-1">💡 到"学员"页点对应学员的"充值"按钮，会自动抵扣欠课</div>
            </div>`}
          </div>

          <div class="lm-stat-card rounded-2xl p-4">
            <div class="font-bold text-xs lm-t1 mb-2 flex items-center gap-1.5"><i class="fa-solid fa-wallet"></i> 课时存量价值</div>
            <div class="flex items-baseline gap-2">
              <span class="text-2xl font-black lm-t1">¥${totalStockValue.toFixed(0)}</span>
              <span class="text-[10px] lm-t3">全部学员剩余课时按单价折算</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderTeacherOptions() {
    const filterSelect = document.getElementById('filterTeacherSelect');
    const modalSelect = document.getElementById('selectTeacher');
    const assistantSelect = document.getElementById('selectAssistantTeacher');

    if (filterSelect) {
      filterSelect.innerHTML = `<option value="all">全校老师 (全部)</option>`;
      teachers.forEach((t) => {
        filterSelect.innerHTML += `<option value="${t.id}">👩‍🏫 ${t.name} (${t.subject || '全科'})</option>`;
      });
      filterSelect.value = selectedTeacherFilter;
    }

    if (modalSelect) {
      modalSelect.innerHTML = '';
      teachers.forEach((t) => {
        modalSelect.innerHTML += `<option value="${t.id}">${t.name} - ${t.subject || '通用'}</option>`;
      });
    }

    if (assistantSelect) {
      assistantSelect.innerHTML = `<option value="">无 (仅主讲老师单师授课)</option>`;
      teachers.forEach((t) => {
        assistantSelect.innerHTML += `<option value="${t.id}">${t.name} - ${t.subject || '通用'}</option>`;
      });
    }
  }

  // ==========================================
  // 4. 周日历头部渲染 (Mon - Sun)
  // ==========================================
  function renderWeekHeader() {
    const headerContainer = document.getElementById('calendarHeaderDays');
    if (!headerContainer) return;
    headerContainer.innerHTML = '';

    const weekEnd = addDays(currentWeekStart, 6);
    const rangeText = `${currentWeekStart.getFullYear()}年${currentWeekStart.getMonth() + 1}月${currentWeekStart.getDate()}日 - ${weekEnd.getMonth() + 1}月${weekEnd.getDate()}日`;

    const rangeEl = document.getElementById('currentWeekRange');
    if (rangeEl) rangeEl.textContent = rangeText;

    const weekdayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const todayStr = formatDate(new Date());

    for (let i = 0; i < 7; i++) {
      const dayDate = addDays(currentWeekStart, i);
      const dateStr = formatDate(dayDate);
      const isToday = dateStr === todayStr;

      const colHeader = document.createElement('div');
      colHeader.className = `py-2 px-1 text-center transition ${isToday ? 'today-column-header' : 'bg-white'}`;

      colHeader.innerHTML = `
        <div class="text-[11px] ${isToday ? 'lm-t1 font-bold' : 'lm-t3 font-medium'}">${weekdayNames[i]}</div>
        <div class="text-xs sm:text-sm font-bold mt-0.5 ${isToday ? 'today-badge inline-block' : 'lm-t1'}">
          ${dayDate.getMonth() + 1}/${dayDate.getDate()}
        </div>
      `;
      headerContainer.appendChild(colHeader);
    }
  }

  // ==========================================
  // 5. 左侧学生列表渲染
  // ==========================================
  function renderStudentList() {
    const container = document.getElementById('studentListContainer');
    if (!container) return;
    container.innerHTML = '';

    // 填充筛选下拉（保留当前选中值）
    const tSel = document.getElementById('studentTeacherFilter');
    const cSel = document.getElementById('studentCourseFilter');
    if (tSel) {
      const prev = tSel.value;
      tSel.innerHTML = '<option value="all">全部老师</option>' +
        teachers.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
      if ([...tSel.options].some((o) => o.value === prev)) tSel.value = prev;
    }
    if (cSel) {
      const prev = cSel.value;
      const names = [...new Set(students.flatMap((st) => (st.courses || []).map((c) => c.name)))].filter(Boolean);
      cSel.innerHTML = '<option value="all">全部课程</option>' +
        names.map((n) => `<option value="${n}">${n}</option>`).join('');
      if ([...cSel.options].some((o) => o.value === prev)) cSel.value = prev;
    }

    const weekStartStr = formatDate(currentWeekStart);
    const weekEndStr = formatDate(addDays(currentWeekStart, 6));

    const scheduledStudentIdsThisWeek = new Set(
      schedules
        .filter((s) => s.date >= weekStartStr && s.date <= weekEndStr)
        .map((s) => s.studentId)
    );

    let filtered = students.filter((st) => {
      normalizeStudent(st);

      const matchNameOrPhone = st.name.toLowerCase().includes(searchQuery) || (st.phone && st.phone.includes(searchQuery));
      const matchCourseName = st.courses.some((c) => c.name.toLowerCase().includes(searchQuery));
      if (!matchNameOrPhone && !matchCourseName) return false;

      // 按老师筛选：排课记录里该老师（主讲或助教）上过/将上该学员的课
      const tSel = document.getElementById('studentTeacherFilter');
      const cSel = document.getElementById('studentCourseFilter');
      if (tSel && tSel.value !== 'all') {
        const matchT = schedules.some((s) => s.studentId === st.id && (s.teacherId === tSel.value || s.assistantTeacherId === tSel.value));
        if (!matchT) return false;
      }
      // 按课程筛选：学员有该名字的课程
      if (cSel && cSel.value !== 'all') {
        if (!st.courses.some((c) => c.name === cSel.value)) return false;
      }

      const totalLessons = st.courses.reduce((acc, c) => acc + c.remainingLessons, 0);

      if (currentFilter === 'unscheduled') {
        return !scheduledStudentIdsThisWeek.has(st.id);
      } else if (currentFilter === 'low') {
        return (totalLessons <= 2 || st.courses.some((c) => c.remainingLessons <= 2)) && !scheduledStudentIdsThisWeek.has(st.id);
      } else if (currentFilter === 'scheduled') {
        return scheduledStudentIdsThisWeek.has(st.id);
      } else if (currentFilter === 'all') {
        return true;
      }
      return !scheduledStudentIdsThisWeek.has(st.id);
    });

    const badgeEl = document.getElementById('studentCountBadge');
    if (badgeEl) badgeEl.textContent = `${filtered.length} 人`;

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="text-center py-10 lm-t3 text-xs">
          <i class="fa-solid fa-user-slash text-2xl mb-2 lm-t3"></i>
          <p>暂无符合条件的学生</p>
        </div>
      `;
      return;
    }

    filtered.forEach((student) => {
      const card = document.createElement('div');
      card.className = 'student-card bg-white p-3 rounded-xl border lm-hairline shadow-2xs flex flex-col gap-2 group relative';
      card.setAttribute('draggable', 'true');
      card.setAttribute('data-student-id', student.id);

      const totalLessons = student.courses.reduce((acc, c) => acc + c.remainingLessons, 0);
      const isLow = totalLessons <= 2;
      const themeColor = getThemeBadgeStyle(student.colorTheme || 'amber');
      const studentDebts = getStudentDebts(student.id);
      const debtsHtml = studentDebts.length
        ? `<div class="flex items-center gap-1 text-[10px] text-rose-600 bg-rose-50 border border-rose-200 px-1.5 py-0.5 rounded">
             <i class="fa-solid fa-triangle-exclamation"></i> 欠课: ${studentDebts.map((d) => `${d.courseName} ${d.amount}节`).join('、')}
           </div>`
        : '';

      const coursesHtml = student.courses
        .map(
          (c) => `
        <div class="flex items-center justify-between text-[11px] lm-soft px-2.5 py-1 rounded-lg lm-hairline">
          <span class="font-semibold lm-t1 truncate">${c.name}${c.unitPrice > 0 ? `<span class="lm-t3 font-normal ml-1">¥${c.unitPrice}/节</span>` : ''}</span>
          <span class="font-bold shrink-0 ml-1.5 ${c.remainingLessons <= 2 ? 'text-rose-600 bg-rose-50 px-1.5 py-0.2 rounded border border-rose-200' : 'lm-t2'}">
            ${c.remainingLessons <= 2 ? '<span class="w-1.5 h-1.5 rounded-full bg-rose-500 animate-ping inline-block mr-1"></span>' : ''}剩${c.remainingLessons}课时
          </span>
        </div>
      `
        )
        .join('');

      card.innerHTML = `
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            <div class="lm-t3 group-hover:text-[#111111] transition cursor-grab">
              <i class="fa-solid fa-grip-vertical text-xs"></i>
            </div>
            <div class="w-8 h-8 rounded-full ${themeColor.bg} ${themeColor.text} flex items-center justify-center font-bold text-xs shrink-0 shadow-xs">
              ${student.name.substring(0, 1)}
            </div>
            <div>
              <div class="font-bold text-xs lm-t1 flex items-center gap-1">
                <span>${student.name}</span>
                <span class="text-[10px] lm-t3 font-normal">(${student.courses.length}门课)</span>
              </div>
              <div class="text-[10px] lm-t3">
                <i class="fa-solid fa-phone text-[9px]"></i> ${student.phone || '无电话'}
              </div>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <button class="btn-detail-student text-sky-400 hover:text-sky-600 transition" title="查看详情">
              <i class="fa-solid fa-circle-info"></i>
            </button>
            <button class="btn-edit-student lm-t3 hover:lm-t1 transition" title="编辑学生课程">
              <i class="fa-solid fa-pen-to-square"></i>
            </button>
            <button class="btn-recharge-student text-emerald-500 hover:text-emerald-600 transition" title="充值课时">
              <i class="fa-solid fa-circle-plus"></i>
            </button>
          </div>
        </div>

        ${debtsHtml}

        <div class="space-y-1 pt-1 border-t lm-hairline">
          ${coursesHtml}
        </div>
      `;

      card.addEventListener('dragstart', (e) => {
        draggedStudent = student;
        draggedSchedule = null;
        card.classList.add('dragging');

        // 抽屉遮罩会挡住日历的 drop 区域 → 拖拽开始时自动收起抽屉
        const drawer = document.getElementById('sidebarStudent');
        const backdrop = document.getElementById('batchSidebarBackdrop');
        if (drawer) { drawer.classList.add('hidden'); drawer.classList.remove('flex'); }
        if (backdrop) backdrop.classList.add('hidden');

        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('application/json', JSON.stringify({ type: 'student', id: student.id }));

        const dragGhost = document.createElement('div');
        dragGhost.className = 'bg-[#111111] text-white px-3 py-1.5 rounded-xl font-bold text-xs shadow-lg';
        dragGhost.textContent = `📅 正在对 [${student.name}] 排课...`;
        document.body.appendChild(dragGhost);
        e.dataTransfer.setDragImage(dragGhost, 10, 10);
        setTimeout(() => document.body.removeChild(dragGhost), 0);
      });

      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        draggedStudent = null;
      });

      card.addEventListener('click', (e) => {
        if (!e.target.closest('.btn-edit-student')) {
          selectStudentForTap(student, card);
        }
      });

      card.querySelector('.btn-detail-student').addEventListener('click', (e) => {
        e.stopPropagation();
        openStudentDetail(student.id);
      });

      card.querySelector('.btn-edit-student').addEventListener('click', (e) => {
        e.stopPropagation();
        openStudentModal(student);
      });

      card.querySelector('.btn-recharge-student').addEventListener('click', (e) => {
        e.stopPropagation();
        openRechargeModal(student);
      });

      container.appendChild(card);
    });
  }

  function getThemeBadgeStyle(theme) {
    // 色卡系浅底 + 同系深字（白底页面上的头像徽章）；深灰绿用白字
    const map = {
      amber:   { bg: 'bg-[#FDE8D3]', text: 'text-[#8A5A28]', border: 'border-[#EBC9A5]' },
      emerald: { bg: 'bg-[#CFD6C4]', text: 'text-[#47523C]', border: 'border-[#B4BFA5]' },
      sky:     { bg: 'bg-[#99CDD8]', text: 'text-[#2E5D68]', border: 'border-[#7EB6C3]' },
      purple:  { bg: 'bg-[#A7B2A4]', text: 'text-[#2F3A2E]', border: 'border-[#8E9A8B]' },
      rose:    { bg: 'bg-[#F3C3B2]', text: 'text-[#7A4231]', border: 'border-[#E3A78F]' },
      mint:    { bg: 'bg-[#DAE9E3]', text: 'text-[#3F6257]', border: 'border-[#B7D2C8]' },
    };
    return map[theme] || map.amber;
  }

  // ==========================================
  // 6. 同一时段多课程并排列显示布局算法 (Google Calendar Side-by-Side Engine)
  // ==========================================
  function layoutOverlapEvents(schedulesList) {
    if (!schedulesList || schedulesList.length === 0) return [];

    const items = schedulesList.map((s) => {
      const [h, m] = s.startTime.split(':').map(Number);
      const startMins = (h - 8) * 60 + m;
      const endMins = startMins + s.durationMinutes;
      return {
        ...s,
        startMins,
        endMins,
        _colIndex: 0,
        _totalCols: 1,
      };
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
    if (currentCluster.length > 0) {
      clusters.push(currentCluster);
    }

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
      cluster.forEach((item) => {
        item._totalCols = maxCols;
      });
    });

    return items;
  }

  // ==========================================
  // 7. 右侧 7 天日历网格 & 拖放引擎渲染
  // ==========================================
  function renderCalendarGrid() {
    const gridContainer = document.getElementById('calendarGridColumns');
    if (!gridContainer) return;
    gridContainer.innerHTML = '';

    const conflictsMap = detectScheduleConflicts();

    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
      const dayDate = addDays(currentWeekStart, dayIndex);
      const dateStr = formatDate(dayDate);

      const dayColumn = document.createElement('div');
      dayColumn.className = 'calendar-day-column group';
      dayColumn.setAttribute('data-date', dateStr);
      dayColumn.setAttribute('data-day-index', dayIndex);

      dayColumn.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        dayColumn.classList.add('drag-over');

        const rect = dayColumn.getBoundingClientRect();
        const offsetY = Math.max(0, Math.min(832, e.clientY - rect.top));

        const totalMinutes = Math.floor((offsetY / 832) * (13 * 60));
        const roundedMinutes = Math.floor(totalMinutes / 15) * 15;

        const hour = 8 + Math.floor(roundedMinutes / 60);
        const min = roundedMinutes % 60;
        const timeStr = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;

        let previewSlot = dayColumn.querySelector('.drag-preview-slot');
        if (!previewSlot) {
          previewSlot = document.createElement('div');
          previewSlot.className = 'drag-preview-slot';
          dayColumn.appendChild(previewSlot);
        }

        const topPx = (roundedMinutes / (13 * 60)) * 832;
        const defaultHeightPx = (60 / (13 * 60)) * 832;
        previewSlot.style.top = `${topPx}px`;
        previewSlot.style.height = `${defaultHeightPx}px`;

        const name = draggedStudent ? draggedStudent.name : draggedSchedule ? draggedSchedule.studentName : '放开排课';
        previewSlot.innerHTML = `<i class="fa-solid fa-clock mr-1"></i> ${timeStr} - ${name}`;
      });

      dayColumn.addEventListener('dragleave', (e) => {
        if (!dayColumn.contains(e.relatedTarget)) {
          dayColumn.classList.remove('drag-over');
          removeDragPreviewSlot(dayColumn);
        }
      });

      dayColumn.addEventListener('drop', (e) => {
        e.preventDefault();
        dayColumn.classList.remove('drag-over');
        removeDragPreviewSlot(dayColumn);

        const rect = dayColumn.getBoundingClientRect();
        const offsetY = Math.max(0, Math.min(832, e.clientY - rect.top));
        const totalMinutes = Math.floor((offsetY / 832) * (13 * 60));
        const roundedMinutes = Math.floor(totalMinutes / 15) * 15;

        const hour = Math.min(20, 8 + Math.floor(roundedMinutes / 60));
        const min = roundedMinutes % 60;
        const startTimeStr = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;

        if (draggedStudent) {
          openScheduleModalForNew(draggedStudent, dateStr, startTimeStr);
        } else if (draggedSchedule) {
          draggedSchedule.date = dateStr;
          draggedSchedule.startTime = startTimeStr;
          saveData();
          renderCalendarGrid();
          updateStats();
          showToast(`已调整 [${draggedSchedule.studentName}] 的课程至 ${dateStr} ${startTimeStr}`, 'calendar-check');
          draggedSchedule = null;
        }
      });

      dayColumn.addEventListener('click', (e) => {
        if (selectedStudentForTap && !e.target.closest('.schedule-event-card')) {
          const rect = dayColumn.getBoundingClientRect();
          const offsetY = Math.max(0, Math.min(832, e.clientY - rect.top));
          const totalMinutes = Math.floor((offsetY / 832) * (13 * 60));
          const roundedMinutes = Math.floor(totalMinutes / 15) * 15;

          const hour = Math.min(20, 8 + Math.floor(roundedMinutes / 60));
          const min = roundedMinutes % 60;
          const startTimeStr = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;

          const st = selectedStudentForTap;
          clearStudentForTap();
          openScheduleModalForNew(st, dateStr, startTimeStr);
        }
      });

      let daySchedules = schedules.filter((s) => s.date === dateStr);
      if (selectedTeacherFilter !== 'all') {
        daySchedules = daySchedules.filter((s) => s.teacherId === selectedTeacherFilter || s.assistantTeacherId === selectedTeacherFilter);
      }

      const layoutItems = layoutOverlapEvents(daySchedules);

      layoutItems.forEach((sch) => {
        const conflictInfo = conflictsMap.get(sch.id);
        const card = createScheduleEventCard(sch, conflictInfo);
        dayColumn.appendChild(card);
      });

      gridContainer.appendChild(dayColumn);
    }

    // 动效：新渲染的课卡轻微错峰进场（含数量限流，见 anim.js）
    if (window.uiAnim) {
      window.uiAnim.cardsStagger(gridContainer, '.schedule-event-card');
      window.uiAnim.emitRendered();
    }
  }

  function removeDragPreviewSlot(container) {
    const slot = container.querySelector('.drag-preview-slot');
    if (slot) container.removeChild(slot);
  }

  // ==========================================
  // 8. 创建日历中的课程事件卡片
  // ==========================================
  // 一次性迁移：把历史排课存的色值对齐为学员头像色。
  // 渲染已实时跟随学员，这一步只是为了清掉历史遗留的脏值（导出/其他端也一致）。
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

  function createScheduleEventCard(schedule, conflictInfo) {
    const card = document.createElement('div');
    const themeClass = `event-${resolveScheduleTheme(schedule)}`;
    const hasConflict = !!conflictInfo;
    card.className = `schedule-event-card ${themeClass} ${hasConflict ? 'has-conflict' : ''}`;
    card.setAttribute('draggable', 'true');
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

    // 空间分层策略（break-ui 压测结论）：
    //   宽：1 列=宽敞（时间+课程+老师课室全给）/ 2 列=中等（只留姓名+课程，
    //       时间、老师、课室一律退场——格子被并排挤窄后，姓名和课程是唯一必须完整的信息）
    //       / ≥3 列=窄（只剩姓名）
    //   高：<56px=矮卡（30 分钟，去角标底、课程改裸文本）/ ≥96px=高卡（信息分行铺开）
    //   老师·课室合并为一行点隔文本，去掉 👩‍🏫/📍 emoji（一张卡最多省 ~30px 横向空间）
    //   状态角标从绝对定位改为随行内联——压测里「✓消」角标正好盖住时间徽章
    //   被挤掉的信息一律进 title 悬浮提示，不丢失
    const isNarrow = totalCols >= 3;
    const isMedium = totalCols === 2;
    const isSpacious = totalCols === 1;
    const isShort = heightPx < 56;
    const isTall = heightPx >= 96;

    const nameFontSize = isSpacious ? (isTall ? 'text-sm font-black' : 'text-[13px] font-extrabold') : (isNarrow ? 'text-[11px] font-bold' : 'text-xs font-bold');
    const timeFontSize = isSpacious ? 'text-[10px] font-mono font-bold' : 'text-[9px] font-mono';

    // 老师 & 课室合并：欧阳老师&司马老师 · A-301（完整信息始终在 title 悬浮提示里）
    const metaParts = [];
    if (schedule.teacherName) {
      metaParts.push(schedule.assistantTeacherName ? `${schedule.teacherName}&${schedule.assistantTeacherName}` : schedule.teacherName);
    }
    if (schedule.room) metaParts.push(schedule.room);
    const metaText = metaParts.join(' · ');

    // 状态徽章内联化：矮卡窄卡只留单字（完整文案走 title）
    const statusCompact = isShort || isNarrow || isMedium;
    let statusChip = '';
    if (schedule.status === SCHEDULE_STATUS.COMPLETED) {
      statusChip = `<span class="shrink-0 ${statusCompact ? 'text-[9px] px-0.5' : 'text-[8px] px-1'} font-black text-white bg-emerald-500 rounded-md leading-none py-[3px]" title="已消课">✓${statusCompact ? '' : ' 消'}</span>`;
    } else if (schedule.status === SCHEDULE_STATUS.STUDENT_LEAVE) {
      statusChip = `<span class="shrink-0 ${statusCompact ? 'text-[9px] px-0.5' : 'text-[8px] px-1'} font-black text-white bg-rose-400 rounded-md leading-none py-[3px]" title="学员请假">假</span>`;
    }
    if (schedule.status === SCHEDULE_STATUS.COMPLETED) {
      card.style.opacity = '0.65';
    } else if (schedule.status === SCHEDULE_STATUS.STUDENT_LEAVE) {
      // 弱化交给 .is-leave（更透 + 去饱和 + 灰白字），不再用内联 opacity/灰度
      card.classList.add('is-leave');
    }

    card.setAttribute(
      'title',
      `学员: ${schedule.studentName}\n课程: ${schedule.subject}\n时间: ${schedule.startTime}-${endTimeStr}\n任课老师: ${schedule.teacherName || '未指定'}${schedule.assistantTeacherName ? ' & ' + schedule.assistantTeacherName : ''}\n课室: ${schedule.room || '未指定'}`
    );

    // 第二行内容：矮卡用裸文本（去掉徽章边框底色的 9px 高度开销）；
    // 高卡把老师·课室单独成行，用足纵向空间；窄卡整行退场。
    // 中等卡（两节并排）：姓名和课程各允许换两行——格子被挤窄后这两项是唯一必须完整的信息，
    // 用宽度换行数，64px 高度实测放得下；超两行才截断（悬浮提示有全文）。
    const canWrap = isMedium && !isShort;
    const subjectPlain = `<span class="${canWrap ? 'line-clamp-2' : 'truncate'} opacity-90 ${isSpacious ? 'text-[10px] font-semibold' : 'text-[9px] font-medium'} min-w-0">${schedule.subject || ''}</span>`;
    const subjectBadge = `<span class="ev-chip shrink-0 ${isSpacious ? 'text-[11px]' : 'text-[10px]'} font-bold px-1.5 py-0.5 rounded-md truncate min-w-0 max-w-full">${schedule.subject || ''}</span>`;
    const metaLine = metaText ? `<span class="truncate opacity-80 ${isSpacious ? 'text-[10px] font-semibold' : 'text-[9px] font-medium'} min-w-0">${metaText}</span>` : '';

    // 冲突提示：矮卡/窄卡只留警示图标（完整原因走 title），否则 48px 高度必裁切
    const conflictIcon = hasConflict
      ? `<span class="shrink-0 inline-flex items-center text-rose-700" title="${conflictInfo.reasons.join(' | ')}"><i class="lm-cf-warn fa-solid fa-triangle-exclamation text-rose-500 text-[9px]"></i></span>`
      : '';
    const conflictFull = hasConflict
      ? `<div class="text-[9px] font-bold text-rose-700 bg-rose-100/95 border border-rose-300 px-1 py-0.2 rounded truncate flex items-center gap-0.5 shadow-2xs shrink-0 mt-[2px]" title="${conflictInfo.reasons.join(' | ')}">
          <i class="lm-cf-warn fa-solid fa-triangle-exclamation text-rose-500 shrink-0 text-[8px]"></i>
          <span class="truncate leading-normal min-w-0">${conflictInfo.reasons.join('; ')}</span>
         </div>`
      : '';

    // 纵向分布：矮卡居中收紧；高卡顶部起排（justify-between 会在中间拉出大空洞）；
    // 中等高度维持上下撑满的原有节奏。
    const vDist = isNarrow ? 'justify-center' : (isShort ? 'justify-center gap-[2px]' : (isTall ? 'justify-start gap-1' : 'justify-between'));

    let bodyRows;
    if (isNarrow) {
      // 窄卡（≥3 节同段重叠）：一格只放得下姓名，其余全走悬浮提示
      bodyRows = '';
    } else if (isMedium || isShort) {
      // 中等（两节并排）/ 矮卡：只保姓名 + 课程，课程用裸文本（不套徽章边框，省出空间给文字）
      bodyRows = `<div class="leading-none flex items-center gap-1 shrink-0 min-w-0">${subjectPlain}${(isMedium || isShort) ? conflictIcon : ''}</div>`;
    } else {
      // 宽敞卡：高卡课程徽章一行、老师·课室单独一行，用足纵向空间且不重复
      bodyRows = `<div class="leading-none flex items-center gap-1 min-w-0 shrink-0">${subjectBadge}${isTall ? '' : metaLine}</div>` +
        (isTall && metaLine ? `<div class="leading-none truncate opacity-80 ${isSpacious ? 'text-[10px] font-semibold' : 'text-[9px] font-medium'} min-w-0 shrink-0">${metaText}</div>` : '') +
        conflictFull;
    }

    card.innerHTML = `
      <div class="flex flex-col ${vDist} h-full pointer-events-none px-2 py-1 min-w-0">
        <div class="flex items-center justify-between gap-1 leading-none shrink-0 min-w-0">
          <span class="event-name ${canWrap ? 'line-clamp-2' : 'truncate'} ${nameFontSize} flex-1 min-w-0 tracking-normal font-sans">${schedule.studentName}</span>
          ${isSpacious ? `<span class="ev-chip ${timeFontSize} shrink-0 px-1 py-0.2 rounded">${schedule.startTime}</span>` : ''}
          ${statusChip}
          ${isNarrow ? conflictIcon : ''}
        </div>
        ${bodyRows}
      </div>
    `;

    card.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      draggedSchedule = schedule;
      draggedStudent = null;
      card.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/json', JSON.stringify({ type: 'schedule', id: schedule.id }));
    });

    card.addEventListener('dragend', () => {
      card.style.opacity = '1';
      draggedSchedule = null;
    });

    card.addEventListener('click', (e) => {
      e.stopPropagation();
      openScheduleActionMenu(schedule);
    });

    return card;
  }

  // 课程卡片点击 → 操作菜单（消课/请假/撤销/编辑/删除）
  // 删除课程统一入口：有后续重复排课时弹"仅本次/本次及之后"双选（无则普通确认）
  function deleteScheduleWithScope(sch, onDone) {
    const later = seriesLaterSiblings(sch).filter((s) => s.status === 'scheduled');
    const laterCount = later.length;

    const doDelete = (ids, msg) => {
      // 删除是不可逆感最强的操作，撤销优先级最高
      pushUndo('删除排课', sch.id);
      ids.forEach((id) => handleDeleteScheduleWithCleanup(id));
      refreshView();
      offerUndo(msg, 'trash-can', '删除排课');
      if (onDone) onDone();
    };

    if (laterCount === 0) {
      if (!confirm('确定删除该课程？待上课状态的课程会退还已扣课时。')) return;
      doDelete([sch.id], '已删除该课程');
      return;
    }

    // 系列存在 → 双选项弹窗
    const ov = document.createElement('div');
    ov.className = 'fixed inset-0 lm-scrim backdrop-blur-xs z-[60] flex items-center justify-center p-4';
    ov.innerHTML = `
      <div class="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5">
        <div class="flex items-start gap-3 pb-3 border-b lm-hairline">
          <div class="w-9 h-9 rounded-full bg-rose-100 text-rose-500 flex items-center justify-center shrink-0"><i class="fa-solid fa-trash-can"></i></div>
          <div>
            <div class="font-bold text-sm lm-t1">删除重复排课系列</div>
            <div class="text-[11px] lm-t3 mt-0.5">${sch.studentName} · ${sch.subject} · ${sch.date} ${sch.startTime}<br>该时段之后还有 <b class="text-rose-500">${laterCount}</b> 节同样的排课</div>
          </div>
        </div>
        <div class="space-y-2 mt-3">
          <button data-scope="this" class="w-full py-2.5 rounded-xl text-sm font-bold btn-quiet transition">
            <i class="fa-solid fa-scissors mr-1"></i> 仅删除本次（保留之后 ${laterCount} 节）
          </button>
          <button data-scope="all" class="w-full py-2.5 rounded-xl text-sm font-bold bg-rose-500 text-white hover:bg-rose-600 transition">
            <i class="fa-solid fa-trash-can mr-1"></i> 删除本次及之后所有（共 ${laterCount + 1} 节）
          </button>
          <button data-scope="cancel" class="w-full py-2 text-xs lm-t3 hover:lm-t2 transition">取消</button>
        </div>
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

  function openScheduleActionMenu(schedule) {
    const status = schedule.status || SCHEDULE_STATUS.SCHEDULED;
    const student = students.find((st) => st.id === schedule.studentId);
    const menu = document.createElement('div');
    menu.id = 'scheduleActionMenu';
    menu.className = 'fixed inset-0 lm-scrim backdrop-blur-xs z-50 flex items-center justify-center p-4';

    let actionsHtml = '';
    if (status !== SCHEDULE_STATUS.STUDENT_LEAVE) {
      actionsHtml += `
        ${status === SCHEDULE_STATUS.SCHEDULED ? `
        <button data-act="checkin" class="w-full py-3 rounded-xl font-bold text-sm bg-emerald-500 text-white hover:bg-emerald-600 transition flex items-center justify-center gap-2">
          <i class="fa-solid fa-circle-check"></i> 消课签到（${getLessonCost(schedule)}节）
        </button>` : ''}
        <button data-act="leave" class="w-full py-3 rounded-xl font-bold text-sm bg-rose-50 text-rose-600 border border-rose-200 hover:bg-rose-100 transition flex items-center justify-center gap-2">
          <i class="fa-solid fa-person-walking-arrow-right"></i> 学员请假（退还${getLessonCost(schedule)}节）${status === SCHEDULE_STATUS.COMPLETED ? ' · 改请假' : ''}
        </button>
        ${status === SCHEDULE_STATUS.COMPLETED ? `
        <button data-act="revert" class="w-full py-3 rounded-xl font-bold text-sm lm-btn-ink text-white transition flex items-center justify-center gap-2">
          <i class="fa-solid fa-rotate-left"></i> 撤销消课（还原为待上课）
        </button>` : ''}
      `;
    } else {
      actionsHtml += `
        <button data-act="revert" class="w-full py-3 rounded-xl font-bold text-sm lm-btn-ink text-white transition flex items-center justify-center gap-2">
          <i class="fa-solid fa-rotate-left"></i> 撤销状态（还原为待上课）
        </button>
      `;
    }
    actionsHtml += `
      <button data-act="edit" class="w-full py-3 rounded-xl font-bold text-sm btn-quiet transition flex items-center justify-center gap-2">
        <i class="fa-solid fa-pen-to-square"></i> 编辑课程信息
      </button>
      <button data-act="delete" class="w-full py-3 rounded-xl font-bold text-sm bg-rose-50 text-rose-600 border border-rose-200 hover:bg-rose-100 transition flex items-center justify-center gap-2">
        <i class="fa-solid fa-trash-can"></i> 删除该课程
      </button>
    `;

    const statusText = status === SCHEDULE_STATUS.COMPLETED ? '已消课 ✓' : status === SCHEDULE_STATUS.STUDENT_LEAVE ? '学员请假 🏖️' : '待上课';
    menu.innerHTML = `
      <div class="bg-white rounded-2xl shadow-2xl w-full max-w-xs p-5 space-y-2.5">
        <div class="pb-3 border-b lm-hairline">
          <div class="font-bold text-sm lm-t1">${schedule.studentName} · ${schedule.subject}</div>
          <div class="text-[11px] lm-t3 mt-0.5">${schedule.date} ${schedule.startTime} · ${schedule.durationMinutes}分钟 · 状态：${statusText}</div>
          ${student && getStudentDebts(student.id).length ? `<div class="text-[10px] text-rose-500 mt-1">⚠ 该学员有欠课：${getStudentDebts(student.id).map(d => d.courseName + ' ' + d.amount + '节').join('、')}</div>` : ''}
        </div>
        ${actionsHtml}
        <button data-act="close" class="w-full py-2 lm-t3 text-xs hover:lm-t2 transition">取消</button>
      </div>
    `;

    menu.addEventListener('click', (e) => {
      if (e.target === menu) { menu.remove(); return; }
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      menu.remove();
      if (act === 'checkin') executeCheckIn(schedule.id);
      else if (act === 'leave') markStudentLeave(schedule.id);
      else if (act === 'revert') revertScheduleStatus(schedule.id);
      else if (act === 'edit') openScheduleModalForEdit(schedule);
      else if (act === 'delete') {
        deleteScheduleWithScope(schedule);
      }
    });

    document.body.appendChild(menu);
  }

  // ==========================================
  // 9. 冲突检测算法
  // ==========================================
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
              // 只提示冲突类型，不再带课室名（与手机端文案保持一致）
              reasonsA.push(`课室冲突`);
              reasonsB.push(`课室冲突`);
            }

            const teachersInA = [
              { id: a.teacherId, name: a.teacherName },
              { id: a.assistantTeacherId, name: a.assistantTeacherName },
            ].filter((t) => t.id);

            const teachersInB = [
              { id: b.teacherId, name: b.teacherName },
              { id: b.assistantTeacherId, name: b.assistantTeacherName },
            ].filter((t) => t.id);

            teachersInA.forEach((tA) => {
              const matchedB = teachersInB.find((tB) => tB.id === tA.id);
              if (matchedB) {
                reasonsA.push(`老师[${tA.name}]撞课`);
                reasonsB.push(`老师[${tA.name}]撞课`);
              }
            });

            if (a.studentId && b.studentId && a.studentId === b.studentId) {
              reasonsA.push(`学员[${a.studentName}]撞课`);
              reasonsB.push(`学员[${b.studentName}]撞课`);
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

  // ==========================================
  // 10. 排课 Modal 弹窗控制
  // ==========================================
  // ============ FAB 选学员弹层 ============
  function hideFabStudentPicker() {
    document.getElementById('fabStudentPicker')?.classList.add('hidden');
    document.getElementById('fabStudentPickerBackdrop')?.classList.add('hidden');
  }

  function toggleFabStudentPicker() {
    const picker = document.getElementById('fabStudentPicker');
    if (!picker) return;
    if (!picker.classList.contains('hidden')) { hideFabStudentPicker(); return; }
    renderFabStudentList();
    picker.classList.remove('hidden');
    document.getElementById('fabStudentPickerBackdrop')?.classList.remove('hidden');
  }

  function renderFabStudentList() {
    const listEl = document.getElementById('fabStudentList');
    if (!listEl) return;
    if (!students.length) {
      listEl.innerHTML = '<div class="text-[11px] text-[#a8a29e] text-center py-4">还没有学员，请先到「学员」页新建</div>';
      return;
    }
    listEl.innerHTML = students.map((st) => {
      const total = (st.courses || []).reduce((acc, c) => acc + (c.remainingLessons || 0), 0);
      const avTheme = getThemeBadgeStyle(st.colorTheme || 'amber');
      return `
      <button type="button" data-fab-student="${st.id}" class="w-full flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-[#faf8f3] transition text-left">
        <span class="w-7 h-7 rounded-full ${avTheme.bg} ${avTheme.text} flex items-center justify-center font-bold text-[11px] shrink-0">${(st.name || '?').substring(0, 1)}</span>
        <span class="flex-1 min-w-0">
          <span class="block text-xs font-bold text-[#111111] truncate">${st.name || ''}</span>
          <span class="block text-[10px] lm-t3">剩 ${total} 课时</span>
        </span>
        <i class="fa-solid fa-chevron-right text-[9px] text-[#d6d3d1]"></i>
      </button>`;
    }).join('');
    listEl.querySelectorAll('[data-fab-student]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const st = students.find((s) => s.id === btn.getAttribute('data-fab-student'));
        hideFabStudentPicker();
        if (!st) return;
        // 默认今天 + 下一个整半点（8:00-20:00 之间）
        const now = new Date();
        const dateStr = now.toLocaleDateString('sv');
        const slot = Math.ceil((now.getHours() * 60 + now.getMinutes() + 1) / 30) * 30;
        let hour = Math.floor(slot / 60), min = slot % 60;
        if (hour > 20) { hour = 20; min = 0; }
        if (hour < 8) { hour = 8; min = 0; }
        openScheduleModalForNew(st, dateStr, `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
      });
    });
  }

  function openScheduleModalForNew(student, dateStr, startTimeStr) {
    normalizeStudent(student);

    const titleEl = document.getElementById('modalScheduleTitle');
    if (titleEl) titleEl.textContent = '安排新课程';

    const idEl = document.getElementById('inputScheduleId');
    if (idEl) idEl.value = '';

    const stIdEl = document.getElementById('inputStudentId');
    if (stIdEl) stIdEl.value = student.id;

    const avEl = document.getElementById('modalStudentAvatar');
    if (avEl) {
      avEl.textContent = student.name.substring(0, 1);
      // 头像沿用学员专属配色（琥珀是头像调色板唯一允许出现的琥珀）
      const avTheme = getThemeBadgeStyle(student.colorTheme || 'amber');
      avEl.className = `w-8 h-8 rounded-full ${avTheme.bg} ${avTheme.text} flex items-center justify-center font-bold text-xs`;
    }

    const nameEl = document.getElementById('modalStudentName');
    if (nameEl) nameEl.textContent = student.name;

    const totalLessons = student.courses.reduce((acc, c) => acc + c.remainingLessons, 0);
    const metaEl = document.getElementById('modalStudentMeta');
    if (metaEl) metaEl.textContent = `${student.courses.length}门课程在读 | 总剩 ${totalLessons} 课时`;

    const dateEl = document.getElementById('inputCourseDate');
    if (dateEl) dateEl.value = dateStr;

    const timeEl = document.getElementById('inputStartTime');
    if (timeEl) timeEl.value = startTimeStr;

    const durEl = document.getElementById('selectDuration');
    if (durEl) durEl.value = '60';

    const roomEl = document.getElementById('inputRoom');
    if (roomEl) roomEl.value = '琴房 101';

    const noteEl = document.getElementById('inputNotes');
    if (noteEl) noteEl.value = '';

    const courseSelect = document.getElementById('selectStudentCourse');
    if (courseSelect) {
      courseSelect.innerHTML = '';
      student.courses.forEach((c) => {
        courseSelect.innerHTML += `<option value="${c.id}" data-name="${c.name}">${c.name} (剩余 ${c.remainingLessons} 课时)</option>`;
      });
    }

    // 科目：新增时留空（保存时自动等于课程包名），候选来自课程类型
    renderCourseTypesDatalist();
    const subjectElNew = document.getElementById('inputSubject');
    if (subjectElNew) {
      subjectElNew.value = '';
      if (courseSelect && courseSelect.options[courseSelect.selectedIndex]) {
        subjectElNew.value = courseSelect.options[courseSelect.selectedIndex].getAttribute('data-name') || '';
      }
    }

    renderTeacherOptions();

    const delBtn = document.getElementById('btnDeleteSchedule');
    if (delBtn) delBtn.classList.add('hidden');

    // 重复排课：仅新增时显示，默认"不重复"，结束日期默认3个月后
    const repeatBlock = document.getElementById('repeatOptionsBlock');
    const ruleEl = document.getElementById('selectRepeatRule');
    const endWrap = document.getElementById('repeatEndDateWrap');
    const endEl = document.getElementById('inputRepeatEndDate');
    const hintEl = document.getElementById('repeatHint');
    if (repeatBlock) repeatBlock.classList.remove('hidden');
    if (ruleEl) ruleEl.value = 'none';
    if (endWrap) endWrap.classList.add('hidden');
    if (endEl) {
      const def = new Date();
      def.setMonth(def.getMonth() + 3);
      endEl.value = formatDate(def);
    }
    if (hintEl) hintEl.classList.add('hidden');

    // 新增模式：隐藏系列批量修改块
    const seriesBlockNew = document.getElementById('seriesEditBlock');
    if (seriesBlockNew) seriesBlockNew.classList.add('hidden');

    showModal('modalSchedule');
  }

  function openScheduleModalForEdit(schedule) {
    const student = students.find((st) => st.id === schedule.studentId) || {
      name: schedule.studentName,
      courses: [{ id: schedule.courseId || 'default', name: schedule.subject, remainingLessons: 0 }],
    };
    normalizeStudent(student);

    const titleEl = document.getElementById('modalScheduleTitle');
    if (titleEl) titleEl.textContent = '修改课程排期';

    const idEl = document.getElementById('inputScheduleId');
    if (idEl) idEl.value = schedule.id;

    const stIdEl = document.getElementById('inputStudentId');
    if (stIdEl) stIdEl.value = schedule.studentId;

    const avEl = document.getElementById('modalStudentAvatar');
    if (avEl) {
      avEl.textContent = student.name.substring(0, 1);
      // 头像沿用学员专属配色（琥珀是头像调色板唯一允许出现的琥珀）
      const avTheme = getThemeBadgeStyle(student.colorTheme || 'amber');
      avEl.className = `w-8 h-8 rounded-full ${avTheme.bg} ${avTheme.text} flex items-center justify-center font-bold text-xs`;
    }

    const nameEl = document.getElementById('modalStudentName');
    if (nameEl) nameEl.textContent = student.name;

    const totalLessons = student.courses.reduce((acc, c) => acc + c.remainingLessons, 0);
    const metaEl = document.getElementById('modalStudentMeta');
    if (metaEl) metaEl.textContent = `${student.courses.length}门课程在读 | 总剩 ${totalLessons} 课时`;

    const dateEl = document.getElementById('inputCourseDate');
    if (dateEl) dateEl.value = schedule.date;

    const timeEl = document.getElementById('inputStartTime');
    if (timeEl) timeEl.value = schedule.startTime;

    const durEl = document.getElementById('selectDuration');
    if (durEl) durEl.value = String(schedule.durationMinutes);

    const roomEl = document.getElementById('inputRoom');
    if (roomEl) roomEl.value = schedule.room || '';

    const noteEl = document.getElementById('inputNotes');
    if (noteEl) noteEl.value = schedule.notes || '';

    const courseSelect = document.getElementById('selectStudentCourse');
    if (courseSelect) {
      courseSelect.innerHTML = '';
      student.courses.forEach((c) => {
        const selected = c.id === schedule.courseId || c.name === schedule.subject ? 'selected' : '';
        courseSelect.innerHTML += `<option value="${c.id}" data-name="${c.name}" ${selected}>${c.name} (剩余 ${c.remainingLessons} 课时)</option>`;
      });
    }

    // 科目：编辑时回填已存的值，候选来自课程类型
    renderCourseTypesDatalist();
    const subjectElEdit = document.getElementById('inputSubject');
    if (subjectElEdit) subjectElEdit.value = schedule.subject || '';

    renderTeacherOptions();
    const tEl = document.getElementById('selectTeacher');
    if (tEl && schedule.teacherId) tEl.value = schedule.teacherId;

    const aEl = document.getElementById('selectAssistantTeacher');
    if (aEl && schedule.assistantTeacherId) aEl.value = schedule.assistantTeacherId;

    // 课卡颜色跟随学员，排课弹窗不再提供单独选色
    const delBtn = document.getElementById('btnDeleteSchedule');
    if (delBtn) delBtn.classList.remove('hidden');

    // 编辑模式隐藏重复排课块，改为显示"系列批量修改"块（若属于系列）
    const repeatBlock = document.getElementById('repeatOptionsBlock');
    if (repeatBlock) repeatBlock.classList.add('hidden');

    const seriesBlock = document.getElementById('seriesEditBlock');
    const seriesChk = document.getElementById('chkApplyToSeries');
    const seriesHint = document.getElementById('seriesEditHint');
    if (seriesChk) seriesChk.checked = false;
    if (seriesBlock) {
      const laterCount = seriesLaterSiblings(schedule).filter((s) => s.status === 'scheduled').length;
      if (laterCount > 0) {
        seriesBlock.classList.remove('hidden');
        updateSeriesHint(); // 文案随日期框实时变化（含「周四 → 周五」的平移提示）
      } else {
        seriesBlock.classList.add('hidden');
      }
    }

    showModal('modalSchedule');
  }

  function closeScheduleModal() {
    hideModal('modalSchedule');
  }

  function handleSaveSchedule(e) {
    e.preventDefault();
    const schId = document.getElementById('inputScheduleId').value;
    const studentId = document.getElementById('inputStudentId').value;
    const student = students.find((st) => st.id === studentId);

    const courseSelect = document.getElementById('selectStudentCourse');
    const courseId = courseSelect ? courseSelect.value : '';
    const courseOpt = courseSelect ? courseSelect.options[courseSelect.selectedIndex] : null;
    const courseName = courseOpt ? courseOpt.getAttribute('data-name') : '通用课程';
    // 科目独立字段：留空则等于课程包名（兼容旧数据）
    const subjectInputEl = document.getElementById('inputSubject');
    let subject = subjectInputEl ? subjectInputEl.value.trim() : '';
    if (!subject) subject = courseName;
    // 现场输入的新科目自动收录进课程类型，下次可下拉选
    addCourseType(subject);

    const tSelect = document.getElementById('selectTeacher');
    const teacherId = tSelect ? tSelect.value : '';
    const teacher = teachers.find((t) => t.id === teacherId);
    const teacherName = teacher ? teacher.name : '';

    const aSelect = document.getElementById('selectAssistantTeacher');
    const assistantTeacherId = aSelect ? aSelect.value : '';
    const assistantTeacher = teachers.find((t) => t.id === assistantTeacherId);
    const assistantTeacherName = assistantTeacher ? assistantTeacher.name : '';

    const date = document.getElementById('inputCourseDate').value;
    const startTime = document.getElementById('inputStartTime').value;
    const durationMinutes = parseInt(document.getElementById('selectDuration').value, 10);
    const room = document.getElementById('inputRoom').value.trim();
    const notes = document.getElementById('inputNotes') ? document.getElementById('inputNotes').value.trim() : '';
    // 课卡颜色统一跟随学员头像色（排课弹窗不再单独选色）
    const colorTheme = (student && student.colorTheme) || 'amber';

    if (schId) {
      const index = schedules.findIndex((s) => s.id === schId);
      if (index !== -1) {
        // 系列成员清单必须基于「修改前」的原始课来计算：
        // seriesLaterSiblings 用日期/时间做边界，改完再算会把自己之后的课漏掉
        const prev = { ...schedules[index] };
        const seriesList = seriesLaterSiblings(prev).filter((s) => s.status === SCHEDULE_STATUS.SCHEDULED);
        const shiftDays = diffDays(prev.date, date);
        const applyToSeries = document.getElementById('chkApplyToSeries');
        const willSync = !!(applyToSeries && applyToSeries.checked);
        if (willSync) pushUndo('批量修改系列', schedules[index].id);
        schedules[index] = {
          ...schedules[index],
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
          notes,
          colorTheme,
        };
        // 系列批量修改：勾选后同步本节之后的待上课系列成员
        if (willSync) {
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
                dateSkipped++; // 撞课的那节保留原日期，其余照改
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
          offerUndo(msg, 'layer-group', '批量修改系列');
        } else {
          showToast('课程排期修改成功！', 'check');
        }
      }
    } else {
      // 重复排课：按每周/隔周生成，冲突跳过，最多52节
      const rule = document.getElementById('selectRepeatRule') ? document.getElementById('selectRepeatRule').value : 'none';
      const endDateStr = document.getElementById('inputRepeatEndDate') ? document.getElementById('inputRepeatEndDate').value : '';
      const seriesId = rule !== 'none' && endDateStr ? 'ser_' + Date.now() : undefined;

      const makeSchedule = (id, d) => ({
        id,
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
        notes,
        colorTheme,
        ...(seriesId ? { seriesId } : {}),
      });
      schedules.push(makeSchedule('sch_' + Date.now(), date));

      // 课时在消课时扣除（App 语义），排课不再扣

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
          // 冲突检测：同一天同一时段同一老师已有课 → 跳过
          const clash = schedules.some((s) => s.date === dStr && s.startTime === startTime && (s.teacherId === teacherId || (assistantTeacherId && s.assistantTeacherId === assistantTeacherId)));
          if (clash) {
            skipped++;
            continue;
          }
          schedules.push(makeSchedule('sch_' + Date.now() + '_' + created, dStr));
          created++;
        }
        let msg = `已排 ${created + 1} 节课（含首次）`;
        if (skipped > 0) msg += `，${skipped} 节因时段冲突被跳过`;
        showToast(`📅 ${msg}`, 'circle-check');
      } else {
        showToast(`已成功为 [${student ? student.name : ''}] 安排【${subject}】课程！`, 'circle-check');
      }
    }

    saveData();
    closeScheduleModal();
    refreshView();

    const updatedConflicts = detectScheduleConflicts();
    const currentSchId = schId || schedules[schedules.length - 1].id;
    // 保存后高亮刚改/刚建的那一节，让改动有落点
    if (window.uiAnim) window.uiAnim.flashSchedule(currentSchId);
    if (updatedConflicts.has(currentSchId)) {
      const info = updatedConflicts.get(currentSchId);
      setTimeout(() => {
        showToast(`⚠️ 警告: 检测到 ${info.reasons.join('; ')}`, 'triangle-exclamation');
      }, 500);
    }
  }

  function handleDeleteSchedule() {
    const schId = document.getElementById('inputScheduleId').value;
    if (!schId) return;
    const sch = schedules.find((s) => s.id === schId);
    if (!sch) return;
    deleteScheduleWithScope(sch, () => closeScheduleModal());
  }

  // ==========================================
  // 11. 教师管理 Modal 弹窗控制
  // ==========================================
  // ==========================================
  // 课程类型（courseTypes）：统一科目名 + 历史课程名归并
  // ==========================================

  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function ensureCourseTypes() {
    if (!Array.isArray(courseTypes)) courseTypes = [];
    if (courseTypes.length === 0) {
      courseTypes = ['钢琴', '美术', '乐理', '吉他'].map((n) => ({ id: 'ct_' + n, name: n }));
    }
  }

  // 新科目名入库（同名不重复加）。返回 true 表示确实是新增
  function addCourseType(name) {
    const n = (name || '').trim();
    if (!n) return false;
    ensureCourseTypes();
    if (courseTypes.some((ct) => ct.name === n)) return false;
    courseTypes.push({ id: 'ct_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), name: n });
    return true;
  }

  function renderCourseTypesDatalist() {
    const dl = document.getElementById('courseTypesList');
    if (!dl) return;
    ensureCourseTypes();
    dl.innerHTML = courseTypes.map((ct) => `<option value="${escAttr(ct.name)}"></option>`).join('');
  }

  // 某个科目名在业务里被用到多少次（课程包数 / 排课节数）
  function courseTypeUsage(name) {
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

  function renderCourseTypesList() {
    const container = document.getElementById('courseTypesListContainer');
    if (!container) return;
    ensureCourseTypes();
    renderCourseTypesDatalist();
    container.innerHTML = '';

    if (courseTypes.length === 0) {
      container.innerHTML = `<div class="lm-t3 text-center py-4">还没有课程类型，先在下面添加</div>`;
      return;
    }

    courseTypes.forEach((ct) => {
      const u = courseTypeUsage(ct.name);
      const item = document.createElement('div');
      item.className = 'flex items-center justify-between p-2.5 lm-section rounded-xl text-xs';
      item.innerHTML = `
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-8 h-8 rounded-lg bg-[#111111] text-white font-bold flex items-center justify-center text-[10px] shrink-0">
            <i class="fa-solid fa-tag"></i>
          </div>
          <div class="min-w-0">
            <div class="font-bold lm-t1 truncate">${escAttr(ct.name)}</div>
            <div class="text-[10px] lm-t2">${u.packages} 个课程包 · ${u.lessons} 节排课在用</div>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button class="btn-rename-coursetype lm-t3 hover:text-sky-600 transition px-2 py-1" title="改名">
            <i class="fa-solid fa-pen"></i>
          </button>
          <button class="btn-del-coursetype lm-t3 hover:text-rose-600 transition px-2 py-1" title="删除">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </div>
      `;

      item.querySelector('.btn-rename-coursetype').addEventListener('click', () => {
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
        renderCourseTypesList();
        showToast(`已改名为「${n}」。历史数据请用下面的「归并」处理`, 'pen');
      });

      item.querySelector('.btn-del-coursetype').addEventListener('click', () => {
        const used = u.packages + u.lessons;
        const warn = used > 0
          ? `「${ct.name}」目前有 ${u.packages} 个课程包、${u.lessons} 节排课在用。\n删除只是不再出现在下拉里，已有数据不会改。确定删除吗？`
          : `确定删除课程类型「${ct.name}」吗？`;
        if (!confirm(warn)) return;
        courseTypes = courseTypes.filter((x) => x.id !== ct.id);
        saveData();
        renderCourseTypesList();
        showToast(`已删除课程类型「${ct.name}」`, 'trash');
      });

      container.appendChild(item);
    });
  }

  function openCourseTypesModal() {
    renderCourseTypesList();
    showModal('modalCourseTypes');
  }

  // 扫描数据里出现过的所有课程名（课程包 + 排课科目）
  function collectCourseNameStats() {
    const map = new Map();
    const bump = (name, kind) => {
      const n = (name || '').trim();
      if (!n) return;
      if (!map.has(n)) map.set(n, { name: n, packages: 0, lessons: 0, debts: 0 });
      map.get(n)[kind] += 1;
    };
    students.forEach((s) => (s.courses || []).forEach((c) => bump(c.name, 'packages')));
    schedules.forEach((s) => bump(s.subject, 'lessons'));
    // 欠课账也按课程名匹配，一并纳入候选（否则只有欠课记录的科目归并不到）
    debts.forEach((d) => bump(d.courseName, 'debts'));
    return [...map.values()].sort((a, b) => (b.packages + b.lessons) - (a.packages + a.lessons));
  }

  function openCourseMergeModal() {
    const list = document.getElementById('courseMergeList');
    if (!list) return;
    ensureCourseTypes();
    renderCourseTypesDatalist();

    const stats = collectCourseNameStats();
    const known = new Set(courseTypes.map((c) => c.name));
    // 已经是标准类型的不用归并（除非它同时也是别名，这里只处理名字不在清单里的）
    const rows = stats.filter((s) => !known.has(s.name));

    if (rows.length === 0) {
      list.innerHTML = `<div class="lm-t3 text-center py-6">数据里的课程名都已是标准课程类型，没有需要归并的 👍</div>`;
      showModal('modalCourseMerge');
      return;
    }

    const options = courseTypes.map((c) => `<option value="${escAttr(c.name)}">${escAttr(c.name)}</option>`).join('');
    list.innerHTML = rows.map((r, i) => `
      <div class="merge-row flex items-center gap-2 p-2 lm-section rounded-xl" data-old="${escAttr(r.name)}">
        <input type="checkbox" class="merge-check rounded border-[#e3dbd0] shrink-0" checked>
        <div class="min-w-0 flex-1">
          <div class="font-bold lm-t1 truncate">${escAttr(r.name)}</div>
          <div class="text-[10px] lm-t3">${r.packages} 个课程包 · ${r.lessons} 节排课${r.debts ? ` · ${r.debts} 条欠课` : ''}</div>
        </div>
        <i class="fa-solid fa-arrow-right lm-t3 text-[10px] shrink-0"></i>
        <select class="merge-target px-2 py-1.5 lm-field rounded-lg text-xs font-semibold lm-t1 shrink-0 max-w-[9rem]">
          <option value="">（选择目标类型）</option>
          ${options}
        </select>
      </div>
    `).join('');

    const all = document.getElementById('chkMergeSelectAll');
    if (all) all.checked = true;
    showModal('modalCourseMerge');
  }

  function applyCourseMerge() {
    const rows = document.querySelectorAll('#courseMergeList .merge-row');
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
    if (!confirm(`即将归并 ${picked} 个课程名：\n\n${summary}\n\n会同步改动：学员课程包名、排课科目、欠课账。\n历史消课流水里的科目名保持原样（那是当时的记录）。\n\n确定应用吗？`)) return;

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
    // 欠课账按 courseName 匹配，跟着改；改完可能有重复键，合并成一条
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

    Object.values(mapping).forEach((n) => addCourseType(n));
    saveData();
    refreshView();
    hideModal('modalCourseMerge');
    renderCourseTypesList();
    offerUndo(`已归并 ${picked} 个课程名（${touchedPackages} 个课程包 / ${touchedLessons} 节排课）`, 'code-merge', `课程名归并 ${picked} 项`);
  }

  function openTeacherModal() {
    renderTeacherListInModal();
    showModal('modalTeacher');
  }

  function closeTeacherModal() {
    hideModal('modalTeacher');
  }

  function renderTeacherListInModal() {
    const container = document.getElementById('teacherListContainer');
    if (!container) return;
    container.innerHTML = '';

    if (teachers.length === 0) {
      container.innerHTML = `<div class="lm-t3 text-center py-4">暂无教师记录</div>`;
      return;
    }

    teachers.forEach((t) => {
      const item = document.createElement('div');
      item.className = 'flex items-center justify-between p-2.5 lm-section rounded-xl text-xs';
      item.innerHTML = `
        <div class="flex items-center gap-2.5">
          <div class="w-8 h-8 rounded-full bg-[#111111] text-white font-bold flex items-center justify-center text-xs">
            ${t.name.substring(0, 1)}
          </div>
          <div>
            <div class="font-bold lm-t1">${t.name}</div>
            <div class="text-[10px] lm-t2">主讲: ${t.subject || '全科'}${t.accessPin ? ` · 访问码 <b class="lm-t1">${t.accessPin}</b>` : ' · 未开通访问'}</div>
          </div>
        </div>
        <div class="flex items-center gap-1">
          <button class="btn-pin-teacher text-[10px] font-bold px-2 py-1 rounded-lg ${t.accessPin ? 'btn-quiet' : 'bg-sky-100 text-sky-700 hover:bg-sky-200'} transition" data-id="${t.id}">${t.accessPin ? '换码' : '生成访问码'}</button>
          <button class="btn-del-teacher lm-t3 hover:text-rose-600 transition px-2 py-1" title="删除教师" data-id="${t.id}">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </div>
      `;

      item.querySelector('.btn-pin-teacher').addEventListener('click', () => {
        const pin = String(Math.floor(1000 + Math.random() * 9000));
        t.accessPin = pin;
        saveData();
        renderTeacherListInModal();
        showToast(`[${t.name}] 老师访问码：${pin}（请微信私发给她）`, 'key');
      });

      item.querySelector('.btn-del-teacher').addEventListener('click', () => {
        if (confirm(`确定要删除 [${t.name}] 老师记录吗？`)) {
          teachers = teachers.filter((x) => x.id !== t.id);
          saveData();
          renderTeacherOptions();
          renderTeacherListInModal();
          refreshView();
          showToast('已成功删除教师', 'trash');
        }
      });

      container.appendChild(item);
    });
  }

  function handleAddTeacher(e) {
    e.preventDefault();
    const nameInput = document.getElementById('teacherNameInput');
    const subjectInput = document.getElementById('teacherSubjectInput');

    const name = nameInput ? nameInput.value.trim() : '';
    const subject = subjectInput ? subjectInput.value.trim() : '通用科目';

    if (!name) return;

    const newTeacher = {
      id: 't_' + Date.now(),
      name,
      subject,
      colorTheme: getRandomColorTheme(),
    };

    teachers.push(newTeacher);
    saveData();

    if (nameInput) nameInput.value = '';
    if (subjectInput) subjectInput.value = '';

    renderTeacherOptions();
    renderTeacherListInModal();
    refreshView();
    showToast(`已添加新任课老师 [${name}]`, 'user-check');
  }

  // ==========================================
  // 12. 学生 Modal 弹窗控制
  // ==========================================
  function openStudentModal(student = null) {
    if (student) {
      normalizeStudent(student);
      const titleEl = document.getElementById('modalStudentTitle');
      if (titleEl) titleEl.textContent = '编辑学员及课程';

      const idEl = document.getElementById('editStudentId');
      if (idEl) idEl.value = student.id;

      const nameEl = document.getElementById('studentNameInput');
      if (nameEl) nameEl.value = student.name;

      const phoneEl = document.getElementById('studentPhoneInput');
      if (phoneEl) phoneEl.value = student.phone || '';

      const colorEl = document.getElementById('studentColorSelect');
      if (colorEl) colorEl.value = student.colorTheme || 'amber';

      const delBtn = document.getElementById('btnDeleteStudent');
      if (delBtn) delBtn.classList.remove('hidden');

      renderStudentCoursesModalRows(student.courses);
    } else {
      const titleEl = document.getElementById('modalStudentTitle');
      if (titleEl) titleEl.textContent = '添加新学员';

      const idEl = document.getElementById('editStudentId');
      if (idEl) idEl.value = '';

      const form = document.getElementById('formStudent');
      if (form) form.reset();

      const randomColor = getRandomColorTheme();
      const colorEl = document.getElementById('studentColorSelect');
      if (colorEl) colorEl.value = randomColor;

      const delBtn = document.getElementById('btnDeleteStudent');
      if (delBtn) delBtn.classList.add('hidden');

      renderStudentCoursesModalRows([{ id: 'c_new_' + Date.now(), name: '钢琴一对一', remainingLessons: 10 }]);
    }
    showModal('modalStudent');
  }

  function renderStudentCoursesModalRows(courses) {
    const container = document.getElementById('studentCoursesListContainer');
    if (!container) return;
    renderCourseTypesDatalist();
    container.innerHTML = '';

    courses.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'course-row flex items-center gap-2';
      row.innerHTML = `
        <input type="text" class="course-name-input flex-1 min-w-0 px-2.5 py-1.5 lm-field rounded-lg text-xs font-medium" placeholder="课程名称（如：钢琴一对一）" value="${c.name || ''}" required>
        <div class="flex items-center gap-1 shrink-0">
          <span class="lm-t3 text-[10px]">剩</span>
          <input type="number" class="course-lessons-input w-16 px-2 py-1.5 lm-field rounded-lg text-xs font-bold lm-t1" value="${c.remainingLessons ?? 10}" required>
          <span class="lm-t3 text-[10px]">课时</span>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <span class="lm-t3 text-[10px]">¥</span>
          <input type="number" min="0" step="0.01" inputmode="decimal" class="course-price-input w-16 px-2 py-1.5 border lm-hairline rounded-lg text-xs font-bold text-emerald-700 outline-none focus:ring-1 focus:ring-emerald-400" placeholder="单价" value="${c.unitPrice > 0 ? c.unitPrice : ''}" aria-label="课程单价（元/节）">
          <span class="lm-t3 text-[10px]">/节</span>
        </div>
        ${
          courses.length > 1
            ? `<button type="button" class="btn-remove-course-row lm-t3 hover:text-rose-500 px-1 py-1 transition" title="删除该课程"><i class="fa-solid fa-trash-can"></i></button>`
            : '<div class="w-5"></div>'
        }
      `;

      if (courses.length > 1) {
        row.querySelector('.btn-remove-course-row').addEventListener('click', () => {
          row.remove();
        });
      }

      container.appendChild(row);
    });
  }

  function addCourseRowToStudentModal() {
    const container = document.getElementById('studentCoursesListContainer');
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'course-row flex items-center gap-2 flex-wrap';
    row.innerHTML = `
      <input type="text" list="courseTypesList" class="course-name-input flex-1 min-w-0 px-2.5 py-1.5 lm-field rounded-lg text-xs font-medium" placeholder="课程名称（如：乐理基础）" required>
      <div class="flex items-center gap-1 shrink-0">
        <span class="lm-t3 text-[10px]">剩</span>
        <input type="number" class="course-lessons-input w-16 px-2 py-1.5 lm-field rounded-lg text-xs font-bold lm-t1" placeholder="可填负数=欠课" value="10" required>
        <span class="lm-t3 text-[10px]">课时</span>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <span class="lm-t3 text-[10px]">¥</span>
        <input type="number" min="0" step="0.01" inputmode="decimal" class="course-price-input w-16 px-2 py-1.5 border lm-hairline rounded-lg text-xs font-bold text-emerald-700 outline-none focus:ring-1 focus:ring-emerald-400" placeholder="单价" aria-label="课程单价（元/节）">
        <span class="lm-t3 text-[10px]">/节</span>
      </div>
      <button type="button" class="btn-remove-course-row lm-t3 hover:text-rose-500 px-1 py-1 transition" title="删除该课程"><i class="fa-solid fa-trash-can"></i></button>
    `;

    row.querySelector('.btn-remove-course-row').addEventListener('click', () => {
      row.remove();
    });

    container.appendChild(row);
  }

  function closeStudentModal() {
    hideModal('modalStudent');
  }

  function handleSaveStudent(e) {
    e.preventDefault();
    const editId = document.getElementById('editStudentId') ? document.getElementById('editStudentId').value : '';
    const nameInput = document.getElementById('studentNameInput');
    const name = nameInput ? nameInput.value.trim() : '';

    const phoneInput = document.getElementById('studentPhoneInput');
    const phone = phoneInput ? phoneInput.value.trim() : '';

    const colorSelect = document.getElementById('studentColorSelect');
    const colorTheme = colorSelect ? colorSelect.value : 'amber';

    const courseRows = document.querySelectorAll('#studentCoursesListContainer .course-row');
    const courses = [];
    courseRows.forEach((row, idx) => {
      const nameVal = row.querySelector('.course-name-input').value.trim() || '通用课程';
      const lessonsVal = parseInt(row.querySelector('.course-lessons-input').value, 10) || 0;
      const priceVal = parseFloat(row.querySelector('.course-price-input')?.value) || 0;
      courses.push({
        id: 'c_' + (editId || 'st') + '_' + idx + '_' + Date.now(),
        name: nameVal,
        remainingLessons: lessonsVal,
        unitPrice: priceVal,
      });
      // 现场输入的课程名自动收录进课程类型，下次建课包 / 排课可下拉选
      addCourseType(nameVal);
    });

    if (courses.length === 0) {
      alert('请至少为学员保留一门课程！');
      return;
    }

    if (editId) {
      const idx = students.findIndex((s) => s.id === editId);
      if (idx !== -1) {
        // 编辑：单价框留空（0）时沿用该课程原有单价，避免编辑资料清零已设好的价格
        const oldCourses = students[idx].courses || [];
        courses.forEach((c) => {
          if (!(c.unitPrice > 0)) {
            const old = oldCourses.find((o) => o.name === c.name);
            if (old && old.unitPrice > 0) c.unitPrice = old.unitPrice;
          }
        });
        students[idx] = { ...students[idx], name, phone, colorTheme, courses };
        showToast('学员信息及多课程更新成功', 'check');
      }
    } else {
      const newStudent = {
        id: 'st_' + Date.now(),
        name,
        phone,
        colorTheme,
        courses,
      };
      students.push(newStudent);
      showToast('成功添加新学员及课程！', 'user-check');
    }

    // 欠课账校准：编辑/新增学员后，负课时（欠课）同步进欠课账，财务页即时可见
    syncAllDebts();

    saveData();
    closeStudentModal();
    refreshView();
  }

  function handleDeleteStudent() {
    const editId = document.getElementById('editStudentId') ? document.getElementById('editStudentId').value : '';
    if (!editId) return;

    if (confirm('确定要删除该学员吗？该学员的所有课程记录及历史排课会被同步清理。')) {
      const victim = students.find((s) => s.id === editId);
      pushUndo(`删除学员 ${victim ? victim.name : ''}`);
      students = students.filter((s) => s.id !== editId);
      schedules = schedules.filter((sch) => sch.studentId !== editId);
      // 注意：这里不动 checkInLogs / debts —— 历史财务流水按原语义保留
      saveData();
      closeStudentModal();
      refreshView();
      offerUndo('已删除学员记录', 'trash', `删除学员 ${victim ? victim.name : ''}`);
    }
  }

  // ==========================================
  // 14. 导入课表功能 (支持 JS / JSON 文件及代码文本)
  // ==========================================
  function openImportModal() {
    const fileInput = document.getElementById('importFileInput');
    if (fileInput) fileInput.value = '';

    const nameEl = document.getElementById('importFileName');
    if (nameEl) nameEl.textContent = '未选择任何文件';

    const textEl = document.getElementById('importTextarea');
    if (textEl) textEl.value = '';

    showModal('modalImport');
  }

  function closeImportModal() {
    hideModal('modalImport');
  }

  function handleImportFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;

    const nameEl = document.getElementById('importFileName');
    if (nameEl) nameEl.textContent = file.name;

    const reader = new FileReader();
    reader.onload = function (evt) {
      const textEl = document.getElementById('importTextarea');
      if (textEl) textEl.value = evt.target.result;
    };
    reader.onerror = function () {
      showToast('文件读取失败，请重试！', 'triangle-exclamation');
    };
    reader.readAsText(file, 'UTF-8');
  }

  function parseImportData(rawText) {
    if (!rawText || !rawText.trim()) {
      throw new Error('导入数据内容为空，请选择文件或粘贴代码！');
    }

    let cleanText = rawText.trim();
    cleanText = cleanText.replace(/^(const|let|var)\s+\w+\s*=\s*/i, '');
    cleanText = cleanText.replace(/^(module\.exports\s*=\s*|export\s+default\s*)/i, '');
    cleanText = cleanText.replace(/;$/, '');

    let data = null;
    try {
      data = JSON.parse(cleanText);
    } catch (e1) {
      try {
        data = new Function('return (' + cleanText + ')')();
      } catch (e2) {
        throw new Error('解析失败：请确保格式为标准的 JSON 或 JS 数据代码！');
      }
    }

    if (!data || typeof data !== 'object') {
      throw new Error('数据解析异常：导入的数据不是有效的对象！');
    }

    return data;
  }

  function handleConfirmImport() {
    const textEl = document.getElementById('importTextarea');
    const rawText = textEl ? textEl.value : '';
    const mode = document.querySelector('input[name="importMode"]:checked')?.value || 'overwrite';

    try {
      const data = parseImportData(rawText);

      let importedStudentsCount = 0;
      let importedSchedulesCount = 0;

      if (data.teachers && Array.isArray(data.teachers)) {
        if (mode === 'overwrite') {
          teachers = data.teachers;
        } else {
          data.teachers.forEach((t) => {
            if (!teachers.some((x) => x.id === t.id)) teachers.push(t);
          });
        }
      }

      if (data.students && Array.isArray(data.students)) {
        const normalizedList = data.students.map(normalizeStudent);
        if (mode === 'overwrite') {
          students = normalizedList;
        } else {
          normalizedList.forEach((st) => {
            if (!students.some((x) => x.id === st.id)) students.push(st);
          });
        }
        importedStudentsCount = normalizedList.length;
      }

      if (data.schedules && Array.isArray(data.schedules)) {
        if (mode === 'overwrite') {
          schedules = data.schedules;
        } else {
          data.schedules.forEach((sch) => {
            if (!schedules.some((x) => x.id === sch.id)) schedules.push(sch);
          });
        }
        importedSchedulesCount = data.schedules.length;
      }

      saveData();
      renderTeacherOptions();
      refreshView();
      closeImportModal();

      showToast(`成功导入 ${importedStudentsCount} 位学员、${importedSchedulesCount} 节课表记录！`, 'file-import');
    } catch (err) {
      alert(err.message);
    }
  }

  // ==========================================
  // 15. 统计 & 工具函数
  // ==========================================
  // ==========================================
  // 撤销（Undo）：操作前整体快照，Toast 内 5 秒窗口一键回滚
  // 快照必须覆盖 4 个会被写入的集合 —— 漏掉 checkInLogs / debts
  // 会让回滚留下脏流水（财务对不上），这是本项目的高危点。
  // ==========================================
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
    refreshView();
    showToast(`↩️ 已撤销：${label}`, 'rotate-left');
    // 撤销后把恢复的那节课高亮一下，让「回到哪儿了」看得见
    if (window.uiAnim && flashId) window.uiAnim.flashSchedule(flashId);
  }

  // 提示 + 撤销入口。调用前必须已经在数据变更前执行过 pushUndo(label)
  function offerUndo(msg, icon, label) {
    if (!undoState) { showToast(msg, icon); return; }
    if (label) undoState.label = label;
    showToast(msg, icon, '撤销', () => runUndo());
    // 5 秒后撤销按钮随 Toast 一起消失，快照同时作废
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(clearUndo, 5200);
  }

  // 统计数字滚动：把上一次的值存在 data-lm-val，下次更新时从旧值滚到新值
  function setStatNumber(el, value, suffix, decimals = 0) {
    if (!el) return;
    const prev = parseFloat(el.dataset.lmVal || '');
    el.dataset.lmVal = String(value);
    if (!window.uiAnim || Number.isNaN(prev) || prev === value) {
      el.textContent = (decimals ? value.toFixed(decimals) : Math.round(value)) + suffix;
      return;
    }
    window.uiAnim.number(el, prev, value, decimals, suffix);
  }

  function updateStats() {
    const weekEnd = addDays(currentWeekStart, 6);
    let currentWeekSchedules = schedules.filter((s) => {
      const d = new Date(s.date);
      return d >= currentWeekStart && d <= weekEnd;
    });

    if (selectedTeacherFilter !== 'all') {
      currentWeekSchedules = currentWeekSchedules.filter((s) => s.teacherId === selectedTeacherFilter || s.assistantTeacherId === selectedTeacherFilter);
    }

    const totalCourses = currentWeekSchedules.length;
    const totalMinutes = currentWeekSchedules.reduce((acc, cur) => acc + cur.durationMinutes, 0);
    const totalHours = (totalMinutes / 60).toFixed(1);

    const cEl = document.getElementById('statWeeklyCourses');
    if (cEl) setStatNumber(cEl, totalCourses, ' 节');

    const hEl = document.getElementById('statWeeklyHours');
    if (hEl) setStatNumber(hEl, parseFloat(totalHours), ' 小时', 1);

    updateFinancePanel();
  }

  // ==========================================
  // 财务看板（简单版，移植自 Teacher-manager）
  // ==========================================
  function updateFinancePanel() {
    const panel = document.getElementById('financePanel');
    if (!panel) return;

    const now = new Date();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthLogs = checkInLogs.filter((l) => (l.checkInTime || '').startsWith(monthPrefix));

    const monthLessons = monthLogs.reduce((acc, l) => acc + (l.deductedLessons || 0), 0);
    const monthValue = monthLogs.reduce((acc, l) => acc + (l.paymentAmount || 0), 0);
    const totalRemaining = students.reduce(
      (acc, st) => acc + (st.courses || []).reduce((a, c) => a + Math.max(0, c.remainingLessons), 0), 0
    );
    const totalStockValue = students.reduce(
      (acc, st) => acc + (st.courses || []).reduce((a, c) => a + Math.max(0, c.remainingLessons) * (c.unitPrice || 0), 0), 0
    );
    const debtors = debts.filter((d) => d.amount > 0);

    panel.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <span class="text-[10px] font-bold lm-t3 uppercase tracking-wider">本月经营</span>
        <span class="text-[9px] lm-t3">${monthPrefix}</span>
      </div>
      <div class="grid grid-cols-2 gap-1.5">
        <div class="lm-soft rounded-lg p-2">
          <div class="text-[9px] lm-t3">本月课消</div>
          <div class="text-sm font-black lm-t1">${monthLessons.toFixed(1)} 节</div>
        </div>
        <div class="lm-soft rounded-lg p-2">
          <div class="text-[9px] lm-t3">课消价值</div>
          <div class="text-sm font-black lm-t1">¥${monthValue.toFixed(0)}</div>
        </div>
        <div class="lm-soft rounded-lg p-2">
          <div class="text-[9px] lm-t3">待消存量</div>
          <div class="text-sm font-black lm-t1">${totalRemaining.toFixed(1)} 节</div>
        </div>
        <div class="rounded-lg p-2" style="background:${debtors.length ? '#fff1f2' : '#faf7f2'};">
          <div class="text-[9px] ${debtors.length ? 'text-rose-600' : 'lm-t3'}">欠课学员</div>
          <div class="text-sm font-black ${debtors.length ? 'text-rose-600' : 'lm-t3'}">${debtors.length} 人</div>
        </div>
      </div>
      ${debtors.length ? `
      <div class="mt-2 space-y-1">
        ${debtors.map((d) => {
          const st = students.find((s) => s.id === d.studentId);
          return `<div class="flex items-center justify-between text-[10px] bg-rose-50/60 px-2 py-1 rounded-md">
            <span class="lm-t2 font-semibold">${st ? st.name : '未知学员'} · ${d.courseName}</span>
            <span class="text-rose-500 font-bold">欠 ${d.amount} 节</span>
          </div>`;
        }).join('')}
      </div>` : ''}
    `;
  }

  // 充值课时弹窗（新购/充值二合一，自动抵扣欠课）
  function openRechargeModal(student) {
    normalizeStudent(student);
    migrateStudentCourses(student);

    const old = document.getElementById('rechargeModal');
    if (old) old.remove();

    const courseOptions = (student.courses || [])
      .map((c) => `<option value="${c.name}">${c.name}（余 ${c.remainingLessons}）</option>`)
      .join('');

    const firstCourse = (student.courses || [])[0];

    const modal = document.createElement('div');
    modal.id = 'rechargeModal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.className = 'fixed inset-0 lm-scrim backdrop-blur-xs z-50 flex items-center justify-center p-4';
    modal.innerHTML = `
      <div class="bg-white rounded-2xl shadow-2xl w-full max-w-xs p-5 space-y-3" onclick="event.stopPropagation()">
        <div class="font-bold text-sm lm-t1 pb-2 border-b lm-hairline">
          <i class="fa-solid fa-circle-plus text-emerald-500"></i>
          为 ${student.name} 充值课时
        </div>
        <div>
          <label class="block text-[11px] font-semibold lm-t2 mb-1">课程</label>
          <select id="rechargeCourseSelect" class="w-full px-3 py-2 border lm-hairline rounded-xl text-xs outline-none focus:ring-2 focus:ring-emerald-300">
            ${courseOptions}
            <option value="__new__">➕ 新课程包...</option>
          </select>
        </div>
        <div id="rechargeNewNameWrap" class="hidden">
          <label class="block text-[11px] font-semibold lm-t2 mb-1">新课程名称</label>
          <input type="text" id="rechargeNewName" placeholder="如：美术一对一" class="w-full px-3 py-2 border lm-hairline rounded-xl text-xs outline-none focus:ring-2 focus:ring-emerald-300">
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-[11px] font-semibold lm-t2 mb-1">充值节数</label>
            <input type="number" id="rechargeLessons" min="1" value="10" class="w-full px-3 py-2 border lm-hairline rounded-xl text-xs font-bold outline-none focus:ring-2 focus:ring-emerald-300">
          </div>
          <div>
            <label class="block text-[11px] font-semibold lm-t2 mb-1">单价 (元/节)</label>
            <input type="number" id="rechargePrice" min="0" step="0.01" inputmode="decimal" value="${firstCourse && firstCourse.unitPrice > 0 ? firstCourse.unitPrice : ''}" placeholder="如 200" class="w-full px-3 py-2 border lm-hairline rounded-xl text-xs font-bold outline-none focus:ring-2 focus:ring-emerald-300">
          </div>
        </div>
        <div class="text-[10px] lm-t3">💡 若该课程有欠课，充值会自动抵扣</div>
        <div class="flex gap-2 pt-1">
          <button id="rechargeCancel" class="flex-1 py-2.5 rounded-xl btn-quiet font-bold text-xs">取消</button>
          <button id="rechargeConfirm" class="flex-1 py-2.5 rounded-xl bg-emerald-500 text-white font-bold text-xs hover:bg-emerald-600">确认充值</button>
        </div>
      </div>
    `;

    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);

    const courseSelect = modal.querySelector('#rechargeCourseSelect');
    courseSelect.addEventListener('change', () => {
      modal.querySelector('#rechargeNewNameWrap').classList.toggle('hidden', courseSelect.value !== '__new__');
      if (courseSelect.value !== '__new__') {
        const c = student.courses.find((x) => x.name === courseSelect.value);
        if (c && c.unitPrice > 0) modal.querySelector('#rechargePrice').value = c.unitPrice;
      }
    });
    modal.querySelector('#rechargeCancel').addEventListener('click', () => modal.remove());
    modal.querySelector('#rechargeConfirm').addEventListener('click', () => {
      const lessons = parseFloat(modal.querySelector('#rechargeLessons').value) || 0;
      const price = parseFloat(modal.querySelector('#rechargePrice').value) || 0;
      if (lessons <= 0) { showToast('请输入有效的充值节数', 'circle-info'); return; }
      let courseName = courseSelect.value;
      if (courseName === '__new__') {
        courseName = (modal.querySelector('#rechargeNewName').value || '').trim();
        if (!courseName) { showToast('请填写新课程名称', 'circle-info'); return; }
      }
      modal.remove();
      purchaseCoursePack(student.id, courseName, lessons, price);
    });
  }

  function exportScheduleData() {
    const jsonText = JSON.stringify({ students, schedules, teachers, courseTypes, checkInLogs, debts }, null, 2);

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(jsonText).then(() => {
        showToast('已复制全量课表数据！可直接粘贴发给手机导入', 'copy');
      }).catch(() => {});
    }

    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(jsonText);
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `课表导出_${formatDate(new Date())}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  }

  // 弹窗动效由 CSS 单一系统驱动（@starting-style 提供进场起点，.lm-modal-closing 触发退场）。
  // 不再叠 GSAP：两套系统争同一属性，且 CSS 的 !important 终态会让 GSAP 白跑。
  function showModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) {
      el.classList.remove('lm-modal-closing');
      el.classList.remove('hidden');
      setTimeout(() => el.classList.add('opacity-100'), 10);
    }
  }

  function hideModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) {
      el.classList.remove('opacity-100');
      el.classList.add('lm-modal-closing'); // CSS 退场：160ms（抽屉 200ms）
      setTimeout(() => {
        el.classList.add('hidden');
        el.classList.remove('lm-modal-closing');
      }, 210);
    }
  }

  function hideToast() {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.classList.add('translate-y-10', 'opacity-0', 'pointer-events-none');
    toast.classList.remove('translate-y-0', 'opacity-100');
    const actionBtn = document.getElementById('toastAction');
    if (actionBtn) { actionBtn.style.display = 'none'; actionBtn.onclick = null; }
  }

  let toastTimer = null;

  function showToast(msg, icon = 'circle-check', actionLabel = '', onAction = null) {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toastMsg');
    const toastIcon = document.getElementById('toastIcon');

    if (toast && toastMsg && toastIcon) {
      toastMsg.textContent = msg;
      toastIcon.className = `fa-solid fa-${icon} text-emerald-300`;

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
      // Toast 只走 CSS 过渡（见 styles.css #toast）；叠 GSAP 会被 transition-all 二次插值拖慢

      // 关键：新 Toast 必须清掉上一条的定时器，否则会提前把这条关掉
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(hideToast, actionLabel ? 5000 : 2800);
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

  // ==========================================
  // break-ui 压测模式（dev-only）
  // URL 带 ?lmData=worst / ?lmData=demo 时生效：worst=把「最坏但真实」的数据
  // 灌进内存渲染课表卡（超长姓名/课程名/四节重叠/30 分钟矮卡/爆满日等），
  // demo=常态对照组。只在内存里换数据：不落盘、不云同步、不动 localStorage。
  // ==========================================
  const LM_FIXTURE_MODE = (location.search.match(/[?&]lmData=(worst|demo)/) || [])[1] || '';

  function lmFmt(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function lmDay(offset) {
    const mon = getMonday(new Date());
    return lmFmt(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + offset));
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
  function lmFixtureSchedules() {
    let n = 0;
    const S = (o) => ({ id: 'wf' + ++n, status: 'scheduled', durationMinutes: 60, ...o });
    return [
      // 周一：短名+最短课+无老师无课室 / 全字段超长 / 四节同段重叠
      S({ date: lmDay(0), startTime: '08:00', durationMinutes: 30, studentId: 's1', studentName: '丁一', subject: '钢琴' }),
      S({ date: lmDay(0), startTime: '09:00', durationMinutes: 60, studentId: 's2', studentName: '欧阳梓萱', subject: '成人零基础钢琴速成班（VIP一对一）', teacherId: 't1', teacherName: '欧阳老师', assistantTeacherId: 't2', assistantTeacherName: '司马老师', room: '音乐教室A-301（三角钢琴房）' }),
      S({ date: lmDay(0), startTime: '10:00', durationMinutes: 45, studentId: 's2', studentName: '欧阳梓萱', subject: '钢琴', teacherId: 't1', teacherName: '欧阳老师', room: 'A-301' }),
      S({ date: lmDay(0), startTime: '10:15', durationMinutes: 45, studentId: 's3', studentName: 'Anastasia Kowalczyk-Wiśniewska', subject: 'Violin Masterclass Grade 8', teacherId: 't1', teacherName: '欧阳老师', room: 'A-301' }),
      S({ date: lmDay(0), startTime: '10:30', durationMinutes: 60, studentId: 's4', studentName: 'Christopher', subject: '声乐', teacherId: 't1', teacherName: '欧阳老师', room: 'A-301' }),
      S({ date: lmDay(0), startTime: '10:45', durationMinutes: 30, studentId: 's7', studentName: '🎵林晓彤', subject: '架子鼓', teacherId: 't1', teacherName: '欧阳老师', room: 'A-301' }),
      // 周二：超长拉丁名 / 已消课徽章 / 双原因冲突（30 分钟矮卡）
      S({ date: lmDay(1), startTime: '09:00', durationMinutes: 60, studentId: 's3', studentName: 'Anastasia Kowalczyk-Wiśniewska', subject: 'Violin Masterclass Grade 8', teacherId: 't2', teacherName: '司马老师', room: 'B-205' }),
      S({ date: lmDay(1), startTime: '11:00', durationMinutes: 60, studentId: 's4', studentName: 'Christopher', subject: '成人零基础钢琴速成班（VIP一对一）', teacherId: 't3', teacherName: '王老师', room: '音乐教室A-301（三角钢琴房）', status: 'completed' }),
      S({ date: lmDay(1), startTime: '13:00', durationMinutes: 30, studentId: 's2', studentName: '欧阳梓萱', subject: '钢琴', teacherId: 't3', teacherName: '王老师', room: 'A-301' }),
      S({ date: lmDay(1), startTime: '13:15', durationMinutes: 30, studentId: 's2', studentName: '欧阳梓萱', subject: '声乐', teacherId: 't3', teacherName: '王老师', room: 'A-301' }),
      // 周三：爆满日（12 节连排）+ 请假
      ...Array.from({ length: 12 }, (_, i) => S({
        date: lmDay(2), startTime: `${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`,
        durationMinutes: 30, studentId: 's' + (1 + (i % 8)), studentName: lmFixtureStudents()[i % 8].name,
        subject: i % 3 === 0 ? '成人零基础钢琴速成班（VIP一对一）' : '钢琴', teacherId: 't1', teacherName: '欧阳老师', room: 'A-301',
      })),
      S({ date: lmDay(2), startTime: '16:00', durationMinutes: 60, studentId: 's8', studentName: '司马相如', subject: '小提琴', teacherId: 't2', teacherName: '司马老师', room: 'B-205', status: 'student_leave' }),
      // 周四：单字名 / 120 分钟高卡 / 越南语声调字母
      S({ date: lmDay(3), startTime: '09:00', durationMinutes: 60, studentId: 's5', studentName: '李', subject: '声乐' }),
      S({ date: lmDay(3), startTime: '11:00', durationMinutes: 120, studentId: 's7', studentName: '🎵林晓彤', subject: '架子鼓', teacherId: 't1', teacherName: '欧阳老师', room: 'A-301' }),
      S({ date: lmDay(3), startTime: '14:00', durationMinutes: 60, studentId: 's6', studentName: 'Nguyễn Thị Minh Khai', subject: 'Ghi-ta cổ điển', teacherId: 't3', teacherName: '王老师', room: 'C-102' }),
      // 周四 17:00：两节 60 分钟并排（中等宽度）——验证「只留姓名+课程」
      S({ date: lmDay(3), startTime: '17:00', durationMinutes: 60, studentId: 's2', studentName: '欧阳梓萱', subject: '成人零基础钢琴速成班（VIP）', teacherId: 't1', teacherName: '欧阳老师', room: 'A-301' }),
      S({ date: lmDay(3), startTime: '17:00', durationMinutes: 60, studentId: 's3', studentName: 'Anastasia Kowalczyk-Wiśniewska', subject: 'Violin Masterclass Grade 8', teacherId: 't1', teacherName: '欧阳老师', room: 'A-301' }),
      // 周五：常态课对照
      S({ date: lmDay(4), startTime: '10:00', durationMinutes: 60, studentId: 's2', studentName: '欧阳梓萱', subject: '钢琴', teacherId: 't1', teacherName: '欧阳老师', room: 'A-301' }),
      S({ date: lmDay(4), startTime: '15:00', durationMinutes: 45, studentId: 's8', studentName: '司马相如', subject: '小提琴', teacherId: 't2', teacherName: '司马老师' }),
    ];
  }
  function lmDemoSchedules() {
    let n = 0;
    const S = (o) => ({ id: 'df' + ++n, status: 'scheduled', durationMinutes: 60, ...o });
    return [
      S({ date: lmDay(0), startTime: '09:00', durationMinutes: 60, studentId: 's1', studentName: '丁一', subject: '钢琴', teacherId: 't1', teacherName: '欧阳老师', room: 'A-301' }),
      S({ date: lmDay(0), startTime: '15:00', durationMinutes: 45, studentId: 's2', studentName: '欧阳梓萱', subject: '声乐', teacherId: 't3', teacherName: '王老师' }),
      S({ date: lmDay(1), startTime: '10:00', durationMinutes: 60, studentId: 's3', studentName: 'Anastasia Kowalczyk', subject: '小提琴', teacherId: 't2', teacherName: '司马老师', room: 'B-205' }),
      S({ date: lmDay(2), startTime: '14:00', durationMinutes: 30, studentId: 's4', studentName: 'Christopher', subject: '吉他', teacherId: 't3', teacherName: '王老师', room: 'C-102' }),
      S({ date: lmDay(4), startTime: '10:00', durationMinutes: 60, studentId: 's2', studentName: '欧阳梓萱', subject: '钢琴', teacherId: 't1', teacherName: '欧阳老师', room: 'A-301' }),
      S({ date: lmDay(4), startTime: '16:00', durationMinutes: 60, studentId: 's8', studentName: '司马相如', subject: '小提琴', teacherId: 't2', teacherName: '司马老师', status: 'completed' }),
    ];
  }

  function applyLmFixtures() {
    if (!LM_FIXTURE_MODE) return;
    window.__lmFixtures = true;
    if (LM_FIXTURE_MODE === 'worst') {
      students = lmFixtureStudents();
      teachers = lmFixtureTeachers();
      schedules = lmFixtureSchedules().map(normalizeSchedule);
    } else {
      students = lmFixtureStudents().slice(0, 4);
      teachers = lmFixtureTeachers();
      schedules = lmDemoSchedules().map(normalizeSchedule);
    }
    schoolSyncKey = ''; // 双保险：压测数据严禁写云端
    console.info(`[break-ui] lmData=${LM_FIXTURE_MODE} 已注入（仅内存，不落盘）`);
  }

  function renderLmFixtureToggle() {
    if (!LM_FIXTURE_MODE) return;
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;bottom:14px;left:50%;transform:translateX(-50%);z-index:9999;background:#fff;border:1px solid #e5e0d5;border-radius:999px;padding:3px;display:flex;gap:2px;box-shadow:0 4px 14px rgba(0,0,0,.12);font-size:12px;font-family:inherit;';
    [
      ['demo', '示例数据'],
      ['worst', '最坏数据'],
    ].forEach(([key, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      const active = key === LM_FIXTURE_MODE;
      b.style.cssText = `border:0;border-radius:999px;padding:5px 14px;cursor:pointer;font:inherit;${active ? 'background:#111;color:#fff;font-weight:700;' : 'background:transparent;color:#626260;'}`;
      b.onclick = () => {
        const u = new URL(location.href);
        u.searchParams.set('lmData', key);
        location.href = u.toString();
      };
      bar.appendChild(b);
    });
    document.body.appendChild(bar);
  }

  document.addEventListener('DOMContentLoaded', initApp);
})();

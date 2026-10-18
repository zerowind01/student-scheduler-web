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
  let selectedTeacherFilter = 'all'; // 课表页筛选老师：all 或 teacherId
  // 财务页的「查看视角」：all = 全校，否则是 teacherId。
  // **故意不复用 selectedTeacherFilter** —— 顶栏那个筛选器只在课表页可见（switchPage 里 mainTopbar 只在
  // schedule 页显示），若共用，用户在课表页筛了某老师、切到财务页会看到数字变了却找不到原因。
  let financeTeacherFilter = 'all';
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

  /* 「点击排课」指示条的退场状态（配合 styles.css 第 19 节）。
     display:none 无法过渡，所以退场是「先加 .lm-tap-banner-out 播动画 → 再延迟摘 .hidden」。
     硬保证：定时器一定会跑完；中途又选中学员则取消挂起的摘除（否则横幅会突然消失）。 */
  let tapBannerTimer = null;
  const TAP_BANNER_EXIT_MS = 180; // 略大于 CSS 的 160ms，留一帧余量

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
      if (tapBannerTimer) { clearTimeout(tapBannerTimer); tapBannerTimer = null; }
      banner.classList.remove('lm-tap-banner-out');
      banner.classList.remove('hidden');
    }
  }

  function clearStudentForTap() {
    selectedStudentForTap = null;
    document.querySelectorAll('.student-card').forEach((c) => c.classList.remove('lm-picked'));
    const banner = document.getElementById('mobileTapScheduleBanner');
    if (!banner || banner.classList.contains('hidden') || tapBannerTimer) return;
    banner.classList.add('lm-tap-banner-out');
    tapBannerTimer = setTimeout(() => {
      tapBannerTimer = null;
      banner.classList.add('hidden');
      banner.classList.remove('lm-tap-banner-out');
    }, TAP_BANNER_EXIT_MS);
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
          migrateLessonUnits();
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
  // 学员详情：消课记录支持「查看全部」「点行直达课程菜单」、累计合计、补课打标
  // detailLogExpanded 记住"是否已展开"（渲染是整块重建的，状态得放在函数外面）
  let detailLogExpanded = false;
  const DETAIL_LOG_PAGE = 30;

  function openStudentDetail(studentId) {
    detailLogExpanded = false;
    renderStudentDetail(studentId);
    showModal('modalStudentDetail');
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

  function renderStudentDetail(studentId) {
    const student = students.find((s) => s.id === studentId);
    if (!student) return;
    normalizeStudent(student);

    const titleEl = document.getElementById('studentDetailTitle');
    if (titleEl) titleEl.textContent = `${student.name} · 学员详情`;
    const body = document.getElementById('studentDetailBody');
    if (!body) return;

    const themeColor = getThemeBadgeStyle(student.colorTheme || 'amber');
    const studentDebts = getStudentDebts(student.id);
    // 全部消课流水（倒序），分页只影响"渲染多少"，合计永远按全量算
    const allLogs = checkInLogs
      .filter((l) => l.studentId === student.id && !isRefundLog(l))
      .slice()
      .sort((a, b) => (b.checkInTime || '').localeCompare(a.checkInTime || ''));
    const totalLoggedLessons = allLogs.reduce((acc, l) => acc + (Number(l.deductedLessons) || 0), 0);
    const totalLoggedAmount = allLogs.reduce((acc, l) => acc + (Number(l.paymentAmount) || 0), 0);
    // 「一共上过几节课」= 现有消课 + 导入的历史消课（历史导入也落在 checkInLogs 里，
    // 所以这里不用另算，一条求和就够）。历史那部分是给老师看口径用的。
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
      <div class="flex items-center gap-3 lm-soft rounded-xl p-3">
        <div class="w-11 h-11 rounded-full ${themeColor.bg} ${themeColor.text} flex items-center justify-center font-bold text-base">${student.name.substring(0, 1)}</div>
        <div class="flex-1">
          <div class="font-bold text-sm lm-t1">${student.name}</div>
          <div class="text-[11px] lm-t2">${student.phone ? '<i class="fa-solid fa-phone text-[9px]"></i> ' + student.phone : '未填电话'}</div>
          ${lifeText ? `<div class="text-[10px] lm-t3 mt-0.5" data-detail-life>${student.joinDate ? '<i class="fa-solid fa-calendar-plus text-[9px]"></i> ' : ''}${lifeText}</div>` : ''}
        </div>
        <div class="text-right">
          <div class="text-lg font-black ${totalOwed > 0 ? 'text-rose-600' : 'lm-t1'}">${totalLessons}</div>
          <div class="text-[9px] lm-t3 font-bold">总剩课时${totalOwed > 0 ? ' · 欠' + totalOwed + '节' : ''}</div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-2">
        <button type="button" id="detailSummaryBtn" class="py-2.5 rounded-xl bg-white border border-[#f0ebe2] hover:bg-[#f8f5f0] font-bold text-xs flex items-center justify-center gap-1.5 transition">
          <i class="fa-solid fa-image"></i> 课时总结图
        </button>
        <button type="button" id="detailRefundBtn" class="py-2.5 rounded-xl bg-white border border-[#f0ebe2] hover:bg-[#f8f5f0] font-bold text-xs flex items-center justify-center gap-1.5 transition"${canRefund ? '' : ' disabled style="opacity:.45;cursor:not-allowed"'}>
          <i class="fa-solid fa-circle-minus" style="color:#d5304f;"></i> 退款 / 退课时${canRefund ? '' : '（无可退）'}
        </button>
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
        <div class="flex items-center justify-between mb-1.5">
          <div class="font-bold text-[11px] lm-t2 uppercase tracking-wider"><i class="fa-solid fa-clock-rotate-left"></i> 消课记录</div>
          ${allLogs.length ? `<div class="text-[10px] lm-t3">累计 <span class="font-black lm-t1">${totalLoggedLessons} 节</span> · <span class="font-black lm-t1">${fmtMoney(totalLoggedAmount)}</span></div>` : ''}
        </div>
        ${allLogs.length === 0 ? '<div class="text-[11px] lm-t3 py-3 text-center lm-soft rounded-xl">暂无消课记录</div>' : `
        <div class="space-y-1 ${detailLogExpanded ? '' : 'max-h-56'} overflow-y-auto custom-scrollbar">
          ${logs.map((l) => {
            const sch = l.scheduleId ? schedules.find((s) => s.id === l.scheduleId) : null;
            const isMakeup = isMakeupLesson(sch);
            const clock = logClock(l);
            return `
          <button type="button" class="w-full text-left flex items-center justify-between lm-soft px-3 py-2 rounded-lg transition hover:bg-[#fff7ef] cursor-pointer" data-detail-log-sch="${l.scheduleId || ''}"${sch ? '' : ' title="排课已删除，仅剩流水"'}>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="font-bold lm-t1">${l.courseName || '课程'}</span>
                ${isMakeup ? '<span class="text-[9px] font-bold px-1.5 py-0.5 rounded" style="background:#e8f2f4;color:#2E5D68;">补课</span>' : ''}
                ${l.teacherName ? `<span class="lm-t3">${l.teacherName}</span>` : ''}
              </div>
              ${l.remarks ? `<div class="lm-t2 truncate mt-0.5">${l.remarks}</div>` : ''}
            </div>
            <div class="text-right shrink-0 ml-2">
              <div class="font-bold lm-t2">${l.deductedLessons}节${l.paymentAmount > 0 ? ' ¥' + Number(l.paymentAmount).toFixed(0) : ''}</div>
              <div class="text-[9px] lm-t3">${logDateText(l)}${clock ? ' ' + clock : ''}</div>
            </div>
          </button>`;
          }).join('')}
        </div>
        ${allLogs.length > DETAIL_LOG_PAGE ? `
        <button type="button" id="detailLogToggle" class="w-full mt-1.5 py-1.5 rounded-lg text-[11px] font-bold lm-t2 transition hover:bg-[#fff7ef]">
          ${detailLogExpanded ? '收起' : `查看全部 ${allLogs.length} 条`}
        </button>` : ''}`}
      </div>

      ${refundLogs.length ? `
      <div>
        <div class="font-bold text-[11px] lm-t2 uppercase tracking-wider mb-1.5"><i class="fa-solid fa-circle-minus" style="color:#d5304f;"></i> 退款记录（最近 ${refundLogs.length} 次）</div>
        <div class="space-y-1">
          ${refundLogs.map((l) => `
          <div class="flex items-center justify-between bg-rose-50/60 border border-rose-100 px-3 py-2 rounded-lg text-[11px]">
            <div class="min-w-0 flex-1">
              <span class="font-bold lm-t1">${l.courseName || '课程'}</span>
              <span class="font-bold text-rose-600 ml-1.5">退 ${l.refundLessons || 0} 节</span>
              ${l.remarks ? `<div class="lm-t3 truncate mt-0.5">${l.remarks}</div>` : ''}
            </div>
            <div class="text-right shrink-0 ml-2">
              <div class="font-black text-rose-600">${fmtMoney(l.paymentAmount)}</div>
              <div class="text-[9px] lm-t3">${logDateText(l)}</div>
            </div>
          </div>`).join('')}
        </div>
      </div>` : ''}

      ${leaves.length ? `
      <div>
        <div class="font-bold text-[11px] lm-t2 uppercase tracking-wider mb-1.5"><i class="fa-solid fa-umbrella-beach"></i> 请假记录（最近 ${leaves.length} 次）</div>
        <div class="space-y-1">
          ${leaves.map((s) => `
          <div class="flex items-center justify-between lm-soft px-3 py-1.5 rounded-lg text-[11px]">
            <span class="lm-t2">${s.date} ${s.startTime || ''}</span>
            <div class="flex items-center gap-1.5">
              <span class="lm-t2">${s.subject || ''}</span>
              ${isPendingMakeup(s) ? '<span class="text-[9px] font-bold px-1.5 py-0.5 rounded" style="background:#fff2f4;color:#d5304f;">待补课</span>' : isMakeupDone(s) ? '<span class="text-[9px] font-bold px-1.5 py-0.5 rounded" style="background:#e8f2f4;color:#2E5D68;">已补课</span>' : ''}
            </div>
          </div>`).join('')}
        </div>
      </div>` : ''}
    `;

    // 退款入口：与「充值」同层（详情页是退款唯一入口，不再另开第二个）
    const refundBtn = document.getElementById('detailRefundBtn');
    if (refundBtn) refundBtn.addEventListener('click', () => {
      if (!refundableCourses(student).length) {
        showToast('该学员没有可退的课时（余额为 0 或欠课）', 'circle-info');
        return;
      }
      hideModal('modalStudentDetail');
      setTimeout(() => openRefundModal(student), 280);
    });

    // 课时总结图（发给家长）
    const summaryBtn = document.getElementById('detailSummaryBtn');
    if (summaryBtn) summaryBtn.addEventListener('click', () => {
      hideModal('modalStudentDetail');
      setTimeout(() => openLessonSummaryModal(student), 280);
    });

    // 消课记录「查看全部 / 收起」：整块重渲染，展开状态存在 detailLogExpanded
    const toggleBtn = document.getElementById('detailLogToggle');
    if (toggleBtn) toggleBtn.addEventListener('click', () => {
      detailLogExpanded = !detailLogExpanded;
      renderStudentDetail(student.id);
    });

    // 点某条消课记录 → 直达那节课的操作菜单（能撤销/退还）。
    // 用 onxxx 赋值而不是 addEventListener：body 是常驻节点，重渲染时监听器会叠加。
    body.onclick = (e) => {
      const row = e.target.closest('[data-detail-log-sch]');
      if (!row) return;
      const sid = row.getAttribute('data-detail-log-sch');
      if (!sid) { showToast('这条记录没有关联排课', 'circle-info'); return; }
      const sch = schedules.find((s) => s.id === sid);
      if (!sch) { showToast('这节课的排课已被删除，只剩流水记录', 'circle-info'); return; }
      hideModal('modalStudentDetail');
      setTimeout(() => openScheduleActionMenu(sch), 280);
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

  // 保存 / 分享：手机优先走系统分享（能直接发微信），桌面回退成下载
  async function exportSummaryImage(canvas, student, course) {
    const name = `课时总结_${student.name}${course ? '_' + course : ''}_${formatDate(new Date())}.png`;
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) { showToast('图片生成失败，试试缩小范围', 'circle-info'); return; }
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
    showToast('图片已保存', 'circle-check');
  }

  function openLessonSummaryModal(student) {
    if (!student) return;
    normalizeStudent(student);
    const allLogs = checkInLogs
      .filter((l) => l.studentId === student.id && !isRefundLog(l))
      .slice()
      .sort((a, b) => (b.checkInTime || '').localeCompare(a.checkInTime || ''));

    const titleEl = document.getElementById('lessonSummaryTitle');
    if (titleEl) titleEl.textContent = `${student.name} · 课时总结图`;
    const body = document.getElementById('lessonSummaryBody');
    if (!body) return;

    // 多课程学员默认让用户选一门再出图；只有一门课就直接出，别多一步
    const courseNames = summaryCourseNames(student, allLogs);
    const courseBlock = courseNames.length > 1 ? `
      <div>
        <div class="font-bold text-[11px] lm-t2 mb-1.5">按课程</div>
        <select id="summaryCourse" class="w-full px-3 py-2 border border-[#f0ebe2] rounded-xl font-bold lm-t1 outline-none bg-white">
          <option value="">全部课程（合并成一张）</option>
          ${courseNames.map((n) => `<option value="${summaryEsc(n)}">${summaryEsc(n)}</option>`).join('')}
        </select>
        <div class="text-[10px] lm-t3 mt-1">选一门课只统计这门课的记录，剩余课时也只算这个课程包。</div>
      </div>` : '';

    body.innerHTML = `
      <div class="text-[11px] lm-t2 leading-relaxed">生成一张图片直接发微信给家长：本期上了哪些课、几节、多少钱、还剩多少节。</div>
      ${allLogs.length === 0 ? '<div class="text-[11px] lm-t3 py-6 text-center lm-soft rounded-xl">该学员还没有消课记录，先消课再来生成</div>' : `
      ${courseBlock}
      <div>
        <div class="font-bold text-[11px] lm-t2 mb-1.5">取多少节</div>
        <div class="flex items-center gap-2">
          <select id="summaryCount" class="flex-1 px-3 py-2 border border-[#f0ebe2] rounded-xl font-bold lm-t1 outline-none bg-white">
            <option value="10" selected>最近 10 节</option>
            <option value="5">最近 5 节</option>
            <option value="20">最近 20 节</option>
            <option value="30">最近 30 节</option>
            <option value="0">全部（最多 ${SUMMARY_MAX_ROWS} 节）</option>
          </select>
        </div>
        <div class="text-[10px] lm-t3 mt-1">一张图最多 ${SUMMARY_MAX_ROWS} 节，再长就看不清了；更长的区间用下面的日期分批生成。</div>
      </div>
      <div>
        <div class="font-bold text-[11px] lm-t2 mb-1.5">日期范围（可选）</div>
        <div class="flex items-center gap-2">
          <input id="summaryFrom" type="date" class="flex-1 min-w-0 px-3 py-2 border border-[#f0ebe2] rounded-xl lm-t2 outline-none" />
          <span class="lm-t3">~</span>
          <input id="summaryTo" type="date" class="flex-1 min-w-0 px-3 py-2 border border-[#f0ebe2] rounded-xl lm-t2 outline-none" />
        </div>
      </div>
      <button type="button" id="summaryGenerate" class="w-full py-3 rounded-xl bg-[#111111] text-white font-bold text-sm transition hover:opacity-90">生成图片</button>
      <div id="summaryPreview" class="hidden">
        <div class="max-h-[52vh] overflow-y-auto rounded-xl border border-[#f0ebe2] custom-scrollbar">
          <img id="summaryImg" class="w-full" alt="课时总结预览" />
        </div>
        <button type="button" id="summarySave" class="w-full mt-2 py-3 rounded-xl bg-white border border-[#f0ebe2] font-bold text-sm flex items-center justify-center gap-1.5 transition hover:bg-[#f8f5f0]">
          <i class="fa-solid fa-download"></i> 保存 / 分享图片
        </button>
      </div>`}
    `;
    showModal('modalLessonSummary');

    if (!allLogs.length) return;

    const courseSel = document.getElementById('summaryCourse');
    const countSel = document.getElementById('summaryCount');
    const fromInput = document.getElementById('summaryFrom');
    const toInput = document.getElementById('summaryTo');
    const previewBox = document.getElementById('summaryPreview');
    const previewImg = document.getElementById('summaryImg');
    let pendingCanvas = null;
    let pendingCourse = '';

    document.getElementById('summaryGenerate').addEventListener('click', () => {
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
        showToast(`「${course}」还没有消课记录`, 'circle-info');
        return;
      }
      let picked = scoped.slice();
      if (from) picked = picked.filter((l) => logDateText(l) >= from);
      if (to) picked = picked.filter((l) => logDateText(l) <= to);
      picked = count > 0 ? picked.slice(0, count) : picked.slice(0, SUMMARY_MAX_ROWS);
      if (!picked.length) {
        pendingCanvas = null;
        previewBox.classList.add('hidden');
        showToast('该范围内没有消课记录', 'circle-info');
        return;
      }
      const rows = buildSummaryRows(picked);
      pendingCanvas = buildLessonSummaryCanvas(student, rows, buildSummaryMeta(student, rows, scoped, { count, from, to, course }));
      pendingCourse = course;
      previewImg.src = pendingCanvas.toDataURL('image/png');
      previewBox.classList.remove('hidden');
      previewBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    document.getElementById('summarySave').addEventListener('click', () => {
      if (!pendingCanvas) { showToast('先点「生成图片」', 'circle-info'); return; }
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

  // ============ 历史账目校准：一节课 = 1 节（2026-10-17，见 AGENTS 第 37 条）============
  // 旧版 getLessonCost 按 durationMinutes 折算（桌面 /60、手机 /45），一节 90 分钟的课被记成 2 节：
  //   · 消课流水 deductedLessons = 2、paymentAmount = 2 × 单价
  //   · 课程包 remainingLessons 多扣（只有「消课」会扣课时，别处不按节数扣）
  // 消课流水的节数只可能是 1（正常）或 0（退款），所以 **>1 的必定是旧折算产物**。
  // 把多记的节数/金额回正、课时加回课程包 —— 跑完不会再有 >1 的记录，天然幂等。
  // 必须在 schedule 解析之后调用（要靠 courseId 定位课时包），且要在 syncAllDebts 之前
  // （欠课账是按 remainingLessons 反推的，先改余额再对账）。
  let lessonUnitsFixed = 0;
  let lessonUnitsNoticeQueued = false;
  function migrateLessonUnits() {
    let fixed = 0;
    checkInLogs.forEach((l) => {
      if (!l || isRefundLog(l)) return;            // 退款行没有节数概念，别碰
      const oldUnits = Number(l.deductedLessons) || 0;
      if (oldUnits <= 1) return;                   // 0 / 1 本来就是对的
      const delta = oldUnits - 1;
      // 找课时包：优先用排课的 courseId（流水上的 courseName 是 subject，可能不等于课时包名）
      const sch = l.scheduleId ? schedules.find((s) => s.id === l.scheduleId) : null;
      const student = students.find((st) => st.id === l.studentId);
      const course = student
        ? (student.courses || []).find((c) => (sch && sch.courseId && c.id === sch.courseId) || c.name === l.courseName)
        : null;
      if (course) course.remainingLessons = (Number(course.remainingLessons) || 0) + delta;
      // 金额按比例回正（旧值 = 节数 × 单价，除回节数就是单价；单价 0 的课保持 0）
      l.paymentAmount = Math.round((Number(l.paymentAmount) || 0) / oldUnits);
      l.deductedLessons = 1;
      l.remarks = (l.remarks ? l.remarks + '；' : '') + `历史校准：旧口径记的 ${oldUnits} 节已回正为 1 节`;
      fixed++;
    });
    if (fixed > 0) {
      lessonUnitsFixed += fixed;
      // 只提示一次：加载与云端拉取会各跑一遍，别弹两次
      if (!lessonUnitsNoticeQueued) {
        lessonUnitsNoticeQueued = true;
        setTimeout(() => showToast(`📐 已校准 ${lessonUnitsFixed} 条历史消课记录：一节就是 1 节，多扣的课时已加回`, 'circle-info'), 900);
      }
    }
    return fixed;
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

  // 「按节课」渲染时的欠课账查询：判的是**这一行的科目**，不是学员级。
  // 欠课账 debts 是 (studentId × courseName) 维度的 —— 只看 studentId 会让
  // 「声乐欠费」的学员在钢琴课那行也挂上欠课，老师会以为这节课的钱也没收到。
  // 科目名优先取排课指向的课程包名（courseId → name），回退到 s.subject。
  function scheduleDebt(sch, student) {
    if (!sch || !student) return null;
    const c = sch.courseId ? (student.courses || []).find((x) => x.id === sch.courseId) : null;
    const name = c ? c.name : sch.subject;
    if (!name) return null;
    return debts.find((d) => d.studentId === student.id && d.courseName === name && d.amount > 0) || null;
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

    // 历史账目校准：旧口径把长课时记成多节 → 先回正节数/金额/课时余额，再对欠课账
    migrateLessonUnits();

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

            // 云端拿回来的仍可能是旧口径数据 → 每次覆盖后都校准一次（幂等）
            migrateLessonUnits();

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

  // 一节课永远 = 1 节（2026-10-17 定口径，见 AGENTS 第 37 条）。
  // **不按时长折算**：旧实现是 Math.max(1, Math.round(durationMinutes / 60))，90 分钟的课被算成 2 节，
  // 节数、消课金额、课程包余额三处一起多扣。课程时长只影响课表排版/冲突检测，与计费无关。
  // 保留函数（而不是各处写死 1）是为了将来若要支持「一节课记 N 节」仍只有一个改动点；
  // 也保留入参签名 —— 调用点都传了 schedule，别为了好看把它删掉。
  function getLessonCost() {
    return 1;
  }

  // ============ 补课链路（F11） ============
  // 与 js/mobile.js 同语义、同字段（两端数据层必须一致）：
  //   请假时用户二选一「需要补课 / 不用补课」——同一次请假不是都要补。
  //   · 源请假课 needMakeup (bool)  —— 缺省 false，历史请假数据不会凭空冒出待补
  //   · 补课课次 makeupOfId (id)    —— 指向它补的那节源请假课
  //   · 源请假课 madeUpById (id)    —— 指向核销它的补课课（仅当补课已消课）
  function isMakeupLesson(s) { return !!(s && s.makeupOfId); }
  // 把 "HH:MM" 吸附到 5 分钟整（排课表单的时间框是 step=300）。
  // 排补课预填源请假课的时间，历史/导入数据的分钟位未必是 5 的倍数 ——
  // 那种值会让表单原生校验静默拦下提交（用户点保存毫无反应）。与手机端同逻辑。
  function snapTo5Min(hm) {
    const parts = String(hm || '').split(':').map(Number);
    if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return hm;
    const total = Math.round((parts[0] * 60 + parts[1]) / 5) * 5;
    return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }
  function isPendingMakeup(s) {
    return !!s && s.status === SCHEDULE_STATUS.STUDENT_LEAVE && !!s.needMakeup && !s.madeUpById;
  }
  function isMakeupDone(s) {
    return !!s && s.status === SCHEDULE_STATUS.STUDENT_LEAVE && !!s.madeUpById;
  }
  // 双向标记一致性：由节次状态反推（撤销消课 / 请假被还原 / 补课被删都自动退回待补）
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
  function cleanupMakeupLinks(schId) {
    schedules.forEach((s) => {
      if (s.id === schId) return;
      if (s.makeupOfId === schId) s.makeupOfId = null;
      if (s.madeUpById === schId) s.madeUpById = null;
    });
  }

  // 待补池的回溯窗口：含今天在内的最近 7 天。与 js/mobile.js 同口径 ——
  // 今日行上的「排补课」只覆盖今天，一周内请的假得另有地方露出来（否则拖久了没人记得）。
  const MAKEUP_WINDOW_DAYS = 7;
  // 近 7 天待补清单：请假 + 需补 + 未核销，按「日期+时间」升序（早请假的排前面）
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
  // 「这假请了几天了」——今天请的=0
  function makeupDaysAgo(dateStr) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const d = new Date(`${dateStr}T00:00:00`);
    if (isNaN(d.getTime())) return 0;
    return Math.max(0, Math.round((today - d) / 86400000));
  }
  // 待补条的「多久了」文案 + 拖过 3 天给的暖黄小标（与手机端同一份口径）
  function makeupAgeLabel(dateStr) {
    const days = makeupDaysAgo(dateStr);
    const text = days === 0 ? '今天' : (days === 1 ? '昨天' : `${days}天前`);
    const chip = days >= 3
      ? `<span class="text-[10px] font-bold rounded-full ml-1.5" style="background:#FEF3C7;color:#7C4A03;padding:1px 6px">已拖 ${days} 天</span>`
      : '';
    return { days, text, chip };
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
    // 补课消课 = 把这节请假课补上了 → 核销源课（源课从「待补」变「已补」）
    syncMakeupLink(sch);
    saveData();
    if (!o.skipRefresh) refreshView();
    if (!o.silentToast) offerUndo(`✅ 已消课：${sch.studentName} · ${sch.subject}（${deducted}节）${sch.makeupOfId ? ' · 补课' : ''}`, 'circle-check', `消课 ${sch.studentName}`);
    if (window.uiAnim) window.uiAnim.flashSchedule(sch.id);
    return true;
  }

  // 学员请假（不限课程时间，已消课的也可改为请假）
  // App 语义：请假本不扣课时；只有已消课改请假时，才把消课扣掉的课时退回
  // needMakeup：由用户在请假时**明确选择**——只有 true 才进待补池
  function markStudentLeave(scheduleId, needMakeup) {
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
    sch.needMakeup = !!needMakeup;
    // 这节本身若是补课课次，改请假 = 没补成 → 源课退回待补
    syncMakeupLink(sch);
    leaveMsg += needMakeup ? ' · 已转入待补课' : ' · 不补课';
    saveData();
    refreshView();
    offerUndo(leaveMsg, 'circle-check', `请假 ${sch.studentName}`);
    if (window.uiAnim) window.uiAnim.flashSchedule(sch.id);
  }

  // 请假课「要不要补」的后续开关（请假后改主意）
  function setNeedMakeup(scheduleId, needMakeup) {
    const sch = schedules.find((s) => s.id === scheduleId);
    if (!sch || sch.status !== SCHEDULE_STATUS.STUDENT_LEAVE) return;
    if (sch.madeUpById && !needMakeup) {
      showToast('该请假课已被补课核销，请先撤销那节补课', 'circle-info');
      return;
    }
    pushUndo(`改补课标记 ${sch.studentName}`);
    sch.needMakeup = !!needMakeup;
    syncMakeupLink(sch);
    saveData();
    refreshView();
    offerUndo(needMakeup ? '📌 已加入待补课' : '已取消补课标记', 'circle-check', `补课标记 ${sch.studentName}`);
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
    // 不请假了 → 补课标记与核销关系一起清掉
    sch.needMakeup = false;
    sch.madeUpById = null;
    syncMakeupLink(sch);
    saveData();
    refreshView();
    offerUndo('已撤销状态，还原为待上课', 'rotate-left', `还原 ${sch.studentName} 的课`);
    if (window.uiAnim) window.uiAnim.flashSchedule(sch.id);
  }

  // 删除排课时同步清理流水
  // ⚠️ 退还课时的唯一依据是「这节课真的扣过多少」= 该排课的消课流水之和，**不能按 status 猜**：
  //    排课环节从来不扣课时（只有消课会扣），所以给「待上课」的课退课时 = 白送一节，
  //    删得越多待消存量越高（旧实现的 bug，见 AGENTS 第 38 条）。
  //    按流水反推还顺带修正了另一个方向：删「已消课」的课会把流水一起删掉（财务回滚），
  //    那就必须把那一节课时也还回去，否则课没上、钱没记、课时却少了一节。
  function handleDeleteScheduleWithCleanup(schId) {
    const sch = schedules.find((s) => s.id === schId);
    const deductedUnits = checkInLogs
      .filter((l) => l.scheduleId === schId && !isRefundLog(l))
      .reduce((sum, l) => sum + (Number(l.deductedLessons) || 0), 0);

    checkInLogs = checkInLogs.filter((l) => l.scheduleId !== schId);
    cleanupMakeupLinks(schId);   // 断补课链路：删的可能是源请假课，也可能是补课课次
    schedules = schedules.filter((s) => s.id !== schId);

    if (sch && deductedUnits > 0) {
      const student = students.find((st) => st.id === sch.studentId);
      if (student) {
        const course = (student.courses || []).find((c) => c.id === sch.courseId || c.name === sch.subject);
        if (course) course.remainingLessons += deductedUnits;
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
  // 退款（F12）
  // ==========================================
  // 语义：把「学员预交、但没上」的课时退掉，并把钱从当月收入里减出来。
  // 记账复用 checkInLogs（全站唯一的财务痕迹），靠三个字段表达，**零数据层改动**：
  //   · deductedLessons = 0   → 退的是没上过的课，不该动「本月课消节数」
  //   · paymentAmount   = -金额 → 「课消价值 / 收入 / 环比 / 明细」全部自动被扣减
  //   · type            = 'refund' → 与消课记录区分（老数据没有该字段，缺省按消课处理）
  // 这样撤销快照、云同步、跨标签同步、老师视角过滤都是现成路径，不用按 7 处 × 2 文件去抄。
  function isRefundLog(l) { return !!(l && l.type === 'refund'); }

  // 退款流水（字段基座与 recordCheckInLog 一致，便于同一张表里混排）
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
  // 注意：退款只会让余额朝 0 变小，永远不会造出负余额 → 不需要碰欠课账（故不调 syncAllDebts）。
  function executeRefund(studentId, courseKey, lessons, amount, remarks) {
    const student = students.find((st) => st.id === studentId);
    if (!student) return false;
    normalizeStudent(student);
    migrateStudentCourses(student);

    const courses = student.courses || [];
    const course = courses.find((c) => c.id === courseKey) || courses.find((c) => c.name === courseKey);
    if (!course) { showToast('找不到该课程包', 'circle-info'); return false; }

    const n = Math.floor(Number(lessons) || 0);
    if (!(n > 0)) { showToast('退款节数至少 1 节', 'circle-info'); return false; }
    const left = Number(course.remainingLessons) || 0;
    if (left <= 0) {
      showToast(`「${course.name}」没有可退课时（当前 ${left} 节）`, 'circle-info');
      return false;
    }
    if (n > left) {
      showToast(`「${course.name}」最多可退 ${left} 节`, 'circle-info');
      return false;
    }

    const money = Math.max(0, Number(amount) || 0);

    pushUndo(`退款 ${student.name}`);
    course.remainingLessons = left - n;
    recordRefundLog(student, course, n, money, remarks);
    saveData();
    refreshView();
    offerUndo(`💸 已为 ${student.name} 退款「${course.name}」${n} 节 · ¥${money.toFixed(0)}`, 'circle-minus', `退款 ${student.name}`);
    return true;
  }

  // 金额显示：负数统一写成 -¥1400（而不是 ¥-1400）
  function fmtMoney(v) {
    const n = Number(v) || 0;
    return (n < 0 ? '-¥' : '¥') + Math.abs(n).toFixed(0);
  }

  // ==========================================
  // 3.6 低课时续费预警（F1）
  // ==========================================
  // 阈值全站唯一：财务页「续费预警」、看板「课时预警」、手机端同名片都读这个数。
  // 侧边栏抽屉的「预警(≤2)」筛选用的是同一阈值，但它是**待排课筛选**（欠课的人更该排课），
  // 故意不排除欠课 —— 两处目的不同，别顺手统一掉。
  const LOW_LESSON_THRESHOLD = 2;

  // 低课时预警行：余额落在 [0, 阈值] 才算「该续费了」（余 0 节也提醒，就是「已用完」）。
  // 欠课（负数）**不进预警** —— 它们归「欠课名单」，两处同时列同一个人会让老师以为要退钱。
  // 排序：剩余节数升序（最该续费的排最前），同数按学员名。
  function lowLessonRows(studentsScope, courseOf) {
    const rows = [];
    (studentsScope || students).forEach((st) => {
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

  // ============ 老师口径（财务页「查看视角」用） ============
  // ⚠️ 与手机端 js/mobile.js 的 studentRelatedToTeacher / courseRelatedToTeacher / logRelatedToTeacher
  //    **必须同语义** —— 那边靠 teacherSession（老师登录态）驱动，桌面端没有登录态，改由 teacherId 参数驱动。
  //    改这里的判定逻辑时，两边一起改（核对脚本 H 段会拿手机端老师登录态的行集合与电脑端逐条比对）。
  //    teacherId 为 'all' / 空 → 一律 true（全校视角，等价于不过滤）。
  const isAllTeachers = (teacherId) => !teacherId || teacherId === 'all';

  // 学员是否与该老师有关：显式关联名单（st.teacherIds）、或主讲/助教上过/将上该学员的课
  function teacherRelatedStudent(st, teacherId) {
    if (isAllTeachers(teacherId)) return true;
    if ((st.teacherIds || []).includes(teacherId)) return true;
    return schedules.some((s) => s.studentId === st.id && (s.teacherId === teacherId || s.assistantTeacherId === teacherId));
  }

  // 某条学员课程包是否属于该老师的教学范围：
  // 排课记录里该老师（主讲或助教）上过/将上这门课 → 归该老师
  function teacherRelatedCourse(st, courseName, teacherId) {
    if (isAllTeachers(teacherId)) return true;
    const c = (st.courses || []).find((x) => x.name === courseName);
    return schedules.some((s) => s.studentId === st.id &&
      (s.teacherId === teacherId || s.assistantTeacherId === teacherId) &&
      ((s.subject || '') === courseName || (c && s.courseId === c.id)));
  }

  // 某条消课流水是否属于该老师的课：流水带 teacherId 直接判，老流水回退查排课。
  // ⚠️ 兜底分支 `!sch` 意味着「既无 teacherId 又找不到排课」的流水对**每个**老师都返回 true ——
  //    退款流水正是这种（scheduleId=''），所以老师视角必须额外排除退款，见 renderPageFinance。
  function teacherRelatedLog(log, teacherId) {
    if (isAllTeachers(teacherId)) return true;
    if (log.teacherId) return log.teacherId === teacherId;
    const sch = schedules.find((s) => s.id === log.scheduleId);
    if (sch) return sch.teacherId === teacherId || sch.assistantTeacherId === teacherId;
    // 历史导入的流水**只有老师名字**：没有 teacherId、也没有排课。
    // 不按名字兜底就会落到「无排课 = 算这位老师的」，把每一笔历史课重复算进每一位老师。
    if (log.teacherName) {
      const t = teachers.find((x) => x.id === teacherId);
      return !!t && t.name === log.teacherName;
    }
    return true; // 既无排课也无老师名（退款等）→ 保持旧口径
  }

  // 视角下拉里显示的老师名（带科目）
  function teacherViewLabel(teacherId) {
    if (isAllTeachers(teacherId)) return '全校';
    const t = teachers.find((x) => x.id === teacherId);
    return t ? `${t.name} · ${t.subject || '全科'}` : '未知老师';
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
    safeBind('btnMonthPrev', 'click', () => { currentMonth.setMonth(currentMonth.getMonth() - 1); renderMonthView({ dayListIn: true }); });
    safeBind('btnMonthNext', 'click', () => { currentMonth.setMonth(currentMonth.getMonth() + 1); renderMonthView({ dayListIn: true }); });
    safeBind('btnMonthToday', 'click', () => { currentMonth = new Date(); monthSelectedDate = formatDate(getToday()); renderMonthView({ dayListIn: true }); });

    // 月视图格子：事件行 → 该课操作菜单（对齐 Google 点事件）；点格子空白 → 切换选中日（右栏跟着走）
    // 事件委托只绑一次（网格 innerHTML 每次渲染都会重建，绑在网格本体上才不会丢）
    const monthGrid = document.getElementById('monthViewGrid');
    if (monthGrid) monthGrid.onclick = (e) => {
      const row = e.target.closest('[data-month-sch]');
      if (row) {
        const sch = schedules.find((x) => x.id === row.getAttribute('data-month-sch'));
        if (sch) openScheduleActionMenu(sch);
        return;
      }
      const cell = e.target.closest('[data-month-day][data-in-month="1"]');
      if (!cell) return;
      const day = cell.getAttribute('data-month-day');
      if (day && day !== monthSelectedDate) {
        monthSelectedDate = day;
        renderMonthView({ dayListIn: true });
      }
    };

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
    safeBind('btnCloseLessonSummary', 'click', () => hideModal('modalLessonSummary'));

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

    /* 抽屉进出场（CSS 在 styles.css 第 18 节）。
       display:none 无法过渡，所以退场是「先加 .lm-drawer-closing 播动画 → 再摘」。
       两条硬保证，避免遮罩把界面卡死：
       ① 延迟摘除有超时兜底，transitionend 没来也一定会摘；
       ② 动画期间又点开 → 取消挂起的摘除并清掉 closing 类，抽屉原地滑回来。 */
    const DRAWER_EXIT_MS = 200; // 略大于 CSS 的 180ms，留一帧余量
    let drawerHideTimer = null;

    function cancelDrawerHide() {
      if (drawerHideTimer) { clearTimeout(drawerHideTimer); drawerHideTimer = null; }
      if (sidebar) sidebar.classList.remove('lm-drawer-closing');
      if (batchBackdrop) batchBackdrop.classList.remove('lm-drawer-closing');
    }

    function collapseSidebar() {
      if (drawerHideTimer) return; // 已在退场中，重复触发忽略
      if (!sidebar || sidebar.classList.contains('hidden')) {
        // 本来就是收起的：直接落终态，不用播动画
        if (sidebar) { sidebar.classList.add('hidden'); sidebar.classList.remove('flex'); }
        if (batchBackdrop) batchBackdrop.classList.add('hidden');
        return;
      }
      sidebar.classList.add('lm-drawer-closing');
      if (batchBackdrop) batchBackdrop.classList.add('lm-drawer-closing');
      drawerHideTimer = setTimeout(() => {
        drawerHideTimer = null;
        sidebar.classList.add('hidden');
        sidebar.classList.remove('flex');
        sidebar.classList.remove('lm-drawer-closing');
        if (batchBackdrop) {
          batchBackdrop.classList.add('hidden');
          batchBackdrop.classList.remove('lm-drawer-closing');
        }
      }, DRAWER_EXIT_MS);
    }

    function expandSidebar() {
      cancelDrawerHide(); // 退场途中又点开：原地滑回来，别停在半路
      if (sidebar) {
        sidebar.classList.remove('hidden');
        sidebar.classList.add('flex');
      }
      if (batchBackdrop) batchBackdrop.classList.remove('hidden');
    }

    if (btnBatchSchedule) btnBatchSchedule.addEventListener('click', () => {
      /* 判据要看「最终会是什么状态」而不是「此刻有没有 .hidden」：
         退场动画进行中时节点还没带 .hidden，若按 hidden 判会再次走 collapse —— 
         而 collapse 在退场中会直接 return，结果就是「点了没反应、然后自己关掉」。
         所以退场中（有挂起定时器）一律当成「已收起」→ 重新打开。 */
      const willBeOpen = sidebar && !sidebar.classList.contains('hidden') && !drawerHideTimer;
      if (willBeOpen) {
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

  function renderMonthView(opts) {
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

    // 每天的课程（按老师筛选；请假课照列 —— 要在格子里画成玫红删除线，像 Google 的「已谢绝」）
    const shown = selectedTeacherFilter === 'all' ? schedules : schedules.filter((s) => s.teacherId === selectedTeacherFilter || s.assistantTeacherId === selectedTeacherFilter);
    const byDate = new Map();
    shown.forEach((s) => {
      if (!byDate.has(s.date)) byDate.set(s.date, []);
      byDate.get(s.date).push(s);
    });
    byDate.forEach((list) => list.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || '')));

    // 学员主题色圆点：色卡色的深化版（小点在浅底上必须够深才可见，底色本身太浅）
    const CAL_DOT_COLORS = { amber: '#D9985F', emerald: '#7E9271', sky: '#4E93A8', purple: '#6F7C6C', rose: '#D08168', mint: '#7FA495' };
    const LEAVE_RED = '#d5304f';

    grid.innerHTML = '';
    for (let i = 0; i < totalCells; i++) {
      const d = addDays(cursor0, i);
      const dateStr = formatDate(d);
      const inMonth = d.getMonth() === month;
      const isToday = dateStr === todayStr;
      const isSel = dateStr === monthSelectedDate;
      const dayLessons = byDate.get(dateStr) || [];

      const cell = document.createElement('div');
      // 表格线格子：暖发丝内框（末列去右边线、末行去下边线，避免与外框叠加）
      const isLastCol = i % 7 === 6;
      const isLastRow = i >= totalCells - 7;
      cell.className = 'month-cell flex flex-col min-h-0 overflow-hidden select-none transition border-[#efe9e0] ' +
        (isLastCol ? '' : 'border-r ') +
        (isLastRow ? '' : 'border-b ') +
        (isSel ? 'is-sel ' : 'hover:bg-[#fbf9f5] ') +
        (inMonth ? 'cursor-pointer' : '');
      cell.setAttribute('data-month-day', dateStr);
      if (inMonth) cell.setAttribute('data-in-month', '1');

      // 日期数字：居中；1 号带月份前缀（对齐 Google 的「10月1」）
      const numText = d.getDate() === 1 ? `${d.getMonth() + 1}月1` : String(d.getDate());
      const numCls = 'month-cell-num' + (inMonth ? '' : ' is-out') + (isToday ? ' is-today' : '') + (isSel ? ' is-sel' : '');
      const numTag = inMonth ? 'button type="button"' : 'span';

      // 事件行：学员色圆点 + 开始时间 + 科目 · 学员（请假=玫红删除线，已消课=灰化）
      const evHtml = dayLessons.map((s) => {
        const done = s.status === SCHEDULE_STATUS.COMPLETED;
        const leave = s.status === SCHEDULE_STATUS.STUDENT_LEAVE;
        const dotColor = CAL_DOT_COLORS[resolveScheduleTheme(s)] || CAL_DOT_COLORS.amber;
        const dotStyle = leave ? `box-shadow:inset 0 0 0 1.5px ${LEAVE_RED}` : `background:${dotColor}`;
        const label = [s.subject, s.studentName].filter(Boolean).join(' · ');
        const state = done ? '已消课' : (leave ? '请假' : '待上课');
        return `<button type="button" class="month-ev${done ? ' is-done' : ''}${leave ? ' is-leave' : ''}" data-month-sch="${escAttr(s.id)}" title="${escAttr(`${s.startTime || ''} ${label}（${state}）`)}">
            <span class="month-ev-dot" style="${dotStyle}"></span>
            <span class="month-ev-time">${escAttr(s.startTime || '')}</span>
            <span class="month-ev-title">${escAttr(label)}</span>
          </button>`;
      }).join('');

      cell.innerHTML = `
        <div class="shrink-0 flex justify-center pt-1 pb-0.5">
          <${numTag} class="${numCls}">${numText}</${numTag}>
        </div>
        <div class="month-evs flex-1 min-h-0 overflow-y-auto px-1 pb-1 flex flex-col gap-px">${evHtml}</div>
      `;

      grid.appendChild(cell);
    }

    renderMonthDayList(byDate, todayStr, WEEKDAY_LABELS, !!(opts && opts.dayListIn));
  }

  // 月视图右栏：选中日的安排列表（卡片样式对齐手机版当日列表）
  // animate：由「点格子 / 翻月 / 回今天」传入 —— 只有这些路径是用户主动换的一天，
  // 右侧清单整块换内容需要一条空间线索；进入月视图本身已有 viewIn，不重复动。
  function renderMonthDayList(byDate, todayStr, WEEKDAY_LABELS, animate) {
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
      if (animate && window.uiAnim && window.uiAnim.listIn) window.uiAnim.listIn(listEl);
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

    if (animate && window.uiAnim && window.uiAnim.listIn) window.uiAnim.listIn(listEl);
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
          <div class="text-3xl font-black text-[#111111] mt-1.5">${fmtMoney(monthValue)}</div>
          <div class="text-[11px] font-semibold mt-1.5 text-[#a8a29e]">课消价值合计（退款已扣减）</div>
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
          const pend = isPendingMakeup(s);
          const mkDone = isMakeupDone(s);
          const dot = done ? '#10b981' : isLeave ? '#9ca3af' : '#475569';
          // 请假三态：待补（暖黄，要行动）/ 已补（灰米，已了结）/ 普通请假（不补）
          const statusHtml = done
            ? '<span class="text-[11px] font-bold text-emerald-600 shrink-0">已消课</span>'
            : isLeave
              ? `<span class="text-[10px] font-bold px-2 py-1 rounded-full shrink-0 ${pend ? 'bg-[#FEF3C7] text-[#7C4A03]' : 'bg-[#f5f2ec] text-[#78716c]'}">${pend ? '请假待补' : (mkDone ? '请假·已补' : '请假')}</span>`
              : `<button class="lm-checkin-btn dash-checkin-btn shrink-0 text-[11px] font-bold px-3.5 py-1.5 rounded-full bg-[#111111] text-white transition" data-id="${s.id}">
                   <span class="lm-cb-label">消课</span>
                   <span class="lm-cb-spinner" aria-hidden="true"></span>
                   <svg class="lm-cb-check" viewBox="0 0 24 24" aria-hidden="true"><path pathLength="100" d="M4.5 12.6 L9.7 17.8 L19.5 6.6"/></svg>
                 </button>`;
          const student = students.find((st) => st.id === s.studentId);
          // 欠课标签按**这一行的科目**判（scheduleDebt 里说明）：声乐欠费的学员，她的钢琴课那行不挂标签。
          // hover 写明是哪个课程包欠几节，免得只看到「欠课」两个字还得去猜是谁欠、欠什么。
          const sd = scheduleDebt(s, student);
          const debtTag = sd ? `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-600 ml-1.5" title="${escAttr(sd.courseName)} 欠课 ${sd.amount} 节">欠课</span>` : '';
          // 待补课：行内直接给「排补课」，不用先点开菜单
          const makeupBtn = pend ? `<button class="lm-mini-btn dash-makeup-btn" data-id="${s.id}">排补课</button>` : '';
          const mkChip = isMakeupLesson(s) ? '<span class="lm-chip-makeup">补课</span>' : '';
          return `<div class="flex items-center justify-between px-5 py-3 border-t border-[#f2ece4]">
            <div class="flex items-center gap-3 min-w-0">
              <span class="w-2 h-2 rounded-full shrink-0" style="background:${dot}"></span>
              <div class="text-[13px] font-bold text-[#111111] truncate">${mkChip}${s.startTime || '--'} ${s.subject || ''} · ${s.studentName || ''}${debtTag}</div>
            </div>
            <div class="flex items-center gap-2 shrink-0">${makeupBtn}${statusHtml}</div>
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
      // 行内「排补课」：直接开补课表单（预填源请假课）
      todayList.querySelectorAll('.dash-makeup-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const sch = schedules.find((x) => x.id === btn.getAttribute('data-id'));
          if (!sch) return;
          openScheduleModalForNew(students.find((st) => st.id === sch.studentId), formatDate(new Date()), sch.startTime, sch);
        });
      });
    }

    // ---- 待补课（近 7 天请假 · 需补 · 未核销）----
    // 今日时间轴里的「排补课」只管今天：几天前请的假没补上，在这儿才露出来，不用翻日历兑账。
    // 与手机端同口径（pendingMakeupList）；清单空则整卡隐藏，不给已有内容添噪声。
    const mkCard = document.getElementById('dashMakeupCard');
    const mkListEl = document.getElementById('dashMakeupList');
    if (mkCard && mkListEl && !dashBusy) {
      const pendMakeups = pendingMakeupList(null);
      mkCard.classList.toggle('hidden', pendMakeups.length === 0);
      const mkBadge = document.getElementById('dashMakeupBadge');
      if (mkBadge) mkBadge.textContent = `近 7 天请假未补 ${pendMakeups.length} 节`;
      mkListEl.innerHTML = pendMakeups.map((s) => {
        const age = makeupAgeLabel(s.date);
        const dayLabel = String(s.date || '').slice(5).replace('-', '/');
        return `<div class="flex items-center justify-between px-5 py-3 border-t border-[#f2ece4]">
          <div class="flex items-center gap-3 min-w-0">
            <span class="w-2 h-2 rounded-full shrink-0" style="background:#D9985F"></span>
            <div class="text-[13px] font-bold text-[#111111] truncate">${dayLabel} ${s.startTime || '--'} ${s.subject || ''} · ${s.studentName || ''}</div>
            <span class="text-[11px] font-semibold text-[#a8a29e] shrink-0">${age.text}请假</span>${age.chip}
          </div>
          <button class="lm-mini-btn dash-makeup-btn shrink-0" data-id="${s.id}">排补课</button>
        </div>`;
      }).join('');
      mkListEl.querySelectorAll('.dash-makeup-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const sch = schedules.find((x) => x.id === btn.getAttribute('data-id'));
          if (!sch) return;
          openScheduleModalForNew(students.find((st) => st.id === sch.studentId), formatDate(new Date()), sch.startTime, sch);
        });
      });
    }

    // ---- 课时预警 ----
    // 取数与财务页「续费预警」共用 lowLessonRows()：欠课（负数）不进这里，它们在看板的欠课区。
    const lowList = document.getElementById('dashLowList');
    if (lowList) {
      const grouped = new Map();
      lowLessonRows(students).forEach((r) => {
        if (!grouped.has(r.student.id)) grouped.set(r.student.id, { st: r.student, lowCourses: [], min: r.left });
        grouped.get(r.student.id).lowCourses.push(r.course);
      });
      const lowStudents = [...grouped.values()];
      if (!lowStudents.length) {
        lowList.innerHTML = `<div class="text-center py-8 text-[#a8a29e] text-xs"><i class="fa-solid fa-shield-heart text-2xl mb-2 block opacity-40"></i>暂无课时预警</div>`;
      } else {
        lowList.innerHTML = lowStudents.slice(0, 8).map(({ st, lowCourses, min }) => {
          return `<div class="flex items-center justify-between px-5 py-3 border-t border-[#f2ece4] cursor-pointer hover:bg-[#faf8f3] transition dash-low-student" data-id="${st.id}">
            <span class="text-[13px] font-bold text-[#111111] truncate">${st.name} <span class="text-[11px] text-[#a8a29e] font-semibold">· ${lowCourses.map((c) => c.name).join('、')}</span></span>
            <span class="text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0 ml-2 bg-rose-50 text-rose-600">${lowLessonText(min)}</span>
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
        // 退款不对应某一节课，算不进任何老师的课时排行（否则会冒出一行「未指定老师」）
        if (isRefundLog(l)) return;
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
    safeBind('btnPageHistoryImport', 'click', openHistoryImport);
    safeBind('btnMobileHistoryImport', 'click', () => {
      hideModal('modalMobileMenu');
      setTimeout(openHistoryImport, 220);
    });
    safeBind('btnCloseHistoryImport', 'click', () => hideModal('modalHistoryImport'));
    safeBind('btnCancelHistoryImport', 'click', () => hideModal('modalHistoryImport'));
    safeBind('btnSelectHistoryFile', 'click', () => document.getElementById('historyFileInput')?.click());
    safeBind('historyFileInput', 'change', handleHistoryFileChange);
    safeBind('btnHistoryTemplate', 'click', downloadHistoryTemplate);
    safeBind('btnConfirmHistoryImport', 'click', handleConfirmHistoryImport);
    safeBind('btnClearHistoryLogs', 'click', handleClearHistoryLogs);
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

    // 查看视角：'all' = 全校，否则是某位老师的 id（与手机端老师登录态同口径，见 teacherRelated* 系列）
    const tId = financeTeacherFilter;
    const scoped = !isAllTeachers(tId);
    const vLabel = teacherViewLabel(tId);

    const now = new Date();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // 老师视角：只统计该老师授课的消课记录（全校视角看全部）。
    // 退款**不摊分到老师**：一笔退款不对应某一节课，走 teacherRelatedLog 的兜底分支（`!sch`）
    // 会让每个老师都被同一笔退款重复扣一次 —— 与手机端 renderMobileFinance 完全一致。
    let scopedLogs = checkInLogs.filter((l) => (l.checkInTime || '').startsWith(monthPrefix));
    if (scoped) scopedLogs = scopedLogs.filter((l) => !isRefundLog(l) && teacherRelatedLog(l, tId));
    const monthLogs = scopedLogs.slice().sort((a, b) => (b.checkInTime || '').localeCompare(a.checkInTime || ''));

    const monthLessons = monthLogs.reduce((acc, l) => acc + (l.deductedLessons || 0), 0);
    // 退款流水 deductedLessons=0 → 课消节数天然不受影响；paymentAmount 是负数 → 金额自动被扣减
    const monthValue = monthLogs.reduce((acc, l) => acc + (l.paymentAmount || 0), 0);
    // 老师视角下 monthLogs 已排除退款 → 这里天然为 0（退款是机构层面的账，不挂在某个老师头上）
    const monthRefund = monthLogs.filter(isRefundLog).reduce((acc, l) => acc + Math.abs(l.paymentAmount || 0), 0);

    // 老师视角：待消存量 / 课时存量价值 / 欠课名单 / 续费预警 只算**该老师授课的课程包**
    const relStudents = scoped ? students.filter((st) => teacherRelatedStudent(st, tId)) : students;
    const myCoursesOf = (st) => scoped ? (st.courses || []).filter((c) => teacherRelatedCourse(st, c.name, tId)) : (st.courses || []);
    const relIds = new Set(relStudents.map((s) => s.id));

    const totalRemaining = relStudents.reduce((acc, st) => acc + myCoursesOf(st).reduce((a, c) => a + Math.max(0, c.remainingLessons), 0), 0);
    const totalStockValue = relStudents.reduce((acc, st) => acc + myCoursesOf(st).reduce((a, c) => a + Math.max(0, c.remainingLessons) * (c.unitPrice || 0), 0), 0);
    const debtors = scoped
      ? debts.filter((d) => d.amount > 0 && relIds.has(d.studentId) && relStudents.some((st) => st.id === d.studentId && teacherRelatedCourse(st, d.courseName, tId)))
      : debts.filter((d) => d.amount > 0);
    // 续费预警（余额 ≤2 节；欠课负数归右栏「欠课名单」，不在这里重复出现）
    const lowRows = lowLessonRows(relStudents, myCoursesOf);

    // 环比（与上月整月比）：只给能由消课流水直接推出的两项
    // 「待消存量 / 欠课学员」没有历史快照（充值不进流水、欠课账只存当前值），硬算会出假数，故不放徽章
    let pLogs = prevMonthLogs();
    if (scoped) pLogs = pLogs.filter((l) => !isRefundLog(l) && teacherRelatedLog(l, tId));
    const prevLessons = sumLessons(pLogs);
    const prevValue = sumValue(pLogs);

    const kpiCard = (icon, iconStyle, label, valueHtml, extraAttr, momHtml) => `
      <div class="lm-stat-card rounded-2xl p-4" ${extraAttr || ''}>
        <div class="flex items-center gap-1.5 text-[11px] font-bold lm-t3"><i class="fa-solid ${icon}" style="${iconStyle}"></i> ${label}${momHtml || ''}</div>
        <div class="text-2xl font-black lm-t1 mt-1.5">${valueHtml}</div>
      </div>`;

    container.innerHTML = `
      <!-- 查看视角：全校 / 单个老师（独立状态，与课表页顶栏那个老师筛选互不影响） -->
      <div class="lm-stat-card rounded-2xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
        <div class="flex items-center gap-2">
          <i class="fa-solid fa-user-tie text-[#78716c] text-xs"></i>
          <label for="financeTeacherSelect" class="text-xs font-bold lm-t2">查看视角</label>
          <select id="financeTeacherSelect" class="bg-white border border-[#efe9e0] rounded-lg px-2 py-1 text-xs font-bold text-[#111111] outline-none focus:ring-1 focus:ring-[#a8a29e] cursor-pointer max-w-[200px]">
            <option value="all">全校老师（全部）</option>
            ${teachers.map((t) => `<option value="${t.id}">${t.name} · ${t.subject || '全科'}</option>`).join('')}
          </select>
        </div>
        <div class="text-[11px] font-bold ${scoped ? 'text-[#fe4c02]' : 'lm-t3'}">
          ${scoped ? `<i class="fa-solid fa-filter mr-1"></i>只统计「${vLabel}」授课的学员与流水` : '全部学员 · 全部流水'}
        </div>
      </div>

      <div class="grid grid-cols-2 xl:grid-cols-4 gap-3">
        ${kpiCard('fa-chart-simple', 'color:#111111;', '本月课消', `${monthLessons.toFixed(1)} <span class="text-xs font-bold lm-t3">节</span>`, '', momBadge(monthLessons, prevLessons, ' 节', (n) => n.toFixed(1), true))}
        ${kpiCard('fa-coins', 'color:#ff5600;', '课消价值', `${fmtMoney(monthValue)}`, '', momBadge(monthValue, prevValue, ' 元', (n) => n.toFixed(0), true))}
        ${kpiCard('fa-layer-group', 'color:#111111;', '待消存量', `${totalRemaining.toFixed(1)} <span class="text-xs font-bold lm-t3">节</span>`)}
        ${kpiCard('fa-triangle-exclamation', 'color:#d5304f;', '欠课学员', `${debtors.length} <span class="text-xs font-bold lm-t3">人</span>`, debtors.length ? 'style="background:#fff1f2;"' : '')}
      </div>

      <div class="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
        <!-- 本月收入明细：桌面表格 -->
        <div class="lm-stat-card rounded-2xl xl:col-span-2">
          <div class="flex items-center justify-between px-4 pt-4 pb-2">
            <div class="font-bold text-xs lm-t1 flex items-center gap-1.5"><i class="fa-solid fa-receipt" style="color:#ff5600;"></i> 本月收入明细${scoped ? `<span class="text-[10px] font-bold lm-t3">· ${vLabel}</span>` : ''}</div>
            <div class="text-[11px] font-bold lm-t2">${monthLogs.length} 笔 · ${monthLessons.toFixed(1)} 节 · 净 ${fmtMoney(monthValue)}${monthRefund > 0 ? ` <span class="text-rose-500">（已退 ¥${monthRefund.toFixed(0)}）</span>` : ''}</div>
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
                ${monthLogs.map((l) => {
                  // 退款行：没有「消课节数」，金额是负数 —— 单独立样式，别混在消课行里读
                  const ref = isRefundLog(l);
                  return `
                <tr class="border-b border-[#f2ece4] ${ref ? 'bg-rose-50/40' : 'hover:bg-[#faf8f3]'} transition">
                  <td class="py-3 pl-2 font-bold lm-t1 whitespace-nowrap">${l.studentName}${ref ? '<span class="ml-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-600">退款</span>' : ''}</td>
                  <td class="py-3 lm-t2 whitespace-nowrap">${l.courseName}</td>
                  <td class="py-3 lm-t3 max-w-[180px] truncate" title="${l.remarks || ''}">${ref ? `退 ${l.refundLessons || 0} 节${l.remarks ? ' · ' + l.remarks : ''}` : (l.remarks || '—')}</td>
                  <td class="py-3 text-right lm-t2 whitespace-nowrap">${ref ? '<span class="lm-t3">—</span>' : `${l.deductedLessons} 节`}</td>
                  <td class="py-3 text-right font-bold whitespace-nowrap ${ref ? 'text-rose-600' : (l.paymentAmount > 0 ? 'lm-t1' : 'lm-t3')}">${l.paymentAmount ? fmtMoney(l.paymentAmount) : '—'}</td>
                  <td class="py-3 text-right lm-t3 whitespace-nowrap pr-2">${(l.checkInTime || '').replace('T', ' ').slice(5, 16)}</td>
                </tr>`;}).join('')}
              </tbody>
            </table>
          </div>`}
        </div>

        <!-- 右栏：续费预警 + 欠课名单 + 课时存量价值 -->
        <div class="space-y-4">
          <div class="lm-stat-card rounded-2xl p-4">
            <div class="font-bold text-xs lm-t1 mb-2 flex items-center gap-1.5"><i class="fa-solid fa-bell" style="color:#fe4c02;"></i> 续费预警 <span class="text-[10px] font-bold lm-t3">（剩余 ≤2 节${scoped ? ` · ${vLabel}` : ''}）</span></div>
            ${lowRows.length === 0 ? '<div class="text-[11px] lm-t3 py-4 text-center">暂无需要续费的学员 👍</div>' : `
            <div class="space-y-1.5 max-h-64 overflow-y-auto custom-scrollbar">
              ${lowRows.map((r) => `
                <button type="button" class="renew-low-row w-full flex items-center justify-between text-xs bg-[#fff7ef] hover:bg-[#ffeee0] px-3 py-2 rounded-lg transition text-left" data-renew-student="${r.student.id}" data-renew-course="${r.course.name}" title="点击为「${r.course.name}」充值">
                  <span class="font-bold lm-t1 truncate">${r.student.name} <span class="lm-t3 font-medium">· ${r.course.name}</span></span>
                  <span class="font-black shrink-0 ml-2 ${r.left === 0 ? 'text-rose-600' : 'text-[#fe4c02]'}">${lowLessonText(r.left)}</span>
                </button>`).join('')}
              <div class="text-[10px] lm-t3 pt-1">💡 点一行直接为该课程充值</div>
            </div>`}
          </div>

          <div class="lm-stat-card rounded-2xl p-4">
            <div class="font-bold text-xs lm-t1 mb-2 flex items-center gap-1.5"><i class="fa-solid fa-triangle-exclamation" style="color:var(--lm-pink);"></i> 欠课名单${scoped ? `<span class="text-[10px] font-bold lm-t3">· ${vLabel}</span>` : ''}</div>
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
              <span class="text-[10px] lm-t3">${scoped ? `「${vLabel}」授课课程剩余课时按单价折算` : '全部学员剩余课时按单价折算'}</span>
            </div>
          </div>
        </div>
      </div>
    `;

    // 查看视角切换 → 整页按该老师重算
    const vSel = document.getElementById('financeTeacherSelect');
    if (vSel) {
      vSel.value = tId;
      // 该老师已被删除 → 视图值落空，静默回退全校（不重渲染，避免递归）
      if (!vSel.value) { financeTeacherFilter = 'all'; vSel.value = 'all'; }
      vSel.addEventListener('change', () => {
        financeTeacherFilter = vSel.value;
        renderPageFinance();
      });
    }

    // 续费预警行 → 直通充值（预选到该课程包，单价一并带出）
    container.querySelectorAll('.renew-low-row').forEach((el) => {
      el.addEventListener('click', () => {
        const st = students.find((s) => s.id === el.getAttribute('data-renew-student'));
        if (st) openRechargeModal(st, el.getAttribute('data-renew-course'));
      });
    });
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
      // 请假三态：待补（假·待补）/ 已补（假✓）/ 普通请假（假）—— 窄卡只放得下两字
      const pend = isPendingMakeup(schedule);
      const dn = isMakeupDone(schedule);
      const leaveMark = pend ? (statusCompact ? '假!' : '假·待补') : (dn ? '假✓' : '假');
      const leaveTitle = pend ? '学员请假 · 待补课' : (dn ? '学员请假 · 已补课' : '学员请假');
      statusChip = `<span class="shrink-0 ${statusCompact ? 'text-[9px] px-0.5' : 'text-[8px] px-1'} font-black text-white ${pend ? 'bg-[#B98235]' : 'bg-rose-400'} rounded-md leading-none py-[3px]" title="${leaveTitle}">${leaveMark}</span>`;
    }
    // 补课课次：另加一枚「补」小标（不动状态角标，两者语义不同）
    if (isMakeupLesson(schedule)) {
      statusChip = '<span class="lm-chip-makeup" title="补课">补</span>' + statusChip;
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
      // 文案要对得上真实语义：待上课本来就没扣课时，没什么可退；已消课的才回滚流水+退课时
      if (!confirm('确定删除该课程？已消课的记录会一并撤销，并退还对应课时。')) return;
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

    const statusText = status === SCHEDULE_STATUS.COMPLETED ? '已消课 ✓'
      : status === SCHEDULE_STATUS.STUDENT_LEAVE
        ? (isPendingMakeup(schedule) ? '学员请假 🏖️ · 待补课' : (isMakeupDone(schedule) ? '学员请假 🏖️ · 已补课' : '学员请假 🏖️'))
        : (isMakeupLesson(schedule) ? '补课 · 待上课' : '待上课');
    const makeupSrc = isMakeupLesson(schedule) ? schedules.find((x) => x.id === schedule.makeupOfId) : null;
    const makeupDone = isMakeupDone(schedule) ? schedules.find((x) => x.id === schedule.madeUpById) : null;

    menu.innerHTML = `
      <div class="relative bg-white rounded-2xl shadow-2xl w-full max-w-xs p-5 space-y-2.5">
        <div id="lmSheetBody" class="space-y-2.5"></div>
      </div>`;

    const body = menu.querySelector('#lmSheetBody');

    const headHtml = () => `
      <div class="lm-sheet-head pb-3 border-b lm-hairline">
        <button type="button" data-act="delete" class="lm-sheet-del" aria-label="删除该课程" title="删除该课程">
          <i class="fa-solid fa-trash-can"></i>
        </button>
        <div class="font-bold text-sm lm-t1">${schedule.studentName} · ${schedule.subject}</div>
        <div class="text-[11px] lm-t3 mt-0.5">${schedule.date} ${schedule.startTime} · ${schedule.durationMinutes}分钟 · 状态：${statusText}</div>
        ${makeupSrc ? `<div class="text-[11px] mt-1" style="color:#2E5D68"><i class="fa-solid fa-arrows-rotate mr-1"></i>补 ${makeupSrc.date} ${makeupSrc.startTime} 的课</div>` : ''}
        ${makeupDone ? `<div class="text-[11px] mt-1" style="color:#2E5D68"><i class="fa-solid fa-circle-check mr-1"></i>已由 ${makeupDone.date} ${makeupDone.startTime} 的补课核销</div>` : ''}
        ${student && getStudentDebts(student.id).length ? `<div class="text-[10px] text-rose-500 mt-1">⚠ 该学员有欠课：${getStudentDebts(student.id).map(d => d.courseName + ' ' + d.amount + '节').join('、')}</div>` : ''}
      </div>`;

    const BTN = 'w-full py-3 rounded-xl font-bold text-sm transition flex items-center justify-center gap-2';

    let actionsHtml = '';
    if (status !== SCHEDULE_STATUS.STUDENT_LEAVE) {
      actionsHtml += `
        ${status === SCHEDULE_STATUS.SCHEDULED ? `
        <button data-act="checkin" class="${BTN} bg-emerald-500 text-white hover:bg-emerald-600">
          <i class="fa-solid fa-circle-check"></i> 消课签到（${getLessonCost(schedule)}节）
        </button>` : ''}
        <button data-act="leave" class="lm-btn-leave ${BTN}">
          <i class="fa-solid fa-person-walking-arrow-right"></i> 学员请假（退还${getLessonCost(schedule)}节）${status === SCHEDULE_STATUS.COMPLETED ? ' · 改请假' : ''}
        </button>
        ${status === SCHEDULE_STATUS.COMPLETED ? `
        <button data-act="revert" class="${BTN} lm-btn-ink text-white">
          <i class="fa-solid fa-rotate-left"></i> 撤销消课（还原为待上课）
        </button>` : ''}
      `;
    } else {
      // 请假态：补课链路的主场
      if (isPendingMakeup(schedule)) {
        actionsHtml += `
        <button data-act="makeup" class="lm-btn-makeup ${BTN}">
          <i class="fa-solid fa-calendar-plus"></i> 排补课
        </button>
        <button data-act="unneed" class="${BTN} btn-quiet">
          <i class="fa-solid fa-ban"></i> 这节课不用补了
        </button>`;
      } else if (!schedule.needMakeup) {
        actionsHtml += `
        <button data-act="need" class="lm-btn-makeup ${BTN}">
          <i class="fa-solid fa-calendar-plus"></i> 加入待补课
        </button>`;
      }
      actionsHtml += `
        <button data-act="revert" class="${BTN} lm-btn-ink text-white">
          <i class="fa-solid fa-rotate-left"></i> 撤销状态（还原为待上课）
        </button>
      `;
    }
    actionsHtml += `
      <button data-act="edit" class="${BTN} btn-quiet">
        <i class="fa-solid fa-pen-to-square"></i> 编辑课程信息
      </button>
    `;

    // 请假二选一：**不是每次请假都要补课**，所以把选择摆成必须选的一步，
    // 而不是偷偷给默认值（漏选会直接错在账上）。与手机端同一套两步交互。
    const askHtml = `
      <div class="pb-3 border-b lm-hairline">
        <div class="font-bold text-sm lm-t1">这节需要补课吗？</div>
        <div class="text-[11px] lm-t3 mt-1 leading-relaxed">
          ${schedule.studentName} · ${schedule.subject} · ${schedule.date} ${schedule.startTime}<br>
          需要补课 → 转入待补课清单，之后可以安排补课；不用补课 → 直接记为请假。
        </div>
      </div>
      <button data-ask="1" class="lm-btn-makeup ${BTN}">
        <i class="fa-solid fa-calendar-plus"></i> 需要补课（转入待补课）
      </button>
      <button data-ask="0" class="${BTN} btn-quiet">
        <i class="fa-solid fa-check"></i> 不用补课（直接记为请假）
      </button>
      <button data-act="back" class="w-full py-2 lm-t3 text-xs hover:lm-t2 transition">返回</button>`;

    const mainHtml = headHtml() + actionsHtml
      + `<button data-act="close" class="w-full py-2 lm-t3 text-xs hover:lm-t2 transition">取消</button>`;

    const renderBody = (view) => { body.innerHTML = view === 'ask' ? askHtml : mainHtml; };
    renderBody('main');

    menu.addEventListener('click', (e) => {
      if (e.target === menu) { menu.remove(); return; }
      const askBtn = e.target.closest('[data-ask]');
      if (askBtn) {
        const need = askBtn.getAttribute('data-ask') === '1';
        menu.remove();
        markStudentLeave(schedule.id, need);
        return;
      }
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      if (act === 'back') { renderBody('main'); return; }
      if (act === 'leave') { renderBody('ask'); return; }   // 请假先切二选一那一屏
      menu.remove();
      if (act === 'checkin') executeCheckIn(schedule.id);
      else if (act === 'makeup') openScheduleModalForNew(student, formatDate(new Date()), schedule.startTime, schedule);
      else if (act === 'need') setNeedMakeup(schedule.id, true);
      else if (act === 'unneed') setNeedMakeup(schedule.id, false);
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

  function openScheduleModalForNew(student, dateStr, startTimeStr, makeupSrc) {
    // 补课：学员/课程/科目/老师/时长/课室一律跟随源请假课，用户只挑日期与时间
    const preset = makeupSrc || null;
    if (preset) {
      student = students.find((st) => st.id === preset.studentId) || student;
      dateStr = formatDate(new Date());
      startTimeStr = snapTo5Min(preset.startTime || startTimeStr);
    }
    normalizeStudent(student);

    const titleEl = document.getElementById('modalScheduleTitle');
    if (titleEl) titleEl.textContent = preset ? '安排补课' : '安排新课程';

    const idEl = document.getElementById('inputScheduleId');
    if (idEl) idEl.value = '';

    // 补课标记写进隐藏域，保存时落成 schedule.makeupOfId
    const makeupEl = document.getElementById('inputMakeupOfId');
    if (makeupEl) makeupEl.value = preset ? preset.id : '';
    const banner = document.getElementById('makeupBanner');
    const bannerText = document.getElementById('makeupBannerText');
    if (banner) banner.classList.toggle('hidden', !preset);
    if (bannerText && preset) {
      bannerText.textContent = `补 ${preset.date} ${preset.startTime} 的课 · ${preset.studentName} · ${preset.subject || ''}`;
    }

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
    if (durEl) durEl.value = String(preset && preset.durationMinutes ? preset.durationMinutes : 60);

    const roomEl = document.getElementById('inputRoom');
    if (roomEl) roomEl.value = (preset && preset.room) ? preset.room : '琴房 101';

    const noteEl = document.getElementById('inputNotes');
    if (noteEl) noteEl.value = '';

    const courseSelect = document.getElementById('selectStudentCourse');
    if (courseSelect) {
      courseSelect.innerHTML = '';
      student.courses.forEach((c) => {
        courseSelect.innerHTML += `<option value="${c.id}" data-name="${c.name}">${c.name} (剩余 ${c.remainingLessons} 课时)</option>`;
      });
      if (preset && preset.courseId) courseSelect.value = preset.courseId;
    }

    // 科目：新增时留空（保存时自动等于课程包名），候选来自课程类型；补课沿用源课的科目
    renderCourseTypesDatalist();
    const subjectElNew = document.getElementById('inputSubject');
    if (subjectElNew) {
      subjectElNew.value = preset ? (preset.subject || '') : '';
      if (!preset && courseSelect && courseSelect.options[courseSelect.selectedIndex]) {
        subjectElNew.value = courseSelect.options[courseSelect.selectedIndex].getAttribute('data-name') || '';
      }
    }

    renderTeacherOptions();
    if (preset) {
      const tSel = document.getElementById('selectTeacher');
      if (tSel && preset.teacherId) tSel.value = preset.teacherId;
      const aSel = document.getElementById('selectAssistantTeacher');
      if (aSel && preset.assistantTeacherId) aSel.value = preset.assistantTeacherId;
    }

    const delBtn = document.getElementById('btnDeleteSchedule');
    if (delBtn) delBtn.classList.add('hidden');

    // 重复排课：仅新增时显示，默认"不重复"，结束日期默认3个月后。
    // 补课是一对一核销，天然只排一节 → 直接藏掉，避免排出一整个系列。
    const repeatBlock = document.getElementById('repeatOptionsBlock');
    const ruleEl = document.getElementById('selectRepeatRule');
    const endWrap = document.getElementById('repeatEndDateWrap');
    const endEl = document.getElementById('inputRepeatEndDate');
    const hintEl = document.getElementById('repeatHint');
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

    // 编辑不走补课模式：清掉补课隐藏域与提示条（否则上次排补课残留的 id 会被误写）
    const makeupElEdit = document.getElementById('inputMakeupOfId');
    if (makeupElEdit) makeupElEdit.value = '';
    const bannerEdit = document.getElementById('makeupBanner');
    if (bannerEdit) bannerEdit.classList.add('hidden');

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
        // ⚠️ 必须显式写 status：云端存的是这个对象的原样 JSON，缺了它整条记录就没有 status。
        //    normalizeSchedule 只在「加载/同步/导入」时补缺省值，新建的对象不经过它，
        //    所以缺字段会被原样推上云 —— ICS 订阅是白名单判断，会把这节课整条漏掉。
        //    见 AGENTS 第 36 条（「界面上有课，日历里没有」）。
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
        notes,
        colorTheme,
        ...(seriesId ? { seriesId } : {}),
      });
      const firstId = 'sch_' + Date.now();
      schedules.push(makeSchedule(firstId, date));
      // 补课：把这一节挂到源请假课上（双向标记由 syncMakeupLink 统一维护）
      const makeupOfId = (() => { const el = document.getElementById('inputMakeupOfId'); return el ? el.value : ''; })();
      if (makeupOfId) {
        const created = schedules.find((s) => s.id === firstId);
        const src = schedules.find((s) => s.id === makeupOfId);
        if (created && src && isPendingMakeup(src)) {
          created.makeupOfId = src.id;
          syncMakeupLink(created);
        } else if (created) {
          showToast('⚠ 原请假课状态已变，这节按普通排课保存', 'circle-info');
        }
      }

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
        // 导入的排课同样要过 normalizeSchedule：外部 JSON 很可能没有 status 字段，
        // 原样入库会被原样推上云 → ICS 白名单漏掉（AGENTS 第 36 条）
        if (mode === 'overwrite') {
          schedules = data.schedules.map(normalizeSchedule);
        } else {
          data.schedules.forEach((sch) => {
            const ns = normalizeSchedule(sch);
            if (!schedules.some((x) => x.id === ns.id)) schedules.push(ns);
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
  // 14b. 导入历史消课（使用 LessonMate 之前上过的课）
  // ==========================================
  // 场景：老师以前用 Excel / 纸质账本记账，换到本系统后要把「过去上过的课」补进来，
  // 否则财务历史、家长对账、学员详情的消课记录全是空的。
  //
  // 与「导入课表数据」（上一节）的区别：那个是全量 JSON 覆盖/合并（改学员、改排课）；
  // 这个**只追加消课流水**，永不改已有排课、不清余额，误操作可以按批次整批撤销。
  //
  // ⚠️ 三条硬约束（改之前先看 AGENTS 第 42 条）：
  //   1. 一行 N 节必须展开成 N 条 1 节流水 —— deductedLessons > 1 会被 migrateLessonUnits
  //      当成旧折算产物改回 1（金额也跟着错），所以历史数据也得守「一节课永远 1 节」。
  //   2. 日期同时写 `date` 和 `checkInTime`，且 checkInTime 取**本地中午 12:00** 转 ISO：
  //      财务按月聚合用的是 checkInTime 的字符串前缀，取 00:00 会在月初滑到上个月。
  //   3. 重导同一份文件必须幂等 —— 去重键 studentId+date+course+金额，按「系统里已有几条」消耗。
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
      .replace(/^\uFEFF/, '')                 // Excel 存 CSV 默认带 BOM
      .split(/\r\n|\r|\n/)
      .filter((l) => l.trim() !== '');
  }

  // 分隔符：Excel/微信复制是制表符，CSV 是逗号，中文 Excel 可能存全角逗号，老 Mac 是分号
  function historyDetectDelimiter(line) {
    if (line.indexOf('\t') >= 0) return '\t';
    if (line.indexOf(',') >= 0) return ',';
    if (line.indexOf('，') >= 0) return '，';
    if (line.indexOf(';') >= 0) return ';';
    return ',';
  }

  // 手写状态机：支持 "含逗号,的备注" 和 "" 转义（CSV 规范）
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

  // 表头识别：认得 2 列以上关键列就当表头，否则按固定顺序 [日期,学员,课程,节数,金额,老师,备注]
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

  // 日期：2026-09-01 / 2026/9/1 / 2026.9.1 / 2026年9月1日 / 20260901（带时间只取日期部分）
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

  // 金额：¥1,200 / 1200元 / 1 200 都能认；看不懂返回 NaN（比悄悄当 0 更该提醒）
  function historyParseAmount(raw) {
    const s = String(raw == null ? '' : raw).replace(/[¥￥$元,，\s]/g, '');
    if (!s) return 0;
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
  }

  function historyParseLessons(raw) {
    const s = String(raw == null ? '' : raw).replace(/[节课时次\s]/g, '');
    if (!s) return 1;                        // 不写节数 = 1 节，这是大多数记法的默认
    const n = parseInt(s, 10);
    if (!Number.isFinite(n) || n < 1) return NaN;
    return Math.min(n, 20);                  // 一行 20 节以上基本是脏数据
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

  // 一行 N 节 → N 条 1 节流水，金额均摊（余数补到最后一条，保证合计一分不差）
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
    };
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

  // 撤销：不按余额反算（历史记录从不扣余额），只把流水本身抽掉
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
    showToast('模板已下载：学员 / 消课记录两个工作表', 'circle-check');
  }

  let historyPlanCache = null;

  function renderHistoryPreview() {
    const box = document.getElementById('historyPreview');
    if (!box) return;
    const plan = historyPlanCache;
    if (!plan) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');

    const warn = [];
    if (plan.errors.length) warn.push(`${plan.errors.length} 行有误`);
    if (plan.skippedDuplicate) warn.push(`${plan.skippedDuplicate} 条已存在（跳过）`);
    if (plan.joinDateWarn) warn.push(`${plan.joinDateWarn} 行加入时间看不懂`);

    const rowsHtml = plan.accepted.slice(0, 8).map((d) => `
      <tr class="border-t border-[#f2ece4]">
        <td class="py-1.5 pr-2 whitespace-nowrap lm-t2">${d.date}</td>
        <td class="py-1.5 pr-2 whitespace-nowrap font-semibold lm-t1">${escAttr(d.studentName)}</td>
        <td class="py-1.5 pr-2 whitespace-nowrap lm-t2">${escAttr(d.course)}</td>
        <td class="py-1.5 pr-2 whitespace-nowrap lm-t2">${d.amount > 0 ? fmtMoney(d.amount) : '—'}</td>
        <td class="py-1.5 whitespace-nowrap lm-t3">${escAttr(d.teacher || '')}</td>
      </tr>`).join('');

    const errHtml = plan.errors.slice(0, 5).map((e) => `<div class="text-[10px] text-rose-500">第 ${e.line} 行：${e.msg}</div>`).join('')
      + (plan.errors.length > 5 ? `<div class="text-[10px] text-rose-400">…还有 ${plan.errors.length - 5} 行</div>` : '');

    box.innerHTML = `
      <div class="rounded-xl border border-[#efe9e0] overflow-hidden">
        <div class="bg-[#faf8f3] px-3 py-2 flex items-center justify-between">
          <span class="font-bold text-[#44403c]">解析结果</span>
          <span class="text-[10px] lm-t3">${plan.totalRows} 行${warn.length ? ' · ' + warn.join(' · ') : ''}</span>
        </div>
        <div class="px-3 py-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
          <span class="lm-t2">可导入 <b class="text-[#fe4c02]">${plan.accepted.length}</b> 条流水</span>
          <span class="lm-t2">涉及学员 <b class="lm-t1">${plan.studentsInFile}</b> 人${plan.newStudents.length ? `（新建 ${plan.newStudents.length} 人）` : ''}</span>
          ${plan.rosterCount ? `<span class="lm-t2">名单 <b class="lm-t1">${plan.rosterCount}</b> 人${plan.rosterOnly ? `（${plan.rosterOnly} 人暂无消课记录）` : ''}</span>` : ''}
          ${plan.joinDateCount ? `<span class="lm-t2">加入时间 <b class="lm-t1">${plan.joinDateCount}</b> 人${plan.joinDateUpdate ? `（${plan.joinDateUpdate} 人将更新）` : ''}</span>` : ''}
          <span class="lm-t2">课程 <b class="lm-t1">${plan.coursesInFile}</b> 门${plan.newCourses.length ? `（新建 ${plan.newCourses.length} 个课程包，余额 0）` : ''}</span>
          <span class="lm-t2">课时费合计 <b class="lm-t1">${plan.amount > 0 ? fmtMoney(plan.amount) : '—'}</b></span>
        </div>
        ${plan.accepted.length ? `
        <div class="px-3 pb-1 overflow-x-auto">
          <table class="w-full text-[11px] text-left">
            <thead><tr class="lm-t3 text-[10px]"><th class="pb-1 font-medium">日期</th><th class="pb-1 font-medium">学员</th><th class="pb-1 font-medium">课程</th><th class="pb-1 font-medium">金额</th><th class="pb-1 font-medium">老师</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          ${plan.accepted.length > 8 ? `<div class="text-[10px] lm-t3 py-1">…下面是另 ${plan.accepted.length - 8} 条</div>` : ''}
        </div>` : (plan.rosterCount
          ? '<div class="px-3 pb-2 text-[11px] lm-t2">本次只导入学员名单，没有消课记录</div>'
          : '<div class="px-3 pb-2 text-[11px] text-rose-500">没有可导入的行</div>')}
        ${errHtml ? `<div class="px-3 py-2 border-t border-[#f2ece4] space-y-0.5">${errHtml}</div>` : ''}
      </div>`;
  }

  function resetHistoryImport() {
    historyPlanCache = null;
    const fileInput = document.getElementById('historyFileInput');
    if (fileInput) fileInput.value = '';
    const nameEl = document.getElementById('historyFileName');
    if (nameEl) nameEl.textContent = '未选择文件';
    const seedEl = document.getElementById('historySeedRemaining');
    if (seedEl) seedEl.checked = false;
    const preview = document.getElementById('historyPreview');
    if (preview) { preview.innerHTML = ''; preview.classList.add('hidden'); }
    const btn = document.getElementById('btnConfirmHistoryImport');
    if (btn) btn.disabled = true;
  }

  function refreshHistoryClearBtn() {
    const btn = document.getElementById('btnClearHistoryLogs');
    if (!btn) return;
    const n = historyImportLogs().length;
    btn.classList.toggle('hidden', n === 0);
    btn.textContent = `清空历史导入（${n} 条）`;
  }

  function openHistoryImport() {
    resetHistoryImport();
    refreshHistoryClearBtn();
    showModal('modalHistoryImport');
  }

  async function handleHistoryFileChange(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const nameEl = document.getElementById('historyFileName');
    if (nameEl) nameEl.textContent = file.name;
    const btn = document.getElementById('btnConfirmHistoryImport');
    let parsed;
    try {
      parsed = await readHistoryFile(file);
    } catch (err) {
      historyPlanCache = null;
      renderHistoryPreview();
      if (btn) btn.disabled = true;
      showToast('文件读取失败，请重试', 'triangle-exclamation');
      return;
    }
    if (parsed.error) {
      historyPlanCache = null;
      renderHistoryPreview();
      if (btn) btn.disabled = true;
      showToast(parsed.error, 'triangle-exclamation');
      return;
    }
    historyPlanCache = buildHistoryPlan(parsed.rows, parsed.roster);
    renderHistoryPreview();
    // 只有名单、没有消课记录也允许导入（新建学员本身就有价值）
    if (btn) btn.disabled = !historyPlanCache.accepted.length && !historyPlanCache.newStudents.length;
    if (!parsed.hasHeader) {
      showToast(parsed.roster.length
        ? '「学员」页没认到表头，按「姓名,加入时间」的列序读的'
        : '没认到表头，按「日期,学员,课程,节数,金额,老师,备注」的列序读的', 'circle-info');
    }
  }

  function handleConfirmHistoryImport() {
    if (!historyPlanCache || (!historyPlanCache.accepted.length && !historyPlanCache.newStudents.length)) {
      showToast('先选一个 Excel 或 CSV 文件', 'circle-info');
      return;
    }
    const seedEl = document.getElementById('historySeedRemaining');
    const res = applyHistoryPlan(historyPlanCache, { seedRemaining: !!(seedEl && seedEl.checked) });
    saveData();
    refreshView();
    const removed = historyPlanCache;
    historyPlanCache = null;
    hideModal('modalHistoryImport');
    showToast(`已导入 ${res.count} 条历史消课记录${res.students ? `，新建 ${res.students} 位学员` : ''}`, 'file-import');
    // 撤销窗口给足：历史导入动辄上百条，5 秒来不及判断，这里放在设置页卡片的「清空」里兜底
    void removed;
  }

  function handleClearHistoryLogs() {
    const n = historyImportLogs().length;
    if (!n) return;
    if (!confirm(`确定清空全部 ${n} 条历史导入的消课记录吗？\n（真实消课、退款记录不受影响；导入时新建的学员和课程包会保留）`)) return;
    const removed = removeHistoryLogs('');
    saveData();
    refreshView();
    refreshHistoryClearBtn();
    showToast(`已清空 ${removed} 条历史导入记录`, 'trash-can');
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

  // 环比徽章：本月累计 vs **上月整月**合计（口径不按日截断，只给个方向感）。
  // 上月为 0（当月没消课记录）时**不给百分比** —— 除零算出来的「+∞%」是假数据，宁可不显示。
  // 悬停 title 里带两侧绝对值，涨幅口径一眼可核对（徽章样式见 css/legacy-tokens.css 末尾）。
  // 位置约定：卡片标题行**右上方**（label 左、徽章右，中间用 margin-left:auto 顶开，不引新 tailwind 类）。
  // 手机端 js/mobile.js 里有一份同名同语义的副本，改口径要两边一起改。
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

  // 上月整月消课流水（跨年由 Date 自动回退）：只喂环比徽章，不改任何既有口径
  function prevMonthLogs() {
    const now = new Date();
    const pm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const pfx = `${pm.getFullYear()}-${String(pm.getMonth() + 1).padStart(2, '0')}`;
    return checkInLogs.filter((l) => (l.checkInTime || '').startsWith(pfx));
  }
  const sumLessons = (logs) => logs.reduce((acc, l) => acc + (l.deductedLessons || 0), 0);
  const sumValue = (logs) => logs.reduce((acc, l) => acc + (l.paymentAmount || 0), 0);

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

    // 上月整月（跨年由 Date 自动回退），只喂环比徽章，不改任何既有口径
    const pLogs = prevMonthLogs();
    const prevLessons = sumLessons(pLogs);
    const prevValue = sumValue(pLogs);
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
          <div class="flex items-center gap-1.5 text-[9px] lm-t3"><span>本月课消</span>${momBadge(monthLessons, prevLessons, ' 节', (n) => n.toFixed(1))}</div>
          <div class="text-sm font-black lm-t1">${monthLessons.toFixed(1)} 节</div>
        </div>
        <div class="lm-soft rounded-lg p-2">
          <div class="flex items-center gap-1.5 text-[9px] lm-t3"><span>课消价值</span>${momBadge(monthValue, prevValue, ' 元', (n) => n.toFixed(0))}</div>
          <div class="text-sm font-black lm-t1">${fmtMoney(monthValue)}</div>
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
  // presetCourseName：从「续费预警」那行点进来时预选到对应课程包（并带出它的单价）
  function openRechargeModal(student, presetCourseName) {
    normalizeStudent(student);
    migrateStudentCourses(student);

    const old = document.getElementById('rechargeModal');
    if (old) old.remove();

    const pre = presetCourseName ? (student.courses || []).find((c) => c.name === presetCourseName) : null;
    const courseOptions = (student.courses || [])
      .map((c) => `<option value="${c.name}"${c === pre ? ' selected' : ''}>${c.name}（余 ${c.remainingLessons}）</option>`)
      .join('');

    const firstCourse = pre || (student.courses || [])[0];

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

  // 退款弹窗（部分退款：按课时退，金额默认 = 节数 × 单价，可手改）
  function openRefundModal(student) {
    normalizeStudent(student);
    migrateStudentCourses(student);

    const old = document.getElementById('refundModal');
    if (old) old.remove();

    const courses = refundableCourses(student);
    if (!courses.length) { showToast('该学员没有可退的课时', 'circle-info'); return; }

    const courseOptions = courses
      .map((c) => `<option value="${c.id}">${c.name}（余 ${c.remainingLessons} 节${c.unitPrice > 0 ? ` · ¥${c.unitPrice}/节` : ''}）</option>`)
      .join('');

    const modal = document.createElement('div');
    modal.id = 'refundModal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.className = 'fixed inset-0 lm-scrim backdrop-blur-xs z-50 flex items-center justify-center p-4';
    modal.innerHTML = `
      <div class="bg-white rounded-2xl shadow-2xl w-full max-w-xs p-5 space-y-3" onclick="event.stopPropagation()">
        <div class="font-bold text-sm lm-t1 pb-2 border-b lm-hairline">
          <i class="fa-solid fa-circle-minus" style="color:#d5304f;"></i>
          为 ${student.name} 退款 / 退课时
        </div>
        <div>
          <label class="block text-[11px] font-semibold lm-t2 mb-1">课程包</label>
          <select id="refundCourseSelect" class="w-full px-3 py-2 border lm-hairline rounded-xl text-xs outline-none focus:ring-2 focus:ring-emerald-300">
            ${courseOptions}
          </select>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-[11px] font-semibold lm-t2 mb-1">退款节数</label>
            <input type="number" id="refundLessons" min="1" step="1" value="1" class="w-full px-3 py-2 border lm-hairline rounded-xl text-xs font-bold outline-none focus:ring-2 focus:ring-emerald-300">
          </div>
          <div>
            <label class="block text-[11px] font-semibold lm-t2 mb-1">退款金额 (元)</label>
            <input type="number" id="refundAmount" min="0" step="0.01" inputmode="decimal" value="0" class="w-full px-3 py-2 border lm-hairline rounded-xl text-xs font-bold outline-none focus:ring-2 focus:ring-emerald-300">
          </div>
        </div>
        <div>
          <label class="block text-[11px] font-semibold lm-t2 mb-1">原因 / 备注（可选）</label>
          <input type="text" id="refundRemarks" placeholder="如：搬家停课" class="w-full px-3 py-2 border lm-hairline rounded-xl text-xs outline-none focus:ring-2 focus:ring-emerald-300">
        </div>
        <div id="refundHint" class="text-[10px] lm-t3"></div>
        <div class="flex gap-2 pt-1">
          <button id="refundCancel" class="flex-1 py-2.5 rounded-xl btn-quiet font-bold text-xs">取消</button>
          <button id="refundConfirm" class="flex-1 py-2.5 rounded-xl text-white font-bold text-xs" style="background:#d5304f;">确认退款</button>
        </div>
      </div>
    `;

    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);

    const sel = modal.querySelector('#refundCourseSelect');
    const lessonsEl = modal.querySelector('#refundLessons');
    const amountEl = modal.querySelector('#refundAmount');
    const hintEl = modal.querySelector('#refundHint');

    const curCourse = () => courses.find((c) => c.id === sel.value) || courses[0];
    // 节数一变就把金额按「节数 × 单价」重算（用户随后可手改金额；改课程包则整体重置）
    const syncByLessons = () => {
      const c = curCourse();
      const left = Number(c.remainingLessons) || 0;
      let n = Math.floor(Number(lessonsEl.value) || 0);
      if (n < 1) n = 1;
      if (n > left) n = left;
      lessonsEl.value = String(n);
      amountEl.value = String((Number(c.unitPrice) || 0) * n);
      hintEl.textContent = `「${c.name}」当前剩 ${left} 节 → 退后剩 ${left - n} 节 · 金额 ¥${Number(amountEl.value || 0).toFixed(0)}`;
    };

    sel.addEventListener('change', () => { lessonsEl.value = '1'; syncByLessons(); });
    lessonsEl.addEventListener('input', syncByLessons);
    amountEl.addEventListener('input', () => {
      const c = curCourse();
      const left = Number(c.remainingLessons) || 0;
      const n = Math.floor(Number(lessonsEl.value) || 0);
      hintEl.textContent = `「${c.name}」当前剩 ${left} 节 → 退后剩 ${left - n} 节 · 金额 ¥${Number(amountEl.value || 0).toFixed(0)}`;
    });
    syncByLessons();

    modal.querySelector('#refundCancel').addEventListener('click', () => modal.remove());
    modal.querySelector('#refundConfirm').addEventListener('click', () => {
      const lessons = Math.floor(Number(lessonsEl.value) || 0);
      const amount = Number(amountEl.value) || 0;
      const remarks = (modal.querySelector('#refundRemarks').value || '').trim();
      const done = executeRefund(student.id, sel.value, lessons, amount, remarks);
      if (done) {
        modal.remove();
        // 退款后把详情重新打开：课时余额与退款记录都得当场看到变化
        setTimeout(() => openStudentDetail(student.id), 320);
      }
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

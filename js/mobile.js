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
  let selectedTeacherFilter = 'all';
  let mobileStartDate = getToday(); // 默认从今天开始显示 3 日日历（周末也能直接看到今天）

  // 周/月日历（系统日历风格：收起=一周条，点标题展开整月，下方挂选中日日程）
  let calMode = 'grid3';                       // 'grid3' 3日时间轴 | 'cal' 周/月
  let calSelected = formatDate(getToday());    // 选中的日期
  let calExpanded = false;                     // 是否展开整月网格
  const CAL_CELL_H = 46;                       // 单行日期格高度（px，用于展开/收起过渡）

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
    return !sch || sch.teacherId === teacherSession.teacherId || sch.assistantTeacherId === teacherSession.teacherId;
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
  function openMobileStudentDetail(studentId) {
    const student = students.find((s) => s.id === studentId);
    if (!student) return;
    normalizeStudent(student);

    const titleEl = document.getElementById('mobileStudentDetailTitle');
    if (titleEl) titleEl.textContent = `${student.name} · 详情`;
    const body = document.getElementById('mobileStudentDetailBody');
    if (!body) return;

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
      <div class="flex items-center gap-3 bg-slate-50 rounded-2xl p-3">
        <div class="w-12 h-12 rounded-full bg-[#111111] text-white flex items-center justify-center font-bold text-base">${student.name.substring(0, 1)}</div>
        <div class="flex-1">
          <div class="font-bold text-sm text-slate-800">${student.name}</div>
          <div class="text-[11px] text-slate-500">${student.phone ? '📞 ' + student.phone : '未填电话'}</div>
        </div>
        <div class="text-right">
          <div class="text-xl font-black ${totalOwed > 0 ? 'text-[#d5304f]' : 'text-[#fe4c02]'}">${totalLessons}</div>
          <div class="text-[9px] text-slate-400 font-bold">总剩课时${totalOwed > 0 ? ' · 欠' + totalOwed + '节' : ''}</div>
        </div>
      </div>

      <button type="button" id="mDetailRechargeBtn" class="w-full py-3 rounded-xl bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-1.5 active:bg-emerald-600 transition">
        <i class="fa-solid fa-circle-plus"></i> 充值 / 新购课时包
      </button>

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
        <div class="font-bold text-[11px] text-slate-500 uppercase tracking-wider mb-1.5">🕘 消课记录（最近 ${logs.length} 条）</div>
        ${logs.length === 0 ? '<div class="text-[11px] text-slate-400 py-4 text-center bg-slate-50 rounded-2xl">暂无消课记录</div>' : `
        <div class="space-y-1 max-h-52 overflow-y-auto">
          ${logs.map((l) => `
          <div class="flex items-center justify-between bg-slate-50 px-3 py-2.5 rounded-xl">
            <div class="min-w-0">
              <span class="font-bold text-slate-700">${l.courseName}</span>
              ${l.teacherName ? `<span class="text-slate-400 ml-1.5">${l.teacherName}</span>` : ''}
              ${l.remarks ? `<span class="text-[#fe4c02] ml-1">${l.remarks}</span>` : ''}
            </div>
            <div class="text-right shrink-0 ml-2">
              <div class="font-bold text-slate-600">${l.deductedLessons}节${l.paymentAmount > 0 ? ' ¥' + l.paymentAmount.toFixed(0) : ''}</div>
              <div class="text-[9px] text-slate-400">${(l.date || (l.checkInTime || '').slice(0, 10))}</div>
            </div>
          </div>`).join('')}
        </div>`}
      </div>

      ${leaves.length ? `
      <div>
        <div class="font-bold text-[11px] text-slate-500 uppercase tracking-wider mb-1.5">🏖️ 请假记录（最近 ${leaves.length} 次）</div>
        <div class="space-y-1">
          ${leaves.map((s) => `
          <div class="flex items-center justify-between bg-slate-50 px-3 py-2 rounded-xl text-[11px]">
            <span class="text-slate-600">${s.date} ${s.startTime || ''}</span>
            <span class="text-slate-500">${s.subject || ''}</span>
          </div>`).join('')}
        </div>
      </div>` : ''}
    `;

    const rechargeBtn = body.querySelector('#mDetailRechargeBtn');
    if (rechargeBtn) rechargeBtn.addEventListener('click', () => {
      hideModal('modalMobileStudentDetail');
      setTimeout(() => openMobileRechargeModal(student), 280);
    });

    showModal('modalMobileStudentDetail');
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

  function openMobileRechargeModal(student) {
    normalizeStudent(student);
    migrateStudentCourses(student);

    const old = document.getElementById('mobileRechargeModal');
    if (old) old.remove();

    const courseOptions = (student.courses || [])
      .map((c) => `<option value="${c.name}">${c.name}（余 ${c.remainingLessons}）</option>`)
      .join('');

    const firstCourse = (student.courses || [])[0];

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
      renderMobile3DayView();
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

  function getLessonCost(schedule) {
    return Math.max(1, Math.round((schedule.durationMinutes || 45) / 45));
  }

  function executeCheckIn(scheduleId, remarks) {
    const sch = schedules.find((s) => s.id === scheduleId);
    if (!sch) return;
    if (sch.status === SCHEDULE_STATUS.COMPLETED) {
      showToast('该课程已消课，无需重复操作');
      return;
    }
    if (sch.status === SCHEDULE_STATUS.STUDENT_LEAVE) {
      showToast('该课程为请假状态，请先撤销请假');
      return;
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
    saveData();
    renderMobile3DayView();
    renderMobileStudents();
    offerUndo(`✅ 已消课：${sch.studentName} · ${sch.subject || sch.courseName || ''}（${deducted}节）`, `消课 ${sch.studentName}`);
    if (window.uiAnim) window.uiAnim.flashSchedule(sch.id);
  }

  // 学员请假（不限课程时间，已消课的也可改为请假）
  // App 语义：请假本不扣课时；只有已消课改请假时，才把消课扣掉的课时退回
  function markStudentLeave(scheduleId) {
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
    saveData();
    // 首页今日列表：让这一行滑到请假区（pendingReorderId 由 renderMobileHome 消费一次）
    // 放在其它重渲染之前 —— 万一它们抛错，用户看到的滑动也已经发生了
    pendingReorderId = sch.id;
    if (typeof renderMobileHome === 'function') renderMobileHome();
    renderMobile3DayView();
    renderMobileStudents();
    offerUndo(leaveMsg, `请假 ${sch.studentName}`);
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
    saveData();
    // 撤销请假：同一套 FLIP，让这一行滑回时间序里原来的位置
    pendingReorderId = sch.id;
    if (typeof renderMobileHome === 'function') renderMobileHome();
    renderMobile3DayView();
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

            // 欠课账校准：负课时（欠课）同步进欠课账
            syncAllDebts();

            localStorage.setItem('edu_scheduler_last_sync_time', String(remoteData.updatedAt));
            saveDataLocalOnly();
            renderMobileTeacherSelect();
            renderMobile3DayView();
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
          renderMobile3DayView();
          renderMobileStudents();
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
    renderMobile3DayView();
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
      renderMobile3DayView();
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
      renderMobile3DayView();
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
          renderMobile3DayView();
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
      if (calMode === 'cal') { shiftCalPage(-1); return; }
      mobileStartDate = addDays(mobileStartDate, -3);
      renderMobile3DayView();
    });

    safeBind('btnMobileNext', 'click', () => {
      if (calMode === 'cal') { shiftCalPage(1); return; }
      mobileStartDate = addDays(mobileStartDate, 3);
      renderMobile3DayView();
    });

    safeBind('btnMobileToday', 'click', () => {
      // 以今天为窗口起点，保证今天永远在3日视图内（旧逻辑回到周一，周末时看不到今天）
      mobileStartDate = getToday();
      if (calMode === 'cal') calSelected = formatDate(getToday());
      renderMobile3DayView();
    });

    // 3日时间轴 ↔ 周/月日历 切换
    safeBind('btnMobileCalMode', 'click', () => {
      calMode = calMode === 'grid3' ? 'cal' : 'grid3';
      if (calMode === 'cal') calSelected = formatDate(getToday());
      applyCalModeUI();
    });

    // ============ 周/月日历：展开收起 + 当日列表点击（翻页走日期条/滑动手势） ============
    safeBind('btnCalExpand', 'click', () => {
      calExpanded = !calExpanded;
      renderMobileCal();
    });
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
        renderMobile3DayView();

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
      renderMobile3DayView();
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
      // 周/月日历是课表的子模式：进课表时按 calMode 决定显示哪个容器，离开课表时一并隐藏
      const calweekEl = document.getElementById('viewCalweek');
      if (calweekEl) calweekEl.classList.toggle('hidden', view !== 'schedule' || calMode !== 'cal');
      if (view === 'schedule' && calMode === 'cal') {
        const vs = document.getElementById('viewSchedule');
        if (vs) vs.classList.add('hidden');
      }
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
      const lowStudents = students.filter((st) => (st.courses || []).some((c) => c.remainingLessons <= 2)).length;
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
    renderMobile3DayView();
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
          <div class="lm-bignum">${todayCountH}<small>节课 · 已消 ${todayDoneH}${leaveTag}</small></div>
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
          <div class="lm-bignum mt-1.5">${myTodayCount}<small>节课 · 已消 ${myTodayDone}${myLeaveTag}</small></div>
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
          <div class="lm-stat-v mt-1">${todayPending}<span class="text-xs font-medium text-[#626260]"> 节</span></div>
          <div class="text-[11px] text-[#9c9fa5] mt-0.5">${todayPending ? '下一节 ' + (todayAll.filter((s) => s.status === SCHEDULE_STATUS.SCHEDULED).sort((a, b) => a.startTime.localeCompare(b.startTime))[0]?.startTime || '') : '全部完成 🎉'}</div>
        </div>
        <div class="lm-card px-4 py-4">
          <div class="text-[11px] font-medium text-[#9c9fa5] flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:#fe4c02"></span> 本周剩余</div>
          <div class="lm-stat-v mt-1 text-[#fe4c02]">${weekLeft}<span class="text-xs font-medium text-[#626260]"> 节</span></div>
          <div class="text-[11px] text-[#9c9fa5] mt-0.5">至周日 · 已消 ${weekDoneCnt} 节</div>
        </div>
        ${!isTeacherView() ? `
        <button id="homeCardDebt" class="lm-card px-4 py-4 text-left active:opacity-80">
          <div class="text-[11px] font-medium text-[#9c9fa5] flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:#ff2067"></span> 欠费学员</div>
          <div class="lm-stat-v mt-1 text-[#d5304f]">${debtCount}<span class="text-xs font-medium text-[#626260]"> 人</span></div>
          <div class="text-[11px] text-[#9c9fa5] mt-0.5">共欠 ${debtTotal} 节</div>
        </button>
        <button id="homeCardRenew" class="lm-card px-4 py-4 text-left active:opacity-80">
          <div class="text-[11px] font-medium text-[#9c9fa5] flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:#fe4c02"></span> 待续费提醒</div>
          <div class="lm-stat-v mt-1 text-[#fe4c02]">${lowCount}<span class="text-xs font-medium text-[#626260]"> 项</span></div>
          <div class="text-[11px] text-[#9c9fa5] mt-0.5">课时≤2 需跟进</div>
        </button>` : `
        <button id="homeCardDebt" class="lm-card px-4 py-4 text-left active:opacity-80">
          <div class="text-[11px] font-medium text-[#9c9fa5] flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:#ff2067"></span> 欠费学员</div>
          <div class="lm-stat-v mt-1 text-[#d5304f]">${tDebtCount}<span class="text-xs font-medium text-[#626260]"> 人</span></div>
          <div class="text-[11px] text-[#9c9fa5] mt-0.5">共欠 ${tDebtTotal} 节</div>
        </button>
        <button id="homeCardRenew" class="lm-card px-4 py-4 text-left active:opacity-80">
          <div class="text-[11px] font-medium text-[#9c9fa5] flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:#fe4c02"></span> 待续费提醒</div>
          <div class="lm-stat-v mt-1 text-[#fe4c02]">${tLowCount}<span class="text-xs font-medium text-[#626260]"> 项</span></div>
          <div class="text-[11px] text-[#9c9fa5] mt-0.5">我的学员 课时≤2</div>
        </button>`}
      </div>`;

    // ---- 今日课程列表 ----
    // 排序：正常课按时间在前，请假课沉到最后（请假的不用盯，别混在时间轴里占位），
    // 两组之间插一条细分隔条，避免「为什么这节不按顺序」的困惑。
    const isLeaveSch = (s) => s.status === SCHEDULE_STATUS.STUDENT_LEAVE;
    const renderTodayRow = (s) => {
      const done = s.status === SCHEDULE_STATUS.COMPLETED;
      const leave = isLeaveSch(s);
      // 按当前时间分态：待上课(黑) → 正在上课(橙) → 待消课(黄)
      const nowHM = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`;
      const endHM = (() => { const [h, m] = (s.startTime || '00:00').split(':').map(Number); const d = new Date(); d.setHours(h, m + (s.durationMinutes || 45), 0, 0); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; })();
      let badge;
      if (done) badge = '<span class="lm-tag lm-tag-done">已消课</span>';
      else if (leave) badge = '<span class="lm-tag lm-tag-leave">请假</span>';
      else if (nowHM >= (s.startTime || '00:00') && nowHM < endHM) badge = '<span class="lm-tag lm-tag-live">正在上课</span>';
      else if (nowHM >= endHM) badge = '<button class="lm-tag lm-tag-due" data-home-checkin="' + s.id + '">待消课 ›</button>';
      else badge = '<button class="lm-tag lm-tag-todo" data-home-checkin="' + s.id + '">待上课 ›</button>';
      return `
        <div class="lm-card px-5 py-4 flex items-center gap-3.5" data-today-row="${s.id}">
          <div class="text-center shrink-0 min-w-[52px]">
            <div class="font-bold text-[18px] text-[#111111]">${s.startTime}</div>
            <div class="text-[10.5px] text-[#9c9fa5] mt-0.5">${s.durationMinutes || 45}分钟</div>
          </div>
          <div class="flex-1 min-w-0" style="border-left:1px solid #f0ebe2;padding-left:14px">
            <div class="font-bold text-[14.5px] text-[#111111] truncate">${s.studentName || ''} <span class="text-[#9c9fa5] font-medium">· ${s.subject || ''}</span></div>
            <div class="text-[12px] text-[#9c9fa5] truncate mt-1">${s.teacherName ? s.teacherName : ''}${s.room ? ' · ' + s.room : ''}</div>
          </div>
          ${badge}
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
    // 今日课程容器独立委托（badge 在 todayBox 不在 cards）
    const todayBoxEl = document.getElementById('mobileHomeToday');
    if (todayBoxEl) todayBoxEl.onclick = (e) => {
      const tag = e.target.closest('[data-home-checkin]');
      if (tag) {
        const sch = schedules.find((x) => x.id === tag.getAttribute('data-home-checkin'));
        if (sch) openMobileScheduleActionMenu(sch);
      }
    };
    cards.onclick = (e) => {
      // 今日课程状态胶囊 → 弹确认菜单（消课/请假二选一）
      const tag = e.target.closest('[data-home-checkin]');
      if (tag) {
        const sch = schedules.find((x) => x.id === tag.getAttribute('data-home-checkin'));
        if (sch && typeof openMobileScheduleActionMenu === 'function') openMobileScheduleActionMenu(sch);
        return;
      }
      const t = e.target.closest('#homeCardDebt, #homeCardRenew');
      if (!t) return;
      if (t.id === 'homeCardDebt') window.__switchMobileView('finance');
      if (t.id === 'homeCardRenew') { window.__switchMobileView('students'); setTimeout(() => {
        const f = document.getElementById('mobileStudentStatusFilter') || document.getElementById('filter-low');
        if (f) { f.value = 'low'; f.dispatchEvent(new Event('change')); }
      }, 250); }
    };
    const exitBtn = document.getElementById('btnTeacherExitHome');
    if (exitBtn) exitBtn.onclick = () => {
      if (!confirm('退出老师身份，回到管理员入口？')) return;
      teacherLogout();
      location.reload();
    };
  }

  // ============ 周/月日历视图（收起=一周条 / 展开=整月网格 + 当日日程列表） ============
  // 学员主题色圆点：色卡色的深化版（白底上可见；底色本身太浅）
  const CAL_DOT_COLORS = { amber: '#D9985F', emerald: '#7E9271', sky: '#4E93A8', purple: '#657166', rose: '#D08168', mint: '#7FA495' };

  function calInView(s) {
    return selectedTeacherFilter === 'all' ||
      s.teacherId === selectedTeacherFilter || s.assistantTeacherId === selectedTeacherFilter;
  }

  function renderMobileCal() {
    const grid = document.getElementById('calGrid');
    const wrap = document.getElementById('calGridWrap');
    const titleEl = document.getElementById('calTitle');
    const chevron = document.getElementById('calChevron');
    const listEl = document.getElementById('calDayList');
    const dayTitleEl = document.getElementById('calDayTitle');
    if (!grid || !listEl || !wrap) return;

    const selDate = new Date(calSelected + 'T00:00:00');
    const todayStr = formatDate(getToday());
    if (titleEl) titleEl.textContent = `${selDate.getFullYear()}年${selDate.getMonth() + 1}月`;
    if (chevron) chevron.style.transform = calExpanded ? 'rotate(180deg)' : '';

    // 每天的课（按老师筛选；请假不计圆点，与桌面月视图同口径）
    const byDate = new Map();
    schedules.filter(calInView).forEach((s) => {
      if (!byDate.has(s.date)) byDate.set(s.date, []);
      byDate.get(s.date).push(s);
    });

    // 网格范围：收起=选中日所在周；展开=选中日所在月（按周一对齐，补足整周）
    const anchor = calExpanded ? new Date(selDate.getFullYear(), selDate.getMonth(), 1) : selDate;
    const start = getMonday(anchor);
    let weeks = 1;
    if (calExpanded) {
      const last = new Date(selDate.getFullYear(), selDate.getMonth() + 1, 0);
      weeks = Math.ceil((Math.round((last - start) / 86400000) + 1) / 7);
    }
    const totalCells = weeks * 7;
    const anchorMonth = selDate.getMonth();

    // 展开/收起的高度过渡（行数可能变化，渲染后按实际行数设 max-height）
    grid.innerHTML = '';
    const targetH = weeks * CAL_CELL_H + 6;
    requestAnimationFrame(() => { wrap.style.maxHeight = targetH + 'px'; });

    for (let i = 0; i < totalCells; i++) {
      const d = addDays(start, i);
      const dateStr = formatDate(d);
      const inMonth = !calExpanded || d.getMonth() === anchorMonth;
      const isToday = dateStr === todayStr;
      const isSel = dateStr === calSelected;
      const dayLessons = byDate.get(dateStr) || [];

      // 圆点标课：取前 3 节的学员主题色，去重（请假课不计圆点，与桌面月视图同口径）
      const themes = [];
      dayLessons.forEach((s) => {
        if (s.status === SCHEDULE_STATUS.STUDENT_LEAVE) return;
        const t = resolveScheduleTheme(s);
        if (themes.length < 3 && !themes.includes(t)) themes.push(t);
      });

      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cal-cell flex flex-col items-center justify-start rounded-xl transition select-none active:bg-black/5' +
        (inMonth ? '' : ' opacity-30');
      cell.style.height = CAL_CELL_H + 'px';
      cell.setAttribute('data-date', dateStr);

      let numCls;
      if (isSel) numCls = 'background:#111111;color:#fff;font-weight:800';
      else if (isToday) numCls = 'color:#fe4c02;font-weight:800;box-shadow:inset 0 0 0 1.5px rgba(254,76,2,.55)';
      else numCls = inMonth ? 'color:#111111;font-weight:700' : 'color:#9c9fa5;font-weight:500';
      cell.innerHTML = `
        <span class="w-8 h-8 rounded-full flex items-center justify-center text-[13.5px]" style="${numCls}">${d.getDate()}</span>
        <span class="flex items-center gap-[3px]" style="height:5px;margin-top:2px">${themes.map((t) => `<span class="rounded-full" style="width:4px;height:4px;background:${CAL_DOT_COLORS[t] || CAL_DOT_COLORS.amber}"></span>`).join('')}</span>
      `;
      cell.addEventListener('click', () => {
        if (calSelected === dateStr && !calExpanded) return;
        calSelected = dateStr;
        renderMobileCal();
      });
      grid.appendChild(cell);
    }

    // ---- 选中日的日程列表 ----
    const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const dayList = (byDate.get(calSelected) || []).slice()
      .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
    if (dayTitleEl) {
      const label = calSelected === todayStr ? '今日安排' : `${selDate.getMonth() + 1}月${selDate.getDate()}日 ${weekdayNames[selDate.getDay()]}`;
      dayTitleEl.innerHTML = `
        <span class="inline-block rounded-full" style="width:6px;height:6px;background:#111"></span>
        ${label} · ${dayList.length} 节课`;
    }

    const nowHM = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`;
    if (dayList.length === 0) {
      listEl.innerHTML = `
        <div class="text-center py-10 text-[#9c9fa5]">
          <i class="fa-regular fa-calendar-check text-2xl mb-2 block"></i>
          <div class="text-xs">这一天还没有排课</div>
        </div>`;
    } else {
      listEl.innerHTML = dayList.map((s) => {
        const done = s.status === SCHEDULE_STATUS.COMPLETED;
        const leave = s.status === SCHEDULE_STATUS.STUDENT_LEAVE;
        const endMins = (() => {
          const [h, m] = (s.startTime || '00:00').split(':').map(Number);
          return h * 60 + m + (s.durationMinutes || 45);
        })();
        const endHM = `${String(Math.floor(endMins / 60)).padStart(2, '0')}:${String(endMins % 60).padStart(2, '0')}`;
        let badge;
        if (done) badge = '<span class="lm-tag lm-tag-done">已消课</span>';
        else if (leave) badge = '<span class="lm-tag lm-tag-leave">请假</span>';
        else if (nowHM >= (s.startTime || '00:00') && nowHM < endHM) badge = '<span class="lm-tag lm-tag-live">正在上课</span>';
        else if (calSelected === todayStr && nowHM >= endHM) badge = '<span class="lm-tag lm-tag-due">待消课</span>';
        else badge = '<span class="lm-tag lm-tag-todo">待上课</span>';
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
    const dateTextEl = document.getElementById('mobileDateText');
    if (dateTextEl) {
      dateTextEl.textContent = calExpanded
        ? `${selDate.getFullYear()}年${selDate.getMonth() + 1}月`
        : `${selDate.getMonth() + 1}月${selDate.getDate()}日 ${weekdayNames[selDate.getDay()]}`;
    }
  }

  // 周/月模式翻页：收起=切换单日（周条自动跟随选中日所在周），展开=整月切换（保持“选中日序号”尽量不变）
  function shiftCalPage(dir) {
    const sel = new Date(calSelected + 'T00:00:00');
    if (calExpanded) {
      const targetMonth = new Date(sel.getFullYear(), sel.getMonth() + dir, 1);
      const lastDay = new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0).getDate();
      const d = new Date(targetMonth.getFullYear(), targetMonth.getMonth(), Math.min(sel.getDate(), lastDay));
      calSelected = formatDate(d);
    } else {
      calSelected = formatDate(addDays(sel, dir));
    }
    renderMobileCal();
  }

  // 课表模式切换：3日时间轴 ↔ 周/月日历
  function applyCalModeUI() {
    const vs = document.getElementById('viewSchedule');
    const vc = document.getElementById('viewCalweek');
    const icon = document.getElementById('calModeIcon');
    if (vs) vs.classList.toggle('hidden', calMode === 'cal');
    if (vc) vc.classList.toggle('hidden', calMode !== 'cal');
    if (icon) icon.className = calMode === 'cal'
      ? 'fa-solid fa-table-columns text-[12px]'
      : 'fa-solid fa-calendar-days text-[12px]';
    const p = document.getElementById('btnMobilePrev');
    const n = document.getElementById('btnMobileNext');
    if (calMode === 'cal') {
      if (p) p.innerHTML = '<i class="fa-solid fa-chevron-left text-[10px]"></i> 前周';
      if (n) n.innerHTML = '后周 <i class="fa-solid fa-chevron-right text-[10px]"></i>';
    } else {
      if (p) p.innerHTML = '<i class="fa-solid fa-chevron-left text-[10px]"></i> 前3天';
      if (n) n.innerHTML = '后3天 <i class="fa-solid fa-chevron-right text-[10px]"></i>';
    }
    if (calMode === 'cal') renderMobileCal();
  }

  function renderMobile3DayView() {
    // 周/月日历模式下，所有既有刷新点统一分流到月历渲染
    if (calMode === 'cal') {
      renderMobileHomeCard();
      renderMobileCal();
      return;
    }
    // 老师视角：课表默认先看自己的课，但保留筛选框可切换（登录成为老师后的首次渲染时选中自己）
    if (isTeacherView()) {
      if (!window.__teacherFilterInit) {
        window.__teacherFilterInit = true;
        if (selectedTeacherFilter === 'all') selectedTeacherFilter = teacherSession.teacherId;
      }
    } else {
      window.__teacherFilterInit = false; // 退出老师身份后重置，下次登录再默认选中
    }
    const headerContainer = document.getElementById('mobileHeaderDays');
    const gridContainer = document.getElementById('mobileGridColumns');
    if (!headerContainer || !gridContainer) return;
    headerContainer.innerHTML = '';
    gridContainer.innerHTML = '';
    renderMobileHomeCard();

    const endDate = addDays(mobileStartDate, 2);
    const dateTextEl = document.getElementById('mobileDateText');
    if (dateTextEl) {
      dateTextEl.textContent = `${mobileStartDate.getMonth() + 1}月${mobileStartDate.getDate()}日 - ${endDate.getMonth() + 1}月${endDate.getDate()}日`;
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

      let daySchedules = schedules.filter((s) => s.date === dateStr);
      if (selectedTeacherFilter !== 'all') {
        daySchedules = daySchedules.filter((s) => s.teacherId === selectedTeacherFilter || s.assistantTeacherId === selectedTeacherFilter);
      }

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
      statusChip = `<span class="shrink-0 ${statusCompact ? 'text-[9px] px-0.5' : 'text-[8px] px-1'} font-black text-white bg-rose-400 rounded-md leading-none py-[3px]" title="学员请假">假</span>`;
      card.style.opacity = '0.5';
      card.classList.add('grayscale');
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
    { bg: 'bg-[#657166]', ring: 'ring-[#657166]/40',  solid: 'bg-[#657166]', text: 'text-[#FFFFFF]' },
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

  function renderMobileStudents() {
    const container = document.getElementById('mobileStudentContainer');
    if (!container) return;
    container.innerHTML = '';
    populateMobileStudentFilters();

    const filterBtn = document.querySelector('.mobile-student-filter.active');
    const filter = filterBtn ? filterBtn.getAttribute('data-filter') : 'all';
    const searchEl = document.getElementById('mobileSearchStudent');
    const query = ((searchEl ? searchEl.value : '') || '').trim().toLowerCase();
    const tSel = document.getElementById('mobileStudentTeacherFilter');
    const cSel = document.getElementById('mobileStudentCourseFilter');
    // 老师视角默认"我的学员"：每次渲染下拉被重建后值可能回到第一项(mine)，但若用户之前选了"全部"则保留
    const teacherFilter = tSel ? (tSel.value || 'all') : 'all';
    const courseFilter = cSel ? cSel.value : 'all';

    let list = students.filter((st) => {
      normalizeStudent(st);
      // 范围下拉：mine=我的学员（关联名单或排课相关）；all=全部；其他值=指定老师
      if (isTeacherView() && teacherFilter === 'mine') {
        const related = (st.teacherIds || []).includes(teacherSession.teacherId) ||
          schedules.some((s) => s.studentId === st.id && (s.teacherId === teacherSession.teacherId || s.assistantTeacherId === teacherSession.teacherId));
        if (!related) return false;
      }
      const matchName = st.name.toLowerCase().includes(query) || (st.phone && st.phone.includes(query));
      const matchCourse = st.courses.some((c) => c.name.toLowerCase().includes(query));
      if (!matchName && !matchCourse) return false;

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
      const emptyText = query || filter === 'low'
        ? '没有符合条件的学员'
        : '还没有学员，点击右上角"+ 新增"开始添加';
      container.innerHTML = `
        <div class="text-center py-10 text-slate-400 text-xs">
          <i class="fa-solid fa-user-ghost text-3xl mb-2 block opacity-40"></i>
          ${emptyText}
        </div>`;
      return;
    }

    list.forEach((st) => {
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

  function openMobileScheduleModalForNew(student = null, dateStr = formatDate(new Date()), startTimeStr = '10:00') {
    const titleEl = document.getElementById('modalMobileScheduleTitle');
    if (titleEl) titleEl.textContent = '安排新课程';

    const idEl = document.getElementById('inputMobileScheduleId');
    if (idEl) idEl.value = '';

    const stSelect = document.getElementById('selectMobileStudent');
    if (stSelect) {
      stSelect.innerHTML = '';
      students.forEach((st) => {
        stSelect.innerHTML += `<option value="${st.id}">${st.name} (${st.courses.length}门课)</option>`;
      });
      const targetStudent = student || students[0];
      if (targetStudent) stSelect.value = targetStudent.id;
      updateMobileCourseDropdown(targetStudent);
      syncMobileSubjectFromCourse();
    }

    const dateEl = document.getElementById('inputMobileDate');
    if (dateEl) dateEl.value = dateStr;

    const timeEl = document.getElementById('inputMobileStartTime');
    if (timeEl) timeEl.value = startTimeStr;

    const durEl = document.getElementById('selectMobileDuration');
    if (durEl) durEl.value = '45';

    const roomEl = document.getElementById('inputMobileRoom');
    if (roomEl) roomEl.value = '琴房 101';

    renderMobileTeacherDropdowns();

    const delBtn = document.getElementById('btnDeleteMobileSchedule');
    if (delBtn) delBtn.classList.add('hidden');

    // 重复排课：仅新增时显示
    const repeatBlock = document.getElementById('mobileRepeatOptionsBlock');
    const ruleEl = document.getElementById('selectMobileRepeatRule');
    const endWrap = document.getElementById('mobileRepeatEndDateWrap');
    const endEl = document.getElementById('inputMobileRepeatEndDate');
    const hintEl = document.getElementById('mobileRepeatHint');
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
    const seriesBlockNew = document.getElementById('mobileSeriesEditBlock');
    if (seriesBlockNew) seriesBlockNew.classList.add('hidden');

    showModal('modalMobileSchedule');
  }

  function openMobileScheduleModalForEdit(schedule) {
    const titleEl = document.getElementById('modalMobileScheduleTitle');
    if (titleEl) titleEl.textContent = '修改课程排期';

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
      schedules.push(makeSchedule('sch_' + Date.now(), date));

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
    renderMobile3DayView();
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
      schedules = schedules.filter((s) => !ids.includes(s.id));
      saveData();
      offerUndo(msg, '删除排课');
      if (onDone) onDone();
    };

    if (laterCount === 0) {
      if (!confirm('确定删除该课程？待上课状态的课程会退还已扣课时。')) return;
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
      renderMobile3DayView();
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
  function renderMobileFinance() {
    const container = document.getElementById('mobileFinanceContent');
    if (!container) return;

    const now = new Date();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // 老师视角：只统计自己课程的消课记录（管理员看全部）
    let scopedLogs = checkInLogs.filter((l) => (l.checkInTime || '').startsWith(monthPrefix));
    if (isTeacherView()) scopedLogs = scopedLogs.filter(logRelatedToTeacher);
    const monthLogs = scopedLogs.slice().sort((a, b) => (b.checkInTime || '').localeCompare(a.checkInTime || ''));

    const monthLessons = monthLogs.reduce((acc, l) => acc + (l.deductedLessons || 0), 0);
    const monthValue = monthLogs.reduce((acc, l) => acc + (l.paymentAmount || 0), 0);

    // 老师视角：待消存量/欠课学员/续费清单只统计**自己授课科目**的课时；管理员看全部
    const relStudents = isTeacherView() ? students.filter(studentRelatedToTeacher) : students;
    const myCoursesOf = (st) => isTeacherView() ? (st.courses || []).filter((c) => courseRelatedToTeacher(st, c.name)) : (st.courses || []);
    const totalRemaining = relStudents.reduce((acc, st) => acc + myCoursesOf(st).reduce((a, c) => a + Math.max(0, c.remainingLessons), 0), 0);
    const relIds = new Set(relStudents.map((s) => s.id));
    const debtors = isTeacherView()
      ? debts.filter((d) => d.amount > 0 && relIds.has(d.studentId) && relStudents.some((st) => st.id === d.studentId && courseRelatedToTeacher(st, d.courseName)))
      : debts.filter((d) => d.amount > 0 && relIds.has(d.studentId));

    // 续费跟进清单（剩余课时≤2，老师视角只看自己授课科目）
    const financeLowList = [];
    relStudents.forEach((st) => myCoursesOf(st).forEach((c) => {
      if (c.remainingLessons <= 2) financeLowList.push({ student: st.name, course: c.courseName || c.name || '', remaining: c.remainingLessons });
    }));

    container.innerHTML = `
      <div class="grid grid-cols-2 gap-2.5">
        <div class="lm-card p-4">
          <div class="text-[11px] text-[#9c9fa5] font-medium flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:#111"></span> 本月课消</div>
          <div class="lm-stat-v text-[#111111] mt-1">${monthLessons.toFixed(1)} <span class="text-[11px] font-medium">节</span></div>
        </div>
        <div class="lm-card p-4">
          <div class="text-[11px] text-[#9c9fa5] font-medium flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:#059669"></span> 课消价值</div>
          <div class="lm-stat-v text-[#059669] mt-1">¥${monthValue.toFixed(0)}</div>
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
        <div class="font-bold text-[12px] text-[#111111] mb-2 flex items-center gap-1.5"><span class="inline-block w-2 h-2 rounded-full" style="background:#fe4c02"></span> 续费跟进清单 <span class="text-[11px] font-medium text-[#9c9fa5]">${isTeacherView() ? '（我的学员）' : ''}</span></div>
        ${financeLowList.length === 0 ? '<div class="text-[12px] text-[#9c9fa5] py-3 text-center">暂无待续费学员</div>' : financeLowList.slice(0, 5).map((x) => `
          <div class="flex items-center justify-between py-1.5" style="border-bottom:1px solid #f0ebe2">
            <div class="text-[11.5px] font-bold text-[#111111]">${x.student} <span class="text-[#9c9fa5] font-medium">· ${x.course}</span></div>
            <div class="text-[11px] font-bold ${x.remaining <= 0 ? 'text-[#d5304f]' : 'text-[#fe4c02]'}">${x.remaining <= 0 ? '已用完' : '剩 ' + x.remaining + ' 节'}</div>
          </div>`).join('')}
        ${financeLowList.length > 5 ? `<div class="text-[11px] text-[#9c9fa5] pt-1.5">还有 ${financeLowList.length - 5} 项，去学员页查看</div>` : ''}
      </div>

      <div class="lm-card p-4">
        <div class="font-bold text-[13px] text-[#111111] mb-2 flex items-center gap-1.5"><i class="fa-solid fa-receipt text-[#ff5600]"></i> 本月${isTeacherView() ? '我的' : ''}消课明细</div>
        ${monthLogs.length === 0 ? '<div class="text-[12px] text-[#9c9fa5] py-4 text-center">本月暂无消课记录</div>' : `
        <div class="space-y-1.5">
          ${monthLogs.map((l) => `
            <div class="flex items-center justify-between text-[11.5px] bg-[#faf6ef] px-3 py-2 rounded-xl">
              <div class="min-w-0">
                <span class="font-bold text-[#111111]">${l.studentName}</span>
                <span class="text-[#9c9fa5] ml-1">${l.courseName}</span>
              </div>
              <div class="text-right shrink-0 ml-2">
                <div class="font-bold text-[#626260]">${l.deductedLessons}节${l.paymentAmount > 0 ? ` · ¥${l.paymentAmount.toFixed(0)}` : ''}</div>
                <div class="text-[10px] text-[#9c9fa5]">${(l.checkInTime || '').replace('T', ' ').slice(5, 16)}</div>
              </div>
            </div>`).join('')}
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

    // 欠课红点
    const badge = document.getElementById('mobileNavDebtBadge');
    if (badge) badge.classList.toggle('hidden', debtors.length === 0);
  }

  function openMobileScheduleActionMenu(schedule) {
    const status = schedule.status || SCHEDULE_STATUS.SCHEDULED;
    const student = students.find((st) => st.id === schedule.studentId);
    const menu = document.createElement('div');
    menu.id = 'mobileScheduleActionMenu';
    menu.className = 'fixed inset-0 bg-slate-900/40 z-50 flex items-end justify-center';
    menu.style.paddingBottom = 'calc(64px + env(safe-area-inset-bottom))';

    let actionsHtml = '';
    if (status !== SCHEDULE_STATUS.STUDENT_LEAVE) {
      actionsHtml += `
        ${status === SCHEDULE_STATUS.SCHEDULED ? `
        <button data-act="checkin" class="w-full py-3.5 rounded-xl font-bold text-sm bg-emerald-500 text-white active:bg-emerald-600 flex items-center justify-center gap-2">
          <i class="fa-solid fa-circle-check"></i> 消课签到（${getLessonCost(schedule)}节）
        </button>` : ''}
        <button data-act="leave" class="w-full py-3.5 rounded-xl font-bold text-sm bg-rose-50 text-rose-600 border border-rose-200 active:bg-rose-100 flex items-center justify-center gap-2">
          <i class="fa-solid fa-person-walking-arrow-right"></i> 学员请假（退还${getLessonCost(schedule)}节）${status === SCHEDULE_STATUS.COMPLETED ? ' · 改请假' : ''}
        </button>
        ${status === SCHEDULE_STATUS.COMPLETED ? `
        <button data-act="revert" class="w-full py-3.5 rounded-xl font-bold text-sm lm-btn-ink flex items-center justify-center gap-2">
          <i class="fa-solid fa-rotate-left"></i> 撤销消课（还原为待上课）
        </button>` : ''}
      `;
    } else {
      actionsHtml += `
        <button data-act="revert" class="w-full py-3.5 rounded-xl font-bold text-sm lm-btn-ink flex items-center justify-center gap-2">
          <i class="fa-solid fa-rotate-left"></i> 撤销状态（还原为待上课）
        </button>
      `;
    }
    actionsHtml += `
      <button data-act="edit" class="w-full py-3.5 rounded-xl font-bold text-sm bg-slate-100 text-slate-700 active:bg-slate-200 flex items-center justify-center gap-2">
        <i class="fa-solid fa-pen-to-square"></i> 编辑课程信息
      </button>
      <button data-act="delete" class="w-full py-3.5 rounded-xl font-bold text-sm bg-rose-50 text-rose-600 border border-rose-200 active:bg-rose-100 flex items-center justify-center gap-2">
        <i class="fa-solid fa-trash-can"></i> 删除该课程
      </button>
    `;

    const statusText = status === SCHEDULE_STATUS.COMPLETED ? '已消课 ✓' : status === SCHEDULE_STATUS.STUDENT_LEAVE ? '学员请假 🏖️' : '待上课';
    menu.innerHTML = `
      <div class="bg-white rounded-t-3xl w-full p-5 pb-2 space-y-2.5 shadow-2xl max-w-md mx-auto">
        <div class="w-10 h-1 bg-slate-200 rounded-full mx-auto mb-1"></div>
        <div class="pb-3 border-b border-slate-100">
          <div class="font-bold text-sm text-slate-800">${schedule.studentName} · ${schedule.subject}</div>
          <div class="text-[11px] text-slate-400 mt-0.5">${schedule.date} ${schedule.startTime} · ${schedule.durationMinutes}分钟 · ${statusText}</div>
          ${student && getStudentDebts(student.id).length ? `<div class="text-[10px] text-rose-500 mt-1">⚠ 欠课：${getStudentDebts(student.id).map(d => d.courseName + ' ' + d.amount + '节').join('、')}</div>` : ''}
        </div>
        ${actionsHtml}
        <button data-act="close" class="w-full py-3 text-slate-400 text-xs">取消</button>
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
      else if (act === 'edit') openMobileScheduleModalForEdit(schedule);
      else if (act === 'delete') {
        deleteMobileScheduleWithScope(schedule, () => {
          renderMobile3DayView();
          renderMobileStudents();
        });
      }
    });

    document.body.appendChild(menu);
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
    renderMobile3DayView();
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
    renderMobile3DayView();
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
      renderMobile3DayView();
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

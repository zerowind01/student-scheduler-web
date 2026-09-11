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

  // 老师视角：检查记录是否属于该老师的课
  function logRelatedToTeacher(log) {
    if (!teacherSession) return true;
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

  function normalizeSchedule(sch) {
    if (!sch.status) sch.status = SCHEDULE_STATUS.SCHEDULED;
    // 兼容 courseName 字段（部分数据入口只写 courseName）
    if (!sch.subject && sch.courseName) sch.subject = sch.courseName;
    return sch;
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
    return Math.max(1, Math.round((schedule.durationMinutes || 60) / 60));
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
    showToast(`✅ 已消课：${sch.studentName} · ${sch.subject || sch.courseName || ''}（${deducted}节）`);
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
    if (sch.status === SCHEDULE_STATUS.COMPLETED) {
      // 已消课 → 改为请假：删除消课流水（回滚财务）+ 退还消课时扣掉的课时
      checkInLogs = checkInLogs.filter((l) => l.scheduleId !== sch.id);
      const student = students.find((st) => st.id === sch.studentId);
      const deducted = getLessonCost(sch);
      if (student) {
        const course = (student.courses || []).find((c) => c.id === sch.courseId || c.name === sch.subject || c.name === sch.courseName);
        if (course) course.remainingLessons += deducted;
      }
      showToast(`🏖️ 已消课的课程改为请假，退还 ${deducted} 节课时`);
    } else {
      showToast('🏖️ 已为 ' + sch.studentName + ' 办理请假');
    }

    sch.status = SCHEDULE_STATUS.STUDENT_LEAVE;
    saveData();
    renderMobile3DayView();
    renderMobileStudents();
  }

  function revertScheduleStatus(scheduleId) {
    const sch = schedules.find((s) => s.id === scheduleId);
    if (!sch || sch.status === SCHEDULE_STATUS.SCHEDULED) return;

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
    renderMobile3DayView();
    renderMobileStudents();
    showToast('已撤销状态，还原为待上课');
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

    // 欠课账校准：负课时（手动填的欠课）同步进欠课账
    syncAllDebts();

    saveDataLocalOnly();
  }

  // 云端同步改走同源 /api/sync 代理（凭据由服务端函数持有，前端不再暴露 token）
  // 服务端实现见 netlify/functions/sync.js —— 读取 UPSTASH_REST_URL / UPSTASH_REST_TOKEN 环境变量
  const CLOUD_SYNC_ENDPOINT = '/api/sync';

  let schoolSyncKey = localStorage.getItem('edu_scheduler_school_key') || 'school_demo_2026';
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
      await fetch(`${CLOUD_SYNC_ENDPOINT}?key=${encodeURIComponent(schoolSyncKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: valStr
      });
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

  function initMobileApp() {
    checkUrlSyncData();
    loadData();
    loadTeacherSession();
    if (typeof updateHeaderIdentity === 'function') updateHeaderIdentity();
    setupMobileEvents();
    setupTeacherLoginGate();
    renderMobileTeacherSelect();
    renderMobile3DayView();
    renderMobileStudents();
    pullFromCloudSync(true).then(() => {
      if (typeof renderMobileHome === 'function') renderMobileHome();
    });
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

    safeBind('btnSaveSyncKey', 'click', () => {
      const el = document.getElementById('inputSyncKey');
      const val = (el ? el.value.trim() : '') || 'school_demo_2026';
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
      mobileStartDate = addDays(mobileStartDate, -3);
      renderMobile3DayView();
    });

    safeBind('btnMobileNext', 'click', () => {
      mobileStartDate = addDays(mobileStartDate, 3);
      renderMobile3DayView();
    });

    safeBind('btnMobileToday', 'click', () => {
      // 以今天为窗口起点，保证今天永远在3日视图内（旧逻辑回到周一，周末时看不到今天）
      mobileStartDate = getToday();
      renderMobile3DayView();
    });

    safeBind('mobileTeacherSelect', 'change', (e) => {
      selectedTeacherFilter = e.target.value;
      renderMobile3DayView();
    });

    // ============ 四视图切换（课表/学员/财务/设置） ============
    const MOBILE_VIEWS = ['home', 'schedule', 'students', 'finance', 'settings'];

    function switchMobileView(view) {
      MOBILE_VIEWS.forEach((v) => {
        const el = document.getElementById('view' + v.charAt(0).toUpperCase() + v.slice(1));
        if (el) el.classList.toggle('hidden', v !== view);
      });
      // GSAP：切换后的新视图轻量进场
      const activeEl = document.getElementById('view' + view.charAt(0).toUpperCase() + view.slice(1));
      if (window.uiAnim && activeEl) window.uiAnim.viewIn(activeEl);
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
      // 日期导航栏只在课表视图显示
      const dateBar = document.getElementById('mobileDateBar');
      if (dateBar) dateBar.classList.toggle('hidden', view !== 'schedule');
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
        colorTheme: getRandomColorTheme ? getRandomColorTheme() : 'amber',
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

    // 老师视角：我的学员/全部学员 切换
    const scopeBtn = document.getElementById('teacherScopeToggle');
    if (scopeBtn) {
      const syncLabel = () => {
        const showAll = sessionStorage.getItem('lm_teacher_show_all_students') === '1';
        scopeBtn.textContent = showAll ? '全部学员 · 切回我的' : '我的学员 · 查全部';
        scopeBtn.classList.toggle('lm-btn-ink', !showAll);
        scopeBtn.classList.toggle('lm-btn-ghost', showAll);
      };
      syncLabel();
      scopeBtn.addEventListener('click', () => {
        const cur = sessionStorage.getItem('lm_teacher_show_all_students') === '1';
        sessionStorage.setItem('lm_teacher_show_all_students', cur ? '0' : '1');
        syncLabel();
        renderMobileStudents();
        showToast(cur ? '已切回我的学员' : '已显示全部学员');
      });
      // 老师视角才显示该按钮
      if (isTeacherView()) scopeBtn.classList.remove('hidden');
    }

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
    });

    safeBind('mobileSearchStudent', 'input', renderMobileStudents);
    safeBind('mobileStudentTeacherFilter', 'change', renderMobileStudents);
    safeBind('mobileStudentCourseFilter', 'change', renderMobileStudents);

    document.querySelectorAll('.mobile-student-filter').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.mobile-student-filter').forEach((b) => {
          b.classList.remove('active', 'lm-btn-ink');
          b.classList.add('bg-slate-100', 'text-slate-600');
        });
        e.target.classList.add('active', 'lm-btn-ink');
        e.target.classList.remove('bg-slate-100', 'text-slate-600');
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
      .flatMap((st) => (st.courses || []).filter((c) => c.remainingLessons <= 2).map((c) => ({ st, c })));
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
      const nowHM = `${String(nowD.getHours()).padStart(2, '0')}:${String(nowD.getMinutes()).padStart(2, '0')}`;
      const nextUpH = todayPendH ? todayAllH.filter((s) => s.status === SCHEDULE_STATUS.SCHEDULED && s.startTime > nowHM).sort((a, b) => a.startTime.localeCompare(b.startTime))[0] : null;
      hero.innerHTML = `
        <div class="lm-card lm-hero" style="border-radius:22px 22px 0 0;position:relative;z-index:2;padding:20px 20px 12px">
          <div class="lm-eyebrow">今日课时</div>
          <div class="lm-bignum">${todayAllH.length}<small>节课 · 已消 ${todayDoneH}</small></div>
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
      const nowHM = `${String(nowD.getHours()).padStart(2, '0')}:${String(nowD.getMinutes()).padStart(2, '0')}`;
      const myNext = myToday.filter((s) => s.status === SCHEDULE_STATUS.SCHEDULED && s.startTime > nowHM)[0] || null;
      const myTomorrow = schedules.filter((s) => s.date === tomorrowStr && inScope(s)).sort((a, b) => a.startTime.localeCompare(b.startTime));
      hero.innerHTML = `
        <div class="lm-card lm-hero" style="border-radius:22px 22px 0 0;position:relative;z-index:2;padding:20px 20px 12px">
          <div class="flex items-center justify-between">
            <div class="lm-eyebrow" style="margin-bottom:0">${teacherSession.name.endsWith('老师') ? teacherSession.name : teacherSession.name + '老师'} · 今日课时</div>
            <button id="btnTeacherExitHome" class="text-[11px] bg-white rounded-full px-2.5 py-1 font-bold text-[#626260] shadow-xs active:bg-[#f1ece3]">退出</button>
          </div>
          <div class="lm-bignum mt-1.5">${myToday.length}<small>节课 · 已消 ${myTodayDone}</small></div>
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
    const todays = todayAll.slice().sort((a, b) => a.startTime.localeCompare(b.startTime));
    todayBox.innerHTML = `
      <div class="font-bold text-[13px] text-[#111111] px-1 pt-1">今日课程（${todays.length}）</div>
      ${todays.length === 0 ? '<div class="text-center text-[12px] text-[#9c9fa5] py-6 lm-card mt-1">今天没有课程安排</div>' : ''}
      ${todays.map((s) => {
        const done = s.status === SCHEDULE_STATUS.COMPLETED;
        const leave = s.status === SCHEDULE_STATUS.STUDENT_LEAVE;
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
        <div class="lm-card px-5 py-4 flex items-center gap-3.5">
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
      }).join('')}`;

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

  function renderMobile3DayView() {
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
          const roundedMinutes = Math.floor(totalMinutes / 15) * 15;

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

  function createMobileScheduleCard(schedule, conflictInfo) {
    const card = document.createElement('div');
    const themeClass = `event-${schedule.colorTheme || 'amber'}`;
    const hasConflict = !!conflictInfo;
    card.className = `schedule-event-card ${themeClass} ${hasConflict ? 'has-conflict' : ''}`;

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

    let teacherText = schedule.teacherName ? `👩‍🏫${schedule.teacherName}` : '';
    if (schedule.assistantTeacherName) teacherText += `&${schedule.assistantTeacherName}`;
    const roomText = schedule.room ? `📍${schedule.room}` : '';

    // 状态角标 + 视觉弱化（与桌面端一致）
    let statusBadge = '';
    if (schedule.status === SCHEDULE_STATUS.COMPLETED) {
      statusBadge = `<span class="absolute top-0.5 right-1 text-[9px] font-black text-white bg-emerald-500 px-1 py-0.2 rounded-md z-10">✓ 消</span>`;
      card.style.opacity = '0.65';
    } else if (schedule.status === SCHEDULE_STATUS.STUDENT_LEAVE) {
      statusBadge = `<span class="absolute top-0.5 right-1 text-[9px] font-black text-white bg-rose-400 px-1 py-0.2 rounded-md z-10">假</span>`;
      card.style.opacity = '0.5';
      card.classList.add('grayscale');
    }

    card.innerHTML = `
      ${statusBadge}
      <div class="flex flex-col justify-between h-full space-y-0.5 pointer-events-none px-1.5 py-1">
        <div class="flex items-center justify-between font-extrabold text-[12px] text-slate-900 leading-tight">
          <span class="truncate flex-1">${schedule.studentName}</span>
          ${totalCols === 1 ? `<span class="text-[9px] opacity-75 font-mono bg-white/70 px-1 rounded">${schedule.startTime}</span>` : ''}
        </div>
        <div class="text-[10px] font-bold opacity-90 truncate flex items-center gap-1 leading-none">
          <span class="bg-white/80 px-1 py-0.2 rounded border border-black/5 truncate">${schedule.subject || schedule.courseName || '课程'}</span>
          ${teacherText ? `<span class="opacity-80 truncate text-[9px]">${teacherText}</span>` : ''}
        </div>
        ${
          hasConflict
            ? `<div class="text-[8.5px] font-bold text-rose-700 bg-rose-100 border border-rose-300 px-1 py-0.2 rounded truncate flex items-center gap-0.5">
                <i class="fa-solid fa-triangle-exclamation text-rose-500 text-[8px] animate-pulse"></i>
                <span class="truncate">${conflictInfo.reasons.join('; ')}</span>
               </div>`
            : ''
        }
      </div>
    `;

    card.addEventListener('click', (e) => {
      e.stopPropagation();
      openMobileScheduleActionMenu(schedule);
    });

    return card;
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
          if (a.start < b.end && a.end > b.start) {
            const reasonsA = [];
            const reasonsB = [];

            if (a.room && b.room && a.room.trim() === b.room.trim()) {
              reasonsA.push(`课室[${a.room}]占用`);
              reasonsB.push(`课室[${b.room}]占用`);
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

  // 按姓名稳定取色：同名学员永远同色，不同学员错开（6 色柔和板，配 tinted 背景）
  const AVATAR_PALETTE = [
    { bg: 'bg-rose-400',  ring: 'ring-rose-100',  solid: 'bg-rose-100',  text: 'text-rose-700' },
    { bg: 'bg-sky-400',   ring: 'ring-sky-100',   solid: 'bg-sky-100',   text: 'text-sky-700' },
    { bg: 'bg-emerald-400', ring: 'ring-emerald-100', solid: 'bg-emerald-100', text: 'text-emerald-700' },
    { bg: 'bg-violet-400',  ring: 'ring-violet-100',  solid: 'bg-violet-100',  text: 'text-violet-700' },
    { bg: 'bg-amber-400',   ring: 'ring-amber-100',   solid: 'bg-amber-100',   text: 'text-amber-700' },
    { bg: 'bg-teal-400',    ring: 'ring-teal-100',    solid: 'bg-teal-100',    text: 'text-teal-700' },
  ];
  // 学员自选 colorTheme（桌面端编辑弹窗可设）→ 头像色
  const THEME_TO_AVATAR = {
    amber: AVATAR_PALETTE[4], emerald: AVATAR_PALETTE[2], sky: AVATAR_PALETTE[1],
    purple: AVATAR_PALETTE[3], rose: AVATAR_PALETTE[0],
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
    const teacherFilter = tSel ? tSel.value : 'all';
    const courseFilter = cSel ? cSel.value : 'all';

    let list = students.filter((st) => {
      normalizeStudent(st);
      // 老师视角：默认只显示"我的学员"（关联名单或排课相关）；切换"显示全部"后放开
      if (isTeacherView()) {
        const showAll = sessionStorage.getItem('lm_teacher_show_all_students') === '1';
        if (!showAll) {
          const related = (st.teacherIds || []).includes(teacherSession.teacherId) ||
            schedules.some((s) => s.studentId === st.id && (s.teacherId === teacherSession.teacherId || s.assistantTeacherId === teacherSession.teacherId));
          if (!related) return false;
        }
      }
      const matchName = st.name.toLowerCase().includes(query) || (st.phone && st.phone.includes(query));
      const matchCourse = st.courses.some((c) => c.name.toLowerCase().includes(query));
      if (!matchName && !matchCourse) return false;

      if (filter === 'low') {
        const total = st.courses.reduce((acc, c) => acc + c.remainingLessons, 0);
        return total <= 2 || st.courses.some((c) => c.remainingLessons <= 2);
      }
      // 按老师筛选：排课记录里该老师（主讲或助教）上过/将上该学员的课
      if (teacherFilter !== 'all') {
        const matchT = schedules.some((s) => s.studentId === st.id && (s.teacherId === teacherFilter || s.assistantTeacherId === teacherFilter));
        if (!matchT) return false;
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
    }

    const dateEl = document.getElementById('inputMobileDate');
    if (dateEl) dateEl.value = dateStr;

    const timeEl = document.getElementById('inputMobileStartTime');
    if (timeEl) timeEl.value = startTimeStr;

    const durEl = document.getElementById('selectMobileDuration');
    if (durEl) durEl.value = '60';

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

    // 编辑模式隐藏重复排课块
    const repeatBlock = document.getElementById('mobileRepeatOptionsBlock');
    if (repeatBlock) repeatBlock.classList.add('hidden');

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
    const subject = courseOpt ? courseOpt.getAttribute('data-name') : '通用课程';

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
    const durationMinutes = parseInt(document.getElementById('selectMobileDuration').value, 10);
    const room = document.getElementById('inputMobileRoom').value.trim();

    if (schId) {
      const idx = schedules.findIndex((s) => s.id === schId);
      if (idx !== -1) {
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
        showToast('修改成功！');
      }
    } else {
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
      });
      schedules.push(makeSchedule('sch_' + Date.now(), date));

      // 课时在消课时扣除（App 语义），排课不再扣——避免"排了又消"重复扣的困惑

      // 重复排课
      const ruleEl = document.getElementById('selectMobileRepeatRule');
      const endEl = document.getElementById('inputMobileRepeatEndDate');
      const rule = ruleEl ? ruleEl.value : 'none';
      const endDateStr = endEl ? endEl.value : '';
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
  }

  // 删除课程统一入口：有后续重复排课时弹"仅本次/本次及之后"双选（无则普通确认）
  function deleteMobileScheduleWithScope(sch, onDone) {
    const later = schedules
      .filter((s) => s.id !== sch.id && s.studentId === sch.studentId && s.courseId === sch.courseId && s.startTime === sch.startTime && (s.teacherId || '') === (sch.teacherId || '') && (!s.status || s.status === 'scheduled') && s.date > sch.date)
      .sort((a, b) => a.date.localeCompare(b.date));
    const laterCount = later.length;

    const doDelete = (ids, msg) => {
      schedules = schedules.filter((s) => !ids.includes(s.id));
      saveData();
      showToast(msg);
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

  function showModal(id) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.remove('hidden');
      setTimeout(() => el.classList.add('opacity-100'), 10);
      // GSAP 进场动效（底部抽屉上滑）
      const box = el.querySelector('.bg-white, [class*="rounded"]');
      if (window.uiAnim) window.uiAnim.modalIn(box, el);
    }
  }

  function hideModal(id) {
    const el = document.getElementById(id);
    if (el) {
      const finish = () => el.classList.add('hidden');
      const box = el.querySelector('.bg-white, [class*="rounded"]');
      if (window.uiAnim) {
        window.uiAnim.modalOut(box, el, finish);
        setTimeout(finish, 260); // 兜底
      } else {
        el.classList.remove('opacity-100');
        setTimeout(finish, 200);
      }
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

    // 老师视角：待消存量/欠课学员只看与自己相关的学员；管理员看全部
    const relStudents = isTeacherView() ? students.filter(studentRelatedToTeacher) : students;
    const totalRemaining = relStudents.reduce((acc, st) => acc + (st.courses || []).reduce((a, c) => a + Math.max(0, c.remainingLessons), 0), 0);
    const relIds = new Set(relStudents.map((s) => s.id));
    const debtors = debts.filter((d) => d.amount > 0 && relIds.has(d.studentId));

    // 续费跟进清单（剩余课时≤2，老师视角只看自己学员）
    const financeLowList = [];
    relStudents.forEach((st) => (st.courses || []).forEach((c) => {
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

  function showToast(msg) {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toastMsg');
    if (toast && toastMsg) {
      toastMsg.textContent = msg;
      toast.classList.remove('translate-y-10', 'opacity-0', 'pointer-events-none');
      toast.classList.add('translate-y-0', 'opacity-100');
      if (window.uiAnim) window.uiAnim.toastIn(toast);
      setTimeout(() => {
        toast.classList.add('translate-y-10', 'opacity-0', 'pointer-events-none');
        toast.classList.remove('translate-y-0', 'opacity-100');
      }, 2500);
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
    const row = document.createElement('div');
    row.className = 'mobile-course-row bg-white border border-slate-200 rounded-xl p-2 space-y-1.5';
    row.innerHTML = `
      <div class="flex items-center gap-2">
        <input type="text" class="m-course-name flex-1 min-w-0 px-3 py-2.5 border border-slate-200 rounded-xl text-xs font-medium outline-none focus:ring-2 focus:ring-[#ff5600]/30 bg-white"
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
      students = students.filter((s) => s.id !== editId);
      schedules = schedules.filter((sch) => sch.studentId !== editId);
      saveData();
      closeMobileStudentModal();
      renderMobileStudents();
      renderMobile3DayView();
      showToast('已删除学员记录');
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

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
    if (student) {
      const course = (student.courses || []).find((c) => c.id === sch.courseId || c.name === sch.subject);
      if (course) {
        if (course.unitPrice > 0) payment = deducted * course.unitPrice;
        if (course.remainingLessons < 0) {
          addDebt(student.id, course.name, -course.remainingLessons);
          course.remainingLessons = 0;
        }
      }
    }

    sch.status = SCHEDULE_STATUS.COMPLETED;
    recordCheckInLog(sch, deducted, payment, remarks);
    saveData();
    renderMobile3DayView();
    renderMobileStudents();
    showToast(`✅ 已消课：${sch.studentName} · ${sch.subject}（${deducted}节）`);
  }

  // 学员请假：退还排课时扣掉的课时（不限课程时间，已消课的也可改为请假）
  function markStudentLeave(scheduleId) {
    const sch = schedules.find((s) => s.id === scheduleId);
    if (!sch) return;
    if (sch.status === SCHEDULE_STATUS.STUDENT_LEAVE) {
      showToast('该课程已是请假状态');
      return;
    }
    if (sch.status === SCHEDULE_STATUS.COMPLETED) {
      // 已消课 → 改为请假：删除消课流水（回滚财务）+ 退还课时
      checkInLogs = checkInLogs.filter((l) => l.scheduleId !== sch.id);
    }

    const student = students.find((st) => st.id === sch.studentId);
    const deducted = getLessonCost(sch);
    if (student) {
      const course = (student.courses || []).find((c) => c.id === sch.courseId || c.name === sch.subject);
      if (course) course.remainingLessons += deducted;
    }

    sch.status = SCHEDULE_STATUS.STUDENT_LEAVE;
    saveData();
    renderMobile3DayView();
    renderMobileStudents();
    showToast(`🏖️ 已为 ${sch.studentName} 办理请假，退还 ${deducted} 节课时`);
  }

  function revertScheduleStatus(scheduleId) {
    const sch = schedules.find((s) => s.id === scheduleId);
    if (!sch || sch.status === SCHEDULE_STATUS.SCHEDULED) return;

    if (sch.status === SCHEDULE_STATUS.COMPLETED) {
      checkInLogs = checkInLogs.filter((l) => l.scheduleId !== sch.id);
    } else if (sch.status === SCHEDULE_STATUS.STUDENT_LEAVE) {
      const student = students.find((st) => st.id === sch.studentId);
      const deducted = getLessonCost(sch);
      if (student) {
        const course = (student.courses || []).find((c) => c.id === sch.courseId || c.name === sch.subject);
        if (course) course.remainingLessons = Math.max(0, course.remainingLessons - deducted);
      }
    }

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
            schedules = remoteData.schedules || [];
            teachers = remoteData.teachers || teachers;
            courseTypes = remoteData.courseTypes || courseTypes;
            checkInLogs = remoteData.checkInLogs || [];
            debts = (remoteData.debts || []).map(normalizeDebt);

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
          schedules = event.data.schedules || schedules;
          teachers = event.data.teachers || teachers;
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
          schedules = data.schedules || [];
          teachers = data.teachers || teachers;
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
    setupMobileEvents();
    renderMobileTeacherSelect();
    renderMobile3DayView();
    renderMobileStudents();
    pullFromCloudSync(true);
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
          schedules = data.schedules || [];
          teachers = data.teachers || teachers;
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
    const MOBILE_VIEWS = ['schedule', 'students', 'finance', 'settings'];

    function switchMobileView(view) {
      MOBILE_VIEWS.forEach((v) => {
        const el = document.getElementById('view' + v.charAt(0).toUpperCase() + v.slice(1));
        if (el) el.classList.toggle('hidden', v !== view);
      });
      document.querySelectorAll('.nav-tab').forEach((tab) => {
        const active = tab.getAttribute('data-view') === view;
        tab.classList.toggle('text-amber-600', active);
        tab.classList.toggle('font-bold', active);
        tab.classList.toggle('text-slate-400', !active);
        tab.classList.toggle('font-medium', !active);
      });
      // 日期导航栏只在课表视图显示
      const dateBar = document.getElementById('mobileDateBar');
      if (dateBar) dateBar.classList.toggle('hidden', view !== 'schedule');
      if (view === 'students') renderMobileStudents();
      if (view === 'finance') renderMobileFinance();
    }

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
      // 手机版复用云同步弹窗所在层级：直接跳电脑版教师管理不可行，
      // 这里用 prompt 系列快速编辑不可靠，改为引导到电脑版
      showToast('教师管理请在电脑版操作（顶栏 → 教师管理）');
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

    safeBind('navTabQuickAdd', 'click', () => {
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

    safeBind('selectMobileStudent', 'change', (e) => {
      const stId = e.target.value;
      const st = students.find((x) => x.id === stId);
      updateMobileCourseDropdown(st);
    });

    safeBind('mobileSearchStudent', 'input', renderMobileStudents);

    document.querySelectorAll('.mobile-student-filter').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.mobile-student-filter').forEach((b) => {
          b.classList.remove('active', 'bg-amber-500', 'text-white');
          b.classList.add('bg-slate-100', 'text-slate-600');
        });
        e.target.classList.add('active', 'bg-amber-500', 'text-white');
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

  function renderMobile3DayView() {
    const headerContainer = document.getElementById('mobileHeaderDays');
    const gridContainer = document.getElementById('mobileGridColumns');
    if (!headerContainer || !gridContainer) return;
    headerContainer.innerHTML = '';
    gridContainer.innerHTML = '';

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
      colHeader.className = `py-1.5 px-1 text-center transition ${isToday ? 'bg-amber-100 text-amber-900 font-bold' : 'text-slate-700 bg-white'}`;
      colHeader.innerHTML = `
        <div class="text-[11px] ${isToday ? 'text-amber-700 font-bold' : 'text-slate-400'}">${weekdayNames[dayDate.getDay()]}</div>
        <div class="text-xs font-extrabold ${isToday ? 'text-amber-900' : 'text-slate-700'}">${dayDate.getMonth() + 1}/${dayDate.getDate()}</div>
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
          <span class="bg-white/80 px-1 py-0.2 rounded border border-black/5 truncate">${schedule.subject}</span>
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

  function renderMobileStudents() {
    const container = document.getElementById('mobileStudentContainer');
    if (!container) return;
    container.innerHTML = '';

    const filterBtn = document.querySelector('.mobile-student-filter.active');
    const filter = filterBtn ? filterBtn.getAttribute('data-filter') : 'all';
    const searchEl = document.getElementById('mobileSearchStudent');
    const query = ((searchEl ? searchEl.value : '') || '').trim().toLowerCase();

    let list = students.filter((st) => {
      normalizeStudent(st);
      const matchName = st.name.toLowerCase().includes(query) || (st.phone && st.phone.includes(query));
      const matchCourse = st.courses.some((c) => c.name.toLowerCase().includes(query));
      if (!matchName && !matchCourse) return false;

      if (filter === 'low') {
        const total = st.courses.reduce((acc, c) => acc + c.remainingLessons, 0);
        return total <= 2 || st.courses.some((c) => c.remainingLessons <= 2);
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
      card.className = 'bg-slate-50 border border-slate-200/80 p-3 rounded-2xl flex items-center justify-between space-x-2';

      const total = st.courses.reduce((acc, c) => acc + c.remainingLessons, 0);
      const coursesStr = st.courses.map((c) => `${c.name}(剩${c.remainingLessons}课时)`).join(', ');

      card.innerHTML = `
        <div class="flex items-center space-x-2.5 flex-1 min-w-0">
          <div class="w-9 h-9 rounded-full bg-amber-500 text-white font-bold flex items-center justify-center text-xs shrink-0">
            ${st.name.substring(0, 1)}
          </div>
          <div class="flex-1 min-w-0">
            <div class="font-bold text-xs text-slate-800 flex items-center gap-1.5">
              <span>${st.name}</span>
              <span class="text-[10px] text-amber-700 bg-amber-100/80 px-1.5 py-0.2 rounded-md">剩${total}课时</span>
            </div>
            <div class="text-[10.5px] text-slate-400 truncate mt-0.5">${coursesStr}</div>
          </div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button class="btn-edit-mobile-student px-2 py-1.5 bg-slate-100 text-slate-500 text-xs rounded-xl active:bg-slate-200" title="编辑学员">
            <i class="fa-solid fa-pen"></i>
          </button>
          <button class="btn-schedule-mobile px-3 py-1.5 bg-amber-500 text-white font-bold text-xs rounded-xl shadow-xs shrink-0">
            排课
          </button>
        </div>
      `;

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
      const newSchedule = {
        id: 'sch_' + Date.now(),
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
        colorTheme: student ? student.colorTheme : 'amber',
      };
      schedules.push(newSchedule);

      if (student && student.courses) {
        const targetCourse = student.courses.find((c) => c.id === courseId || c.name === subject);
        if (targetCourse) {
          const cost = Math.max(1, Math.round(durationMinutes / 60));
          targetCourse.remainingLessons = Math.max(0, targetCourse.remainingLessons - cost);
        }
      }

      showToast(`已成功为 [${student ? student.name : ''}] 排课！`);
    }

    saveData();
    closeMobileScheduleModal();
    renderMobile3DayView();
  }

  function handleDeleteMobileSchedule() {
    const idEl = document.getElementById('inputMobileScheduleId');
    const schId = idEl ? idEl.value : '';
    if (!schId) return;

    if (confirm('确定要删除此节课程安排吗？')) {
      schedules = schedules.filter((s) => s.id !== schId);
      saveData();
      closeMobileScheduleModal();
      renderMobile3DayView();
      showToast('已删除课程');
    }
  }

  function showModal(id) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.remove('hidden');
      setTimeout(() => el.classList.add('opacity-100'), 10);
    }
  }

  function hideModal(id) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.remove('opacity-100');
      setTimeout(() => el.classList.add('hidden'), 200);
    }
  }

  // 手机端财务视图渲染
  function renderMobileFinance() {
    const container = document.getElementById('mobileFinanceContent');
    if (!container) return;

    const now = new Date();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthLogs = checkInLogs.filter((l) => (l.checkInTime || '').startsWith(monthPrefix)).slice().sort((a, b) => (b.checkInTime || '').localeCompare(a.checkInTime || ''));

    const monthLessons = monthLogs.reduce((acc, l) => acc + (l.deductedLessons || 0), 0);
    const monthValue = monthLogs.reduce((acc, l) => acc + (l.paymentAmount || 0), 0);
    const totalRemaining = students.reduce((acc, st) => acc + (st.courses || []).reduce((a, c) => a + Math.max(0, c.remainingLessons), 0), 0);
    const debtors = debts.filter((d) => d.amount > 0);

    container.innerHTML = `
      <div class="grid grid-cols-2 gap-2.5">
        <div class="bg-white border border-amber-100 rounded-2xl p-3.5">
          <div class="text-[10px] text-amber-600/70 font-bold">本月课消</div>
          <div class="text-lg font-black text-amber-700 mt-0.5">${monthLessons.toFixed(1)} <span class="text-[10px]">节</span></div>
        </div>
        <div class="bg-white border border-emerald-100 rounded-2xl p-3.5">
          <div class="text-[10px] text-emerald-600/70 font-bold">课消价值</div>
          <div class="text-lg font-black text-emerald-700 mt-0.5">¥${monthValue.toFixed(0)}</div>
        </div>
        <div class="bg-white border border-sky-100 rounded-2xl p-3.5">
          <div class="text-[10px] text-sky-600/70 font-bold">待消存量</div>
          <div class="text-lg font-black text-sky-700 mt-0.5">${totalRemaining.toFixed(1)} <span class="text-[10px]">节</span></div>
        </div>
        <div class="bg-white border ${debtors.length ? 'border-rose-200' : 'border-slate-100'} rounded-2xl p-3.5">
          <div class="text-[10px] ${debtors.length ? 'text-rose-600/70' : 'text-slate-400'} font-bold">欠课学员</div>
          <div class="text-lg font-black ${debtors.length ? 'text-rose-600' : 'text-slate-300'} mt-0.5">${debtors.length} <span class="text-[10px]">人</span></div>
        </div>
      </div>

      <div class="bg-white border border-slate-200 rounded-2xl p-3.5">
        <div class="font-bold text-xs text-slate-800 mb-2 flex items-center gap-1.5"><i class="fa-solid fa-receipt text-amber-500"></i> 本月收入明细</div>
        ${monthLogs.length === 0 ? '<div class="text-[11px] text-slate-400 py-4 text-center">本月暂无消课记录</div>' : `
        <div class="space-y-1.5">
          ${monthLogs.map((l) => `
            <div class="flex items-center justify-between text-[11px] bg-slate-50 px-3 py-2 rounded-lg">
              <div class="min-w-0">
                <span class="font-bold text-slate-700">${l.studentName}</span>
                <span class="text-slate-400 ml-1">${l.courseName}</span>
              </div>
              <div class="text-right shrink-0 ml-2">
                <div class="font-bold text-slate-600">${l.deductedLessons}节${l.paymentAmount > 0 ? ` · ¥${l.paymentAmount.toFixed(0)}` : ''}</div>
                <div class="text-[9px] text-slate-400">${(l.checkInTime || '').replace('T', ' ').slice(5, 16)}</div>
              </div>
            </div>`).join('')}
        </div>`}
      </div>

      <div class="bg-white border ${debtors.length ? 'border-rose-200' : 'border-slate-200'} rounded-2xl p-3.5">
        <div class="font-bold text-xs text-slate-800 mb-2 flex items-center gap-1.5"><i class="fa-solid fa-triangle-exclamation text-rose-500"></i> 欠课名单</div>
        ${debtors.length === 0 ? '<div class="text-[11px] text-slate-400 py-4 text-center">没有欠课学员 🎉</div>' : `
        <div class="space-y-1.5">
          ${debtors.map((d) => {
            const st = students.find((s) => s.id === d.studentId);
            return `
            <div class="flex items-center justify-between text-[11px] bg-rose-50/60 px-3 py-2 rounded-lg">
              <span class="font-bold text-slate-700">${st ? st.name : '未知学员'} · ${d.courseName}</span>
              <span class="font-black text-rose-600">欠 ${d.amount} 节</span>
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
        <button data-act="revert" class="w-full py-3.5 rounded-xl font-bold text-sm bg-amber-500 text-white active:bg-amber-600 flex items-center justify-center gap-2">
          <i class="fa-solid fa-rotate-left"></i> 撤销消课（还原为待上课）
        </button>` : ''}
      `;
    } else {
      actionsHtml += `
        <button data-act="revert" class="w-full py-3.5 rounded-xl font-bold text-sm bg-amber-500 text-white active:bg-amber-600 flex items-center justify-center gap-2">
          <i class="fa-solid fa-rotate-left"></i> 撤销状态（还原为待上课）
        </button>
      `;
    }
    actionsHtml += `
      <button data-act="edit" class="w-full py-3.5 rounded-xl font-bold text-sm bg-slate-100 text-slate-700 active:bg-slate-200 flex items-center justify-center gap-2">
        <i class="fa-solid fa-pen-to-square"></i> 编辑课程信息
      </button>
      ${status !== SCHEDULE_STATUS.SCHEDULED ? `
      <button data-act="delete" class="w-full py-3.5 rounded-xl font-bold text-sm bg-rose-50 text-rose-600 border border-rose-200 active:bg-rose-100 flex items-center justify-center gap-2">
        <i class="fa-solid fa-trash-can"></i> 删除该课程
      </button>` : ''}
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
        if (confirm('确定删除该课程？待上课状态的课程会退还已扣课时。')) {
          const student1 = students.find((st) => st.id === schedule.studentId);
          checkInLogs = checkInLogs.filter((l) => l.scheduleId !== schedule.id);
          schedules = schedules.filter((s) => s.id !== schedule.id);
          if (schedule.status === SCHEDULE_STATUS.SCHEDULED && student1) {
            const course = (student1.courses || []).find((c) => c.id === schedule.courseId || c.name === schedule.subject);
            if (course) course.remainingLessons += getLessonCost(schedule);
          }
          saveData();
          renderMobile3DayView();
          renderMobileStudents();
          showToast('已删除该课程');
        }
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

    showModal('modalMobileStudent');
  }

  function closeMobileStudentModal() {
    hideModal('modalMobileStudent');
  }

  function addMobileCourseRow(course = null) {
    const container = document.getElementById('mobileStudentCoursesContainer');
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'mobile-course-row flex items-center gap-2';
    row.innerHTML = `
      <input type="text" class="m-course-name flex-1 min-w-0 px-3 py-2.5 border border-slate-200 rounded-xl text-xs font-medium outline-none focus:ring-2 focus:ring-amber-400 bg-white"
             placeholder="课程名称（如：钢琴一对一）" value="${course ? course.name || '' : ''}" required>
      <div class="flex items-center gap-1 shrink-0 bg-white border border-slate-200 rounded-xl px-2 py-1">
        <button type="button" class="m-course-debt-toggle w-6 h-6 rounded-lg text-[10px] font-bold transition ${course && course.remainingLessons < 0 ? 'bg-rose-500 text-white' : 'bg-slate-100 text-slate-400'}" title="点一下切换欠课">${course && course.remainingLessons < 0 ? '欠' : '＋'}</button>
        <input type="number" min="0" class="m-course-lessons w-12 text-center border-0 outline-none text-xs font-bold ${course && course.remainingLessons < 0 ? 'text-rose-600' : 'text-amber-800'}"
               placeholder="0" value="${course ? Math.abs(course.remainingLessons ?? 10) : 10}" required>
        <span class="m-course-unit text-slate-400 text-[10px]">${course && course.remainingLessons < 0 ? '欠课' : '课时'}</span>
      </div>
      <button type="button" class="m-course-remove text-slate-300 hover:text-rose-500 px-1.5 py-2 transition" title="删除该课程">
        <i class="fa-solid fa-trash-can"></i>
      </button>
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
        lessonsEl.className = 'm-course-lessons w-12 text-center border-0 outline-none text-xs font-bold text-amber-800';
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
      if (!cName && idx > 0) return;
      courses.push({
        id: 'c_m_' + (editId || 'st') + '_' + idx + '_' + Date.now(),
        name: cName || '通用课程',
        remainingLessons: cLessons,
      });
    });

    if (courses.length === 0) {
      showToast('请至少填写一门课程');
      return;
    }

    if (editId) {
      const idx = students.findIndex((s) => s.id === editId);
      if (idx !== -1) {
        // 编辑：沿用原课程 id，保证历史排课记录的引用不断
        const oldCourses = students[idx].courses || [];
        students[idx] = {
          ...students[idx],
          name,
          phone,
          colorTheme,
          courses: courses.map((c, i) => ({
            ...c,
            id: oldCourses[i] ? oldCourses[i].id : c.id,
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
        courses,
      });
      showToast('成功添加新学员！');
    }

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

  document.addEventListener('DOMContentLoaded', initMobileApp);
})();

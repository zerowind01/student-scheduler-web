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

  const COLOR_THEMES = ['amber', 'emerald', 'sky', 'purple', 'rose'];

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
  let draggedStudent = null; // 当前正在拖拽的学生
  let draggedSchedule = null; // 当前正在拖拽调整的现有课程
  let selectedStudentForTap = null; // 移动端/触摸屏点击选中的学员（点击排课模式）
  let currentFilter = 'unscheduled'; // 默认仅显示未排课学生（待排课）
  let searchQuery = ''; // 学生搜索关键字

  function selectStudentForTap(student, cardElement) {
    document.querySelectorAll('.student-card').forEach((c) => c.classList.remove('ring-2', 'ring-amber-500', 'border-amber-400'));

    if (selectedStudentForTap && selectedStudentForTap.id === student.id) {
      clearStudentForTap();
      return;
    }

    selectedStudentForTap = student;
    if (cardElement) cardElement.classList.add('ring-2', 'ring-amber-500', 'border-amber-400');

    const banner = document.getElementById('mobileTapScheduleBanner');
    const nameEl = document.getElementById('tapStudentName');
    if (banner && nameEl) {
      nameEl.textContent = student.name;
      banner.classList.remove('hidden');
    }
  }

  function clearStudentForTap() {
    selectedStudentForTap = null;
    document.querySelectorAll('.student-card').forEach((c) => c.classList.remove('ring-2', 'ring-amber-500', 'border-amber-400'));
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
          schedules = data.schedules || [];
          teachers = data.teachers || teachers;
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
    setupEventListeners();
    bindPageNav();
    renderTeacherOptions();
    renderWeekHeader();
    renderStudentList();
    renderCalendarGrid();
    updateStats();
    pullFromCloudSync(true);
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

    // 欠课账校准：负课时（手动填的欠课）同步进欠课账，保证财务页欠课名单完整
    syncAllDebts();

    saveDataLocalOnly();
  }

  // ==========================================
  // 云端实时跨设备同步引擎
  // ==========================================
  let schoolSyncKey = localStorage.getItem('edu_scheduler_school_key') || 'school_demo_2026';
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
            schedules = remoteData.schedules || [];
            teachers = remoteData.teachers || teachers;
            courseTypes = remoteData.courseTypes || courseTypes;
            checkInLogs = remoteData.checkInLogs || [];
            debts = (remoteData.debts || []).map(normalizeDebt);

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
        if (event.data && event.data.updatedAt) {
          students = event.data.students || students;
          schedules = event.data.schedules || schedules;
          teachers = event.data.teachers || teachers;
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
  function executeCheckIn(scheduleId, remarks) {
    const sch = schedules.find((s) => s.id === scheduleId);
    if (!sch) return;
    if (sch.status === SCHEDULE_STATUS.COMPLETED) {
      showToast('该课程已消课，无需重复操作', 'circle-info');
      return;
    }
    if (sch.status === SCHEDULE_STATUS.STUDENT_LEAVE) {
      showToast('该课程为请假状态，请先撤销请假', 'circle-info');
      return;
    }

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
    refreshView();
    showToast(`✅ 已消课：${sch.studentName} · ${sch.subject}（${deducted}节）`, 'circle-check');
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
    if (sch.status === SCHEDULE_STATUS.COMPLETED) {
      // 已消课 → 改为请假：删除消课流水（回滚财务）+ 退还消课时扣掉的课时
      checkInLogs = checkInLogs.filter((l) => l.scheduleId !== sch.id);
      const student = students.find((st) => st.id === sch.studentId);
      const deducted = getLessonCost(sch);
      if (student) {
        const course = (student.courses || []).find((c) => c.id === sch.courseId || c.name === sch.subject);
        if (course) course.remainingLessons += deducted;
      }
      showToast(`🏖️ 已消课的课程改为请假，退还 ${deducted} 节课时`, 'circle-check');
    } else {
      showToast(`🏖️ 已为 ${sch.studentName} 办理请假`, 'circle-check');
    }

    sch.status = SCHEDULE_STATUS.STUDENT_LEAVE;
    saveData();
    refreshView();
  }

  // 撤销状态（completed/student_leave → scheduled）
  function revertScheduleStatus(scheduleId) {
    const sch = schedules.find((s) => s.id === scheduleId);
    if (!sch || sch.status === SCHEDULE_STATUS.SCHEDULED) return;

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
    showToast('已撤销状态，还原为待上课', 'rotate-left');
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
  function setupEventListeners() {
    safeBind('btnPrevWeek', 'click', () => {
      currentWeekStart = addDays(currentWeekStart, -7);
      refreshView();
    });

    safeBind('btnNextWeek', 'click', () => {
      currentWeekStart = addDays(currentWeekStart, 7);
      refreshView();
    });

    safeBind('btnToday', 'click', () => {
      currentWeekStart = getMonday(new Date());
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
    safeBind('btnSaveSyncKey', 'click', () => {
      const el = document.getElementById('inputSyncKey');
      const val = (el ? el.value.trim() : '') || 'school_demo_2026';
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
          schedules = data.schedules || [];
          teachers = data.teachers || teachers;
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

    document.querySelectorAll('.filter-student-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.filter-student-btn').forEach((b) => b.classList.remove('active', 'bg-amber-500', 'text-white'));
        document.querySelectorAll('.filter-student-btn').forEach((b) => b.classList.add('text-slate-600'));
        e.target.classList.add('active', 'bg-amber-500', 'text-white');
        e.target.classList.remove('text-slate-600');
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
    updateStats();
    renderPageStudents();
    renderPageFinance();
    updateDebtBadges();
  }

  // ==========================================
  // 分页导航（课表/学员/财务/设置）
  // ==========================================
  const PAGE_IDS = ['pageSchedule', 'pageStudents', 'pageFinance', 'pageSettings'];

  function switchPage(page) {
    PAGE_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', id !== 'page' + page.charAt(0).toUpperCase() + page.slice(1));
    });

    // 桌面侧栏按钮高亮
    document.querySelectorAll('.nav-page-btn[data-page]').forEach((btn) => {
      const active = btn.getAttribute('data-page') === page;
      btn.classList.toggle('active', active);
      if (active) {
        btn.classList.remove('text-slate-400');
        btn.classList.add('bg-amber-500/90', 'text-white');
      } else {
        btn.classList.add('text-slate-400');
        btn.classList.remove('bg-amber-500/90', 'text-white');
      }
    });

    // 手机底部导航高亮
    document.querySelectorAll('.mnav-btn').forEach((btn) => {
      const active = btn.getAttribute('data-page') === page;
      btn.classList.toggle('text-amber-600', active);
      btn.classList.toggle('font-bold', active);
      btn.classList.toggle('text-slate-700', !active);
    });

    // 课表页隐藏手机浮动栏（因为课表有自己的操作），其他页显示
    const bottomNav = document.getElementById('mobileBottomNav');
    if (bottomNav) bottomNav.classList.toggle('hidden', page === 'schedule');

    if (page === 'students') renderPageStudents();
    if (page === 'finance') renderPageFinance();
  }

  function bindPageNav() {
    document.querySelectorAll('.nav-page-btn[data-page], .mnav-btn[data-page]').forEach((btn) => {
      btn.addEventListener('click', () => switchPage(btn.getAttribute('data-page')));
    });
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
      container.innerHTML = `<div class="col-span-full text-center py-16 text-slate-400 text-sm">还没有学员，点击右上角"新建学员"开始</div>`;
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
      <div class="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-2xs space-y-2" data-student-page-id="${student.id}">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            <div class="w-9 h-9 rounded-full ${themeColor.bg} ${themeColor.text} flex items-center justify-center font-bold text-sm shrink-0">${student.name.substring(0, 1)}</div>
            <div>
              <div class="font-bold text-sm text-slate-800">${student.name}</div>
              <div class="text-[10px] text-slate-400"><i class="fa-solid fa-phone text-[9px]"></i> ${student.phone || '无电话'}</div>
            </div>
          </div>
        </div>
        ${studentDebts.length ? `<div class="text-[10px] text-rose-600 bg-rose-50 border border-rose-200 px-2 py-1 rounded-lg"><i class="fa-solid fa-triangle-exclamation"></i> 欠课: ${studentDebts.map((d) => `${d.courseName} ${d.amount}节`).join('、')}</div>` : ''}
        <div class="space-y-1">
          ${student.courses.map((c) => `
            <div class="flex items-center justify-between text-[11px] bg-slate-50 px-2.5 py-1.5 rounded-lg border border-slate-100">
              <span class="font-semibold text-slate-700">${c.name}</span>
              <span class="font-bold ${c.remainingLessons <= 2 ? 'text-rose-600' : 'text-slate-500'}">剩${c.remainingLessons}课时${c.unitPrice > 0 ? ` · ¥${c.unitPrice}/节` : ''}</span>
            </div>`).join('')}
        </div>
        <div class="flex gap-2 pt-1">
          <button class="flex-1 py-2 rounded-lg bg-slate-100 text-slate-700 text-[11px] font-bold page-edit-student" data-id="${student.id}"><i class="fa-solid fa-pen-to-square"></i> 编辑</button>
          <button class="flex-1 py-2 rounded-lg bg-emerald-500 text-white text-[11px] font-bold page-recharge-student" data-id="${student.id}"><i class="fa-solid fa-circle-plus"></i> 充值</button>
        </div>
      </div>`;
    }).join('');

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

    container.innerHTML = `
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div class="bg-white border border-amber-100 rounded-2xl p-4">
          <div class="text-[10px] text-amber-600/70 font-bold">本月课消</div>
          <div class="text-xl font-black text-amber-700 mt-1">${monthLessons.toFixed(1)} <span class="text-xs">节</span></div>
        </div>
        <div class="bg-white border border-emerald-100 rounded-2xl p-4">
          <div class="text-[10px] text-emerald-600/70 font-bold">课消价值</div>
          <div class="text-xl font-black text-emerald-700 mt-1">¥${monthValue.toFixed(0)}</div>
        </div>
        <div class="bg-white border border-sky-100 rounded-2xl p-4">
          <div class="text-[10px] text-sky-600/70 font-bold">待消存量</div>
          <div class="text-xl font-black text-sky-700 mt-1">${totalRemaining.toFixed(1)} <span class="text-xs">节</span></div>
        </div>
        <div class="bg-white border ${debtors.length ? 'border-rose-200' : 'border-slate-100'} rounded-2xl p-4">
          <div class="text-[10px] ${debtors.length ? 'text-rose-600/70' : 'text-slate-400'} font-bold">欠课学员</div>
          <div class="text-xl font-black ${debtors.length ? 'text-rose-600' : 'text-slate-300'} mt-1">${debtors.length} <span class="text-xs">人</span></div>
        </div>
      </div>

      <div class="bg-white border border-slate-200 rounded-2xl p-4">
        <div class="font-bold text-xs text-slate-800 mb-2 flex items-center gap-1.5"><i class="fa-solid fa-receipt text-amber-500"></i> 本月收入明细（消课流水）</div>
        ${monthLogs.length === 0 ? '<div class="text-[11px] text-slate-400 py-4 text-center">本月暂无消课记录</div>' : `
        <div class="space-y-1.5 max-h-64 overflow-y-auto custom-scrollbar">
          ${monthLogs.map((l) => `
            <div class="flex items-center justify-between text-[11px] bg-slate-50 px-3 py-2 rounded-lg">
              <div>
                <span class="font-bold text-slate-700">${l.studentName}</span>
                <span class="text-slate-400 ml-1.5">${l.courseName}</span>
                ${l.remarks ? `<span class="text-amber-600 ml-1">${l.remarks}</span>` : ''}
              </div>
              <div class="text-right shrink-0 ml-2">
                <div class="font-bold text-slate-600">${l.deductedLessons}节 ${l.paymentAmount > 0 ? `· ¥${l.paymentAmount.toFixed(0)}` : ''}</div>
                <div class="text-[9px] text-slate-400">${(l.checkInTime || '').replace('T', ' ').slice(5, 16)}</div>
              </div>
            </div>`).join('')}
        </div>`}
      </div>

      <div class="bg-white border ${debtors.length ? 'border-rose-200' : 'border-slate-200'} rounded-2xl p-4">
        <div class="font-bold text-xs text-slate-800 mb-2 flex items-center gap-1.5"><i class="fa-solid fa-triangle-exclamation text-rose-500"></i> 欠课名单</div>
        ${debtors.length === 0 ? '<div class="text-[11px] text-slate-400 py-4 text-center">没有欠课学员，太棒了 🎉</div>' : `
        <div class="space-y-1.5">
          ${debtors.map((d) => {
            const st = students.find((s) => s.id === d.studentId);
            return `
            <div class="flex items-center justify-between text-[11px] bg-rose-50/60 px-3 py-2 rounded-lg">
              <span class="font-bold text-slate-700">${st ? st.name : '未知学员'} · ${d.courseName}</span>
              <span class="font-black text-rose-600">欠 ${d.amount} 节</span>
            </div>`;}).join('')}
          <div class="text-[10px] text-slate-400 pt-1">💡 到"学员"页点对应学员的"充值"按钮，会自动抵扣欠课</div>
        </div>`}
      </div>

      <div class="bg-white border border-slate-200 rounded-2xl p-4">
        <div class="font-bold text-xs text-slate-800 mb-2 flex items-center gap-1.5"><i class="fa-solid fa-wallet text-emerald-500"></i> 课时存量价值</div>
        <div class="flex items-baseline gap-2">
          <span class="text-2xl font-black text-emerald-600">¥${totalStockValue.toFixed(0)}</span>
          <span class="text-[10px] text-slate-400">全部学员剩余课时按单价折算</span>
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
        <div class="text-[11px] ${isToday ? 'text-amber-600 font-bold' : 'text-slate-400 font-medium'}">${weekdayNames[i]}</div>
        <div class="text-xs sm:text-sm font-bold mt-0.5 ${isToday ? 'today-badge inline-block' : 'text-slate-700'}">
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
        <div class="text-center py-10 text-slate-400 text-xs">
          <i class="fa-solid fa-user-slash text-2xl mb-2 text-slate-300"></i>
          <p>暂无符合条件的学生</p>
        </div>
      `;
      return;
    }

    filtered.forEach((student) => {
      const card = document.createElement('div');
      card.className = 'student-card bg-white p-3 rounded-xl border border-slate-200/80 shadow-2xs flex flex-col gap-2 group relative';
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
        <div class="flex items-center justify-between text-[11px] bg-slate-50/90 px-2.5 py-1 rounded-lg border border-slate-100">
          <span class="font-semibold text-slate-700 truncate">${c.name}</span>
          <span class="font-bold shrink-0 ml-1.5 ${c.remainingLessons <= 2 ? 'text-rose-600 bg-rose-50 px-1.5 py-0.2 rounded border border-rose-200' : 'text-slate-500'}">
            ${c.remainingLessons <= 2 ? '<span class="w-1.5 h-1.5 rounded-full bg-rose-500 animate-ping inline-block mr-1"></span>' : ''}剩${c.remainingLessons}课时
          </span>
        </div>
      `
        )
        .join('');

      card.innerHTML = `
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            <div class="text-slate-300 group-hover:text-amber-500 transition cursor-grab">
              <i class="fa-solid fa-grip-vertical text-xs"></i>
            </div>
            <div class="w-8 h-8 rounded-full ${themeColor.bg} ${themeColor.text} flex items-center justify-center font-bold text-xs shrink-0 shadow-xs">
              ${student.name.substring(0, 1)}
            </div>
            <div>
              <div class="font-bold text-xs text-slate-800 flex items-center gap-1">
                <span>${student.name}</span>
                <span class="text-[10px] text-slate-400 font-normal">(${student.courses.length}门课)</span>
              </div>
              <div class="text-[10px] text-slate-400">
                <i class="fa-solid fa-phone text-[9px]"></i> ${student.phone || '无电话'}
              </div>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <button class="btn-edit-student text-slate-400 hover:text-slate-700 transition" title="编辑学生课程">
              <i class="fa-solid fa-pen-to-square"></i>
            </button>
            <button class="btn-recharge-student text-emerald-500 hover:text-emerald-600 transition" title="充值课时">
              <i class="fa-solid fa-circle-plus"></i>
            </button>
          </div>
        </div>

        ${debtsHtml}

        <div class="space-y-1 pt-1 border-t border-slate-100">
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
        dragGhost.className = 'bg-amber-500 text-white px-3 py-1.5 rounded-xl font-bold text-xs shadow-lg';
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
    const map = {
      amber: { bg: 'bg-amber-100', text: 'text-amber-700', border: 'border-amber-300' },
      emerald: { bg: 'bg-emerald-100', text: 'text-emerald-700', border: 'border-emerald-300' },
      sky: { bg: 'bg-sky-100', text: 'text-sky-700', border: 'border-sky-300' },
      purple: { bg: 'bg-purple-100', text: 'text-purple-700', border: 'border-purple-300' },
      rose: { bg: 'bg-rose-100', text: 'text-rose-700', border: 'border-rose-300' },
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
  }

  function removeDragPreviewSlot(container) {
    const slot = container.querySelector('.drag-preview-slot');
    if (slot) container.removeChild(slot);
  }

  // ==========================================
  // 8. 创建日历中的课程事件卡片
  // ==========================================
  function createScheduleEventCard(schedule, conflictInfo) {
    const card = document.createElement('div');
    const themeClass = `event-${schedule.colorTheme || 'amber'}`;
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

    let teacherText = '';
    if (schedule.teacherName) {
      if (schedule.assistantTeacherName) {
        teacherText = `👩‍🏫${schedule.teacherName}&${schedule.assistantTeacherName}`;
      } else {
        teacherText = `👩‍🏫${schedule.teacherName}`;
      }
    }
    const roomText = schedule.room ? `📍${schedule.room}` : '';

    const isSideBySide = totalCols > 1;

    card.setAttribute(
      'title',
      `学员: ${schedule.studentName}\n课程: ${schedule.subject}\n时间: ${schedule.startTime}-${endTimeStr}\n任课老师: ${schedule.teacherName || '未指定'}${schedule.assistantTeacherName ? ' & ' + schedule.assistantTeacherName : ''}\n课室: ${schedule.room || '未指定'}`
    );

    const isSpacious = totalCols === 1;
    const isVeryTall = heightPx >= 68;

    const nameFontSize = isSpacious ? (isVeryTall ? 'text-sm font-black' : 'text-[13px] font-extrabold') : 'text-xs font-bold';
    const timeFontSize = isSpacious ? 'text-[10px] font-mono font-bold' : 'text-[9px] font-mono';
    const badgeFontSize = isSpacious ? 'text-[11px] font-bold' : 'text-[10px] font-bold';
    const textFontSize = isSpacious ? 'text-[10.5px] font-semibold' : 'text-[9.5px] font-medium';

    // 状态角标（待上课/已消课/请假）
    let statusBadge = '';
    if (schedule.status === SCHEDULE_STATUS.COMPLETED) {
      statusBadge = `<span class="absolute top-0.5 right-1 text-[8px] font-black text-white bg-emerald-500 px-1 py-0.2 rounded-md shadow-xs z-10" title="已消课">✓ 消</span>`;
    } else if (schedule.status === SCHEDULE_STATUS.STUDENT_LEAVE) {
      statusBadge = `<span class="absolute top-0.5 right-1 text-[8px] font-black text-white bg-rose-400 px-1 py-0.2 rounded-md shadow-xs z-10" title="学员请假">假</span>`;
    }
    if (schedule.status === SCHEDULE_STATUS.COMPLETED) {
      card.style.opacity = '0.65';
    } else if (schedule.status === SCHEDULE_STATUS.STUDENT_LEAVE) {
      card.style.opacity = '0.5';
      card.classList.add('grayscale');
    }

    card.innerHTML = `
      ${statusBadge}
      <div class="flex flex-col justify-between h-full space-y-0.5 pointer-events-none px-2 py-1">
        <div class="flex items-center justify-between gap-1 leading-none shrink-0">
          <span class="truncate text-slate-900 ${nameFontSize} flex-1 tracking-normal font-sans">${schedule.studentName}</span>
          ${
            !isSideBySide
              ? `<span class="${timeFontSize} opacity-80 shrink-0 bg-white/75 px-1 py-0.2 rounded border border-black/5">${schedule.startTime}-${endTimeStr}</span>`
              : ''
          }
        </div>

        <div class="leading-none flex items-center gap-1 flex-wrap truncate shrink-0 -mt-[2px]">
          <span class="${badgeFontSize} px-1.5 py-0.5 bg-white/80 text-slate-800 rounded-md border border-black/5 shadow-2xs truncate">${schedule.subject}</span>
          ${teacherText ? `<span class="opacity-85 ${textFontSize} truncate">${teacherText}</span>` : ''}
          ${roomText ? `<span class="opacity-85 ${textFontSize} truncate">${roomText}</span>` : ''}
        </div>

        ${
          hasConflict
            ? `<div class="text-[9px] font-bold text-rose-700 bg-rose-100/95 border border-rose-300 px-1 py-0.2 rounded truncate flex items-center gap-0.5 shadow-2xs shrink-0 mt-0.5" title="${conflictInfo.reasons.join(' | ')}">
                <i class="fa-solid fa-triangle-exclamation text-rose-500 animate-pulse shrink-0 text-[8px]"></i>
                <span class="truncate leading-normal">${conflictInfo.reasons.join('; ')}</span>
               </div>`
            : ''
        }
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
  function openScheduleActionMenu(schedule) {
    const status = schedule.status || SCHEDULE_STATUS.SCHEDULED;
    const student = students.find((st) => st.id === schedule.studentId);
    const menu = document.createElement('div');
    menu.id = 'scheduleActionMenu';
    menu.className = 'fixed inset-0 bg-slate-900/40 backdrop-blur-xs z-50 flex items-center justify-center p-4';

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
        <button data-act="revert" class="w-full py-3 rounded-xl font-bold text-sm bg-amber-500 text-white hover:bg-amber-600 transition flex items-center justify-center gap-2">
          <i class="fa-solid fa-rotate-left"></i> 撤销消课（还原为待上课）
        </button>` : ''}
      `;
    } else {
      actionsHtml += `
        <button data-act="revert" class="w-full py-3 rounded-xl font-bold text-sm bg-amber-500 text-white hover:bg-amber-600 transition flex items-center justify-center gap-2">
          <i class="fa-solid fa-rotate-left"></i> 撤销状态（还原为待上课）
        </button>
      `;
    }
    actionsHtml += `
      <button data-act="edit" class="w-full py-3 rounded-xl font-bold text-sm bg-slate-100 text-slate-700 hover:bg-slate-200 transition flex items-center justify-center gap-2">
        <i class="fa-solid fa-pen-to-square"></i> 编辑课程信息
      </button>
      ${status !== SCHEDULE_STATUS.SCHEDULED ? `
      <button data-act="delete" class="w-full py-3 rounded-xl font-bold text-sm bg-rose-50 text-rose-600 border border-rose-200 hover:bg-rose-100 transition flex items-center justify-center gap-2">
        <i class="fa-solid fa-trash-can"></i> 删除该课程
      </button>` : ''}
    `;

    const statusText = status === SCHEDULE_STATUS.COMPLETED ? '已消课 ✓' : status === SCHEDULE_STATUS.STUDENT_LEAVE ? '学员请假 🏖️' : '待上课';
    menu.innerHTML = `
      <div class="bg-white rounded-2xl shadow-2xl w-full max-w-xs p-5 space-y-2.5">
        <div class="pb-3 border-b border-slate-100">
          <div class="font-bold text-sm text-slate-800">${schedule.studentName} · ${schedule.subject}</div>
          <div class="text-[11px] text-slate-400 mt-0.5">${schedule.date} ${schedule.startTime} · ${schedule.durationMinutes}分钟 · 状态：${statusText}</div>
          ${student && getStudentDebts(student.id).length ? `<div class="text-[10px] text-rose-500 mt-1">⚠ 该学员有欠课：${getStudentDebts(student.id).map(d => d.courseName + ' ' + d.amount + '节').join('、')}</div>` : ''}
        </div>
        ${actionsHtml}
        <button data-act="close" class="w-full py-2 text-slate-400 text-xs hover:text-slate-600 transition">取消</button>
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
        if (confirm('确定删除该课程？待上课状态的课程会退还已扣课时。')) {
          handleDeleteScheduleWithCleanup(schedule.id);
          refreshView();
          showToast('已删除该课程', 'trash-can');
        }
      }
    });

    document.body.appendChild(menu);
  }

  // ==========================================
  // 9. 冲突检测算法
  // ==========================================
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
  function openScheduleModalForNew(student, dateStr, startTimeStr) {
    normalizeStudent(student);

    const titleEl = document.getElementById('modalScheduleTitle');
    if (titleEl) titleEl.textContent = '安排新课程';

    const idEl = document.getElementById('inputScheduleId');
    if (idEl) idEl.value = '';

    const stIdEl = document.getElementById('inputStudentId');
    if (stIdEl) stIdEl.value = student.id;

    const avEl = document.getElementById('modalStudentAvatar');
    if (avEl) avEl.textContent = student.name.substring(0, 1);

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

    renderTeacherOptions();

    const theme = student.colorTheme || 'amber';
    const radio = document.querySelector(`input[name="colorTheme"][value="${theme}"]`);
    if (radio) radio.checked = true;

    const delBtn = document.getElementById('btnDeleteSchedule');
    if (delBtn) delBtn.classList.add('hidden');

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
    if (avEl) avEl.textContent = student.name.substring(0, 1);

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

    renderTeacherOptions();
    const tEl = document.getElementById('selectTeacher');
    if (tEl && schedule.teacherId) tEl.value = schedule.teacherId;

    const aEl = document.getElementById('selectAssistantTeacher');
    if (aEl && schedule.assistantTeacherId) aEl.value = schedule.assistantTeacherId;

    const theme = schedule.colorTheme || 'amber';
    const radio = document.querySelector(`input[name="colorTheme"][value="${theme}"]`);
    if (radio) radio.checked = true;

    const delBtn = document.getElementById('btnDeleteSchedule');
    if (delBtn) delBtn.classList.remove('hidden');

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
    const subject = courseOpt ? courseOpt.getAttribute('data-name') : '通用课程';

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
    const colorTheme = document.querySelector('input[name="colorTheme"]:checked')?.value || 'amber';

    if (schId) {
      const index = schedules.findIndex((s) => s.id === schId);
      if (index !== -1) {
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
        showToast('课程排期修改成功！', 'check');
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
        notes,
        colorTheme,
      };
      schedules.push(newSchedule);

      // 课时在消课时扣除（App 语义），排课不再扣

      showToast(`已成功为 [${student ? student.name : ''}] 安排【${subject}】课程！`, 'circle-check');
    }

    saveData();
    closeScheduleModal();
    refreshView();

    const updatedConflicts = detectScheduleConflicts();
    const currentSchId = schId || schedules[schedules.length - 1].id;
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

    if (confirm('确定要删除此节课程安排吗？')) {
      handleDeleteScheduleWithCleanup(schId);
      closeScheduleModal();
      refreshView();
      showToast('已取消该课程安排', 'trash-can');
    }
  }

  // ==========================================
  // 11. 教师管理 Modal 弹窗控制
  // ==========================================
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
      container.innerHTML = `<div class="text-slate-400 text-center py-4">暂无教师记录</div>`;
      return;
    }

    teachers.forEach((t) => {
      const item = document.createElement('div');
      item.className = 'flex items-center justify-between p-2.5 bg-slate-50 border border-slate-200/80 rounded-xl text-xs';
      item.innerHTML = `
        <div class="flex items-center gap-2.5">
          <div class="w-8 h-8 rounded-full bg-amber-500 text-white font-bold flex items-center justify-center text-xs shadow-2xs">
            ${t.name.substring(0, 1)}
          </div>
          <div>
            <div class="font-bold text-slate-800">${t.name}</div>
            <div class="text-[10px] text-slate-500">主讲: ${t.subject || '全科'}</div>
          </div>
        </div>
        <button class="btn-del-teacher text-slate-400 hover:text-rose-600 transition px-2 py-1" title="删除教师" data-id="${t.id}">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      `;

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
    container.innerHTML = '';

    courses.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'course-row flex items-center gap-2';
      row.innerHTML = `
        <input type="text" class="course-name-input flex-1 px-2.5 py-1.5 border border-slate-200 rounded-lg text-xs font-medium outline-none focus:ring-1 focus:ring-amber-400" placeholder="课程名称（如：钢琴一对一）" value="${c.name || ''}" required>
        <div class="flex items-center gap-1 shrink-0">
          <span class="text-slate-400 text-[10px]">剩</span>
          <input type="number" class="course-lessons-input w-16 px-2 py-1.5 border border-slate-200 rounded-lg text-xs font-bold text-amber-800 outline-none focus:ring-1 focus:ring-amber-400" value="${c.remainingLessons ?? 10}" required>
          <span class="text-slate-400 text-[10px]">课时</span>
        </div>
        ${
          courses.length > 1
            ? `<button type="button" class="btn-remove-course-row text-slate-300 hover:text-rose-500 px-1 py-1 transition" title="删除该课程"><i class="fa-solid fa-trash-can"></i></button>`
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
    row.className = 'course-row flex items-center gap-2';
    row.innerHTML = `
      <input type="text" class="course-name-input flex-1 px-2.5 py-1.5 border border-slate-200 rounded-lg text-xs font-medium outline-none focus:ring-1 focus:ring-amber-400" placeholder="课程名称（如：乐理基础）" required>
      <div class="flex items-center gap-1 shrink-0">
        <span class="text-slate-400 text-[10px]">剩</span>
        <input type="number" class="course-lessons-input w-16 px-2 py-1.5 border border-slate-200 rounded-lg text-xs font-bold text-amber-800 outline-none focus:ring-1 focus:ring-amber-400" placeholder="可填负数=欠课" value="10" required>
        <span class="text-slate-400 text-[10px]">课时</span>
      </div>
      <button type="button" class="btn-remove-course-row text-slate-300 hover:text-rose-500 px-1 py-1 transition" title="删除该课程"><i class="fa-solid fa-trash-can"></i></button>
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
      courses.push({
        id: 'c_' + (editId || 'st') + '_' + idx + '_' + Date.now(),
        name: nameVal,
        remainingLessons: lessonsVal,
      });
    });

    if (courses.length === 0) {
      alert('请至少为学员保留一门课程！');
      return;
    }

    if (editId) {
      const idx = students.findIndex((s) => s.id === editId);
      if (idx !== -1) {
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

    saveData();
    closeStudentModal();
    refreshView();
  }

  function handleDeleteStudent() {
    const editId = document.getElementById('editStudentId') ? document.getElementById('editStudentId').value : '';
    if (!editId) return;

    if (confirm('确定要删除该学员吗？该学员的所有课程记录及历史排课会被同步清理。')) {
      students = students.filter((s) => s.id !== editId);
      schedules = schedules.filter((sch) => sch.studentId !== editId);
      saveData();
      closeStudentModal();
      refreshView();
      showToast('已删除学员记录', 'trash');
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
    if (cEl) cEl.textContent = `${totalCourses} 节`;

    const hEl = document.getElementById('statWeeklyHours');
    if (hEl) hEl.textContent = `${totalHours} 小时`;

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
        <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">本月经营</span>
        <span class="text-[9px] text-slate-300">${monthPrefix}</span>
      </div>
      <div class="grid grid-cols-2 gap-1.5">
        <div class="bg-amber-50 border border-amber-100 rounded-lg p-2">
          <div class="text-[9px] text-amber-600/70">本月课消</div>
          <div class="text-sm font-black text-amber-700">${monthLessons.toFixed(1)} 节</div>
        </div>
        <div class="bg-emerald-50 border border-emerald-100 rounded-lg p-2">
          <div class="text-[9px] text-emerald-600/70">课消价值</div>
          <div class="text-sm font-black text-emerald-700">¥${monthValue.toFixed(0)}</div>
        </div>
        <div class="bg-sky-50 border border-sky-100 rounded-lg p-2">
          <div class="text-[9px] text-sky-600/70">待消存量</div>
          <div class="text-sm font-black text-sky-700">${totalRemaining.toFixed(1)} 节</div>
        </div>
        <div class="${debtors.length ? 'bg-rose-50 border-rose-100' : 'bg-slate-50 border-slate-100'} border rounded-lg p-2">
          <div class="text-[9px] ${debtors.length ? 'text-rose-600/70' : 'text-slate-400'}">欠课学员</div>
          <div class="text-sm font-black ${debtors.length ? 'text-rose-600' : 'text-slate-400'}">${debtors.length} 人</div>
        </div>
      </div>
      ${debtors.length ? `
      <div class="mt-2 space-y-1">
        ${debtors.map((d) => {
          const st = students.find((s) => s.id === d.studentId);
          return `<div class="flex items-center justify-between text-[10px] bg-rose-50/60 px-2 py-1 rounded-md">
            <span class="text-slate-600 font-semibold">${st ? st.name : '未知学员'} · ${d.courseName}</span>
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

    const modal = document.createElement('div');
    modal.id = 'rechargeModal';
    modal.className = 'fixed inset-0 bg-slate-900/40 backdrop-blur-xs z-50 flex items-center justify-center p-4';
    modal.innerHTML = `
      <div class="bg-white rounded-2xl shadow-2xl w-full max-w-xs p-5 space-y-3" onclick="event.stopPropagation()">
        <div class="font-bold text-sm text-slate-800 pb-2 border-b border-slate-100">
          <i class="fa-solid fa-circle-plus text-emerald-500"></i>
          为 ${student.name} 充值课时
        </div>
        <div>
          <label class="block text-[11px] font-semibold text-slate-500 mb-1">课程</label>
          <select id="rechargeCourseSelect" class="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs outline-none focus:ring-2 focus:ring-emerald-300">
            ${courseOptions}
            <option value="__new__">➕ 新课程包...</option>
          </select>
        </div>
        <div id="rechargeNewNameWrap" class="hidden">
          <label class="block text-[11px] font-semibold text-slate-500 mb-1">新课程名称</label>
          <input type="text" id="rechargeNewName" placeholder="如：美术一对一" class="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs outline-none focus:ring-2 focus:ring-emerald-300">
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-[11px] font-semibold text-slate-500 mb-1">充值节数</label>
            <input type="number" id="rechargeLessons" min="1" value="10" class="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs font-bold outline-none focus:ring-2 focus:ring-emerald-300">
          </div>
          <div>
            <label class="block text-[11px] font-semibold text-slate-500 mb-1">单价 (元/节)</label>
            <input type="number" id="rechargePrice" min="0" value="200" class="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs font-bold outline-none focus:ring-2 focus:ring-emerald-300">
          </div>
        </div>
        <div class="text-[10px] text-slate-400">💡 若该课程有欠课，充值会自动抵扣</div>
        <div class="flex gap-2 pt-1">
          <button id="rechargeCancel" class="flex-1 py-2.5 rounded-xl text-slate-600 bg-slate-100 font-bold text-xs">取消</button>
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

  function showModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) {
      el.classList.remove('hidden');
      setTimeout(() => el.classList.add('opacity-100'), 10);
    }
  }

  function hideModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) {
      el.classList.remove('opacity-100');
      setTimeout(() => el.classList.add('hidden'), 200);
    }
  }

  function showToast(msg, icon = 'circle-check') {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toastMsg');
    const toastIcon = document.getElementById('toastIcon');

    if (toast && toastMsg && toastIcon) {
      toastMsg.textContent = msg;
      toastIcon.className = `fa-solid fa-${icon} text-amber-400`;

      toast.classList.remove('translate-y-10', 'opacity-0', 'pointer-events-none');
      toast.classList.add('translate-y-0', 'opacity-100');

      setTimeout(() => {
        toast.classList.add('translate-y-10', 'opacity-0', 'pointer-events-none');
        toast.classList.remove('translate-y-0', 'opacity-100');
      }, 2800);
    }
  }

  document.addEventListener('DOMContentLoaded', initApp);
})();

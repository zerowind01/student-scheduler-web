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

  const COLOR_THEMES = ['amber', 'emerald', 'sky', 'purple', 'rose'];

  function getRandomColorTheme() {
    return COLOR_THEMES[Math.floor(Math.random() * COLOR_THEMES.length)];
  }

  let students = [];
  let schedules = [];
  let teachers = [];
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
  function initApp() {
    loadData();
    setupEventListeners();
    renderTeacherOptions();
    renderWeekHeader();
    renderStudentList();
    renderCalendarGrid();
    updateStats();
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

    if (rawTeachers) {
      try {
        teachers = JSON.parse(rawTeachers);
      } catch (e) {
        teachers = [];
      }
    }
    if (!teachers || teachers.length === 0) {
      teachers = [
        { id: 't1', name: '张老师', subject: '钢琴', colorTheme: 'amber' },
        { id: 't2', name: '王老师', subject: '小提琴', colorTheme: 'emerald' },
        { id: 't3', name: '李老师', subject: '声乐/视唱', colorTheme: 'sky' },
        { id: 't4', name: '赵老师', subject: '吉他', colorTheme: 'purple' },
        { id: 't5', name: '陈老师', subject: '架子鼓', colorTheme: 'rose' },
      ];
    }

    if (rawStudents) {
      try {
        students = JSON.parse(rawStudents).map(normalizeStudent);
      } catch (e) {
        students = [];
      }
    } else {
      students = [
        {
          id: 's1',
          name: '张伟',
          phone: '13800112233',
          colorTheme: 'amber',
          courses: [
            { id: 'c_s1_1', name: '钢琴一对一', remainingLessons: 12 },
            { id: 'c_s1_2', name: '视唱练耳基础', remainingLessons: 8 },
          ],
        },
        {
          id: 's2',
          name: '李娜',
          phone: '13911223344',
          colorTheme: 'emerald',
          courses: [
            { id: 'c_s2_1', name: '小提琴基础', remainingLessons: 8 },
            { id: 'c_s2_2', name: '室内乐合奏', remainingLessons: 4 },
          ],
        },
        {
          id: 's3',
          name: '王强',
          phone: '13722334455',
          colorTheme: 'sky',
          courses: [{ id: 'c_s3_1', name: '美声发声', remainingLessons: 2 }],
        },
        {
          id: 's4',
          name: '赵敏',
          phone: '13633445566',
          colorTheme: 'purple',
          courses: [
            { id: 'c_s4_1', name: '古典吉他', remainingLessons: 15 },
            { id: 'c_s4_2', name: '民谣吉他弹唱', remainingLessons: 6 },
          ],
        },
        {
          id: 's5',
          name: '孙悦',
          phone: '13544556677',
          colorTheme: 'rose',
          courses: [{ id: 'c_s5_1', name: '爵士鼓入门', remainingLessons: 1 }],
        },
        {
          id: 's6',
          name: '周杰',
          phone: '13455667788',
          colorTheme: 'amber',
          courses: [{ id: 'c_s6_1', name: '古筝进阶', remainingLessons: 6 }],
        },
      ];
    }

    if (rawSchedules) {
      try {
        schedules = JSON.parse(rawSchedules);
      } catch (e) {
        schedules = [];
      }
    } else {
      const weekStart = getMonday(new Date());
      const mon = formatDate(addDays(weekStart, 0));
      const wed = formatDate(addDays(weekStart, 2));
      const fri = formatDate(addDays(weekStart, 4));
      const sat = formatDate(addDays(weekStart, 5));

      schedules = [
        {
          id: 'sch_1',
          studentId: 's1',
          studentName: '张伟',
          courseId: 'c_s1_1',
          subject: '钢琴一对一',
          teacherId: 't1',
          teacherName: '张老师',
          assistantTeacherId: '',
          assistantTeacherName: '',
          date: mon,
          startTime: '10:00',
          durationMinutes: 60,
          room: '琴房 101',
          colorTheme: 'amber',
          notes: '准备汤普森第二册',
        },
        {
          id: 'sch_6',
          studentId: 's5',
          studentName: '孙悦',
          courseId: 'c_s5_1',
          subject: '爵士鼓入门',
          teacherId: 't5',
          teacherName: '陈老师',
          assistantTeacherId: '',
          assistantTeacherName: '',
          date: mon,
          startTime: '10:00',
          durationMinutes: 60,
          room: '综合教室 201',
          colorTheme: 'rose',
          notes: '同时间段不同教室并行授课并排展示',
        },
        {
          id: 'sch_2',
          studentId: 's2',
          studentName: '李娜',
          courseId: 'c_s2_2',
          subject: '室内乐合奏',
          teacherId: 't2',
          teacherName: '王老师',
          assistantTeacherId: 't3',
          assistantTeacherName: '李老师',
          date: wed,
          startTime: '14:30',
          durationMinutes: 90,
          room: '琴房 103',
          colorTheme: 'emerald',
          notes: '双师共上合奏指导',
        },
        {
          id: 'sch_5',
          studentId: 's6',
          studentName: '周杰',
          courseId: 'c_s6_1',
          subject: '古筝进阶',
          teacherId: 't1',
          teacherName: '张老师',
          assistantTeacherId: '',
          assistantTeacherName: '',
          date: wed,
          startTime: '14:30',
          durationMinutes: 60,
          room: '琴房 103',
          colorTheme: 'amber',
          notes: '占用琴房103冲突演示',
        },
        {
          id: 'sch_3',
          studentId: 's3',
          studentName: '王强',
          courseId: 'c_s3_1',
          subject: '美声发声',
          teacherId: 't3',
          teacherName: '李老师',
          assistantTeacherId: '',
          assistantTeacherName: '',
          date: fri,
          startTime: '16:00',
          durationMinutes: 60,
          room: '声乐教室 B',
          colorTheme: 'sky',
          notes: '高音换声技巧',
        },
        {
          id: 'sch_4',
          studentId: 's4',
          studentName: '赵敏',
          courseId: 'c_s4_1',
          subject: '古典吉他',
          teacherId: 't4',
          teacherName: '赵老师',
          assistantTeacherId: 't5',
          assistantTeacherName: '陈老师',
          date: sat,
          startTime: '09:30',
          durationMinutes: 60,
          room: '琴房 102',
          colorTheme: 'purple',
          notes: '打击乐与吉他合奏课程',
        },
      ];
    }

    saveDataLocalOnly();
  }

  // ==========================================
  // 云端实时跨设备同步引擎
  // ==========================================
  let schoolSyncKey = localStorage.getItem('edu_scheduler_school_key') || 'school_demo_2026';
  let isCloudSyncing = false;

  // Upstash Serverless Redis 实时云端存储 (100% 全球持久化 + CORS 支持)
  const UPSTASH_REST_URL = 'https://coherent-possum-31725.upstash.io';
  const UPSTASH_REST_TOKEN = 'AXutACQgM2YxNWYzMzEtYjM0NC00YzM0LTk5MzktZTM1OGExN2I3YzA1';

  async function pushToCloudSync() {
    saveDataLocalOnly();
    if (!schoolSyncKey || isCloudSyncing) return;

    try {
      isCloudSyncing = true;
      const now = Date.now();

      const payload = {
        key: schoolSyncKey,
        updatedAt: now,
        students,
        schedules,
        teachers,
      };

      localStorage.setItem('edu_scheduler_last_sync_time', String(now));

      if ('BroadcastChannel' in window) {
        try {
          new BroadcastChannel('edu_scheduler_broadcast').postMessage(payload);
        } catch (e) {}
      }

      const valStr = JSON.stringify(payload);
      await fetch(`${UPSTASH_REST_URL}/set/${encodeURIComponent(schoolSyncKey)}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${UPSTASH_REST_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(valStr)
      });
    } catch (err) {
      console.warn('Cloud sync push:', err);
    } finally {
      isCloudSyncing = false;
    }
  }

  async function pullFromCloudSync() {
    if (!schoolSyncKey || isCloudSyncing) return;

    try {
      const res = await fetch(`${UPSTASH_REST_URL}/get/${encodeURIComponent(schoolSyncKey)}`, {
        headers: {
          'Authorization': `Bearer ${UPSTASH_REST_TOKEN}`
        }
      });
      if (!res.ok) return;

      const data = await res.json();
      if (data && data.result) {
        const remoteData = typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
        if (remoteData && remoteData.updatedAt) {
          const localTime = parseInt(localStorage.getItem('edu_scheduler_last_sync_time') || '0', 10);
          if (remoteData.updatedAt > localTime) {
            isCloudSyncing = true;
            students = remoteData.students || students;
            schedules = remoteData.schedules || schedules;
            teachers = remoteData.teachers || teachers;

            localStorage.setItem('edu_scheduler_last_sync_time', String(remoteData.updatedAt));
            saveDataLocalOnly();
            renderTeacherOptions();
            refreshView();

            showToast('⚡ 已实时同步最新课表数据！', 'bolt');
          }
        }
      }
    } catch (err) {
      // 离线忽略
    } finally {
      isCloudSyncing = false;
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
      pushToCloudSync();
      showToast(`已开启云同步！同步码: ${val}`, 'cloud-arrow-up');
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
    const btnToggleSidebar = document.getElementById('btnToggleSidebar');
    const btnExpandSidebarFloating = document.getElementById('btnExpandSidebarFloating');
    const sidebarBackdrop = document.getElementById('sidebarBackdrop');

    function collapseSidebar() {
      if (sidebar) sidebar.classList.add('sidebar-collapsed');
      if (btnExpandSidebarFloating) btnExpandSidebarFloating.classList.remove('hidden');
      if (sidebarBackdrop) sidebarBackdrop.classList.add('hidden');
    }

    function expandSidebar() {
      if (sidebar) sidebar.classList.remove('sidebar-collapsed');
      if (btnExpandSidebarFloating) btnExpandSidebarFloating.classList.add('hidden');
      if (window.innerWidth < 768 && sidebarBackdrop) {
        sidebarBackdrop.classList.remove('hidden');
      }
    }

    if (btnToggleSidebar) btnToggleSidebar.addEventListener('click', collapseSidebar);
    if (btnExpandSidebarFloating) btnExpandSidebarFloating.addEventListener('click', expandSidebar);
    if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', collapseSidebar);

    if (window.innerWidth < 1080) {
      collapseSidebar();
    }
  }

  function refreshView() {
    renderWeekHeader();
    renderStudentList();
    renderCalendarGrid();
    updateStats();
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
            <span class="text-[10px] font-bold ${isLow ? 'text-rose-600 bg-rose-50 border border-rose-200' : 'text-amber-700 bg-amber-50'} px-1.5 py-0.5 rounded">
              共剩${totalLessons}课时
            </span>
            <button class="btn-edit-student text-slate-400 hover:text-slate-700 transition" title="编辑学生课程">
              <i class="fa-solid fa-pen-to-square"></i>
            </button>
          </div>
        </div>

        <div class="space-y-1 pt-1 border-t border-slate-100">
          ${coursesHtml}
        </div>
      `;

      card.addEventListener('dragstart', (e) => {
        draggedStudent = student;
        draggedSchedule = null;
        card.classList.add('dragging');

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

    card.innerHTML = `
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
      openScheduleModalForEdit(schedule);
    });

    return card;
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

      if (student && student.courses) {
        const targetCourse = student.courses.find((c) => c.id === courseId || c.name === subject);
        if (targetCourse) {
          const lessonCost = Math.max(1, Math.round(durationMinutes / 60));
          targetCourse.remainingLessons = Math.max(0, targetCourse.remainingLessons - lessonCost);
        }
      }

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
      schedules = schedules.filter((s) => s.id !== schId);
      saveData();
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
          <input type="number" class="course-lessons-input w-16 px-2 py-1.5 border border-slate-200 rounded-lg text-xs font-bold text-amber-800 outline-none focus:ring-1 focus:ring-amber-400" min="0" value="${c.remainingLessons ?? 10}" required>
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
        <input type="number" class="course-lessons-input w-16 px-2 py-1.5 border border-slate-200 rounded-lg text-xs font-bold text-amber-800 outline-none focus:ring-1 focus:ring-amber-400" min="0" value="10" required>
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
  }

  function exportScheduleData() {
    const jsonText = JSON.stringify({ students, schedules, teachers }, null, 2);

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

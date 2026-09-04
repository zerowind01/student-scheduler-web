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

  let students = [];
  let schedules = [];
  let teachers = [];
  let selectedTeacherFilter = 'all';
  let mobileStartDate = getMonday(new Date()); // 默认从本周一开启 3 日日历

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

  // Upstash Serverless Redis 实时云端存储 (100% 全球持久化 + CORS 支持)
  const UPSTASH_REST_URL = 'https://coherent-possum-31725.upstash.io';
  const UPSTASH_REST_TOKEN = 'AXutACQgM2YxNWYzMzEtYjM0NC00YzM0LTk5MzktZTM1OGExN2I3YzA1';

  let schoolSyncKey = localStorage.getItem('edu_scheduler_school_key') || 'school_demo_2026';
  let isCloudSyncing = false;

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
      await fetch(UPSTASH_REST_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${UPSTASH_REST_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(['SET', schoolSyncKey, valStr])
      });
    } catch (err) {
      console.warn('Cloud sync push:', err);
    } finally {
      isCloudSyncing = false;
    }
  }

  async function pullFromCloudSync(force = false) {
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
          if (force || remoteData.updatedAt > localTime) {
            isCloudSyncing = true;
            students = remoteData.students || students;
            schedules = remoteData.schedules || schedules;
            teachers = remoteData.teachers || teachers;

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
  }

  function initMobileApp() {
    loadData();
    setupMobileEvents();
    renderMobileTeacherSelect();
    renderMobile3DayView();
    renderMobileStudents();
    // 手机端启动时强制优先从云端拉取已存在的课表，覆盖本地初始状态
    pullFromCloudSync(true);
  }

  function safeBind(id, eventName, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(eventName, handler);
  }

  function setupMobileEvents() {
    safeBind('btnMobileCloudSync', 'click', () => {
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
        showToast(`已开启云同步！同步码: ${val}`);
      });
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
      mobileStartDate = getMonday(new Date());
      renderMobile3DayView();
    });

    safeBind('mobileTeacherSelect', 'change', (e) => {
      selectedTeacherFilter = e.target.value;
      renderMobile3DayView();
    });

    safeBind('navTabSchedule', 'click', () => {
      const sView = document.getElementById('viewSchedule');
      const stView = document.getElementById('viewStudents');
      if (sView) sView.classList.remove('hidden');
      if (stView) stView.classList.add('hidden');

      const tab1 = document.getElementById('navTabSchedule');
      const tab2 = document.getElementById('navTabStudents');
      if (tab1) {
        tab1.classList.add('text-amber-600', 'font-bold');
        tab1.classList.remove('text-slate-400', 'font-medium');
      }
      if (tab2) {
        tab2.classList.remove('text-amber-600', 'font-bold');
        tab2.classList.add('text-slate-400', 'font-medium');
      }
    });

    safeBind('navTabStudents', 'click', () => {
      const sView = document.getElementById('viewSchedule');
      const stView = document.getElementById('viewStudents');
      if (stView) stView.classList.remove('hidden');
      if (sView) sView.classList.add('hidden');

      const tab1 = document.getElementById('navTabSchedule');
      const tab2 = document.getElementById('navTabStudents');
      if (tab2) {
        tab2.classList.add('text-amber-600', 'font-bold');
        tab2.classList.remove('text-slate-400', 'font-medium');
      }
      if (tab1) {
        tab1.classList.remove('text-amber-600', 'font-bold');
        tab1.classList.add('text-slate-400', 'font-medium');
      }
      renderMobileStudents();
    });

    safeBind('navTabQuickAdd', 'click', () => {
      openMobileScheduleModalForNew();
    });

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

    card.innerHTML = `
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
      openMobileScheduleModalForEdit(schedule);
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
      container.innerHTML = `<div class="text-center py-10 text-slate-400 text-xs">暂无学员记录</div>`;
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
        <button class="btn-schedule-mobile px-3 py-1.5 bg-amber-500 text-white font-bold text-xs rounded-xl shadow-xs shrink-0">
          排课
        </button>
      `;

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

  document.addEventListener('DOMContentLoaded', initMobileApp);
})();

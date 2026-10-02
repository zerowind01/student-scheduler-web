// Cloudflare Pages Function — ICS 日历订阅（iPhone/iPad 原生日历提醒）
// GET /api/ics?key=<同步码>&teacher=<teacherId 或老师姓名>
// 返回该老师名下全部课程的 VCALENDAR；手机日历订阅后可设"提前15分钟提醒"一次生效
// 取数逻辑与 sync.js 一致：有 UPSTASH 环境变量时直连，否则回退代理到 Netlify

const NETLIFY_UPSTREAM = 'https://lesson-mate.netlify.app/.netlify/functions/sync';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
}

async function fetchSchoolData(key, env) {
  const url = env.UPSTASH_REST_URL;
  const token = env.UPSTASH_REST_TOKEN;
  let raw = null;

  if (url && token) {
    const res = await fetch(`${url.replace(/\/+$/, '')}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const j = await res.json();
      raw = j && j.result ? j.result : null;
      if (raw && typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch (e) { /* 保持原样 */ }
      }
    }
  } else {
    // 阶段一回退：转发 Netlify 同名函数
    const res = await fetch(`${NETLIFY_UPSTREAM}?key=${encodeURIComponent(key)}`);
    if (res.ok) raw = await res.json();
  }

  return raw && typeof raw === 'object' ? raw : { schedules: [], students: [], teachers: [] };
}

// ---- ICS 工具 ----

function icsEscape(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// 数据里的时间均为东八区本地时间；转成 UTC 输出（DTSTART:...Z），手机按本地时区正确显示
function lessonStartMs(dateStr, timeStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [hh, mm] = String(timeStr || '00:00').split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh || 0, mm || 0) - 8 * 3600 * 1000;
}

function toIcsUtc(ms) {
  const dt = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${dt.getUTCFullYear()}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())}T${p(dt.getUTCHours())}${p(dt.getUTCMinutes())}00Z`;
}

function foldLine(line) {
  // RFC5545：单行不超过 75 字节，超出用 CRLF+空格 折行
  const out = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of line) {
    const b = ch.charCodeAt(0) > 127 ? 3 : 1; // UTF-8 中文按 3 字节估
    if (curBytes + b > 73) {
      out.push(cur);
      cur = ' ' + ch;
      curBytes = 1 + b;
    } else {
      cur += ch;
      curBytes += b;
    }
  }
  out.push(cur);
  return out.join('\r\n');
}

function buildIcs(data, teacherLabel) {
  const schedules = Array.isArray(data.schedules) ? data.schedules : [];
  const students = Array.isArray(data.students) ? data.students : [];
  const studentById = {};
  students.forEach((s) => { if (s && s.id) studentById[s.id] = s; });

  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const dtStamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;

  // 只保留有意义的时间窗：过去 60 天 ～ 未来 180 天
  const minDate = new Date(now.getTime() - 60 * 86400000).toISOString().slice(0, 10);
  const maxDate = new Date(now.getTime() + 180 * 86400000).toISOString().slice(0, 10);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//LessonMate//Teacher Calendar//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(`LessonMate · ${teacherLabel}`)}`,
    'X-WR-TIMEZONE:Asia/Shanghai',
    'REFRESH-INTERVAL;VALUE=DURATION:PT2H',
    'X-PUBLISHED-TTL:PT2H',
  ];

  schedules.forEach((s, i) => {
    if (!s || !s.date || s.date < minDate || s.date > maxDate) return;
    // 白名单：只有排课中和已完成（透明占位）进日历；请假/取消等一切其他状态一律不计入
    if (s.status !== 'scheduled' && s.status !== 'completed') return;
    if (!s.teacherId && !s.assistantTeacherId && !s.teacherName) return;

    const studentName =
      s.studentName || (studentById[s.studentId] ? studentById[s.studentId].name : '学员');
    const subject = s.subject || s.courseName || '课程';
    const teacherName = s.teacherName || '';
    const dur = Number(s.durationMinutes) > 0 ? Number(s.durationMinutes) : 45;

    const startMs = lessonStartMs(s.date, s.startTime);
    const dtStart = toIcsUtc(startMs);
    const dtEnd = toIcsUtc(startMs + dur * 60000);

    const completed = s.status === 'completed';

    lines.push(
      'BEGIN:VEVENT',
      `UID:${icsEscape(s.id || `sc_${i}_${s.date}`)}@lesson-mate.pages.dev`,
      `DTSTAMP:${dtStamp}`,
      `DTSTART:${dtStart}`,
      `DTEND:${dtEnd}`,
      `SUMMARY:${icsEscape(`${subject} · ${studentName}`)}`,
      teacherName ? `DESCRIPTION:${icsEscape(`老师：${teacherName}`)}` : null,
      completed ? 'TRANSP:TRANSPARENT' : 'TRANSP:OPAQUE',
      completed ? null : 'BEGIN:VALARM',
      completed ? null : 'TRIGGER:-PT15M',
      completed ? null : 'ACTION:DISPLAY',
      completed ? null : `DESCRIPTION:${icsEscape(`15分钟后上课：${subject} · ${studentName}`)}`,
      completed ? null : 'END:VALARM',
      'END:VEVENT'
    );
  });

  lines.push('END:VCALENDAR');

  return lines
    .filter((l) => l !== null)
    .map(foldLine)
    .join('\r\n') + '\r\n';
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: corsHeaders() });
  }

  try {
    const incoming = new URL(request.url);
    const key = incoming.searchParams.get('key');
    const teacher = (incoming.searchParams.get('teacher') || '').trim();

    if (!key) {
      return new Response('missing ?key= (同步码)', { status: 400, headers: corsHeaders() });
    }
    if (!teacher) {
      return new Response(
        'missing ?teacher= (老师ID或姓名)。示例：/api/ics?key=xxx&teacher=t1',
        { status: 400, headers: corsHeaders() }
      );
    }

    const data = await fetchSchoolData(key, env);

    // 按老师过滤：teacherId / assistantTeacherId / teacherName 三种匹配
    const match = (s) =>
      s.teacherId === teacher ||
      s.assistantTeacherId === teacher ||
      (s.teacherName || '') === teacher;

    const filtered = {
      ...data,
      schedules: (data.schedules || []).filter(match),
    };

    // 老师显示名：优先用 teachers 列表里的名字，否则用传入值
    let teacherLabel = teacher;
    if (Array.isArray(data.teachers)) {
      const t = data.teachers.find((x) => x && (x.id === teacher || x.name === teacher));
      if (t && t.name) teacherLabel = t.name;
    }

    const ics = buildIcs(filtered, teacherLabel);

    return new Response(ics, {
      status: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'text/calendar; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }
}

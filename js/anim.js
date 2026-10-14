/* ==========================================================================
   排课工作台 · 动效层
   分工（单一系统，避免两套东西争同一属性）：
   - 常驻 HTML + .hidden 显隐的弹窗（.modal-box）/ Toast / 侧栏滑块
     → CSS 过渡与 @starting-style（不依赖 GSAP CDN）
   - 运行时 appendChild 出来的浮层（第 5 节上滑操作菜单）→ 本文件（GSAP）
   - 数字滚动 / 翻周翻月方向感 / 课卡错峰进场 / 就地回闪 → 本文件（GSAP）
   禁止：滚动视差、循环动画、GSAP 粒子类效果
   全部遵守 prefers-reduced-motion（tokens.css 有 CSS 兜底，本文件有 RM 兜底）
   ========================================================================== */

/* ---- 0. 环境探测（每次调用时探测，不缓存） ----
   hasGSAP 以前只在加载时取一次：GSAP 走 CDN 时若晚于本文件到达（或加载失败后由
   兜底脚本补加载），整个会话的动效就永久失效。改成调用时才读 window.gsap，
   晚到的也能用上。
   RM 同理——系统开关是可以在会话中途改的，加监听实时跟随。 */
const rmQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
let RM = rmQuery.matches;
if (rmQuery.addEventListener) {
  rmQuery.addEventListener('change', (e) => { RM = e.matches; });
}

function uiAnimate(fn) {
  if (RM) return;
  const g = window.gsap;
  if (!g) return; // GSAP 未就绪 → 静态（功能不受影响）
  fn(g);
}

/* 游离 tween 回收：列表每次保存/云同步都会整个重建 DOM，
   上一次的 tween 还挂在已被替换掉的节点上继续跑。
   这里按「一批」记录，下一批开始时先 kill 掉上一批。 */
let trackedTweens = [];
function trackTween(t) {
  if (t) trackedTweens.push(t);
  if (trackedTweens.length > 24) trackedTweens = trackedTweens.slice(-12);
  return t;
}
function killTrackedTweens() {
  for (const t of trackedTweens) {
    try { t.kill(); } catch (_) { /* 已结束或目标已卸载 */ }
  }
  trackedTweens = [];
}

/* ---- 1. 弹窗 / Toast：交给 CSS 单一系统（详见 styles.css 第 7 节）----
   曾经这里用 GSAP 驱动弹窗与 Toast，但：
   - 弹窗：CSS 里 `div:not(.hidden) > .modal-box { transform/opacity !important }`
     会压过 GSAP 的内联样式，等于整段动画空跑（手机抽屉因此完全没有上滑）；
   - Toast：元素自带 Tailwind `transition-all`，GSAP 逐帧写 transform 会被二次插值拖慢。
   两套系统争同一属性本身就是缺陷，所以这里不再提供 modal/toast 动画：
   弹窗用 @starting-style 进场 + .lm-modal-closing 退场，Toast 用 CSS 过渡。
   保留的好处是不依赖 GSAP CDN —— CDN 加载失败时弹窗也不会变成透明看不见。 */

/* ---- 1. 课时数字滚动 ----
   消课/充值/撤销后调用：数字从旧值滚到新值
   用法：animateNumber(el, oldValue, newValue, decimals, suffix)
   suffix 用于带单位的统计（「 节」「 小时」），避免滚动过程中单位丢失 */
/* 同一元素上只允许一个滚动 tween：消课→撤销来回点会并发两个 tween 同时写
   textContent，数字会来回抽。用 WeakMap 记住上一个，开新的前先 kill。 */
const numberTweens = new WeakMap();

function animateNumber(el, from, to, decimals = 0, suffix = '') {
  const render = (v) => {
    if (el) el.textContent = (decimals ? v.toFixed(decimals) : Math.round(v)) + suffix;
  };
  if (!el) return;
  const prev = numberTweens.get(el);
  if (prev) { try { prev.kill(); } catch (_) {} numberTweens.delete(el); }
  if (RM) { render(to); return; }
  const g = window.gsap;
  if (!g) { render(to); return; }
  const obj = { v: from };
  numberTweens.set(el, g.to(obj, {
    v: to,
    duration: 0.5,
    ease: 'power2.out',
    onUpdate: () => render(obj.v),
    onComplete: () => numberTweens.delete(el),
  }));
}

/* ---- 2. 翻周 / 翻月方向感 ----
   只在这里用：底部 tab 切换不做整页淡入（高频操作）。
   dirX：-1 上一周（内容从左侧进）、1 下一周（从右侧进）；不传则只做纵向 rise。 */
function animateViewIn(viewEl, dirX = 0) {
  if (!viewEl) return;
  uiAnimate((gsap) => {
    // 视图容器是常驻节点：不 kill 旧 tween 的话，连点翻周会叠加多个 tween 互相抢同一属性
    gsap.killTweensOf(viewEl);
    gsap.fromTo(viewEl,
      { opacity: 0, y: dirX ? 0 : 8, x: dirX ? 22 * dirX : 0 },
      { opacity: 1, y: 0, x: 0, duration: 0.22, ease: 'power2.out', clearProps: 'opacity,transform' }
    );
  });
}

/* ---- 3. 日历课卡批量进场（周视图 / 月视图 / 3日视图渲染后） ----
   每次保存都会重渲染，所以 stagger 必须收着：数量一多就整体淡入，
   且步长压到 22ms —— 最多 12 张时尾随也只有 264ms，不会拖尾。 */
const MAX_STAGGER = 12;

function animateCardsStagger(containerEl, cardSelector = '.schedule-event-card') {
  if (!containerEl) return;
  uiAnimate((gsap) => {
    const cards = containerEl.querySelectorAll(cardSelector);
    if (!cards.length) return;
    // 上一批卡片已被本次渲染替换掉，先把挂在它们身上的 tween 收掉再起新的
    killTrackedTweens();
    if (cards.length > MAX_STAGGER) {
      trackTween(gsap.fromTo(cards,
        { opacity: 0, y: 6 },
        { opacity: 1, y: 0, duration: 0.16, ease: 'power2.out', clearProps: 'opacity,transform' }
      ));
      return;
    }
    trackTween(gsap.fromTo(cards,
      { opacity: 0, y: 8 },
      { opacity: 1, y: 0, duration: 0.2, stagger: 0.022, ease: 'power2.out', clearProps: 'opacity,transform' }
    ));
  });
}

/* ---- 4. 就地高亮回闪（保存 / 消课 / 撤销后） ----
   目的：让「我刚才改的是哪一节」有落点，光靠 Toast 用户找不到目标。
   CSS 动画实现（styles.css 的 .lm-flash），GSAP 挂了也不影响。
   flashSchedule(id) 直接按 data-schedule-id 定位课卡，双端通用。 */
function flash(el) {
  if (!el) return;
  if (RM) return; // 用户要求减少动效 → 不做回闪
  el.classList.remove('lm-flash');
  void el.offsetWidth; // 强制重排，保证连续触发时动画能重放
  el.classList.add('lm-flash');
  const clear = () => el.classList.remove('lm-flash');
  el.addEventListener('animationend', clear, { once: true });
  setTimeout(clear, 900); // 兜底清理
}

function flashSchedule(scheduleId) {
  if (!scheduleId || RM) return;
  const apply = () => {
    const el = document.querySelector(`[data-schedule-id="${scheduleId}"]`);
    if (!el) return false;
    flash(el);
    return true;
  };

  if (!apply()) {
    // 目标不在当前视图（如切了周/月）：下一次渲染后补闪一次
    document.addEventListener('lm:rendered', function once() {
      document.removeEventListener('lm:rendered', once);
      apply();
    }, { once: true });
    return;
  }

  // 已闪过一次，但实践中消课/保存后常会紧跟着再渲染一遍（卡片被重建 → class 丢失）。
  // 短窗口内若发生重渲染，对新卡片补闪一次，保证用户看得到。
  const reflash = () => {
    document.removeEventListener('lm:rendered', reflash);
    apply();
  };
  document.addEventListener('lm:rendered', reflash, { once: true });
  setTimeout(() => document.removeEventListener('lm:rendered', reflash), 400);
}

/* ---- 4.5 侧栏清单进场（月视图「选中日安排」这类随点击整块换内容的面板）----
   场景：点日历格子 → 右栏/下方清单整块重建。属于「点击后大块区域瞬换」，
   没有过渡时用户会丢失「这份清单是从我点的那格来的」这条空间线索。
   只做一次很轻的淡入 + 上浮，绝不拖长。容器是常驻节点，连点格子必须能被打断重放，
   所以每次都 killTweensOf 再起新的（和 animateViewIn 同一个理由）。
   注意：**不要在拖动 / 手势进行中调用** —— 会搅乱跟手的几何补间。 */
function animateListIn(el) {
  if (!el) return;
  uiAnimate((gsap) => {
    gsap.killTweensOf(el);
    gsap.fromTo(el,
      { opacity: 0, y: 6 },
      { opacity: 1, y: 0, duration: 0.18, ease: 'power2.out', clearProps: 'opacity,transform' }
    );
  });
}

/* ---- 5. 上滑弹层（运行时动态创建的底部操作菜单）----
   归属说明（别和第 1 节搞混）：
   - styles.css 第 7 节那套 CSS 系统管的是「常驻在 HTML 里、靠 .hidden 显隐」的
     .modal-box —— 它带 !important 终态，GSAP 写进去会被压掉，两者不可混用；
   - 本节只服务另一种浮层：运行时 document.body.appendChild 出来、不挂 .modal-box 的。
     它们以前是「凭空出现、凭空消失」—— 节点直接被 remove 掉，CSS 连过渡窗口都没有。
   这里把进场与退场一起接管，保证「上滑进来 = 下滑出去」对称，动画跑完才摘节点。
   RM / GSAP 缺失 → 直接落到终态（功能不受影响，只是没有过渡）。

   注意：这两个补间**不进 trackTween**。弹层是自我管理生命周期的节点，而
   killTrackedTweens 是给「会被整体重建的列表节点」用的；把弹层补间并进去，
   列表一重渲染就会连进场动画一起掐掉（补间停在 yPercent:100 上 = 面板消失）。 */

/* 进场 0.34s / 退场 0.20s —— 刻意非对称：进场是「落定」，退场是「让开」。
   行程约 420px（4~6 个动作按钮），power3.out 让前 150ms 就走掉 2/3，
   所以 340ms 的进场属于抽屉/模态的合理区间，不需要再砍。
   退场必须比进场快，且**不能用 ease-in**（见 sheetOut 里的实测注释）。 */
const SHEET_ENTER_S = 0.34;
const SHEET_EXIT_S = 0.20;

// 遮罩：约定的子节点 [data-sheet-backdrop]；找不到就只动面板（不报错）
function sheetBackdrop(overlay, panel) {
  const bd = overlay && overlay.querySelector('[data-sheet-backdrop]');
  return bd && bd !== panel ? bd : null;
}

/* 进场：面板从屏幕下沿整块滑上来 + 遮罩淡入；opts.items 命中的子项再轻微错峰。
   起始态只在有 GSAP 时用 gsap.set 写内联 —— 万一 GSAP 没就绪，元素保持自然态，
   不会出现「面板停在屏幕外」的失败模式（这点和 CSS 的 @starting-style 同思路）。 */
function sheetIn(overlay, panel, opts) {
  if (!overlay || !panel) return;
  uiAnimate((gsap) => {
    const bd = sheetBackdrop(overlay, panel);
    gsap.set(panel, { yPercent: 100 });
    if (bd) gsap.set(bd, { opacity: 0 });

    const tl = gsap.timeline();
    if (bd) tl.to(bd, { opacity: 1, duration: 0.18, ease: 'power2.out' }, 0);
    // 终态用 clearProps 把内联 transform 摘掉，交回 CSS（面板将来还要被其它逻辑复用）
    tl.to(panel, { yPercent: 0, duration: SHEET_ENTER_S, ease: 'power3.out', clearProps: 'transform' }, 0);

    const sel = opts && opts.items;
    if (sel) {
      const items = panel.querySelectorAll(sel);
      if (items.length) {
        // 错峰必须收在面板「落定」之前，否则会出现「面板停了、按钮还在往下飘」的尾巴。
        // 6 个按钮：50 + 5*22 + 200 = 360ms ≈ 面板 340ms 落地。
        // 按钮很多时（编辑类长菜单）把步长再压一半，避免整条菜单的进场被拉长。
        const stagger = items.length > 8 ? 0.012 : 0.022;
        tl.fromTo(items,
          { y: 10, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.2, stagger, ease: 'power2.out', clearProps: 'transform,opacity' },
          0.05
        );
      }
    }
  });
}

/* 退场：面板滑下去 + 遮罩淡出；动画结束才回调 done（调用方在 done 里 remove 节点）。
   幂等：连点遮罩 / 按钮只会跑一次（overlay.dataset.lmSheetClosing 当闩）。 */
function sheetOut(overlay, panel, done) {
  const finish = () => { if (done) done(); };
  if (!overlay || !panel) { finish(); return; }
  if (overlay.dataset.lmSheetClosing === '1') return;
  overlay.dataset.lmSheetClosing = '1';

  const g = window.gsap;
  if (RM || !g) { finish(); return; }   // 无 GSAP / 减少动效 → 直接摘节点

  const bd = sheetBackdrop(overlay, panel);
  // 进场可能还在跑：先把子项恢复到自然态，否则退场那 220ms 里会看到半透明的按钮
  const items = panel.querySelectorAll('[data-act]');
  if (items.length) g.set(items, { clearProps: 'opacity,transform' });
  g.killTweensOf(panel);
  if (bd) g.killTweensOf(bd);

  let called = false;
  const once = () => { if (called) return; called = true; finish(); };
  const tl = g.timeline({ onComplete: once, onInterrupt: once });
  /* 退场曲线必须是 ease-out 家族 —— 退出时用户盯的就是「第一帧有没有动」。
     实测（面板高 420px、退场 220ms）：power1.in 前 70ms 只走 134px（32%），
     power2.out 走 225px（54%）。用 ease-in 会让面板先「黏半拍」再走，
     手感就是卡顿；这里同时把时长收到 0.20s，退场比进场快是刻意的非对称。 */
  if (bd) tl.to(bd, { opacity: 0, duration: SHEET_EXIT_S, ease: 'power2.out' }, 0);
  tl.to(panel, { yPercent: 100, duration: SHEET_EXIT_S, ease: 'power2.out' }, 0);
  // 兜底：补间若被外部 kill 掉，done 也得放出去，否则节点永远摘不掉
  setTimeout(once, (SHEET_EXIT_S + 0.15) * 1000);
}

/* ==========================================================================
   6. 按钮异步三态：idle → loading → done（配套 styles.css 第 17 节）
   典型调用：消课按钮。work() 是同步的（本地处理），所以必须给 spinner
   一个最短展示时长 —— 否则一闪而过，用户会以为按钮坏了而不是成功了。

   work():   立即执行，返回 true 表示成功、false 表示被业务拦截（已消课/请假等）
   onDone(): 成功态停留结束后回调，通常用来重渲染列表
   ========================================================================== */
const MIN_SPINNER_MS = 420;  // spinner 至少转 2/3 圈
const DONE_HOLD_MS = 800;    // 勾描完 320ms，再停一拍供眼部确认

/* 渲染闸门：动画进行中，列表重渲染要绕开按钮所在的行。
   现实里重渲染的来源很多（云同步轮询、BroadcastChannel、撤销……），
   只要有一路在动画途中重建 DOM，按钮节点被换掉，三段动效就整个消失。
   这里用一个计数对外开放，由渲染方（renderDashboard）主动避让。 */
let busyCount = 0;

function runAsyncButton(btn, work, onDone) {
  if (!btn || btn.dataset.lmBusy === '1') return;
  btn.dataset.lmBusy = '1';
  busyCount++;
  btn.setAttribute('aria-busy', 'true');
  btn.classList.add('is-loading');

  const t0 = Date.now();
  let ok = false;
  try {
    ok = work() === true;
  } catch (err) {
    console.error('[uiAnim.runAsyncButton]', err);
    ok = false;
  }

  const finish = () => {
    btn.removeAttribute('aria-busy');
    btn.dataset.lmBusy = '';
    busyCount = Math.max(0, busyCount - 1);
  };

  const wait = Math.max(0, MIN_SPINNER_MS - (Date.now() - t0));
  setTimeout(() => {
    if (!ok) {
      // 被拦截：静默回到初态，原因已经由各自的 Toast 说明了
      btn.classList.remove('is-loading');
      finish();
      return;
    }
    btn.classList.remove('is-loading');
    btn.classList.add('is-done');
    setTimeout(() => {
      // 顺序：先放开渲染闸门 → 再让业务重渲染 → 最后才复位按钮。
      // 若先摘 is-done，按钮会在爬回原色的 240ms 里被看见，出现「绿了又变黑」的反向淡出。
      busyCount = Math.max(0, busyCount - 1);
      if (onDone) onDone();
      // 若业务方并没有重渲染（按钮还挂在文档里），才把它复位回初态。
      if (document.body.contains(btn)) {
        btn.classList.remove('is-done');
        btn.removeAttribute('aria-busy');
        btn.dataset.lmBusy = '';
        return;
      }
      // 节点已被替换，无需再复位
      btn.removeAttribute('aria-busy');
      btn.dataset.lmBusy = '';
    }, DONE_HOLD_MS);
  }, wait);
}

/* 渲染完成事件：供 flashSchedule 延迟补偿，也方便以后挂别的渲染后逻辑 */
function emitRendered() {
  document.dispatchEvent(new CustomEvent('lm:rendered'));
}

/* 挂到 window 供 app.js / mobile.js 调用 */
window.uiAnim = {
  number: animateNumber,
  viewIn: animateViewIn,
  listIn: animateListIn,
  cardsStagger: animateCardsStagger,
  flash: flash,
  flashSchedule: flashSchedule,
  runAsyncButton: runAsyncButton,
  // 动态创建的底部浮层（不挂 .modal-box 的那些）：上滑进场 / 下滑退场
  sheetIn: sheetIn,
  sheetOut: sheetOut,
  isBusy: () => busyCount > 0,
  emitRendered: emitRendered,
  // 供调用方自行判断是否需要"直落终态"（如手机端日历的手势跟手动画）：
  // RM 是实时值，系统偏好中途改也能立刻跟上。
  reduceMotion: () => RM,
};

/* ==========================================================================
   排课工作台 · GSAP 动效层（Step 4）
   三类动效，全部 motivated：
   1. 进场    — 弹窗 fade + slide-up（220ms，--ease-out）
   2. 反馈    — Toast 弹入 + 课时数字滚动
   3. 状态变化 — 日历课卡状态色条宽度过渡
   禁止：滚动视差、循环动画、GSAP 粒子类效果
   全部遵守 prefers-reduced-motion（tokens.css 已有 CSS 兜底）
   ========================================================================== */

/* ---- 0. 环境探测（一次性，能力探测模式） ---- */
const RM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const hasGSAP = typeof window.gsap !== 'undefined';

/* 统一入口：环境不满足时全部退化为即时状态切换 */
function uiAnimate(fn) {
  if (RM || !hasGSAP) return; // reduced-motion 或 GSAP 未加载 → 静态
  fn(window.gsap);
}

/* ---- 1. 弹窗进场 / 退场 ----
   目标元素结构（两端一致）：
   .modal-overlay（遮罩） > .modal-box（内容壳）
   用法：showModal/hideModal 里在 class 切换后调用 */
function animateModalIn(boxEl, overlayEl) {
  uiAnimate((gsap) => {
    if (overlayEl) gsap.fromTo(overlayEl, { opacity: 0 }, { opacity: 1, duration: 0.18, ease: 'power2.out' });
    if (boxEl) gsap.fromTo(boxEl,
      { opacity: 0, y: 24, scale: 0.98 },
      { opacity: 1, y: 0, scale: 1, duration: 0.28, ease: 'power3.out' }
    );
  });
}

function animateModalOut(boxEl, overlayEl, done) {
  if (RM || !hasGSAP) { if (done) done(); return; }
  if (!hasGSAP) { if (done) done(); return; }
  const gsap = window.gsap;
  const tl = gsap.timeline({ onComplete: done });
  if (boxEl) tl.to(boxEl, { opacity: 0, y: 16, scale: 0.98, duration: 0.18, ease: 'power2.in' }, 0);
  if (overlayEl) tl.to(overlayEl, { opacity: 0, duration: 0.18, ease: 'power2.in' }, 0);
  if (!boxEl && !overlayEl) { if (done) done(); }
}

/* ---- 2. Toast 弹入 ----
   showToast 渲染后调用：从底部弹入，1.2s 后由原逻辑移除 */
function animateToastIn(el) {
  uiAnimate((gsap) => {
    gsap.fromTo(el,
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.3, ease: 'back.out(1.6)' }
    );
  });
}

/* ---- 3. 课时数字滚动 ----
   消课/充值/撤销后调用：数字从旧值滚到新值
   用法：animateNumber(el, oldValue, newValue, decimals, suffix)
   suffix 用于带单位的统计（「 节」「 小时」），避免滚动过程中单位丢失 */
function animateNumber(el, from, to, decimals = 0, suffix = '') {
  const render = (v) => {
    if (el) el.textContent = (decimals ? v.toFixed(decimals) : Math.round(v)) + suffix;
  };
  if (RM || !hasGSAP || !el) { render(to); return; }
  const obj = { v: from };
  window.gsap.to(obj, {
    v: to,
    duration: 0.5,
    ease: 'power2.out',
    onUpdate: () => render(obj.v),
  });
}

/* ---- 4. 页面/视图切换 ----
   tab 切换时对新视图做轻量 fade+rise
   dirX：翻周时的方向感，-1 上一周（内容从左侧进）、1 下一周（从右侧进）；
   不传则只做纵向 rise（分页切换场景） */
function animateViewIn(viewEl, dirX = 0) {
  uiAnimate((gsap) => {
    gsap.fromTo(viewEl,
      { opacity: 0, y: dirX ? 0 : 10, x: dirX ? 26 * dirX : 0 },
      { opacity: 1, y: 0, x: 0, duration: 0.26, ease: 'power2.out', clearProps: 'all' }
    );
  });
}

/* ---- 5. 日历课卡批量进场（周视图 / 月视图 / 3日视图渲染后） ----
   限流很重要：课表每次保存都会重渲染，长列表若逐个 stagger 会拖沓。
   规则：超过 MAX_STAGGER 个就整体淡入；数量越多 stagger 步长越小。 */
const MAX_STAGGER = 24;

function animateCardsStagger(containerEl, cardSelector = '.schedule-event-card') {
  if (!containerEl) return;
  uiAnimate((gsap) => {
    const cards = containerEl.querySelectorAll(cardSelector);
    if (!cards.length) return;
    if (cards.length > MAX_STAGGER) {
      gsap.fromTo(cards,
        { opacity: 0, y: 6 },
        { opacity: 1, y: 0, duration: 0.22, ease: 'power2.out', clearProps: 'all' }
      );
      return;
    }
    const step = cards.length > 12 ? 0.018 : 0.03;
    gsap.fromTo(cards,
      { opacity: 0, y: 8 },
      { opacity: 1, y: 0, duration: 0.26, stagger: step, ease: 'power2.out', clearProps: 'all' }
    );
  });
}

/* ---- 6. 学员卡删除/移除退场（可选：列表项飞出） ---- */
function animateCardOut(el, done) {
  if (RM || !hasGSAP) { if (done) done(); return; }
  window.gsap.to(el, {
    opacity: 0, x: 24, duration: 0.2, ease: 'power2.in',
    onComplete: done,
  });
}

/* ---- 7. 就地高亮回闪（保存 / 消课 / 撤销后） ----
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

/* 渲染完成事件：供 flashSchedule 延迟补偿，也方便以后挂别的渲染后逻辑 */
function emitRendered() {
  document.dispatchEvent(new CustomEvent('lm:rendered'));
}

/* 挂到 window 供 app.js / mobile.js 调用 */
window.uiAnim = {
  modalIn: animateModalIn,
  modalOut: animateModalOut,
  toastIn: animateToastIn,
  number: animateNumber,
  viewIn: animateViewIn,
  cardsStagger: animateCardsStagger,
  cardOut: animateCardOut,
  flash: flash,
  flashSchedule: flashSchedule,
  emitRendered: emitRendered,
};

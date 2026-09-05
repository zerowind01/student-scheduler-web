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
   用法：animateNumber(el, oldValue, newValue, decimals) */
function animateNumber(el, from, to, decimals = 0) {
  if (RM || !hasGSAP || !el) {
    if (el) el.textContent = decimals ? to.toFixed(decimals) : Math.round(to);
    return;
  }
  const obj = { v: from };
  window.gsap.to(obj, {
    v: to,
    duration: 0.5,
    ease: 'power2.out',
    onUpdate: () => {
      el.textContent = decimals ? obj.v.toFixed(decimals) : Math.round(obj.v);
    },
  });
}

/* ---- 4. 页面/视图切换 ----
   tab 切换时对新视图做轻量 fade+rise */
function animateViewIn(viewEl) {
  uiAnimate((gsap) => {
    gsap.fromTo(viewEl,
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, duration: 0.24, ease: 'power2.out', clearProps: 'all' }
    );
  });
}

/* ---- 5. 日历课卡批量进场（月视图/3日视图渲染后） ----
   只在首次渲染时轻微 stagger，列表更新频繁时不用 */
function animateCardsStagger(containerEl, cardSelector = '.schedule-event-card') {
  if (!containerEl) return;
  uiAnimate((gsap) => {
    const cards = containerEl.querySelectorAll(cardSelector);
    if (!cards.length) return;
    gsap.fromTo(cards,
      { opacity: 0, y: 8 },
      { opacity: 1, y: 0, duration: 0.26, stagger: 0.03, ease: 'power2.out', clearProps: 'all' }
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

/* 挂到 window 供 app.js / mobile.js 调用 */
window.uiAnim = {
  modalIn: animateModalIn,
  modalOut: animateModalOut,
  toastIn: animateToastIn,
  number: animateNumber,
  viewIn: animateViewIn,
  cardsStagger: animateCardsStagger,
  cardOut: animateCardOut,
};

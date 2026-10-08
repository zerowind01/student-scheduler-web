/* ==========================================================================
   排课工作台 · 动效层
   分工（单一系统，避免两套东西争同一属性）：
   - 弹窗 / Toast / 侧栏滑块 → CSS 过渡与 @starting-style（不依赖 GSAP CDN）
   - 数字滚动 / 翻周翻月方向感 / 课卡错峰进场 / 就地回闪 → 本文件（GSAP）
   禁止：滚动视差、循环动画、GSAP 粒子类效果
   全部遵守 prefers-reduced-motion（tokens.css 有 CSS 兜底，本文件有 RM 兜底）
   ========================================================================== */

/* ---- 0. 环境探测（一次性，能力探测模式） ---- */
const RM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const hasGSAP = typeof window.gsap !== 'undefined';

/* 统一入口：环境不满足时全部退化为即时状态切换 */
function uiAnimate(fn) {
  if (RM || !hasGSAP) return; // reduced-motion 或 GSAP 未加载 → 静态
  fn(window.gsap);
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

/* ---- 2. 翻周 / 翻月方向感 ----
   只在这里用：底部 tab 切换不做整页淡入（高频操作）。
   dirX：-1 上一周（内容从左侧进）、1 下一周（从右侧进）；不传则只做纵向 rise。 */
function animateViewIn(viewEl, dirX = 0) {
  uiAnimate((gsap) => {
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
    if (cards.length > MAX_STAGGER) {
      gsap.fromTo(cards,
        { opacity: 0, y: 6 },
        { opacity: 1, y: 0, duration: 0.16, ease: 'power2.out', clearProps: 'opacity,transform' }
      );
      return;
    }
    gsap.fromTo(cards,
      { opacity: 0, y: 8 },
      { opacity: 1, y: 0, duration: 0.2, stagger: 0.022, ease: 'power2.out', clearProps: 'opacity,transform' }
    );
  });
}

/* ---- 4. 学员卡删除/移除退场（可选：列表项飞出） ---- */
function animateCardOut(el, done) {
  if (RM || !hasGSAP) { if (done) done(); return; }
  window.gsap.to(el, {
    opacity: 0, x: 24, duration: 0.2, ease: 'power2.in',
    onComplete: done,
  });
}

/* ---- 5. 就地高亮回闪（保存 / 消课 / 撤销后） ----
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
  number: animateNumber,
  viewIn: animateViewIn,
  cardsStagger: animateCardsStagger,
  cardOut: animateCardOut,
  flash: flash,
  flashSchedule: flashSchedule,
  emitRendered: emitRendered,
};

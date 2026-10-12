/** @type {import('tailwindcss').Config} */
// 本文件只服务一件事：把 cdn.tailwindcss.com（Play CDN）换成静态 css/tailwind.css。
// ---------------------------------------------------------------------------
// 为什么不继续用 Play CDN：它在页面里挂 MutationObserver，每次 DOM 变更都要重新
// 扫描/生成样式表 —— 本项目所有渲染都是 innerHTML 整块重建，等于每渲染一次就付一次
// 全量样式重算。实测（4x CPU 节流，390×900）冷态单个转场的长帧：
//   周→月 142.6ms → 18.2ms ／ 容器切换 196.7ms → 36.1ms ／ 点日期格(纯重渲染) 106.2ms → 18.1ms
// 详见 tmp/anim-cold-start.mjs 与 tmp/anim-tailwind-ab.mjs。
//
// 改完 JS/HTML 里的 class 之后必须重新生成：
//   npx -y tailwindcss@3.4.17 -c tailwind.config.js -i tools/tailwind-input.css -o css/tailwind.css --minify
// （或直接跑 tools\build-tailwind.cmd）
module.exports = {
  // content 必须覆盖所有会出现 class 字面量的地方：两个 HTML + 全部 JS
  // （JS 里是模板字符串，class 字面量原样写在里面，正则扫得到；
  //  但**不要**写 `text-${size}` 这种前缀拼接式 class —— 扫不到，漏了就会掉样式）
  content: ['./index.html', './mobile.html', './js/**/*.js'],
  theme: { extend: {} },
  // 与 Play CDN 的默认口径对齐：preflight 开、核心插件全开、无前缀、无重要标记
  corePlugins: { preflight: true },
};

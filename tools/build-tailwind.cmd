@echo off
REM 重新生成 css/tailwind.css —— 改完任何 HTML/JS 里的 class 之后必须跑一次。
REM 背景：原来用 cdn.tailwindcss.com（Play CDN），它在运行时挂 MutationObserver，
REM 每次 DOM 变更都重新扫描/生成样式表；本项目所有渲染都是 innerHTML 整块重建，
REM 等于每渲染一次就付一次全量样式重算（实测冷态单个转场长帧 142~197ms → 换成静态样式后 18~36ms）。
REM 生成后请确认 tools\tailwind-input.css 里的 @tailwind 三行没被改，且两个 HTML 里的
REM <link href="css/tailwind.css"> 仍在 </head> 之前（层叠顺序 = Tailwind 最后，与旧 CDN 一致）。
setlocal
cd /d "%~dp0.."
call npx -y tailwindcss@3.4.17 -c tailwind.config.js -i tools/tailwind-input.css -o css/tailwind.css --minify
if errorlevel 1 (echo [FAIL] tailwind 生成失败 & exit /b 1)
echo.
echo [OK] css/tailwind.css 已重新生成，记得同步提升两个 HTML 里的 ?v= 版本号
endlocal

'use strict';
// 离线壳。策略只有一条：**同源 GET 一律网络优先，失败才退缓存**。
//
// 为什么不用 cache-first：这一仓没有构建步骤，js/*.js 与 css/*.css 都是源文件本身被浏览器
// 直接执行。把"手工写死的 VERSION 号 + 缓存优先"压在这套结构上，等于把 js/css 永久钉在
// 第一次缓存的那一版——HTML 更新了、Service Worker 还端出旧模块，玩家看到的是"新界面配旧
// 规则"的鬼状态，而且光靠改 VERSION 修不好（老 SW 还在控制页面）。网络优先的代价只是断网时
// 少一次即时命中，而那正是缓存该出场的唯一时刻。
const VERSION = 'fleet-v1';
const SHELL = [
  './',
  'index.html',
  'css/game.css',
  'manifest.webmanifest',
  'js/main.js',
  'js/view.js',
  'js/pwa.js',
  'js/core/board.js',
  'js/core/enumerate.js',
  'js/core/game.js',
  'js/core/library.js',
  'js/core/make.js',
  'js/core/rules.js',
  'js/core/rng.js',
  'js/core/solve.js',
  'js/core/storage.js',
  'js/data/lots.js',
  'assets/textures/chart-paper.png',
  'assets/sprites/hull-plate.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(`${VERSION}-shell`)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(`${VERSION}-`)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (ev) => {
  if (ev.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 跨源的一律不碰：这一仓不出域名（没有 CDN、没有字体、没有第三方脚本），缓存别人的
  // 响应等于替别人承担失效策略。
  if (url.origin !== self.location.origin) return;

  ev.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(`${VERSION}-net`).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => {
        if (hit) return hit;
        // 断网时导航请求要落到缓存的壳上，否则离线打开是一片白。
        if (req.mode === 'navigate') {
          return caches.match('index.html').then((shell) => shell || Response.error());
        }
        return Response.error();
      })),
  );
});

'use strict';
// 离线可用 + 永不被旧缓存钉住。
//
// 两条实测换来的口径：
//   1) 一律 **网络优先**，命中网络才回填缓存。手工 VERSION + cache-first 的组合，
//      发出去的 HTML 会配上上一版的 js/css，出一个"新界面配旧逻辑"的鬼状态，
//      而且玩家自己无法恢复（只能等缓存过期）。
//   2) 缓存名带版本号（activate 时清掉非本版的名字）。改版**不需要**同步 bump：
//      同名文件重绘之后，网络优先这一条保证客户端下一次联网就拿到新字节。
const VERSION = 'fleet-cos-v1';
const CACHE = `${VERSION}-shell`;
// 离线壳：界面 + 引擎 + 样式 + 运行时真读的位图，逐条列全。
// 之前只有 index.html 与 manifest 两件，断网时界面能开但引擎与纹理全缺 ——
// 半截壳比白屏更难认（画布空着、按钮点了没反应）。
// 清单里每一条都必须真的在盘上（闸逐条核），所以加文件要先改这一行。
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/game.css',
  'css/studio.css',
  'js/main.js',
  'js/sw-register.js',
  'js/haptics.js',
  'js/audio.js',
  'js/view.js',
  'js/pwa.js',
  'js/core/board.js',
  'js/core/enumerate.js',
  'js/core/game.js',
  'js/core/library.js',
  'js/core/make.js',
  'js/core/rng.js',
  'js/core/rules.js',
  'js/core/solve.js',
  'js/core/storage.js',
  'js/data/lots.js',
  'assets/textures/chart-paper.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-1024.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
  'icons/favicon-16.png',
];

self.addEventListener('install', (ev) => {
  // 逐条抓：一条 404 不该把整壳作废（addAll 是全有全无的）。
  // 这条与存档那边同一条规矩——坏一条只丢那一条。
  ev.waitUntil(
    caches
      .open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  ev.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        // 导航请求（地址栏/刷新/桌面图标）离线时回落到缓存的那份壳，不白屏。
        if (req.mode === 'navigate') {
          const shell = await caches.match('index.html');
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});

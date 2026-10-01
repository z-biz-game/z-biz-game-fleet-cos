// js/pwa.js + manifest + sw.js, checked from node: no browser, no service worker, just the
// two contracts that actually break in the field.
//
//   1. Registration never throws and never claims success in an environment that cannot host
//      a worker: `file://` (Electron and double-clicking index.html), plain http on a LAN
//      address, a browser without `navigator.serviceWorker`, and a register() that rejects or
//      throws synchronously.
//   2. Everything the manifest and the offline shell promise is on disk. A manifest whose icon
//      404s is not "installable", and a precache list naming a file that no longer exists makes
//      the worker install red — both are caught here rather than by a human reading JSON.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test, run, ok, eq } from '../tools/harness.mjs';
import { pwaSupported, registerSW, SW_URL } from '../js/pwa.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

function pngSize(file) {
  const buf = readFileSync(join(ROOT, file));
  ok(buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    `${file} 不是 PNG 签名`);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), bytes: buf.length };
}

const env = (over = {}) => ({
  location: { protocol: 'https:' },
  navigator: { serviceWorker: { register: () => Promise.resolve({ scope: 'https://x/' }) } },
  isSecureContext: true,
  ...over,
});

// tools/harness.mjs 的 test() 是同步的：异步 fn 返回的 promise 既不 await、reject 也不会
// 记成 FAIL。所以先在顶层把结果取回来变成数据，test() 里只做同步断言。
const attempt = async (fn) => {
  try {
    return { threw: false, value: await fn() };
  } catch (err) {
    return { threw: true, value: String((err && err.message) || err) };
  }
};

const throwingEnv = () => {
  const e = env();
  Object.defineProperty(e.navigator, 'serviceWorker', { get() { throw new TypeError('blocked'); } });
  return e;
};

const R = {
  file: await attempt(() => registerSW(env({ location: { protocol: 'file:' } }))),
  denied: await attempt(() => registerSW(env({
    navigator: { serviceWorker: { register: () => Promise.reject(Object.assign(new Error('nope'), { name: 'SecurityError' })) } },
  }))),
  syncThrow: await attempt(() => registerSW(throwingEnv())),
  ok: await attempt(() => registerSW(env())),
};

test('file:// 不注册、不抛异常', () => {
  const e = env({ location: { protocol: 'file:' } });
  ok(pwaSupported(e) === false, 'file:// 必须判为不支持');
  eq(R.file.threw, false, `注册不该抛：${R.file.value}`);
  eq(R.file.value, { supported: false, registered: false, scope: null, reason: 'file://' });
});

test('没有 serviceWorker 的浏览器判为不支持', () => {
  ok(pwaSupported(env({ navigator: {} })) === false);
  ok(pwaSupported(env({ navigator: undefined })) === false);
});

test('非安全上下文（http://LAN）判为不支持', () => {
  ok(pwaSupported(env({ isSecureContext: false })) === false);
});

test('register() 被拒绝时只记录原因，不抛', () => {
  eq(R.denied.threw, false, `reject 必须被吞掉：${R.denied.value}`);
  eq(R.denied.value.supported, true);
  eq(R.denied.value.registered, false);
  eq(R.denied.value.reason, 'SecurityError');
});

test('取 navigator.serviceWorker 就抛的引擎也不崩', () => {
  eq(R.syncThrow.threw, false, `同步抛必须被吞掉：${R.syncThrow.value}`);
  eq(R.syncThrow.value.registered, false);
  ok(R.syncThrow.value.reason.startsWith('sync:'),
    `reason 应记成 sync:*，实际 ${R.syncThrow.value.reason}`);
});

test('正常环境注册成功并回报 scope', () => {
  eq(R.ok.threw, false);
  eq(R.ok.value.supported, true);
  eq(R.ok.value.registered, true);
  eq(R.ok.value.scope, 'https://x/');
  ok(SW_URL === 'sw.js', '注册路径必须是相对 scope 的 sw.js');
});

test('manifest 的字段是真的', () => {
  const mf = readJSON('manifest.webmanifest');
  ok(mf.name && mf.short_name, 'name/short_name');
  ok(mf.start_url && mf.start_url !== '#', 'start_url 必须可解析');
  eq(mf.display, 'standalone');
  eq(mf.theme_color, '#0f1319');
  ok(Array.isArray(mf.icons) && mf.icons.length >= 2, 'icons 至少两张');
  const big = mf.icons.filter((i) => /^\d{3}x\d{3}$/.test(i.sizes) && Number(i.sizes.split('x')[0]) >= 192);
  ok(big.length >= 2, `≥192 的图标要有 2 张以上，实际 ${big.length}`);
});

test('manifest 指向的图标盘上真有，且是够大的真 PNG', () => {
  const mf = readJSON('manifest.webmanifest');
  for (const icon of mf.icons) {
    ok(existsSync(join(ROOT, icon.src)), `${icon.src} 不在盘上`);
    const [w, h] = icon.sizes.split('x').map(Number);
    const real = pngSize(icon.src);
    eq([real.w, real.h], [w, h], `${icon.src} 的 sizes 与 IHDR 不一致`);
    ok(real.bytes > 200, `${icon.src} 只有 ${real.bytes} 字节，不像真图`);
  }
});

test('离线壳清单里的路径全部存在', () => {
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const list = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  ok(list, '找不到 SHELL 清单');
  const urls = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  ok(urls.length >= 10, `清单只有 ${urls.length} 项，不像覆盖了壳`);
  for (const u of urls) {
    const rel = u.replace(/^\.\//, '').replace(/\/$/, '');
    const p = rel === '' ? 'index.html' : rel;
    ok(existsSync(join(ROOT, p)), `SHELL 里引用了不存在的 ${u}`);
  }
});

test('sw.js 是网络优先，且缓存名带版本', () => {
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  ok(/const VERSION = '[a-z0-9-]+-v\d+'/.test(sw), 'VERSION 要带版本号，activate 才能清旧桶');
  const handler = sw.slice(sw.indexOf("addEventListener('fetch'"));
  const net = handler.indexOf('fetch(req)');
  const cacheFirst = handler.indexOf('caches.match(req)');
  ok(net >= 0 && cacheFirst > net, '必须是先 fetch(req) 再退缓存；反了就是把 js/css 钉死');
  ok(!/caches\.match\(req\)\.then\(\(hit\) => hit \|\| fetch/.test(sw), '不许存在缓存优先分支');
  ok(/req\.method !== 'GET'/.test(handler), '非 GET 必须直接放行');
  ok(/url\.origin !== self\.location\.origin/.test(handler), '跨源请求不许接管');
});

test('index.html 接了清单与唯一的 apple-touch-icon', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  ok(/<link rel="manifest" href="manifest\.webmanifest">/.test(html), '缺 rel=manifest');
  eq((html.match(/rel="apple-touch-icon"/g) || []).length, 1, 'apple-touch-icon 必须唯一');
  ok(/viewport-fit=cover/.test(html), 'env(safe-area-inset-*) 要 viewport-fit=cover 才拿得到值');
});

run();

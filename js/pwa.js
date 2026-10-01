// Service-worker registration, kept out of main.js so the shell stays about the game.
//
// Two environments must not throw here, both of them real:
//   * `file://` — opening index.html straight off disk (Electron does it, people do it).
//     A service worker needs an origin, so registering one either rejects or, in some
//     engines, throws synchronously on the `navigator.serviceWorker` getter itself.
//   * plain http on a LAN address — `serviceWorker` is simply undefined there.
// Neither is a reason to lose the game, so both are reported and skipped.
//
// `window.fleetPwa` is the test surface: tools/playtest.mjs asserts the registration state
// instead of inferring it from "the page still worked".

export const SW_URL = 'sw.js';

export function pwaSupported(env = globalThis) {
  if (env.location && env.location.protocol === 'file:') return false;
  const nav = env.navigator;
  // `in` on undefined throws, and this function's whole contract is that it never does.
  if (!nav || typeof nav !== 'object') return false;
  if (!('serviceWorker' in nav)) return false;
  // Service workers are a secure-context feature: https, 127.0.0.1 and localhost qualify,
  // http://192.168.x.x does not — and registering there fails asynchronously with a message
  // that reads like a bug in this file.
  if (env.isSecureContext === false) return false;
  return true;
}

export function registerSW(env = globalThis, url = SW_URL) {
  const report = { supported: false, registered: false, scope: null, reason: '' };
  try {
    if (!pwaSupported(env)) {
      report.reason = env.location && env.location.protocol === 'file:' ? 'file://' : 'unsupported';
      return Promise.resolve(report);
    }
    report.supported = true;
    return env.navigator.serviceWorker.register(url, { scope: './' })
      .then((reg) => {
        report.registered = true;
        report.scope = reg.scope || null;
        return report;
      })
      .catch((err) => {
        report.reason = String((err && err.name) || err);
        return report;
      });
  } catch (err) {
    // Synchronous throw out of the getter: still not a reason to break the shell.
    report.reason = `sync:${String((err && err.name) || err)}`;
    return Promise.resolve(report);
  }
}

const report = { supported: false, registered: false, scope: null, reason: 'not-attempted' };

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const start = () => registerSW().then((r) => {
    Object.assign(report, r);
    window.fleetPwa = report;
    return r;
  });
  // Registering before the load event competes with the module graph for the same connections;
  // after it, the shell is already on screen.
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
  window.fleetPwa = report;
}

export default report;

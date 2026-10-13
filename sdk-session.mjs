import { Browser, BrowserUse } from '@browser_use/pi';
export function checkSDK(session) {
  if (!(session.runtime?.owned instanceof Set) ||
      typeof session.runtime.terminate !== 'function' || !session.browser?.endpoint) {
    throw new Error('Incompatible Browser Use SDK API: shared-browser isolation requires session.runtime.owned, session.runtime.terminate, and session.browser.endpoint.');
  }
}
export const sessionOptions = {
  model: 'openai/gpt-5.4',
  streamFn() { throw new Error('Nested model calls are disabled; Pi drives this browser directly.'); },
  telemetry: false, highlightActions: true,
  operationTimeoutMs: 15_000, cellTimeoutMs: 30_000, maxOutputChars: 12_000,
};

// This is an accidental-cross-client guard, not a sandbox. Raw CDP remains global.
function installGuards(owned) {
  const allowed = new Set(owned);
  // SDK runtime.owned is the durable client ledger used by release cleanup. Worker
  // IPC messages are consumed by that runtime even when the current cell is reset.
  const recordOwned = targetId => {
    if (typeof process.send === 'function') process.send({ type: 'owned', targetId });
  };
  const originalTabs = tabs;
  const list = originalTabs.list.bind(originalTabs);
  const open = originalTabs.open.bind(originalTabs);
  const get = originalTabs.get.bind(originalTabs);
  async function localTabs() {
    const all = await list();
    let before;
    do {
      before = allowed.size;
      for (const tab of all) {
        if (allowed.has(tab.openerId) && !allowed.has(tab.targetId)) {
          allowed.add(tab.targetId);
          recordOwned(tab.targetId);
        }
      }
    } while (before !== allowed.size);
    return all.filter(tab => allowed.has(tab.targetId));
  }
  originalTabs.list = localTabs;
  originalTabs.open = async (...args) => {
    const target = await open(...args);
    allowed.add(target.targetId);
    recordOwned(target.targetId);
    return target;
  };
  originalTabs.get = async id => {
    if (!(await localTabs()).some(tab => tab.targetId === id)) throw new Error('Tab belongs to another client or no longer exists.');
    return get(id);
  };
  const send = browser.send.bind(browser);
  browser.send = async (method, ...args) => {
    if (method === 'Browser.close') throw new Error('This browser is service-owned. Use /browser close to release only your client; the final release closes the browser.');
    return send(method, ...args);
  };
  const originalReconnect = reconnect;
  globalThis.reconnect = async () => {
    const result = await originalReconnect();
    globalThis.reconnect = originalReconnect;
    installGuards([...allowed]);
    return result;
  };
}

export async function createClientSession(endpoint, workspace, registerWorker) {
  const session = await BrowserUse.create({ ...sessionOptions, browser: Browser.chrome({ cdpUrl: endpoint }), workspace });
  checkSDK(session);
  let guardedWorker;
  return {
    session,
    async execute(code, options) {
      // SDK creates a fresh target on first initialization, and retains that target on reset.
      if (!session.runtime.worker) await session.execute('await page.info();', options);
      if (guardedWorker !== session.runtime.worker) {
        const source = `(${installGuards.toString()})(${JSON.stringify([...session.runtime.owned])});`;
        await session.execute(source, options);
        guardedWorker = session.runtime.worker;
      }
      // Acknowledged ownership is required before user code can block this worker.
      await registerWorker(session.runtime.worker);
      if (options.signal?.aborted) throw new Error('Browser operation cancelled.');
      return session.execute(code, options);
    },
    close() { return session.close(); },
  };
}

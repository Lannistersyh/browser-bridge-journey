// EdgeBridge — 扩展侧 v2.0（合并版）
// 架构来源：
//   - 基座：native messaging + chrome.debugger（本项目原创，零 TCP 端口）
//   - 协议握手 + 版本协商：借鉴 Tencent/BrowserSkill (9.2k★) handshake.ts
//   - 指数退避重连：借鉴 BrowserSkill WSTransport + Unagi-cq/cdp-bridge-mcp (305★)
//   - 就绪广播（ext_ready）：借鉴 cdp-bridge-mcp background.js
//   - 视口截图 / 全页截图：借鉴 BrowserSkill viewport-screenshot.ts / observation.ts
const HOST = 'com.edgebridge.app';
const VER = '2.0.0';
const PROTOCOL_VERSION = '1';

let port = null;
const attached = new Set();

function log(...a){ try{ console.log('[edgebridge]', ...a); }catch(e){} }

// ---------- 原生宿主连接（指数退避，借鉴 BrowserSkill WSTransport） ----------
const RECONNECT = { initial: 500, max: 8000 };
let reconnectDelay = RECONNECT.initial;

function ensurePort() {
  if (port) return port;
  try { port = chrome.runtime.connectNative(HOST); }
  catch (e) { log('connectNative failed', e); port = null; scheduleReconnect(); return null; }
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    log('native disconnected', chrome.runtime.lastError?.message || '');
    port = null;
    scheduleReconnect();
  });
  reconnectDelay = RECONNECT.initial;          // 连上即重置退避
  // 握手（借鉴 BrowserSkill system.handshake）：报版本 + 能力清单
  try {
    port.postMessage({ id: 0, method: '__hello', params: {
      v: VER, protocol: PROTOCOL_VERSION,
      capabilities: ['tabs','open','activate','close','detach','cdp','screenshot','screenshotFull']
    }});
  } catch(e) {}
  // 就绪广播（借鉴 cdp-bridge-mcp ext_ready）：连接建立即上报当前标签页
  chrome.tabs.query({}).then(tabs => {
    try { port && port.postMessage({ id: 0, method: '__tabs_event', params: {
      reason: 'ready', tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active }))
    }}); } catch(e) {}
  }).catch(()=>{});
  log('native connected', VER);
  return port;
}

function scheduleReconnect() {
  setTimeout(() => ensurePort(), reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT.max);   // 0.5s→1s→2s→…→8s 封顶
}

function reply(id, ok, result, error) {
  const p = ensurePort();
  if (p) try { p.postMessage({ id, ok, result: result === undefined ? null : result, error: error || null }); } catch(e) {}
}

// ---------- 标签页管理 ----------
async function findTab(match) {
  const tabs = await chrome.tabs.query({});
  const usable = tabs.filter(t => /^(https?|file):/i.test(t.url || ''));
  if (match && match.tabId != null) return tabs.find(t => t.id === match.tabId) || null;
  if (match && match.urlIncludes) return usable.find(t => (t.url||'').includes(match.urlIncludes)) || null;
  return usable[0] || null;
}

async function attach(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  attached.add(tabId);
}

chrome.debugger.onDetach.addListener((src) => { if (src && src.tabId != null) attached.delete(src.tabId); });

// ---------- 截图（借鉴 BrowserSkill observation.ts） ----------
async function viewportScreenshot(tabId) {
  return await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format: 'png', fromSurface: true });
}

async function fullPageScreenshot(tabId) {
  const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics', {});
  const shot = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: Math.ceil(metrics.contentSize?.width || 1280), height: Math.ceil(metrics.contentSize?.height || 800), scale: 1 },
  });
  return { metrics, ...shot };
}

// ---------- 消息分发 ----------
async function onMessage(msg) {
  if (!msg || !msg.id) return;
  const { id, method, params = {}, match } = msg;
  try {
    switch (method) {
      case '__hello':   return reply(id, true, { v: VER });
      case '__tabs': {
        const tabs = await chrome.tabs.query({});
        return reply(id, true, tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active })));
      }
      case '__open': {
        const t = await chrome.tabs.create({ url: params.url, active: params.active !== false });
        await new Promise(r => setTimeout(r, params.wait || 1500));
        const fresh = await chrome.tabs.get(t.id).catch(() => null);
        return reply(id, true, { id: t.id, url: fresh && fresh.url, title: fresh && fresh.title });
      }
      case '__activate': {
        const t = await chrome.tabs.update(params.tabId, { active: true });
        if (t && t.windowId != null) await chrome.windows.update(t.windowId, { focused: true }).catch(()=>{});
        return reply(id, true, { ok: true });
      }
      case '__close': {
        await chrome.tabs.remove(params.tabId);
        return reply(id, true, { ok: true });
      }
      case '__detach': {
        for (const tabId of [...attached]) await chrome.debugger.detach({ tabId }).catch(()=>{});
        attached.clear();
        return reply(id, true, { ok: true });
      }
      case '__screenshot': {
        const tab = await findTab(match);
        if (!tab) return reply(id, false, null, 'no matching tab');
        await attach(tab.id);
        return reply(id, true, await viewportScreenshot(tab.id));
      }
      case '__screenshotFull': {
        const tab = await findTab(match);
        if (!tab) return reply(id, false, null, 'no matching tab');
        await attach(tab.id);
        return reply(id, true, await fullPageScreenshot(tab.id));
      }
    }
    // 通用 CDP 透传
    const tab = await findTab(match);
    if (!tab) return reply(id, false, null, 'no matching tab（没有可用的 http/https 标签页，可先用 __open 打开一个）');
    await attach(tab.id);
    const res = await chrome.debugger.sendCommand({ tabId: tab.id }, method, params);
    reply(id, true, res);
  } catch (e) {
    reply(id, false, null, (e && e.message) ? e.message : String(e));
  }
}

// ---------- 标签页事件推送 ----------
chrome.tabs.onUpdated?.addListener?.((tabId, info, tab) => {
  if (info.status === 'complete' && port) {
    try { port.postMessage({ id: 0, method: '__tabs_event', params: { reason: 'update', tabId, url: tab.url, title: tab.title } }); } catch(e) {}
  }
});

chrome.runtime.onInstalled.addListener(() => ensurePort());
chrome.runtime.onStartup.addListener(() => ensurePort());
ensurePort();

// MV3 保活
chrome.alarms?.create?.('keepalive', { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm?.addListener(() => ensurePort());

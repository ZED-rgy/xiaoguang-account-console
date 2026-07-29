const { app, BrowserView, BrowserWindow, Menu, Notification, Tray, ipcMain, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const collector = require('./collector');
const { createAccountLifecycle } = require('./account-lifecycle');
const { createCollectionCoordinator } = require('./collection-coordinator');
const { createSettingsRuntime } = require('./settings-runtime');
const { createRuntimeSupervisor, resolveBackendCommand, resolveDataDir } = require('./runtime-supervisor');
const { createAutostartController } = require('./autostart');
const { extractLoadableUrl, selectKuaishouSearchIdentity } = require('./parsers');
const { selectProfileSnapshot } = require('./profile');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.ACCOUNT_CONSOLE_PORT || 8826);
const URL = `http://127.0.0.1:${PORT}`;
const APP_NAME = '小光账号';
const APP_ID = 'com.local.account-console';
const settingsRuntime = createSettingsRuntime({ apiOrigin: URL, fetchImpl: fetch });

// 数据目录：开发时用仓库 data/；打包后用 exe 旁的 data/（整个安装目录自包含可搬移）。
// 通过环境变量传给后端（backend/config.py）和采集日志（collector.js）。
const DATA_DIR = resolveDataDir({
  envDataDir: process.env.ACCOUNT_CONSOLE_DATA,
  portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
  executablePath: app.getPath('exe'),
  isPackaged: app.isPackaged,
  root: ROOT,
});
process.env.ACCOUNT_CONSOLE_DATA = DATA_DIR;

let backendLogFd = null;
function startBackendProcess() {
  const logDir = path.join(DATA_DIR, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'backend.log');
  backendLogFd = fs.openSync(logPath, 'a');
  const launch = resolveBackendCommand({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    root: ROOT,
    existsSync: fs.existsSync,
  });
  fs.writeSync(backendLogFd, `[${new Date().toISOString()}] start ${launch.kind}: ${launch.command}\n`);
  try {
    return spawn(launch.command, launch.args, {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', backendLogFd, backendLogFd],
      env: { ...process.env, ACCOUNT_CONSOLE_DATA: DATA_DIR },
    });
  } catch (error) {
    fs.closeSync(backendLogFd);
    backendLogFd = null;
    throw error;
  }
}

const runtimeSupervisor = createRuntimeSupervisor({
  apiOrigin: URL,
  appId: APP_ID,
  dataDir: DATA_DIR,
  fetchImpl: fetch,
  startProcess: startBackendProcess,
});

// 登录态（persist: 分区）固定存到 data/electron-profile：Electron 默认的
// userData 路径含产品名，历史上每次改名/换打包方式都会静默丢掉全部登录态。
// 首次启动时把散落在旧 userData 里的分区合并迁移过来（同名分区先到先得）。
const USER_DATA_DIR = path.join(DATA_DIR, 'electron-profile');
function migrateLegacyPartitions() {
  const target = path.join(USER_DATA_DIR, 'Partitions');
  try {
    const appData = app.getPath('appData');
    for (const legacy of ['账号管理台', 'account-console', '小光账号']) {
      const src = path.join(appData, legacy, 'Partitions');
      if (!fs.existsSync(src)) continue;
      for (const name of fs.readdirSync(src)) {
        const dest = path.join(target, name);
        if (fs.existsSync(dest)) continue;
        fs.cpSync(path.join(src, name), dest, { recursive: true });
      }
    }
  } catch { /* 迁移失败不阻塞启动，最多需要重新扫码 */ }
}
migrateLegacyPartitions();
app.setPath('userData', USER_DATA_DIR);

// 全局 UA 清洗：默认 UA 携带「小光账号/版本 Electron/版本」token（还含中文），
// 平台登录风控会把它当异常环境拒掉（扫码后提示"访问太频繁"）。采集窗口在
// collector.js 里已单独清洗，这里补上工作区内嵌浏览器等其余所有页面。
app.userAgentFallback = app.userAgentFallback
  .replace(/ ?小光账号\/[\d.]+/g, '')
  .replace(/ ?账号管理台\/[\d.]+/g, '')
  .replace(/ ?account-console\/[\d.]+/g, '')
  .replace(/ ?Electron\/[\d.]+/g, '');

let mainWindow = null;
let splashWindow = null;
let tray = null;
let isQuitting = false;
let trayHintShown = false;
let lastBounds = { x: 0, y: 0, width: 0, height: 0 };
// 开机自启等场景静默启动到托盘，不弹主窗口
const startHidden = process.argv.includes('--hidden');

// 常规偏好（设置页可改，存后端 app_settings，改动后经 IPC 即时推送到这里）
let generalConfig = { close_to_tray: true, notify_on_collect: true, autostart_hidden: true };
const autostart = createAutostartController(
  app,
  process.execPath,
  () => generalConfig.autostart_hidden !== false,
);

async function fetchGeneralConfig() {
  try {
    const snapshot = await settingsRuntime.load();
    generalConfig = snapshot.general;
    scheduleConfig = snapshot.schedule;
    lastAutoDate = snapshot.schedule.last_auto_date || null;
  } catch { /* 用默认值 */ }
}

function notify(title, body) {
  try {
    new Notification({ title, body, icon: path.join(ROOT, 'assets', 'icon.png') }).show();
  } catch { /* 通知失败不影响功能 */ }
}

// 采集结果类通知受「采集完成系统通知」开关控制
function notifyCollect(title, body) {
  if (generalConfig.notify_on_collect === false) return;
  notify(title, body);
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------- 系统托盘：关窗进托盘常驻，定时采集在后台继续跑 ----------
function updateTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: '打开小光账号', click: showMainWindow },
    { label: '立即采集全部', click: () => runTrayCollection() },
    { type: 'separator' },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: autostart.isEnabled(),
      click: (item) => {
        applyAutostart(item.checked);
        updateTrayMenu();
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  if (tray) return;
  tray = new Tray(path.join(ROOT, 'assets', 'icon.ico'));
  tray.setToolTip(APP_NAME);
  tray.on('click', showMainWindow);
  updateTrayMenu();
}

// 托盘手动触发：按采集设置遍历所有勾选平台采一轮
async function runTrayCollection() {
  const summary = await collectionCoordinator.run({ trigger: 'manual' }, mainWindow);
  if (summary) {
    notifyCollect('采集完成', `成功 ${summary.success} 个 · 失败 ${summary.failed} 个 · 新增 ${summary.inserted} 条`);
  }
}

// 开机自启写系统注册表；autostart_hidden 决定自启时是否静默进托盘
function applyAutostart(enabled, hiddenOverride) {
  return autostart.setEnabled(enabled, hiddenOverride);
}

// 启动画面：点开到主窗口出现之间有几秒后端启动等待，给个可视反馈
function createSplash() {
  const win = new BrowserWindow({
    width: 320, height: 190, frame: false, resizable: false,
    backgroundColor: '#171a30', autoHideMenuBar: true, skipTaskbar: true,
    webPreferences: { sandbox: true },
  });
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html><html><head><meta charset="utf-8"><style>
      body { margin:0; height:100vh; display:grid; place-items:center; background:#171a30;
             font-family:"Microsoft YaHei UI","Segoe UI",sans-serif; color:#eef0ff; user-select:none; }
      .box { text-align:center; }
      .spark { font-size:34px; color:#ffd27d; text-shadow:0 0 18px rgba(255,190,90,.8); }
      h1 { margin:10px 0 4px; font-size:16px; font-weight:600; letter-spacing:1px; }
      p { margin:0; font-size:11.5px; color:#9aa0c3; }
      .bar { margin:14px auto 0; width:120px; height:3px; border-radius:2px; background:#2b2f52; overflow:hidden; }
      .bar i { display:block; width:40%; height:100%; border-radius:2px; background:#ffd27d;
               animation:slide 1.1s ease-in-out infinite; }
      @keyframes slide { 0%{margin-left:-40%} 100%{margin-left:100%} }
    </style></head><body><div class="box">
      <div class="spark">✦</div><h1>小光账号</h1><p>正在启动本地服务…</p>
      <div class="bar"><i></i></div>
    </div></body></html>
  `)}`);
  return win;
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
  splashWindow = null;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureServer() {
  await runtimeSupervisor.ensureReady();
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function showStartupError(error) {
  closeSplash();
  const message = escapeHtml(error?.message || error || '未知错误');
  const errorWindow = new BrowserWindow({
    width: 760,
    height: 480,
    resizable: false,
    title: `${APP_NAME} - 启动失败`,
    backgroundColor: '#f4f6f8',
    autoHideMenuBar: true,
  });
  errorWindow.setMenuBarVisibility(false);
  errorWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8">
        <title>${APP_NAME} - 启动失败</title>
        <style>
          body { margin: 0; font-family: "Microsoft YaHei UI", "Segoe UI", sans-serif; background: #f4f6f8; color: #111827; }
          main { padding: 38px 42px; }
          h1 { margin: 0 0 10px; font-size: 28px; }
          p { color: #52616f; line-height: 1.7; }
          code { display: block; margin: 18px 0; padding: 14px; border-radius: 8px; background: #10201d; color: #dff4ec; white-space: pre-wrap; }
          ul { color: #344054; line-height: 1.9; padding-left: 20px; }
          strong { color: #0f766e; }
        </style>
      </head>
      <body>
        <main>
          <h1>小光账号没有启动成功</h1>
          <p>桌面外壳已经打开，但本地服务没有准备好。请先检查下面几项，然后重新启动。</p>
          <code>${message}</code>
          <ul>
            <li>确认电脑已经安装 Python，并且命令行可以运行 <strong>python</strong>。</li>
            <li>确认 8826 端口没有被其他程序长期占用。</li>
            <li>如果刚刚关闭过软件，等待几秒后再重新打开。</li>
            <li>开发排障可以运行 <strong>scripts/start-server.bat</strong> 查看后端错误。</li>
          </ul>
        </main>
      </body>
    </html>
  `)}`);
}

function cleanBounds(bounds) {
  return {
    x: Math.max(0, Math.round(bounds.x || 0)),
    y: Math.max(0, Math.round(bounds.y || 0)),
    width: Math.max(0, Math.round(bounds.width || 0)),
    height: Math.max(0, Math.round(bounds.height || 0)),
  };
}

// ---------- 工作区多标签：每个已打开账号一个常驻 BrowserView ----------
// 切换标签只是切换谁占据 embedHost 的矩形，后台标签保持活着（上传/编辑不中断）。
const workspaceTabs = new Map(); // account_id -> BrowserView（账号管理页内部标签）
let activeTabId = null;

function activeTabView() {
  return activeTabId != null ? workspaceTabs.get(activeTabId) || null : null;
}

function setViewBounds(bounds) {
  lastBounds = cleanBounds(bounds);
  const view = activeTabView();
  if (view) view.setBounds(lastBounds);
}

function hideEmbedded() {
  // 同时清空 lastBounds：主窗口 resize 会重放 lastBounds，留着旧矩形会让
  // 已隐藏的工作区浏览器盖回其他功能区页面上。
  lastBounds = { x: 0, y: 0, width: 0, height: 0 };
  const view = activeTabView();
  if (view) view.setBounds(lastBounds);
}

function switchWorkspaceTab(accountId) {
  const id = Number(accountId);
  if (!workspaceTabs.has(id)) return { ok: false, message: 'tab not open' };
  activeTabId = id;
  for (const [tabId, view] of workspaceTabs) {
    view.setBounds(tabId === id ? lastBounds : { x: 0, y: 0, width: 0, height: 0 });
  }
  return { ok: true };
}

function closeWorkspaceTab(accountId) {
  const id = Number(accountId);
  const view = workspaceTabs.get(id);
  if (!view) return { ok: true };
  workspaceTabs.delete(id);
  if (activeTabId === id) activeTabId = null;
  try {
    if (mainWindow) mainWindow.removeBrowserView(view);
    view.webContents.destroy();
  } catch { /* 已销毁 */ }
  return { ok: true };
}

function adoptLoginSession(payload = {}) {
  const fromId = Number(payload.from_id);
  const toId = Number(payload.to_id);
  if (!Number.isFinite(fromId) || !Number.isFinite(toId)) {
    return { ok: false, message: 'invalid account id' };
  }
  if (fromId === toId) return { ok: true };
  const view = workspaceTabs.get(fromId);
  if (!view) return { ok: false, message: 'login tab not open' };
  // 目标账号可能正在上传或编辑：保留它的 BrowserView，关闭临时登录页即可。
  // 新登录分区已写入数据库，下次重开目标标签时会使用新的登录态。
  if (workspaceTabs.has(toId)) {
    closeWorkspaceTab(fromId);
    switchWorkspaceTab(toId);
    return { ok: true, preserved_existing: true };
  }
  workspaceTabs.delete(fromId);
  view.__accountId = toId;
  workspaceTabs.set(toId, view);
  if (activeTabId === fromId || activeTabId == null) activeTabId = toId;
  switchWorkspaceTab(toId);
  return { ok: true };
}

async function cancelLoginSessionView(payload = {}) {
  const accountId = Number(payload.account_id);
  if (!Number.isFinite(accountId)) return { ok: false, message: 'invalid account id' };
  closeWorkspaceTab(accountId);
  const partition = String(payload.partition || '');
  if (partition.startsWith('persist:account-')) {
    try { await session.fromPartition(partition).clearStorageData(); } catch { /* best effort */ }
  }
  return { ok: true };
}

async function openEmbedded(payload) {
  if (!mainWindow) return { ok: false, message: 'window not ready' };
  const id = Number(payload.account_id);
  if (!Number.isFinite(id)) return { ok: false, message: 'account_id required' };
  const partition = payload.partition || `persist:account-${id}`;
  let view = workspaceTabs.get(id);
  const created = !view;
  if (created) {
    view = new BrowserView({
      webPreferences: {
        session: session.fromPartition(partition),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    view.__accountId = id;
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) view.webContents.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    const sendProfileReady = (reason) => {
      if (!mainWindow) return;
      mainWindow.webContents.send('embedded:profile-ready', {
        account_id: view.__accountId,
        url: view.webContents.getURL(),
        reason,
      });
    };
    // 扫码登录通常伴随重定向或单页路由变化；每种导航都重新安排资料识别。
    view.webContents.on('did-finish-load', () => sendProfileReady('finished'));
    view.webContents.on('did-navigate', () => sendProfileReady('navigate'));
    view.webContents.on('did-navigate-in-page', () => sendProfileReady('navigate-in-page'));
    workspaceTabs.set(id, view);
    mainWindow.addBrowserView(view);
  }
  switchWorkspaceTab(id);
  // 已打开的标签重复点击只聚焦不刷新；带 navigate 才重新加载（切换 发布/作品/主页）
  if (payload.url && (created || payload.navigate)) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await view.webContents.loadURL(payload.url);
        break;
      } catch (error) {
        if (error && error.code === 'ERR_ABORTED') break; // 页面内跳转打断加载，属正常
        if (attempt === 2) {
          // 不向渲染进程抛原始异常：返回结构化错误由前端给出人话提示
          return {
            ok: false,
            created,
            message: `页面加载失败（${(error && (error.code || error.message)) || '网络异常'}），点击账号标签可重试`,
          };
        }
        await sleep(1200); // 平台页偶发拒载，稍候自动重试一次
      }
    }
  }
  return { ok: true, created };
}

// 页面侧只采集快照；可信候选判断集中在 profile.js，供账号标签与后台主页共用并可单测。
const PROFILE_SNAPSHOT_SCRIPT = `
    (() => {
      const absolute = (value) => {
        try { return value ? new URL(value, location.href).href : ""; } catch { return ""; }
      };
      const meta = (selector) => {
        const node = document.querySelector(selector);
        return node ? node.getAttribute("content") || "" : "";
      };
      const cookieValue = (name) => {
        const prefix = name + '=';
        const item = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
        return item ? decodeURIComponent(item.slice(prefix.length)) : '';
      };
      const storageJson = (name) => {
        try { return JSON.parse(localStorage.getItem(name) || 'null'); } catch { return null; }
      };
      const title = meta('meta[property="og:title"]') || meta('meta[name="title"]') || document.title || "";
      const isPublicHome =
        (location.host === 'www.douyin.com' && /^\\/user\\//.test(location.pathname)) ||
        location.host === 'space.bilibili.com' ||
        (location.host === 'www.kuaishou.com' && /^\\/profile\\//.test(location.pathname)) ||
        (location.host === 'www.xiaohongshu.com' && /^\\/user\\/profile\\//.test(location.pathname));
      const candidates = new Map();
      const pushImage = (img, trusted) => {
        if (!img) return;
        const src = absolute(img.currentSrc || img.src);
        if (!src || /^data:/i.test(src)) return;
        const parent = img.closest('button, a, [class*="user"], [class*="avatar"], [class*="header"]') || img.parentElement;
        const rect = img.getBoundingClientRect();
        const parentClass = String(parent && parent.className ? parent.className : '').toLowerCase();
        const nearbyIdentityLink = /user|avatar|account|profile/.test(parentClass)
          ? parent.querySelector('a[href]')
          : null;
        const item = {
          src,
          alt: img.alt || "",
          title: img.title || "",
          text: [img.className || "", img.id || "", parent ? parent.innerText.slice(0, 100) : ""].join(" "),
          width: img.naturalWidth || img.width || 0,
          height: img.naturalHeight || img.height || 0,
          trusted: Boolean(trusted),
          topRight: rect.top >= 0 && rect.top < 180 && rect.right > window.innerWidth * 0.72,
          href: absolute((img.closest('a[href]') || nearbyIdentityLink)?.href || ''),
        };
        const old = candidates.get(src);
        if (!old || (!old.trusted && item.trusted)) candidates.set(src, item);
      };
      const trustedSelectors = [
        'header img[class*="avatar"]',
        '[class*="header"] img[class*="avatar"]',
        '[class*="user"] img[class*="avatar"]',
        '[class*="account"] img[class*="avatar"]',
        'img[src*="aweme-avatar"]',
        'img[src*="/bfs/face/"]',
        'img[src*="uhead"]',
        'img[src*="sns-avatar"]',
      ];
      trustedSelectors.forEach(selector => {
        try { document.querySelectorAll(selector).forEach(img => pushImage(img, true)); } catch { /* 页面选择器异常 */ }
      });
      if (isPublicHome) Array.from(document.images).forEach(img => pushImage(img, false));
      const xiaohongshuBizUser = storageJson('USER_INFO_FOR_BIZ');
      const xiaohongshuUser = storageJson('USER_INFO');
      const xiaohongshuUserId = String(xiaohongshuBizUser?.userId
        || xiaohongshuUser?.user?.value?.userId
        || String(localStorage.getItem('snsWebPublishCurrentUser') || '').replace(/^"|"$/g, '')
        || '');
      const kuaishouCard = document.querySelector('.header-info-card');
      const kuaishouUserId = String(kuaishouCard?.__vue__?.personalInfo?.userId || cookieValue('userId') || '');
      return {
        url: location.href,
        title: title.trim(),
        pageText: document.body ? document.body.innerText.slice(0, 800) : "",
        metaAvatar: absolute(meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]') || meta('meta[itemprop="image"]')),
        candidates: Array.from(candidates.values()),
        identityHints: {
          xiaohongshuUserId,
          kuaishouUserId,
          bilibiliUserId: cookieValue('DedeUserID'),
        },
      };
    })();
  `;

async function extractProfileFromContents(contents) {
  const snapshot = await contents.executeJavaScript(PROFILE_SNAPSHOT_SCRIPT, true);
  return snapshot ? selectProfileSnapshot(snapshot) : { ok: false, message: '未读取到资料' };
}

async function extractEmbeddedProfile(accountId = null) {
  const id = Number(accountId);
  const view = Number.isFinite(id) ? workspaceTabs.get(id) : activeTabView();
  if (!view) return { ok: false, message: '请先打开账号标签' };
  return extractProfileFromContents(view.webContents);
}

async function resolveKuaishouPublicProfile({ nickname, internalId, partition }) {
  if (!String(nickname || '').trim() || !/^\d+$/.test(String(internalId || ''))) return null;
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 800,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const contents = win.webContents;
  const pending = new Set();
  let candidateSettled = false;
  let resolveCandidate;
  const candidateResult = new Promise(resolve => { resolveCandidate = resolve; });
  const acceptCandidate = value => {
    if (candidateSettled || !value) return;
    candidateSettled = true;
    resolveCandidate(value);
  };
  try {
    contents.setAudioMuted(true);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await contents.loadURL('about:blank');
    contents.debugger.attach('1.3');
    await contents.debugger.sendCommand('Network.enable');
    contents.debugger.on('message', async (_event, method, params) => {
      try {
        if (method === 'Network.responseReceived'
          && /\/rest\/v\/search\/user/.test(params.response.url || '')) {
          pending.add(params.requestId);
        }
        if (method === 'Network.loadingFinished' && pending.has(params.requestId)) {
          pending.delete(params.requestId);
          const body = await contents.debugger.sendCommand('Network.getResponseBody', {
            requestId: params.requestId,
          });
          const text = body.base64Encoded
            ? Buffer.from(body.body, 'base64').toString('utf8')
            : body.body;
          acceptCandidate(selectKuaishouSearchIdentity(JSON.parse(text), nickname));
        }
      } catch { /* 等待下一条搜索响应 */ }
    });
    const searchUrl = `https://www.kuaishou.com/search/video?searchKey=${encodeURIComponent(nickname)}`;
    await contents.loadURL(searchUrl).catch(error => {
      if (error && error.code !== 'ERR_ABORTED') throw error;
    });
    const candidate = await Promise.race([
      candidateResult,
      new Promise(resolve => setTimeout(() => resolve(null), 15000)),
    ]);
    if (!candidate) return null;
    const domReady = new Promise(resolve => contents.once('dom-ready', resolve));
    await Promise.race([
      contents.loadURL(candidate.homepage_url).catch(error => {
        if (error && error.code !== 'ERR_ABORTED') throw error;
      }),
      domReady,
    ]);
    // 快手公开页标题会先出现，账号资料区通常再延迟数秒渲染。
    // 有限轮询直到昵称和创作者中心数字快手号同时出现，避免仅凭同名搜索误绑。
    for (let attempt = 0; attempt < 9; attempt += 1) {
      await sleep(attempt === 0 ? 1800 : 1100);
      const page = await contents.executeJavaScript(
        '({ title: document.title, text: document.body ? document.body.innerText.slice(0, 3000) : "" })',
        true,
      ).catch(() => null);
      const identityMatches = String(page?.text || '').includes(String(internalId));
      const nicknameMatches = `${page?.title || ''} ${page?.text || ''}`.includes(String(nickname).trim());
      if (identityMatches && nicknameMatches) return candidate;
    }
    return null;
  } catch {
    return null;
  } finally {
    try { contents.debugger.detach(); } catch { /* ignore */ }
    try { if (!win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
  }
}

// 后台加载账号公开主页提取头像/昵称：创作者中心页拿不到可信头像时走这条通道，
// 用账号自己的登录分区打开，提取完即销毁窗口，不打扰当前页面。
async function fetchHomepageProfile(payload) {
  const id = Number(payload && payload.account_id);
  const url = extractLoadableUrl(payload && payload.url ? payload.url : '');
  const requestedPartition = String(payload && payload.partition ? payload.partition : '');
  const partition = requestedPartition.startsWith('persist:account-')
    ? requestedPartition
    : `persist:account-${id}`;
  const requireIdentity = Boolean(payload && payload.require_identity);
  if (!Number.isFinite(id) || !/^https?:\/\//i.test(url)) return { ok: false, message: '主页链接无效' };
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 800,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    win.webContents.setAudioMuted(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const domReady = new Promise(resolve => win.webContents.once('dom-ready', resolve));
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('主页加载超时')), 30000));
    await Promise.race([
      Promise.race([
        win.webContents.loadURL(url).catch((error) => {
          if (error && error.code !== 'ERR_ABORTED') throw error; // 短链跳转中断属正常
        }),
        domReady,
      ]),
      timeout,
    ]);
    let profile = { ok: false, message: '未读取到资料' };
    // 创作者后台的当前用户状态通常晚于 dom-ready；身份发现会等到稳定 ID 出现，
    // 避免把推荐内容中的其他作者链接当成当前账号。
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await sleep(attempt === 0 ? 1800 : 1500);
      profile = await extractProfileFromContents(win.webContents);
      if (profile?.ok && (!requireIdentity || (profile.homepage_url && profile.platform_account_id))) {
        return profile;
      }
    }
    if (profile?.ok && profile.platform === '快手'
      && !profile.platform_account_id && profile.nickname) {
      const identity = await resolveKuaishouPublicProfile({
        nickname: profile.nickname,
        internalId: profile.platform_internal_id,
        // 创作者中心分区在 www.kuaishou.com 上可能没有公共站点会话，
        // 使用采集分区做只读公开搜索；最终仍以创作者中心数字快手号二次核验。
        partition: 'persist:collector-kuaishou',
      });
      if (identity) {
        return {
          ...profile,
          ...identity,
          ok: true,
          login_status: profile.login_status || '已登录',
        };
      }
    }
    return profile;
  } catch (error) {
    return { ok: false, message: String(error && error.message ? error.message : error) };
  } finally {
    try { if (!win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
  }
}

function navigateEmbedded(action) {
  const view = activeTabView();
  if (!view) return { ok: false, message: 'account tab not open' };
  const contents = view.webContents;
  if (action === 'back' && contents.canGoBack()) contents.goBack();
  if (action === 'forward' && contents.canGoForward()) contents.goForward();
  if (action === 'reload') contents.reload();
  return {
    ok: true,
    canGoBack: contents.canGoBack(),
    canGoForward: contents.canGoForward(),
    url: contents.getURL(),
  };
}

async function createWindow() {
  app.setName(APP_NAME);
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
  Menu.setApplicationMenu(null);
  if (!startHidden) splashWindow = createSplash();
  await ensureServer();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    title: APP_NAME,
    backgroundColor: '#f4f6f8',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.once('ready-to-show', () => {
    closeSplash();
    if (!startHidden) mainWindow.show();
  });
  await mainWindow.webContents.session.clearCache().catch(() => {});
  mainWindow.loadURL(URL);
  mainWindow.on('resize', () => {
    const view = activeTabView();
    if (view) view.setBounds(lastBounds);
  });
  // 点 × 默认进托盘常驻（定时采集继续跑）；设置里选「直接退出」则关窗即退
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    if (generalConfig.close_to_tray === false) {
      isQuitting = true;
      app.quit();
      return;
    }
    event.preventDefault();
    mainWindow.hide();
    if (!trayHintShown) {
      trayHintShown = true;
      notify('已最小化到托盘', '定时采集将继续在后台运行；点托盘图标可打开界面，右键可退出。');
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  createTray();
  // 启动内置调度器：每分钟检查一次是否到点
  await fetchGeneralConfig();
  setInterval(tickScheduler, 60 * 1000);
}

const accountLifecycle = createAccountLifecycle({
  apiOrigin: URL,
  fetchImpl: fetch,
  openEmbedded,
  extractProfile: extractEmbeddedProfile,
  discoverProfile: fetchHomepageProfile,
  adoptLoginSession,
  cancelLoginView: cancelLoginSessionView,
});

async function repairCollectIdentity(account) {
  try {
    const sourceResponse = await fetch(`${URL}/api/accounts/${Number(account.id)}/profile-source`);
    if (!sourceResponse.ok) return null;
    const source = await sourceResponse.json();
    const profile = await fetchHomepageProfile({
      account_id: Number(account.id),
      url: source.url,
      partition: source.partition,
      require_identity: true,
    });
    if (!profile?.ok || !profile.homepage_url || !profile.platform_account_id) return null;
    const savedResponse = await fetch(`${URL}/api/accounts/${Number(account.id)}/discovered-identity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        homepage_url: profile.homepage_url,
        platform_account_id: profile.platform_account_id,
      }),
    });
    if (!savedResponse.ok) return null;
    const saved = await savedResponse.json();
    return saved.account || null;
  } catch {
    return null;
  }
}

const collectionCoordinator = createCollectionCoordinator({
  apiOrigin: URL,
  fetchImpl: fetch,
  runPlatform: (options, progressWindow) => collector.runCollection(options, progressWindow),
  repairIdentity: repairCollectIdentity,
});

ipcMain.handle('embedded:open', (_event, payload) => openEmbedded(payload));
ipcMain.handle('embedded:extract-profile', (_event, accountId) => extractEmbeddedProfile(accountId));
ipcMain.handle('embedded:navigate', (_event, action) => navigateEmbedded(action));
ipcMain.on('embedded:bounds', (_event, bounds) => setViewBounds(bounds));
ipcMain.on('embedded:hide', hideEmbedded);
ipcMain.handle('workspace:switch', (_event, accountId) => switchWorkspaceTab(accountId));
ipcMain.handle('workspace:close', (_event, accountId) => closeWorkspaceTab(accountId));
ipcMain.handle('account-login:adopt', (_event, payload) => adoptLoginSession(payload));
ipcMain.handle('account-login:cancel-view', (_event, payload) => cancelLoginSessionView(payload));
ipcMain.handle('account-login:begin', (_event, payload) => accountLifecycle.beginLogin(payload));
ipcMain.handle('account-login:inspect', (_event, payload) => accountLifecycle.inspectLogin(payload));
ipcMain.handle('account-login:cancel', (_event, payload) => accountLifecycle.cancelLogin(payload));
ipcMain.handle('profile:fetch-homepage', (_event, payload) => fetchHomepageProfile(payload));
ipcMain.handle('profile:discover', (_event, payload) => fetchHomepageProfile(payload));
ipcMain.handle('collect:run', (_event, payload) => collectionCoordinator.run(payload || {}, mainWindow));
ipcMain.handle('collect:stop', () => collector.stopCollection());
ipcMain.handle('collect:open-login', (_event, platform) => collector.openLoginWindow(platform || '抖音'));
ipcMain.handle('collect:update-schedule', async (_event, config) => {
  scheduleConfig = await settingsRuntime.saveSchedule(config || {});
  lastAutoDate = scheduleConfig.last_auto_date || lastAutoDate;
  return scheduleConfig;
});
ipcMain.handle('settings:get', () => ({
  autostart: autostart.isEnabled(),
  ...generalConfig,
}));
ipcMain.handle('settings:set-autostart', async (_event, payload) => {
  const previousEnabled = autostart.isEnabled();
  const previousHidden = generalConfig.autostart_hidden;
  const enabled = Boolean(payload && payload.enabled);
  const hidden = payload && payload.autostart_hidden !== undefined
    ? Boolean(payload.autostart_hidden)
    : generalConfig.autostart_hidden;
  generalConfig = await settingsRuntime.saveGeneralWithEffect(
    { autostart_hidden: hidden },
    () => applyAutostart(enabled, hidden),
    () => applyAutostart(previousEnabled, previousHidden),
  );
  updateTrayMenu();
  return { ok: true, autostart: autostart.isEnabled(), ...generalConfig };
});
ipcMain.handle('settings:update-general', async (_event, config) => {
  generalConfig = await settingsRuntime.saveGeneral(config || {});
  updateTrayMenu();
  return generalConfig;
});
ipcMain.handle('settings:open-data-dir', () => shell.openPath(DATA_DIR));

// 全局兜底：任何窗口都不允许跳到非 http(s) 协议（避免 bitbrowser:// 之类唤起系统弹窗）
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!/^https?:/i.test(url)) event.preventDefault();
  });
});

// ---------- 内置定时采集（每天 / 每周） ----------
let scheduleConfig = { auto_enabled: false, frequency: 'daily', weekday: 1, hour: 6, minute: 0 };
let lastAutoDate = null;

// 本地日期（YYYY-MM-DD）：调度判定统一用本地时间，不能用 toISOString 的 UTC 日期
function localDateString(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// 触发日期落盘：重启应用后当天不会重复自动采集
async function persistLastAutoDate(date) {
  scheduleConfig = await settingsRuntime.saveSchedule({ last_auto_date: date });
  lastAutoDate = scheduleConfig.last_auto_date || null;
}

// 按采集设置遍历所有勾选平台采一轮，返回汇总（供定时调度与托盘手动触发共用）
async function collectScheduledPlatforms(trigger) {
  const total = await collectionCoordinator.run({ trigger }, mainWindow);
  if (tray) tray.setToolTip(`${APP_NAME} · 上次采集 ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  return total?.ok ? total : null;
}

async function tickScheduler() {
  try {
    if (!scheduleConfig.auto_enabled) return;
    const now = new Date();
    const today = localDateString(now);
    if (lastAutoDate === today) return;
    if (scheduleConfig.frequency === 'weekly' && now.getDay() !== Number(scheduleConfig.weekday || 0)) return;
    // 已过设定时刻且今天没跑过就触发：晚开应用也会补跑当天一次
    const dueMinutes = Number(scheduleConfig.hour || 0) * 60 + Number(scheduleConfig.minute || 0);
    if (now.getHours() * 60 + now.getMinutes() < dueMinutes) return;
    await persistLastAutoDate(today);
    console.log('[scheduler] 触发定时采集', today);
    const summary = await collectScheduledPlatforms('scheduled');
    if (summary) {
      notifyCollect('定时采集完成', `成功 ${summary.success} 个 · 失败 ${summary.failed} 个 · 新增 ${summary.inserted} 条`);
    }
  } catch (error) {
    console.error('[scheduler] 采集失败:', error && error.message ? error.message : error);
  }
}

async function runHeadlessCollection() {
  try {
    await ensureServer();
    try {
      const cfg = await (await fetch(`${URL}/api/collect/config`)).json();
      // 应用内调度器（托盘常驻时）今天已采过就跳过，避免和系统计划任务双跑
      if (cfg.last_auto_date === localDateString(new Date())) {
        console.log('今天已自动采集过，跳过本次系统计划任务');
        return;
      }
    } catch { /* 读配置失败则只采抖音 */ }
    const summary = await collectionCoordinator.run({ trigger: 'scheduled' });
    console.log(JSON.stringify(summary, null, 2));
    // 系统计划任务采完记录日期，应用内调度器当天不再重复采
    await persistLastAutoDate(localDateString(new Date()));
  } catch (error) {
    console.error('collect failed:', error && error.message ? error.message : error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
}

const isCollectMode = process.argv.includes('--collect');

// 单实例锁：重复启动只聚焦已有窗口（--collect 无头模式不受锁限制，保证定时任务可跑）
if (!isCollectMode && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (!isCollectMode) {
    // 二次启动唤出窗口（含托盘隐藏态），不会再出现"启动器打不开"的僵尸
    app.on('second-instance', showMainWindow);
  }
  app.whenReady()
    .then(() => (isCollectMode ? runHeadlessCollection() : createWindow()))
    .catch(showStartupError);
}
app.on('window-all-closed', () => {
  if (isCollectMode) return; // 采集模式由采集流程自行退出
  // 托盘常驻：有托盘时窗口全关不退出；无托盘（启动失败等）保持原退出行为
  if (!tray && process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  isQuitting = true;
  if (tray) { tray.destroy(); tray = null; }
  runtimeSupervisor.shutdown();
  if (backendLogFd !== null) {
    fs.closeSync(backendLogFd);
    backendLogFd = null;
  }
});

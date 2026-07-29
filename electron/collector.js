// 采集器：隐藏窗口打开账号公开主页，通过 CDP 捕获平台数据接口的 JSON 响应，
// 解析公开互动数据后上报本地 API。只读公开页面，不做任何写操作。
const { BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const API = 'http://127.0.0.1:8826';

// 日志目录跟随数据目录（main.js 启动时设置 ACCOUNT_CONSOLE_DATA），须延迟读取
function logDir() {
  const dataDir = process.env.ACCOUNT_CONSOLE_DATA || path.resolve(__dirname, '..', 'data');
  return path.join(dataDir, 'logs');
}

function log(line) {
  try {
    const dir = logDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString();
    const day = stamp.slice(0, 10).replace(/-/g, '');
    fs.appendFileSync(path.join(dir, `collect-${day}.log`), `[${stamp}] ${line}\n`);
  } catch { /* 日志失败不影响采集 */ }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

const LOAD_TIMEOUT_MS = 45000;      // 单页加载超时（对齐扩展实践值）
const ACCOUNT_TIMEOUT_MS = 180000;  // 单账号总超时
const EVAL_TIMEOUT_MS = 10000;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// 手动停止采集
let cancelRequested = false;
let running = false;
function stopCollection() {
  if (!running) return { ok: true, message: '当前没有采集任务' };
  cancelRequested = true;
  return { ok: true, message: '已请求停止，正在收尾当前账号' };
}

// 屏蔽非 http(s) 协议跳转与弹窗（如 bitbrowser:// 唤起系统对话框）。
// followLinks: 登录窗口把新开链接加载进当前页；采集窗口一律拒绝，避免页面被导航走。
function hardenContents(contents, { followLinks = false } = {}) {
  contents.setWindowOpenHandler(({ url }) => {
    if (followLinks && /^https?:/i.test(url)) contents.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!/^https?:/i.test(url)) event.preventDefault();
  });
}

// 平台 adapter 与纯解析函数在 parsers.js（无 electron 依赖，可单测）
const { ADAPTERS, extractLoadableUrl, isCollectableHomepage } = require('./parsers');
const {
  candidateCaptureLimit,
  createPendingRequestTracker,
  selectLatestWorks,
  shouldStopCapture,
} = require('./collection-candidates');
const { prepareFreshCollection, withCacheBust } = require('./collection-freshness');
const { collectInitialWorks, requiredInitialDataError } = require('./collection-initial');

function cleanUserAgent(contents) {
  const ua = contents.getUserAgent()
    .replace(/ ?Electron\/[\d.]+/g, '')
    .replace(/ ?account-console\/[\d.]+/gi, '')
    .replace(/ ?账号管理台\/[\d.]+/g, '')
    .replace(/ ?小光账号\/[\d.]+/g, '');
  contents.setUserAgent(ua);
}

// 打开可见窗口，让用户把「采集专用小号」登录到采集会话里。
function openLoginWindow(platform) {
  const adapter = ADAPTERS[platform];
  if (!adapter) return { ok: false, message: `暂不支持 ${platform}` };
  const win = new BrowserWindow({
    width: 1200,
    height: 860,
    title: `采集浏览器登录 - ${platform}（请用采集专用小号登录）`,
    autoHideMenuBar: true,
    webPreferences: {
      partition: adapter.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  cleanUserAgent(win.webContents);
  hardenContents(win.webContents, { followLinks: true });
  win.loadURL(adapter.loginUrl);
  return { ok: true };
}

async function collectAccount(account, adapter, options = {}, onProgress = null) {
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + ACCOUNT_TIMEOUT_MS;
  const scanLimit = Math.max(5, Math.min(100, Number(options.scanLimit) || 20));
  const captureLimit = candidateCaptureLimit(scanLimit, adapter.candidateMultiplier);
  const maxScrolls = options.maxScrolls || 12;
  const name = account.account_name || `账号${account.id}`;
  const worksById = new Map();
  let apiResponses = 0;
  let canonicalUrl = null;
  let windowClosed = false;
  let authorProfile = null;

  const fail = (message) => ({
    account_id: account.id,
    platform: account.platform,
    started_at: startedAt,
    status: 'failed',
    error_message: message,
    works: [],
  });

  const loadUrl = extractLoadableUrl(account.homepage_url);
  if (!/^https?:\/\//i.test(loadUrl)) {
    return fail(`主页链接无效：${String(loadUrl).slice(0, 60)}`);
  }

  const win = new BrowserWindow({
    show: Boolean(options.showWindow),
    width: 1100,
    height: 820,
    title: `采集中：${name}（请勿操作此窗口，采完自动关闭）`,
    autoHideMenuBar: true,
    webPreferences: {
      partition: adapter.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.on('closed', () => { windowClosed = true; });
  const contents = win.webContents;
  cleanUserAgent(contents);
  hardenContents(contents);
  contents.setAudioMuted(true);

  const pending = createPendingRequestTracker(adapter.apiPattern);
  try {
    // 先加载空白页拉起渲染进程，否则 CDP 命令会因目标不存在而无限等待
    await withTimeout(contents.loadURL('about:blank'), EVAL_TIMEOUT_MS, '渲染进程初始化超时').catch(() => {});
    contents.debugger.attach('1.3');
    await withTimeout(
      contents.debugger.sendCommand('Network.enable'),
      EVAL_TIMEOUT_MS, '调试通道初始化超时',
    );
    if (adapter.forceFresh) {
      await withTimeout(
        prepareFreshCollection(contents),
        EVAL_TIMEOUT_MS, '清理采集缓存超时',
      );
    }
    contents.debugger.on('message', async (_event, method, params) => {
      pending.observe(method, params);
      try {
        if (method === 'Network.loadingFinished' && pending.has(params.requestId)) {
          try {
            const body = await contents.debugger.sendCommand('Network.getResponseBody', {
              requestId: params.requestId,
            });
            const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf-8') : body.body;
            const parsed = JSON.parse(text);
            const works = adapter.parse(parsed);
            if (!authorProfile && typeof adapter.profile === 'function') {
              const p = adapter.profile(parsed);
              if (p) authorProfile = p;
            }
            apiResponses += 1;
            works.forEach((work) => worksById.set(work.platform_work_id, work));
            if (onProgress) onProgress(worksById.size);
          } finally {
            pending.complete(params.requestId);
          }
        }
      } catch {
        // 单个响应解析失败不影响整体
      }
    });

    const requestUrl = adapter.forceFresh ? withCacheBust(loadUrl) : loadUrl;
    log(`  [${name}] 打开主页：${loadUrl}${adapter.forceFresh ? '（强制刷新）' : ''}`);
    // DOM 就绪即可继续（不死等 load 事件——重资源页面 load 可能迟迟不触发，但数据已在流入）
    const domReady = new Promise((resolve) => contents.once('dom-ready', resolve));
    try {
      await withTimeout(Promise.race([
        contents.loadURL(requestUrl).catch((error) => {
          if (error && error.code !== 'ERR_ABORTED') throw error; // 短链跳转中断首次加载属正常
        }),
        domReady,
      ]), LOAD_TIMEOUT_MS, `页面加载超时（${LOAD_TIMEOUT_MS / 1000}s）`);
    } catch (error) {
      return fail(`页面打不开：${error && error.message ? error.message : error}`);
    }
    log(`  [${name}] 页面就绪，开始滚动`);
    await sleep(rand(2500, 4500));

    const initialResult = await collectInitialWorks(contents, adapter, account);
    const initialError = requiredInitialDataError(adapter, initialResult);
    if (initialError) return fail(initialError);
    const initialWorks = initialResult.works;
    initialWorks.forEach(work => worksById.set(work.platform_work_id, work));
    if (initialWorks.length) {
      log(`  [${name}] 读取公开主页首屏 ${initialWorks.length} 条，继续滚动采集后续页`);
      if (onProgress) onProgress(worksById.size);
    }

    let stableRounds = 0;
    for (let i = 0; i < maxScrolls; i += 1) {
      if (cancelRequested) return fail('已手动停止');
      if (windowClosed) return fail('采集窗口被手动关闭');
      if (Date.now() > deadline) return fail(`单账号采集超时（已捕获接口 ${apiResponses} 次、作品 ${worksById.size} 条）`);
      if (shouldStopCapture({
        candidateCount: worksById.size,
        captureLimit,
        pendingCount: pending.size,
        requireStableAfterLimit: adapter.requireStableAfterLimit,
      })) break;
      const before = worksById.size;
      await withTimeout(
        contents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)', true),
        EVAL_TIMEOUT_MS, '页面无响应',
      ).catch(() => {});
      await sleep(rand(1800, 3600));
      log(`  [${name}] 滚动第 ${i + 1} 轮：接口响应 ${apiResponses} 次，累计作品 ${worksById.size} 条`);
      stableRounds = worksById.size === before ? stableRounds + 1 : 0;
      if (shouldStopCapture({
        candidateCount: worksById.size,
        captureLimit,
        previousCount: before,
        pendingCount: pending.size,
        stableRounds,
        requireStableAfterLimit: adapter.requireStableAfterLimit,
      })) break;
      if (stableRounds >= 3 && pending.size === 0) break;
    }

    const pendingDeadline = Math.min(deadline, Date.now() + 10000);
    while (pending.size > 0 && Date.now() < pendingDeadline) await sleep(100);
    if (pending.size > 0) {
      return fail(`接口响应处理超时（仍有 ${pending.size} 个请求未完成）`);
    }

    // 短链会跳转到标准主页，回收 canonical 链接持久化，下次直达
    const finalUrl = await withTimeout(
      contents.executeJavaScript('location.href', true), EVAL_TIMEOUT_MS, 'href timeout',
    ).catch(() => '');
    const canonical = String(finalUrl || '').match(/https:\/\/www\.douyin\.com\/user\/[\w-]+/);
    if (canonical && canonical[0] !== account.homepage_url) canonicalUrl = canonical[0];

    if (worksById.size === 0) {
      const pageInfo = await withTimeout(
        contents.executeJavaScript(
          '([document.title, document.body ? document.body.innerText.slice(0, 300) : ""].join(" "))',
          true,
        ), EVAL_TIMEOUT_MS, 'page info timeout',
      ).catch(() => '');
      const blocked = /验证码|安全验证|captcha|登录|访问异常/i.test(pageInfo);
      return fail(blocked
        ? '页面出现验证/登录拦截，请先打开采集浏览器登录采集小号'
        : `未捕获到作品数据（接口响应 ${apiResponses} 次），主页链接可能失效`);
    }
    const candidates = Array.from(worksById.values());
    const selection = adapter.selectLatest
      ? selectLatestWorks(candidates, scanLimit)
      : {
        works: candidates.slice(0, scanLimit),
        captured: candidates.length,
        truncated: Math.max(0, candidates.length - scanLimit),
        newestAt: candidates[0]?.published_at || null,
        oldestAt: candidates[Math.min(candidates.length, scanLimit) - 1]?.published_at || null,
      };
    log(`  [${name}] 候选 ${selection.captured} 条，保存最新 ${selection.works.length} 条，范围 ${selection.newestAt || '-'} ~ ${selection.oldestAt || '-'}，截断 ${selection.truncated} 条`);
    return {
      account_id: account.id,
      platform: account.platform,
      started_at: startedAt,
      status: 'success',
      works: selection.works,
      selection: {
        captured: selection.captured,
        truncated: selection.truncated,
        newest_at: selection.newestAt,
        oldest_at: selection.oldestAt,
      },
      canonical_url: canonicalUrl,
      author: authorProfile,
    };
  } finally {
    try { contents.debugger.detach(); } catch { /* ignore */ }
    try { if (!win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
  }
}

async function report(result) {
  const response = await fetch(`${API}/api/collect/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...result, trigger_source: result.trigger_source || 'manual' }),
  });
  return response.json();
}

// 把采集时解析出的标准主页回写账号，下次直达且永不失效
async function persistCanonicalUrl(accountId, canonicalUrl) {
  try {
    await fetch(`${API}/api/accounts/${accountId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ homepage_url: canonicalUrl }),
    });
    log(`  [链接] 账号 ${accountId} 主页已更新为标准链接`);
  } catch { /* 回写失败不影响采集 */ }
}

// 采集入口：不带 accountIds 则采集该平台全部有主页链接的账号。
async function runCollection(options = {}, progressWindow = null) {
  const platform = options.platform || '抖音';
  const trigger = options.trigger || 'manual';
  const adapter = ADAPTERS[platform];
  if (!adapter) return { ok: false, message: `暂不支持 ${platform}` };
  if (running) return { ok: false, message: '已有采集任务在运行，请先停止或等待完成' };
  running = true;
  cancelRequested = false;

  try {
    // 扫描上限与窗口可见性从采集设置读取（可被 options 覆盖）
    let scanLimit = Number(options.scanLimit) || 0;
    let showBrowser = true;
    try {
      const cfg = await (await fetch(`${API}/api/collect/config`)).json();
      if (!scanLimit) scanLimit = Number(cfg.scan_limit) || 20;
      showBrowser = cfg.show_browser !== false;
    } catch { if (!scanLimit) scanLimit = 20; }
    // 定时采集（凌晨无人值守）始终隐藏窗口；手动采集按设置显示
    const showWindow = trigger === 'scheduled' ? false : showBrowser;

    const targetsResponse = await fetch(`${API}/api/collect/targets?platform=${encodeURIComponent(platform)}`);
    let targets = (await targetsResponse.json()).data || [];
    targets = targets.filter((account) => isCollectableHomepage(account.platform, account.homepage_url));
    if (Array.isArray(options.accountIds) && options.accountIds.length) {
      const wanted = new Set(options.accountIds.map(Number));
      targets = targets.filter((account) => wanted.has(account.id));
    }
    if (!targets.length) {
      return { ok: false, message: '没有可采集的账号（需要平台匹配且填写了主页链接）' };
    }

    const notify = (payload) => {
      if (progressWindow && !progressWindow.isDestroyed()) {
        progressWindow.webContents.send('collect:progress', payload);
      }
    };

    const summary = { ok: true, platform, trigger, total: targets.length, success: 0, failed: 0, inserted: 0, updated: 0, stopped: false, errors: [] };
    log(`开始采集 ${platform}（${trigger}），共 ${targets.length} 个账号，每账号上限 ${scanLimit} 条`);
    for (let i = 0; i < targets.length; i += 1) {
      if (cancelRequested) { summary.stopped = true; break; }
      const account = targets[i];
      const base = { index: i + 1, total: targets.length, account_name: account.account_name };
      notify({ stage: 'collecting', ...base, collected: 0 });
      let result;
      try {
        // 外层硬看门狗：即使内部出现未知悬挂，也强制在限时内判失败并记录
        result = await withTimeout(
          collectAccount(account, adapter, { ...options, scanLimit, showWindow },
            (collected) => notify({ stage: 'collecting', ...base, collected })),
          ACCOUNT_TIMEOUT_MS + 30000,
          '采集流程无响应（外层看门狗超时）',
        );
      } catch (error) {
        result = {
          account_id: account.id,
          platform,
          status: 'failed',
          error_message: String(error && error.message ? error.message : error),
          works: [],
        };
      }
      result.trigger_source = trigger;
      try {
        const saved = await report(result);
        summary.inserted += saved.inserted || 0;
        summary.updated += saved.updated || 0;
      } catch (error) {
        result.status = 'failed';
        result.error_message = `上报失败: ${error.message}`;
      }
      if (result.status === 'success') {
        summary.success += 1;
        log(`  [成功] ${account.account_name || account.id}：${result.works.length} 个作品`);
        if (result.canonical_url) await persistCanonicalUrl(account.id, result.canonical_url);
      } else {
        summary.failed += 1;
        summary.errors.push(`${account.account_name || account.id}: ${result.error_message}`);
        log(`  [失败] ${account.account_name || account.id}：${result.error_message}`);
      }
      notify({ stage: 'done-one', ...base, status: result.status });
      if (cancelRequested) { summary.stopped = true; break; }
      if (i < targets.length - 1) {
        await sleep(trigger === 'scheduled' ? rand(30000, 90000) : rand(8000, 20000));
      }
    }
    log(`采集结束：成功 ${summary.success}，失败 ${summary.failed}，新增 ${summary.inserted}，更新 ${summary.updated}${summary.stopped ? '（手动停止）' : ''}`);
    notify({ stage: 'finished', summary });
    return summary;
  } finally {
    running = false;
    cancelRequested = false;
  }
}

module.exports = { runCollection, openLoginWindow, stopCollection, ADAPTERS };

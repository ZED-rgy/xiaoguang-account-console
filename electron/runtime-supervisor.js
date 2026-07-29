const path = require('node:path');

function normalizePath(value) {
  return path.resolve(String(value || '')).replace(/[\\/]+$/, '').toLocaleLowerCase();
}

function resolveDataDir(options = {}) {
  if (options.envDataDir) return path.resolve(options.envDataDir);
  if (options.isPackaged && options.portableDir) {
    return path.join(path.resolve(options.portableDir), 'data');
  }
  if (options.isPackaged) {
    return path.join(path.dirname(path.resolve(options.executablePath)), 'data');
  }
  return path.join(path.resolve(options.root || process.cwd()), 'data');
}

function createRuntimeSupervisor(options = {}) {
  const apiOrigin = String(options.apiOrigin || 'http://127.0.0.1:8826').replace(/\/$/, '');
  const appId = String(options.appId || 'com.local.account-console');
  const dataDir = normalizePath(options.dataDir);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const startProcess = options.startProcess;
  const stopProcess = options.stopProcess || ((ownedChild) => {
    if (process.platform === 'win32' && ownedChild.pid) {
      const { spawnSync } = require('node:child_process');
      spawnSync('taskkill.exe', ['/PID', String(ownedChild.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      return;
    }
    if (!ownedChild.killed) ownedChild.kill();
  });
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = Number(options.maxAttempts || 40);
  const intervalMs = Number(options.intervalMs || 250);
  let child = null;

  async function probe() {
    try {
      const response = await fetchImpl(`${apiOrigin}/api/health`);
      if (!response.ok) return { kind: 'absent' };
      const health = await response.json();
      if (health.app_id !== appId) {
        return { kind: 'conflict', message: `端口被其他应用占用：${health.app_id || 'unknown'}`, health };
      }
      if (normalizePath(health.data_dir) !== dataDir) {
        return { kind: 'conflict', message: `检测到其他数据目录的实例：${health.data_dir || 'unknown'}`, health };
      }
      return { kind: 'ready', health };
    } catch {
      return { kind: 'absent' };
    }
  }

  async function ensureReady() {
    const initial = await probe();
    if (initial.kind === 'ready') return { ok: true, reused: true, health: initial.health };
    if (initial.kind === 'conflict') throw new Error(initial.message);
    if (!startProcess) throw new Error('backend process starter unavailable');

    let processError = null;
    let processExit = null;
    child = startProcess();
    child.once?.('error', (error) => { processError = error; });
    child.once?.('exit', (code, signal) => { processExit = { code, signal }; });
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (processError) throw processError;
      if (processExit) {
        throw new Error(`Local backend exited early: code=${processExit.code ?? '-'} signal=${processExit.signal ?? '-'}`);
      }
      const current = await probe();
      if (current.kind === 'ready') return { ok: true, reused: false, health: current.health };
      if (current.kind === 'conflict') throw new Error(current.message);
      await sleep(intervalMs);
    }
    throw new Error('小光账号服务启动超时');
  }

  function shutdown() {
    if (child) stopProcess(child);
    child = null;
  }

  return { ensureReady, probe, shutdown };
}

function resolveBackendCommand(options = {}) {
  const existsSync = options.existsSync || require('node:fs').existsSync;
  const resourcesPath = options.resourcesPath || '';
  const root = options.root || process.cwd();
  const packagedServer = path.join(resourcesPath, 'backend', 'account-console-server.exe');
  if (options.isPackaged && existsSync(packagedServer)) {
    return { command: packagedServer, args: [], kind: 'packaged-server' };
  }
  const embeddedPython = path.join(resourcesPath, 'runtime', 'python', 'python.exe');
  if (options.isPackaged && existsSync(embeddedPython)) {
    return { command: embeddedPython, args: [path.join(root, 'run_server.py')], kind: 'embedded-python' };
  }
  return { command: 'python', args: ['run_server.py'], kind: 'system-python' };
}

module.exports = { createRuntimeSupervisor, normalizePath, resolveBackendCommand, resolveDataDir };

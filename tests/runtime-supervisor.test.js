const test = require('node:test');
const assert = require('node:assert/strict');

const { createRuntimeSupervisor } = require('../electron/runtime-supervisor');
const { resolveBackendCommand, resolveDataDir } = require('../electron/runtime-supervisor');

function response(body) {
  return { ok: true, async json() { return body; } };
}

test('runtime supervisor starts the owned backend when no server is listening', async () => {
  let probes = 0;
  let starts = 0;
  const supervisor = createRuntimeSupervisor({
    apiOrigin: 'http://127.0.0.1:8826',
    appId: 'com.local.account-console',
    dataDir: 'D:\\小光账号\\data',
    fetchImpl: async () => {
      probes += 1;
      if (probes === 1) {
        throw new Error('connection refused');
      }
      return response({
        ok: true,
        app_id: 'com.local.account-console',
        version: '0.2.0',
        data_dir: 'D:\\小光账号\\data',
      });
    },
    startProcess: () => {
      starts += 1;
      return { once() {}, kill() {} };
    },
    sleep: async () => {},
    maxAttempts: 2,
  });

  const result = await supervisor.ensureReady();

  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
  assert.equal(starts, 1);
  assert.equal(result.health.app_id, 'com.local.account-console');
});

test('runtime supervisor refuses a matching app that points at another data directory', async () => {
  const supervisor = createRuntimeSupervisor({
    apiOrigin: 'http://127.0.0.1:8826',
    appId: 'com.local.account-console',
    dataDir: 'D:\\小光账号\\data',
    fetchImpl: async () => response({
      ok: true,
      app_id: 'com.local.account-console',
      data_dir: 'D:\\other-install\\data',
    }),
    startProcess: () => { throw new Error('must not start'); },
  });

  await assert.rejects(() => supervisor.ensureReady(), /其他数据目录/);
});

test('packaged runtime prefers the bundled backend executable', () => {
  const command = resolveBackendCommand({
    isPackaged: true,
    resourcesPath: 'D:\\小光账号\\resources',
    root: 'D:\\小光账号\\resources\\app',
    existsSync: (candidate) => candidate.endsWith('account-console-server.exe'),
  });

  assert.equal(command.kind, 'packaged-server');
  assert.match(command.command, /account-console-server\.exe$/);
  assert.deepEqual(command.args, []);
});

test('shutdown terminates the complete owned backend process tree', async () => {
  let probes = 0;
  const stopped = [];
  const ownedChild = { pid: 4242, once() {}, kill() {} };
  const supervisor = createRuntimeSupervisor({
    dataDir: 'D:\\account-console\\data',
    fetchImpl: async () => {
      probes += 1;
      if (probes === 1) throw new Error('connection refused');
      return response({
        app_id: 'com.local.account-console',
        data_dir: 'D:\\account-console\\data',
      });
    },
    startProcess: () => ownedChild,
    stopProcess: (child) => stopped.push(child),
    sleep: async () => {},
    maxAttempts: 2,
  });

  await supervisor.ensureReady();
  supervisor.shutdown();

  assert.deepEqual(stopped, [ownedChild]);
});

test('portable runtime stores data beside the original portable executable', () => {
  const dataDir = resolveDataDir({
    envDataDir: '',
    portableDir: 'E:\\Portable Apps\\Account Console',
    executablePath: 'C:\\Users\\user\\AppData\\Local\\Temp\\portable-build\\account.exe',
    isPackaged: true,
    root: 'D:\\source',
  });

  assert.equal(dataDir, 'E:\\Portable Apps\\Account Console\\data');
});

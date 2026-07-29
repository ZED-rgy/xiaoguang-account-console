const test = require('node:test');
const assert = require('node:assert/strict');

const { createAutostartController } = require('../electron/autostart');

test('开机启动读写使用相同的可执行文件和隐藏参数', () => {
  const calls = [];
  const app = {
    setLoginItemSettings: (settings) => calls.push(['set', settings]),
    getLoginItemSettings: (settings) => {
      calls.push(['get', settings]);
      return { openAtLogin: true, executableWillLaunchAtLogin: true };
    },
  };
  const controller = createAutostartController(app, 'D:\\小光账号\\小光账号.exe', () => true);

  assert.equal(controller.setEnabled(true), true);
  assert.deepEqual(calls, [
    ['set', {
      openAtLogin: true,
      path: 'D:\\小光账号\\小光账号.exe',
      args: ['--hidden'],
    }],
    ['get', {
      path: 'D:\\小光账号\\小光账号.exe',
      args: ['--hidden'],
    }],
  ]);
});

test('Windows 已存在启动项时使用 executableWillLaunchAtLogin 恢复勾选状态', () => {
  const app = {
    setLoginItemSettings: () => {},
    getLoginItemSettings: () => ({
      openAtLogin: false,
      executableWillLaunchAtLogin: true,
    }),
  };
  const controller = createAutostartController(app, 'D:\\小光账号\\小光账号.exe', () => false);

  assert.equal(controller.isEnabled(), true);
});

test('更新隐藏启动设置时使用显式候选值而不是旧运行态', () => {
  const calls = [];
  const app = {
    setLoginItemSettings: (settings) => calls.push(settings),
    getLoginItemSettings: () => ({ openAtLogin: true }),
  };
  const controller = createAutostartController(app, 'D:\\小光账号\\小光账号.exe', () => true);

  controller.setEnabled(true, false);

  assert.deepEqual(calls[0].args, []);
});

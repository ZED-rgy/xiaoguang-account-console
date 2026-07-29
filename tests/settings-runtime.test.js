const test = require('node:test');
const assert = require('node:assert/strict');

const { createSettingsRuntime } = require('../electron/settings-runtime');

function response(body) {
  return { ok: true, async json() { return body; } };
}

test('saving settings persists and updates the runtime snapshot in one operation', async () => {
  const calls = [];
  const runtime = createSettingsRuntime({
    apiOrigin: 'http://127.0.0.1:8826',
    fetchImpl: async (url, options = {}) => {
      calls.push([url, options]);
      if (url.endsWith('/api/general-settings')) {
        return response({ close_to_tray: false, notify_on_collect: true, autostart_hidden: true });
      }
      return response({ auto_enabled: true, frequency: 'daily', hour: 7, minute: 30, platforms: ['抖音'] });
    },
  });

  const general = await runtime.saveGeneral({ close_to_tray: false });
  const schedule = await runtime.saveSchedule({ auto_enabled: true, hour: 7, minute: 30 });

  assert.equal(general.close_to_tray, false);
  assert.equal(schedule.hour, 7);
  assert.equal(runtime.snapshot().general.close_to_tray, false);
  assert.equal(runtime.snapshot().schedule.minute, 30);
  assert.deepEqual(calls.map((call) => [call[0].split('/api/')[1], call[1].method]), [
    ['general-settings', 'POST'],
    ['collect/config', 'POST'],
  ]);
});

test('external setting effect is rolled back when persistence fails', async () => {
  const effects = [];
  const runtime = createSettingsRuntime({
    general: { autostart_hidden: true },
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      async json() { return { detail: 'disk full' }; },
    }),
  });

  await assert.rejects(
    () => runtime.saveGeneralWithEffect(
      { autostart_hidden: false },
      async () => effects.push('apply'),
      async () => effects.push('rollback'),
    ),
    /disk full/,
  );

  assert.deepEqual(effects, ['apply', 'rollback']);
  assert.equal(runtime.snapshot().general.autostart_hidden, true);
});

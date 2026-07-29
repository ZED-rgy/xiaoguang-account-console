const test = require('node:test');
const assert = require('node:assert/strict');

const { createCollectionCoordinator } = require('../electron/collection-coordinator');

function response(body) {
  return { ok: true, async json() { return body; } };
}

test('one collection request repairs identities, groups platforms, and aggregates results', async () => {
  const runs = [];
  const coordinator = createCollectionCoordinator({
    apiOrigin: 'http://127.0.0.1:8826',
    fetchImpl: async (url) => {
      if (url.endsWith('/api/collect/config')) {
        return response({ platforms: ['抖音', '快手'], scan_limit: 20 });
      }
      return response({ data: [
        { id: 1, platform: '抖音', homepage_url: 'https://www.douyin.com/user/a' },
        { id: 2, platform: '快手', homepage_url: 'https://www.kuaishou.com/profile/4768338482' },
      ] });
    },
    repairIdentity: async (account) => ({
      ...account,
      homepage_url: 'https://www.kuaishou.com/profile/3xstable-user',
      platform_account_id: '3xstable-user',
    }),
    runPlatform: async (options) => {
      runs.push(options);
      return options.platform === '抖音'
        ? { ok: true, total: 1, success: 1, failed: 0, inserted: 2, updated: 1, errors: [] }
        : { ok: true, total: 1, success: 1, failed: 0, inserted: 3, updated: 0, errors: [] };
    },
  });

  const result = await coordinator.run({ trigger: 'manual', accountIds: [1, 2] });

  assert.equal(result.ok, true);
  assert.equal(result.total, 2);
  assert.equal(result.success, 2);
  assert.equal(result.inserted, 5);
  assert.deepEqual(runs.map((item) => [item.platform, item.accountIds]), [
    ['抖音', [1]],
    ['快手', [2]],
  ]);
});

test('manual account selection is not filtered by automatic platform settings', async () => {
  const runs = [];
  const coordinator = createCollectionCoordinator({
    fetchImpl: async (url) => url.endsWith('/api/collect/config')
      ? response({ platforms: ['抖音'] })
      : response({ data: [
        { id: 9, platform: 'B站', homepage_url: 'https://space.bilibili.com/123/video' },
      ] }),
    runPlatform: async (options) => {
      runs.push(options);
      return { ok: true, total: 1, success: 1, failed: 0, inserted: 1, updated: 0, errors: [] };
    },
  });

  const result = await coordinator.run({ trigger: 'manual', accountIds: [9] });

  assert.equal(result.ok, true);
  assert.deepEqual(runs.map(({ platform, accountIds }) => ({ platform, accountIds })), [
    { platform: 'B站', accountIds: [9] },
  ]);
});

test('collection reports failure when every platform run is rejected', async () => {
  const coordinator = createCollectionCoordinator({
    fetchImpl: async (url) => url.endsWith('/api/collect/config')
      ? response({ platforms: ['抖音'] })
      : response({ data: [
        { id: 1, platform: '抖音', homepage_url: 'https://www.douyin.com/user/a' },
      ] }),
    runPlatform: async () => ({ ok: false, message: 'collector busy' }),
  });

  const result = await coordinator.run({ trigger: 'manual' });

  assert.equal(result.ok, false);
  assert.match(result.message, /collector busy/);
});

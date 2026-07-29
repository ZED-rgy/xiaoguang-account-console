const test = require('node:test');
const assert = require('node:assert/strict');

const { prepareFreshCollection, withCacheBust } = require('../electron/collection-freshness');

test('prepareFreshCollection clears cached responses and bypasses service workers', async () => {
  const commands = [];
  let cacheCleared = false;
  const contents = {
    debugger: {
      sendCommand: async (method, params) => commands.push({ method, params }),
    },
    session: {
      clearCache: async () => { cacheCleared = true; },
    },
  };

  await prepareFreshCollection(contents);

  assert.equal(cacheCleared, true);
  assert.deepEqual(commands, [
    { method: 'Network.setCacheDisabled', params: { cacheDisabled: true } },
    { method: 'Network.setBypassServiceWorker', params: { bypass: true } },
  ]);
  assert.equal(
    withCacheBust('https://www.xiaohongshu.com/user/profile/abc?tab=note', 1234),
    'https://www.xiaohongshu.com/user/profile/abc?tab=note&_account_console_refresh=1234',
  );
});

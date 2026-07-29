const test = require('node:test');
const assert = require('node:assert/strict');

const { createAccountLifecycle } = require('../electron/account-lifecycle');

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() { return body; },
  };
}

test('beginLogin creates a temporary session and opens its isolated browser view', async () => {
  const calls = [];
  const session = {
    ok: true,
    account_id: -101,
    platform: '抖音',
    partition: 'persist:account-login-101',
    url: 'https://creator.douyin.com/',
  };
  const lifecycle = createAccountLifecycle({
    apiOrigin: 'http://127.0.0.1:8826',
    fetchImpl: async (url, options) => {
      calls.push(['fetch', url, options]);
      return jsonResponse(session);
    },
    openEmbedded: async (payload) => {
      calls.push(['open', payload]);
      return { ok: true, created: true };
    },
  });

  const result = await lifecycle.beginLogin({ platform: '抖音', addToCollectTargets: true });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'waiting');
  assert.equal(result.add_to_collect_targets, true);
  assert.equal(calls[0][1], 'http://127.0.0.1:8826/api/account-login-sessions');
  assert.equal(JSON.parse(calls[0][2].body).platform, '抖音');
  assert.equal(calls[1][0], 'open');
  assert.equal(calls[1][1].partition, 'persist:account-login-101');
});

test('beginLogin removes the temporary session when the browser view cannot open', async () => {
  const calls = [];
  const lifecycle = createAccountLifecycle({
    apiOrigin: 'http://127.0.0.1:8826',
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      if (options.method === 'DELETE') return jsonResponse({ ok: true });
      return jsonResponse({
        account_id: -102,
        platform: '抖音',
        partition: 'persist:account-login-102',
        url: 'https://creator.douyin.com/',
      });
    },
    openEmbedded: async () => ({ ok: false, message: 'network unavailable' }),
  });

  const result = await lifecycle.beginLogin({ platform: '抖音' });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assert.equal(calls.at(-1)[1].method, 'DELETE');
  assert.match(calls.at(-1)[0], /account-login-sessions\/-102$/);
});

test('inspectLogin completes promotion only after profile evidence contains stable identity', async () => {
  const calls = [];
  const lifecycle = createAccountLifecycle({
    apiOrigin: 'http://127.0.0.1:8826',
    fetchImpl: async (url, options) => {
      calls.push(['fetch', url, options]);
      return jsonResponse({
        ok: true,
        account_id: 7,
        merged: false,
        account: { id: 7, account_name: '小光英语', avatar_url: '/api/avatars/7' },
      });
    },
    extractProfile: async (accountId) => {
      calls.push(['extract', accountId]);
      return { ok: true, login_status: '已登录', nickname: '小光英语', avatar_url: '' };
    },
    discoverProfile: async (payload) => {
      calls.push(['discover', payload]);
      return {
        ok: true,
        nickname: '小光英语',
        avatar_url: 'https://cdn.example/avatar.png',
        homepage_url: 'https://www.douyin.com/user/stable-id',
        platform_account_id: 'stable-id',
      };
    },
    adoptLoginSession: async (payload) => {
      calls.push(['adopt', payload]);
      return { ok: true };
    },
  });

  const result = await lifecycle.inspectLogin({
    account_id: -101,
    platform: '抖音',
    partition: 'persist:account-login-101',
    url: 'https://creator.douyin.com/',
    add_to_collect_targets: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.account_id, 7);
  assert.deepEqual(calls.find((item) => item[0] === 'adopt')[1], { from_id: -101, to_id: 7 });
  const completeCall = calls.find((item) => item[0] === 'fetch');
  assert.match(completeCall[1], /account-login-sessions\/-101\/complete$/);
  assert.deepEqual(JSON.parse(completeCall[2].body), {
    profile_nickname: '小光英语',
    avatar_url: 'https://cdn.example/avatar.png',
    homepage_url: 'https://www.douyin.com/user/stable-id',
    platform_account_id: 'stable-id',
    add_to_collect_targets: true,
  });
});

test('cancelLogin clears the browser partition and removes the temporary session', async () => {
  const calls = [];
  const lifecycle = createAccountLifecycle({
    apiOrigin: 'http://127.0.0.1:8826',
    fetchImpl: async (url, options) => {
      calls.push(['fetch', url, options]);
      return jsonResponse({ ok: true, account_id: -101 });
    },
    cancelLoginView: async (payload) => {
      calls.push(['cancel-view', payload]);
      return { ok: true };
    },
  });

  const result = await lifecycle.cancelLogin({
    account_id: -101,
    partition: 'persist:account-login-101',
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0][0], 'cancel-view');
  assert.equal(calls[1][2].method, 'DELETE');
  assert.match(calls[1][1], /account-login-sessions\/-101$/);
});

test('beginLogin removes the backend session when opening the browser throws', async () => {
  const methods = [];
  const lifecycle = createAccountLifecycle({
    fetchImpl: async (_url, options) => {
      methods.push(options.method);
      return options.method === 'DELETE'
        ? jsonResponse({ ok: true })
        : jsonResponse({ account_id: -201, partition: 'persist:account-login-201' });
    },
    openEmbedded: async () => { throw new Error('browser crashed'); },
  });

  const result = await lifecycle.beginLogin({ platform: '抖音' });

  assert.equal(result.ok, false);
  assert.match(result.message, /browser crashed/);
  assert.deepEqual(methods, ['POST', 'DELETE']);
});

test('cancelLogin removes the backend session even when view cleanup fails', async () => {
  const methods = [];
  const lifecycle = createAccountLifecycle({
    fetchImpl: async (_url, options) => {
      methods.push(options.method);
      return jsonResponse({ ok: true });
    },
    cancelLoginView: async () => { throw new Error('view cleanup failed'); },
  });

  await assert.rejects(
    () => lifecycle.cancelLogin({ account_id: -202, partition: 'persist:account-login-202' }),
    /view cleanup failed/,
  );
  assert.deepEqual(methods, ['DELETE']);
});

test('inspectLogin completes promotion when browser adoption fails', async () => {
  const lifecycle = createAccountLifecycle({
    fetchImpl: async () => jsonResponse({ ok: true, account_id: 17 }),
    extractProfile: async () => ({
      ok: true,
      login_status: '已登录',
      nickname: 'account',
      avatar_url: 'https://cdn.example/avatar.png',
      homepage_url: 'https://www.douyin.com/user/stable-id',
      platform_account_id: 'stable-id',
    }),
    adoptLoginSession: async () => { throw new Error('adoption failed'); },
  });

  const result = await lifecycle.inspectLogin({ account_id: -203, platform: '抖音' });

  assert.equal(result.status, 'completed');
  assert.equal(result.account_id, 17);
  assert.equal(result.adopted, false);
});

test('inspectLogin rejects an invalid homepage as stable identity evidence', async () => {
  let completed = false;
  const lifecycle = createAccountLifecycle({
    fetchImpl: async () => {
      completed = true;
      return jsonResponse({ ok: true, account_id: 18 });
    },
    extractProfile: async () => ({
      ok: true,
      login_status: '已登录',
      nickname: 'account',
      avatar_url: 'https://cdn.example/avatar.png',
      homepage_url: 'https://example.com/not-a-platform-homepage',
    }),
  });

  const result = await lifecycle.inspectLogin({ account_id: -204, platform: '抖音' });

  assert.equal(result.status, 'checking');
  assert.equal(completed, false);
});

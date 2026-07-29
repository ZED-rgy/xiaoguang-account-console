const { isPlatformHomepage } = require('./platform-capabilities');

function createAccountLifecycle(options = {}) {
  const apiOrigin = String(options.apiOrigin || 'http://127.0.0.1:8826').replace(/\/$/, '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const openEmbedded = options.openEmbedded;
  const extractProfile = options.extractProfile;
  const discoverProfile = options.discoverProfile;
  const adoptLoginSession = options.adoptLoginSession;
  const cancelLoginView = options.cancelLoginView;
  const lastDiscoveryAt = new Map();

  async function request(path, init = {}) {
    const response = await fetchImpl(`${apiOrigin}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      ...init,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail || body.message || `HTTP ${response.status}`);
    return body;
  }

  async function beginLogin(payload = {}) {
    const platform = String(payload.platform || '').trim();
    if (!platform) return { ok: false, status: 'error', message: 'platform required' };
    const session = await request('/api/account-login-sessions', {
      method: 'POST',
      body: JSON.stringify({ platform }),
    });
    let opened;
    try {
      opened = await openEmbedded({ ...session, target: 'home' });
    } catch (error) {
      opened = { ok: false, message: error?.message || 'login view failed' };
    }
    if (opened?.ok === false) {
      if (cancelLoginView) {
        try {
          await cancelLoginView({ account_id: session.account_id, partition: session.partition });
        } catch { /* backend cleanup must still run */ }
      }
      try {
        await request(`/api/account-login-sessions/${session.account_id}`, { method: 'DELETE' });
      } catch { /* preserve the original browser error */ }
      return { ...session, ok: false, status: 'error', message: opened.message || 'login view failed' };
    }
    return {
      ...session,
      ok: true,
      status: 'waiting',
      add_to_collect_targets: payload.addToCollectTargets === true,
    };
  }

  function cleanNickname(value) {
    return String(value || '')
      .replace(/\s*[-_|].*$/, '')
      .replace(/创作者中心|登录|扫码|首页|工作台/g, '')
      .trim()
      .slice(0, 80);
  }

  function completeEvidence(profile = {}, platform = '') {
    return Boolean(
      cleanNickname(profile.nickname || profile.profile_nickname)
      && profile.avatar_url
      && (profile.platform_account_id || isPlatformHomepage(platform, profile.homepage_url)),
    );
  }

  async function inspectLogin(session = {}) {
    const accountId = Number(session.account_id);
    if (!Number.isFinite(accountId)) return { ok: false, status: 'error', message: 'invalid login session' };
    let profile = await extractProfile(accountId);
    if (!profile?.ok || profile.login_status !== '已登录') {
      return {
        ok: true,
        status: profile?.reason === 'login-page' ? 'waiting' : 'checking',
        message: profile?.reason === 'login-page' ? '请在平台页面完成登录' : '正在确认登录状态',
      };
    }

    const now = Date.now();
    const mayDiscover = !lastDiscoveryAt.has(accountId) || now - lastDiscoveryAt.get(accountId) >= 30000;
    if (!completeEvidence(profile, session.platform) && discoverProfile && mayDiscover) {
      lastDiscoveryAt.set(accountId, now);
      const discovered = await discoverProfile({
        account_id: accountId,
        url: profile.homepage_url || session.url,
        partition: session.partition,
        require_identity: true,
      });
      if (discovered?.ok) {
        profile = {
          ...profile,
          nickname: cleanNickname(profile.nickname) || cleanNickname(discovered.nickname),
          avatar_url: profile.avatar_url || discovered.avatar_url,
          homepage_url: profile.homepage_url || discovered.homepage_url,
          platform_account_id: profile.platform_account_id || discovered.platform_account_id,
        };
      }
    }

    if (!completeEvidence(profile, session.platform)) {
      return {
        ok: true,
        status: 'checking',
        message: !profile.platform_account_id && !profile.homepage_url
          ? '登录成功，正在识别账号身份'
          : '登录成功，正在识别昵称和头像',
      };
    }

    const completed = await request(`/api/account-login-sessions/${accountId}/complete`, {
      method: 'POST',
      body: JSON.stringify({
        profile_nickname: cleanNickname(profile.nickname || profile.profile_nickname),
        avatar_url: profile.avatar_url || null,
        homepage_url: profile.homepage_url || null,
        platform_account_id: profile.platform_account_id || null,
        add_to_collect_targets: session.add_to_collect_targets === true,
      }),
    });
    const finalId = Number(completed.account_id);
    let adopted = true;
    if (finalId !== accountId && adoptLoginSession) {
      try {
        const adoptedResult = await adoptLoginSession({ from_id: accountId, to_id: finalId });
        adopted = adoptedResult?.ok !== false;
      } catch {
        adopted = false;
      }
    }
    lastDiscoveryAt.delete(accountId);
    return { ...completed, ok: true, status: 'completed', account_id: finalId, adopted };
  }

  async function cancelLogin(session = {}) {
    const accountId = Number(session.account_id);
    if (!Number.isFinite(accountId)) return { ok: false, status: 'error', message: 'invalid login session' };
    let viewError = null;
    if (cancelLoginView) {
      try {
        await cancelLoginView({ account_id: accountId, partition: session.partition });
      } catch (error) {
        viewError = error;
      }
    }
    let result;
    try {
      result = await request(`/api/account-login-sessions/${accountId}`, { method: 'DELETE' });
    } finally {
      lastDiscoveryAt.delete(accountId);
    }
    if (viewError) throw viewError;
    return { ...result, ok: true, status: 'cancelled' };
  }

  return { beginLogin, inspectLogin, cancelLogin };
}

module.exports = { createAccountLifecycle };

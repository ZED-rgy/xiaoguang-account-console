(function accountVisualsModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AccountVisuals = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createAccountVisuals() {
  const PLATFORMS = {
    '抖音': { key: 'douyin', icon: 'douyin.svg' },
    '快手': { key: 'kuaishou', icon: 'kuaishou.svg' },
    '小红书': { key: 'xiaohongshu', icon: 'xiaohongshu.svg' },
    'B站': { key: 'bilibili', icon: 'bilibili.svg' },
    '咸鱼': { key: 'xianyu', icon: 'xianyu.svg' },
  };

  function configurePlatformVisuals(capabilities = []) {
    capabilities.forEach((item) => {
      const name = String(item?.name || '').trim();
      if (!name) return;
      PLATFORMS[name] = {
        key: String(item.key || 'default'),
        icon: String(item.icon || 'default.svg'),
      };
    });
  }

  function getPlatformVisual(platform) {
    const label = String(platform || '其他平台');
    const item = PLATFORMS[label] || { key: 'default', icon: 'default.svg' };
    return {
      key: item.key,
      label,
      iconPath: `/assets/platform-icons/${item.icon}`,
    };
  }

  function resolveLoginStatus(account = {}) {
    return account.login_status
      || (account.profile_synced_at ? '已登录' : (account.profile_path ? '待登录' : '未登录'));
  }

  function getAccountVisualState(account = {}) {
    const status = resolveLoginStatus(account);
    const isLoggedIn = status === '已登录';
    return {
      status,
      isLoggedIn,
      className: isLoggedIn ? 'account-online' : 'account-offline',
    };
  }

  function stripRepeatedStatus(detail, status) {
    const text = String(detail || '');
    const state = String(status || '');
    if (!state || text === state) return text === state ? '' : text;
    const prefix = `${state} · `;
    return text.startsWith(prefix) ? text.slice(prefix.length) : text;
  }

  return {
    configurePlatformVisuals,
    getPlatformVisual,
    resolveLoginStatus,
    getAccountVisualState,
    stripRepeatedStatus,
  };
}));

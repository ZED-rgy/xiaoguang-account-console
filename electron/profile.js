// 账号资料选择纯逻辑：页面采集与可信候选判断分离，便于逐平台回归测试。

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function candidateScore(candidate) {
  const src = String(candidate.src || '');
  const text = `${candidate.alt || ''} ${candidate.text || ''} ${src}`.toLowerCase();
  const width = Number(candidate.width) || 0;
  const height = Number(candidate.height) || 0;
  const square = width > 0 && height > 0
    && Math.abs(width - height) <= Math.max(width, height) * 0.35;
  let score = candidate.trusted ? 12 : 0;
  if (/avatar|face|head|profile|author|portrait|头像|\/bfs\/face\/|aweme-avatar|uhead|sns-avatar/.test(text)) score += 6;
  if (candidate.topRight) score += 5;
  if (square) score += 4;
  if (width >= 32 && height >= 32 && width <= 320 && height <= 320) score += 3;
  if (/sprite|icon|emoji|qrcode|qr|banner|cover|background|captcha|logo|ai创作工具/.test(text)) score -= 12;
  return score;
}

function candidateNickname(candidate) {
  const raw = cleanText(candidate.nickname || candidate.alt || candidate.title);
  if (!raw || /ai创作工具|头像|avatar|创作中心|投稿|数据中心/i.test(raw)) return null;
  return raw.slice(0, 80);
}

function publicTitleNickname(url, title) {
  if (!isPublicHomepage(url)) return null;
  let value = cleanText(title)
    .replace(/的个人空间.*$/, '')
    .replace(/的个人主页.*$/, '')
    .replace(/的主页.*$/, '')
    .replace(/\s*[-_|].*$/, '')
    .trim();
  if (!value || value.length < 2 || /哔哩哔哩|抖音|快手|小红书|创作者中心|首页/.test(value)) return null;
  return value.slice(0, 80);
}

function isPublicHomepage(url) {
  try {
    const parsed = new URL(url);
    return (parsed.host === 'www.douyin.com' && /^\/user\//.test(parsed.pathname))
      || parsed.host === 'space.bilibili.com'
      || (parsed.host === 'www.kuaishou.com' && /^\/profile\//.test(parsed.pathname))
      || (parsed.host === 'www.xiaohongshu.com' && /^\/user\/profile\//.test(parsed.pathname));
  } catch {
    return false;
  }
}

function isCreatorWorkspace(url) {
  try {
    return ['creator.douyin.com', 'cp.kuaishou.com', 'creator.xiaohongshu.com', 'member.bilibili.com', 'www.goofish.com']
      .includes(new URL(url).host);
  } catch {
    return false;
  }
}

function platformForUrl(url) {
  try {
    const host = new URL(url).host;
    if (host === 'creator.douyin.com' || host === 'www.douyin.com') return '抖音';
    if (host === 'cp.kuaishou.com' || host === 'www.kuaishou.com') return '快手';
    if (host === 'creator.xiaohongshu.com' || host === 'www.xiaohongshu.com') return '小红书';
    if (host === 'member.bilibili.com' || host === 'space.bilibili.com') return 'B站';
    if (host === 'www.goofish.com') return '咸鱼';
  } catch { /* ignore invalid URL */ }
  return null;
}

function accountIdentity(platform, urls) {
  const patterns = {
    '抖音': /^https?:\/\/www\.douyin\.com\/user\/([\w.-]+)/i,
    '快手': /^https?:\/\/www\.kuaishou\.com\/profile\/([\w.-]+)/i,
    '小红书': /^https?:\/\/www\.xiaohongshu\.com\/user\/profile\/([\w.-]+)/i,
    'B站': /^https?:\/\/space\.bilibili\.com\/(\d+)/i,
  };
  if (platform === '咸鱼') {
    for (const raw of urls) {
      try {
        const parsed = new URL(String(raw || ''));
        if (parsed.host !== 'www.goofish.com') continue;
        const userId = parsed.searchParams.get('userId') || parsed.searchParams.get('userid');
        if (userId) {
          return {
            homepage_url: `https://www.goofish.com/personal?userId=${encodeURIComponent(userId)}`,
            platform_account_id: userId,
          };
        }
      } catch { /* ignore invalid link */ }
    }
    return { homepage_url: '', platform_account_id: '' };
  }
  const pattern = patterns[platform];
  if (!pattern) return { homepage_url: '', platform_account_id: '' };
  for (const raw of urls) {
    const value = String(raw || '');
    const match = value.match(pattern);
    if (match) return { homepage_url: match[0], platform_account_id: match[1] };
  }
  return { homepage_url: '', platform_account_id: '' };
}

function accountIdentityFromHints(platform, hints = {}) {
  const definitions = {
    '小红书': {
      value: hints.xiaohongshuUserId,
      valid: /^[a-f0-9]{24}$/i,
      homepage: id => `https://www.xiaohongshu.com/user/profile/${id}`,
    },
    '快手': {
      value: hints.kuaishouUserId,
      // 创作者中心 userId 是纯数字内部号，不能作为公开 /profile/ 的 principal id。
      valid: /^(?=.*[a-z])[a-z0-9._-]{3,64}$/i,
      homepage: id => `https://www.kuaishou.com/profile/${id}`,
    },
    'B站': {
      value: hints.bilibiliUserId,
      valid: /^\d{1,20}$/,
      homepage: id => `https://space.bilibili.com/${id}`,
    },
  };
  const definition = definitions[platform];
  if (!definition) return { homepage_url: '', platform_account_id: '' };
  const id = cleanText(definition.value);
  if (!definition.valid.test(id)) return { homepage_url: '', platform_account_id: '' };
  return { homepage_url: definition.homepage(id), platform_account_id: id };
}

function selectProfileSnapshot(snapshot = {}) {
  const url = String(snapshot.url || '');
  const title = String(snapshot.title || '');
  const pageText = String(snapshot.pageText || '');
  const urlLooksLoggedOut = /login|passport|captcha/i.test(url);
  const titleLooksLoggedOut = /扫码登录|账号登录|验证码|安全验证/i.test(title);
  const pageLooksLoggedOut = /请.{0,12}(?:扫码|登录)|(?:立即|马上|点击|扫码|账号|手机号|验证码)登录|登录注册|未登录|登录后继续|请输入验证码|完成安全验证/i.test(pageText);
  if (urlLooksLoggedOut || titleLooksLoggedOut || pageLooksLoggedOut) {
    return { ok: false, reason: 'login-page', login_status: '未登录', message: '当前仍是登录页' };
  }
  const ranked = (Array.isArray(snapshot.candidates) ? snapshot.candidates : [])
    .map((candidate) => ({ ...candidate, score: candidateScore(candidate) }))
    .filter((candidate) => /^https?:\/\//i.test(candidate.src || '') && candidate.score >= 12)
    .sort((a, b) => b.score - a.score);
  const best = ranked[0] || null;
  const metaAvatar = String(snapshot.metaAvatar || '');
  const useMeta = !best && isPublicHomepage(url) && /^https?:\/\//i.test(metaAvatar)
    && !/logo|banner|login|passport|qrcode|captcha/i.test(metaAvatar);
  const visibleText = `${title} ${pageText}`;
  const errorPage = /(?:^|\D)(?:404|500)(?:\D|$)|页面出错|页面不存在|访问异常|something went wrong|network error/i.test(visibleText);
  const workspaceSignal = /投稿管理|发布作品|作品管理|内容管理|数据中心|粉丝管理|账号设置|个人中心|退出登录/.test(visibleText);
  const authenticated = isCreatorWorkspace(url) && !errorPage && (Boolean(best?.trusted) || workspaceSignal);
  if (!authenticated && !isPublicHomepage(url)) {
    return {
      ok: false,
      reason: 'unknown-page',
      login_status: '未知',
      message: '当前页面未确认登录状态',
    };
  }
  const platform = platformForUrl(url);
  const hintedIdentity = accountIdentityFromHints(platform, snapshot.identityHints);
  const creatorHintRequired = authenticated && ['小红书', '快手', 'B站'].includes(platform);
  let identity = authenticated && hintedIdentity.platform_account_id
    ? hintedIdentity
    : (creatorHintRequired ? { homepage_url: '', platform_account_id: '' } : accountIdentity(platform, [
    url,
    best?.href,
    ...(Array.isArray(snapshot.candidates)
      ? snapshot.candidates.filter(candidate => candidate.trusted).map(candidate => candidate.href)
      : []),
    ]));
  if (!identity.platform_account_id) {
    identity = hintedIdentity;
  }
  return {
    ok: true,
    login_status: authenticated ? '已登录' : null,
    platform,
    url,
    title: cleanText(title),
    nickname: (best ? candidateNickname(best) : null) || publicTitleNickname(url, title),
    avatar_url: best ? best.src : (useMeta ? metaAvatar : ''),
    avatar_score: best ? best.score : (useMeta ? 9 : 0),
    homepage_url: identity.homepage_url,
    platform_account_id: identity.platform_account_id,
    platform_internal_id: platform === '快手' && /^\d+$/.test(String(snapshot.identityHints?.kuaishouUserId || ''))
      ? String(snapshot.identityHints.kuaishouUserId)
      : '',
  };
}

module.exports = { selectProfileSnapshot };

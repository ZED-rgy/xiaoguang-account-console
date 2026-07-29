const test = require('node:test');
const assert = require('node:assert/strict');

const { selectProfileSnapshot } = require('../electron/profile');

test('B站创作中心识别可信账号头像和昵称', () => {
  const profile = selectProfileSnapshot({
    url: 'https://member.bilibili.com/platform/upload/video/frame',
    title: '哔哩哔哩创作中心',
    pageText: '投稿 数据中心 粉丝管理',
    candidates: [
      {
        src: 'https://i0.hdslb.com/bfs/face/member-avatar.jpg',
        alt: '小光在成长ing',
        text: '小光在成长ing',
        width: 48,
        height: 48,
        trusted: true,
      },
      {
        src: 'https://i0.hdslb.com/bfs/face/ai-tool-avatar.jpg',
        alt: 'AI创作工具',
        text: '试试更多AI创作工具吧',
        width: 48,
        height: 48,
        trusted: false,
      },
    ],
  });

  assert.equal(profile.ok, true);
  assert.equal(profile.login_status, '已登录');
  assert.equal(profile.avatar_url, 'https://i0.hdslb.com/bfs/face/member-avatar.jpg');
  assert.equal(profile.nickname, '小光在成长ing');
  assert.ok(profile.avatar_score >= 12);
});

test('登录页保持未登录且不采纳二维码或宣传头像', () => {
  const profile = selectProfileSnapshot({
    url: 'https://passport.bilibili.com/login',
    title: '扫码登录',
    pageText: '请使用客户端扫码登录',
    candidates: [
      {
        src: 'https://example.com/ai-avatar.png',
        alt: 'AI创作工具',
        text: '试试更多AI创作工具吧',
        width: 48,
        height: 48,
        trusted: true,
      },
    ],
  });

  assert.equal(profile.ok, false);
  assert.equal(profile.reason, 'login-page');
  assert.equal(profile.login_status, '未登录');
  assert.equal(profile.avatar_url, undefined);
});

test('公开主页可以使用可信的 og:image 作为头像兜底', () => {
  const profile = selectProfileSnapshot({
    url: 'https://space.bilibili.com/123456',
    title: '小光在成长ing的个人空间',
    pageText: '小光在成长ing 关注 发消息',
    metaAvatar: 'https://i0.hdslb.com/bfs/face/public-avatar.jpg',
    candidates: [],
  });

  assert.equal(profile.ok, true);
  assert.equal(profile.avatar_url, 'https://i0.hdslb.com/bfs/face/public-avatar.jpg');
  assert.ok(profile.avatar_score >= 8);
  assert.equal(profile.nickname, '小光在成长ing');
});

test('创作者域名的错误页不会被误判为已登录', () => {
  const profile = selectProfileSnapshot({
    url: 'https://member.bilibili.com/platform/upload/video/frame',
    title: '500 - 页面出错了',
    pageText: 'Something went wrong，请稍后重试',
    candidates: [],
  });

  assert.equal(profile.ok, false);
  assert.equal(profile.reason, 'unknown-page');
  assert.notEqual(profile.login_status, '已登录');
});

test('抖音、快手和小红书公开主页提取安全昵称', () => {
  const cases = [
    ['https://www.douyin.com/user/MS4wLjABAAAA', '小光英语 - 抖音'],
    ['https://www.kuaishou.com/profile/3xabc', '小光英语的个人主页'],
    ['https://www.xiaohongshu.com/user/profile/abc123', '小光英语 - 小红书'],
  ];
  cases.forEach(([url, title]) => {
    const profile = selectProfileSnapshot({
      url,
      title,
      pageText: '作品 关注 粉丝',
      metaAvatar: 'https://example.com/avatar.jpg',
      candidates: [],
    });
    assert.equal(profile.ok, true);
    assert.equal(profile.nickname, '小光英语');
    assert.notEqual(profile.login_status, '已登录');
  });
});

test('创作者页面显示请登录时保持未登录', () => {
  const profile = selectProfileSnapshot({
    url: 'https://member.bilibili.com/platform/upload/video/frame',
    title: '哔哩哔哩创作中心',
    pageText: '请登录',
    candidates: [],
  });

  assert.equal(profile.ok, false);
  assert.equal(profile.reason, 'login-page');
  assert.equal(profile.login_status, '未登录');
});

test('创作者落地页显示立即登录时不会自动创建账号', () => {
  const profile = selectProfileSnapshot({
    url: 'https://creator.douyin.com/creator-micro/home',
    title: '抖音创作者中心',
    pageText: '一站式创作服务 立即登录 数据中心',
    candidates: [],
  });

  assert.equal(profile.ok, false);
  assert.equal(profile.reason, 'login-page');
  assert.equal(profile.login_status, '未登录');
});

test('创作者页面从账号主页链接提取稳定平台身份', () => {
  const profile = selectProfileSnapshot({
    url: 'https://member.bilibili.com/platform/home',
    title: '哔哩哔哩创作中心',
    pageText: '投稿 数据中心 粉丝管理',
    identityHints: { bilibiliUserId: '12345678' },
    links: [
      'https://member.bilibili.com/platform/upload/video/frame',
      'https://space.bilibili.com/12345678',
    ],
    candidates: [{
      src: 'https://i0.hdslb.com/bfs/face/member-avatar.jpg',
      alt: '小光在成长ing',
      text: 'avatar',
      href: 'https://space.bilibili.com/12345678',
      width: 48,
      height: 48,
      trusted: true,
    }],
  });

  assert.equal(profile.ok, true);
  assert.equal(profile.platform, 'B站');
  assert.equal(profile.homepage_url, 'https://space.bilibili.com/12345678');
  assert.equal(profile.platform_account_id, '12345678');
});

test('抖音主页身份保留 sec_uid 中的点号', () => {
  const profile = selectProfileSnapshot({
    url: 'https://creator.douyin.com/creator-micro/home',
    title: '抖音创作者中心',
    pageText: '投稿管理 作品管理 数据中心',
    links: ['https://www.douyin.com/user/MS4wLjABAAAA.abc_123-xyz?from_tab_name=main'],
    candidates: [{
      src: 'https://example.com/aweme-avatar/account.jpeg',
      alt: '小光英语',
      text: 'avatar',
      href: 'https://www.douyin.com/user/MS4wLjABAAAA.abc_123-xyz?from_tab_name=main',
      width: 48,
      height: 48,
      trusted: true,
    }],
  });

  assert.equal(profile.ok, true);
  assert.equal(profile.platform_account_id, 'MS4wLjABAAAA.abc_123-xyz');
  assert.equal(profile.homepage_url, 'https://www.douyin.com/user/MS4wLjABAAAA.abc_123-xyz');
});

test('创作者登录态身份优先于页面中的其他账号链接', () => {
  const profile = selectProfileSnapshot({
    url: 'https://member.bilibili.com/platform/home',
    title: '哔哩哔哩创作中心',
    pageText: '投稿管理 作品管理 数据中心',
    identityHints: { bilibiliUserId: '123456' },
    links: ['https://space.bilibili.com/999999'],
    candidates: [{
      src: 'https://i0.hdslb.com/bfs/face/current.jpg',
      alt: '当前账号',
      text: 'avatar',
      href: 'https://space.bilibili.com/123456',
      width: 48,
      height: 48,
      trusted: true,
    }],
  });

  assert.equal(profile.platform_account_id, '123456');
  assert.equal(profile.homepage_url, 'https://space.bilibili.com/123456');
});

test('B站创作者页缺少当前登录身份时不采用页面中的其他作者链接', () => {
  const profile = selectProfileSnapshot({
    url: 'https://member.bilibili.com/platform/home',
    title: '哔哩哔哩创作中心',
    pageText: '投稿管理 作品管理 数据中心',
    candidates: [{
      src: 'https://i0.hdslb.com/bfs/face/recommended.jpg',
      alt: '推荐作者', text: 'user avatar',
      href: 'https://space.bilibili.com/471516177',
      width: 48, height: 48, trusted: true,
    }],
  });

  assert.equal(profile.ok, true);
  assert.equal(profile.platform_account_id, '');
  assert.equal(profile.homepage_url, '');
  assert.equal(profile.platform_internal_id, '');
});

test('咸鱼个人页链接提取 userId 作为稳定身份', () => {
  const profile = selectProfileSnapshot({
    url: 'https://www.goofish.com/',
    title: '闲鱼',
    pageText: '个人中心 发布作品 退出登录',
    links: ['https://www.goofish.com/personal?userId=2201234567890'],
    candidates: [{
      src: 'https://example.com/avatar.jpg',
      alt: '闲鱼用户',
      text: 'user avatar',
      href: 'https://www.goofish.com/personal?userId=2201234567890',
      width: 48,
      height: 48,
      trusted: true,
    }],
  });

  assert.equal(profile.ok, true);
  assert.equal(profile.platform_account_id, '2201234567890');
  assert.equal(profile.homepage_url, 'https://www.goofish.com/personal?userId=2201234567890');
});

test('小红书创作者中心使用登录态 userId 自动生成主页链接', () => {
  const profile = selectProfileSnapshot({
    url: 'https://creator.xiaohongshu.com/new/home',
    title: '小红书创作服务平台',
    pageText: '发布笔记 数据中心 退出登录',
    identityHints: { xiaohongshuUserId: '6810b3340000000006011f98' },
    candidates: [{
      src: 'https://sns-avatar.example.com/current.jpg',
      alt: '小光在成长ing', text: 'user avatar', width: 48, height: 48, trusted: true,
    }],
  });

  assert.equal(profile.ok, true);
  assert.equal(profile.platform_account_id, '6810b3340000000006011f98');
  assert.equal(profile.homepage_url, 'https://www.xiaohongshu.com/user/profile/6810b3340000000006011f98');
});

test('快手创作者中心数字 userId 不是公开主页 principal id', () => {
  const profile = selectProfileSnapshot({
    url: 'https://cp.kuaishou.com/profile',
    title: '快手创作者服务平台',
    pageText: '作品管理 数据中心 退出登录',
    identityHints: { kuaishouUserId: '4768338482' },
    candidates: [{
      src: 'https://example.com/uhead/current.jpg',
      alt: '小光在成长ing', text: 'user avatar', width: 48, height: 48, trusted: true,
    }],
  });

  assert.equal(profile.ok, true);
  assert.equal(profile.platform_account_id, '');
  assert.equal(profile.homepage_url, '');
  assert.equal(profile.platform_internal_id, '4768338482');
});

test('快手登录态主页身份兼容字母数字 ID', () => {
  const profile = selectProfileSnapshot({
    url: 'https://cp.kuaishou.com/profile',
    title: '快手创作者服务平台',
    pageText: '作品管理 数据中心 退出登录',
    identityHints: { kuaishouUserId: '3xabc-user' },
    candidates: [{
      src: 'https://example.com/uhead/current.jpg',
      text: 'user avatar', width: 48, height: 48, trusted: true,
    }],
  });

  assert.equal(profile.platform_account_id, '3xabc-user');
  assert.equal(profile.homepage_url, 'https://www.kuaishou.com/profile/3xabc-user');
});

test('B站创作中心使用 DedeUserID 自动生成主页链接', () => {
  const profile = selectProfileSnapshot({
    url: 'https://member.bilibili.com/platform/home',
    title: '哔哩哔哩创作中心',
    pageText: '投稿管理 数据中心 粉丝管理',
    identityHints: { bilibiliUserId: '3494372721035952' },
    candidates: [{
      src: 'https://i0.hdslb.com/bfs/face/current.jpg',
      alt: '小光在成长ing', text: 'user avatar',
      href: 'https://space.bilibili.com/471516177',
      width: 48, height: 48, trusted: true,
    }],
  });

  assert.equal(profile.ok, true);
  assert.equal(profile.platform_account_id, '3494372721035952');
  assert.equal(profile.homepage_url, 'https://space.bilibili.com/3494372721035952');
});

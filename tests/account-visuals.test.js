const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  configurePlatformVisuals,
  getPlatformVisual,
  getAccountVisualState,
  resolveLoginStatus,
  stripRepeatedStatus,
} = require('../frontend/account-visuals');

test('后端平台能力声明可配置新增平台视觉', () => {
  configurePlatformVisuals([{ name: '微信视频号', key: 'wechat-video', icon: 'default.svg' }]);
  assert.deepEqual(getPlatformVisual('微信视频号'), {
    key: 'wechat-video',
    label: '微信视频号',
    iconPath: '/assets/platform-icons/default.svg',
  });
});

test('五个平台映射到项目自制的本地文字徽标', () => {
  const cases = {
    抖音: 'douyin.svg',
    快手: 'kuaishou.svg',
    小红书: 'xiaohongshu.svg',
    B站: 'bilibili.svg',
    咸鱼: 'xianyu.svg',
  };

  Object.entries(cases).forEach(([platform, file]) => {
    const visual = getPlatformVisual(platform);
    assert.equal(visual.label, platform);
    assert.equal(visual.iconPath, `/assets/platform-icons/${file}`);
    assert.equal(
      fs.existsSync(path.join(__dirname, '..', 'frontend', visual.iconPath.replace('/assets/', ''))),
      true,
      `${platform} 图标应随应用本地打包`,
    );
  });
});

test('采集完成事件统一刷新账号、作品和总览数据', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../frontend/app.js'),
    'utf8',
  );
  assert.match(source, /async function refreshCollectedData\(\)/);
  assert.match(source, /Promise\.all\(\[loadAccounts\(\), loadWorks\(\), loadDashboard\(\), loadCollectHistory\(\)\]\)/);
  assert.match(source, /p\.stage === 'finished'[\s\S]{0,300}summary\?\.trigger === 'scheduled'[\s\S]{0,200}refreshCollectedData\(\)/);
  assert.match(source, /async function collectAccountData[\s\S]+await refreshCollectedData\(\)/);
});

test('登录账号保持正常显示，其他登录态统一置灰', () => {
  assert.deepEqual(getAccountVisualState({ login_status: '已登录' }), {
    status: '已登录',
    isLoggedIn: true,
    className: 'account-online',
  });

  ['未登录', '待登录', '登录失效'].forEach((status) => {
    assert.deepEqual(getAccountVisualState({ login_status: status }), {
      status,
      isLoggedIn: false,
      className: 'account-offline',
    });
  });
});

test('旧账号按同步记录和浏览器资料目录推断登录态', () => {
  assert.equal(resolveLoginStatus({ profile_synced_at: '2026-07-10T12:00:00' }), '已登录');
  assert.equal(resolveLoginStatus({ profile_path: 'profiles/douyin-a' }), '待登录');
  assert.equal(resolveLoginStatus({}), '未登录');
});

test('未知平台使用通用本地图标', () => {
  assert.deepEqual(getPlatformVisual('视频号'), {
    key: 'default',
    label: '视频号',
    iconPath: '/assets/platform-icons/default.svg',
  });
});

test('同步说明移除重复状态时不把自定义状态当作正则', () => {
  assert.equal(stripRepeatedStatus('已登录 · 资料待同步', '已登录'), '资料待同步');
  assert.equal(stripRepeatedStatus('未登录', '未登录'), '');
  assert.equal(stripRepeatedStatus('[ · 自定义说明', '['), '自定义说明');
});

test('账号管理承载平台标签和添加账号入口，不再保留独立工作区导航', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
  assert.match(html, /id="accountManagerTab"/);
  assert.match(html, /id="newAccountBtn"[^>]*>＋ 添加账号</);
  assert.match(html, /id="platformPicker"/);
  assert.match(html, /登录成功后账号会自动加入列表/);
  assert.doesNotMatch(html, /data-view="workspace"/);
  assert.doesNotMatch(html, /id="workspaceView"/);
});

test('添加账号使用隐藏登录会话并在登录成功后自动完成同步', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');
  assert.match(appSource, /beginAccountLogin\(\{ platform, addToCollectTargets \}\)/);
  assert.match(appSource, /inspectAccountLogin\(\{/);
  assert.match(appSource, /cancelAccountLogin\?\.\(\{/);
  assert.doesNotMatch(appSource, /api\('\/api\/account-login-sessions'/);
  assert.match(appSource, /state\.loginSessions\.delete\(id\)/);
  assert.match(appSource, /await loadAccounts\(\)/);
  assert.match(appSource, /if \(!done && state\.loginSessions\.has\(id\)\) scheduleLoginInspection\(id, 3000\)/);

  const electronSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.match(electronSource, /createAccountLifecycle\(/);
  assert.match(electronSource, /preserved_existing: true/);
  assert.doesNotMatch(electronSource, /if \(workspaceTabs\.has\(toId\)\) closeWorkspaceTab\(toId\)/);
});

test('采集中心优先选择已有账号，新账号登录作为次级入口', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');
  assert.match(html, /id="collectNewAccount"[^>]*>＋ 添加采集目标</);
  assert.match(html, /id="collectTargetPicker"/);
  assert.match(html, /直接选择已有账号，不需要重新登录/);
  assert.match(html, /id="collectLoginNewAccount"[^>]*>登录新账号</);
  assert.match(appSource, /api\('\/api\/collect\/targets', \{ method: 'POST'/);
  assert.match(appSource, /removeCollectTarget\(\$\{a\.id\}\)/);
  assert.match(appSource, /LOGIN_PLATFORMS\.filter\(\(\[platform\]\) => state\.collectSupported\.includes\(platform\)\)/);
  assert.doesNotMatch(appSource, /onclick="removeAccount\(\$\{a\.id\}\)">删除<\/button>/);
});

test('作品页突出最近采集结果并保留发布时间排序', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');
  const worksView = html.slice(html.indexOf('id="worksView"'), html.indexOf('id="collectView"'));

  assert.match(worksView, /id="workSort"/);
  assert.match(worksView, /最近采集/);
  assert.match(worksView, /最新发布/);
  assert.match(worksView, /采集时间/);
  assert.match(appSource, /params\.set\('sort', \$\('#workSort'\)\.value\)/);
  assert.match(appSource, /timeText\(w\.collected_at\)/);
});

test('账号数据对比使用账号名和平台组成唯一标签', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');
  assert.match(appSource, /labels: ba\.map\(a => `\$\{a\.account_name\} · \$\{a\.platform\}`\)/);
});

test('平台数据对比保留时间范围内零作品的已采集平台', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');
  assert.match(appSource, /const bp = d\.by_platform \|\| \[\];/);
  assert.doesNotMatch(appSource, /d\.by_platform[^;]*\.filter\(p => p\.works > 0\)/);
});

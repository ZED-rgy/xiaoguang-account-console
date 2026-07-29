const test = require('node:test');
const assert = require('node:assert/strict');

const {
  capabilities,
  extractLoadableUrl,
  isCollectableHomepage,
} = require('../electron/platform-capabilities');

test('shared platform capabilities drive collection support and homepage rules', () => {
  assert.deepEqual(
    capabilities.filter((item) => item.collect_supported).map((item) => item.name),
    ['抖音', '快手', '小红书', 'B站'],
  );
  assert.equal(
    extractLoadableUrl('B站主页 https://space.bilibili.com/123456'),
    'https://space.bilibili.com/123456/video',
  );
  assert.equal(
    extractLoadableUrl('https://space.bilibili.com/123456/dynamic'),
    'https://space.bilibili.com/123456/video',
  );
  assert.equal(isCollectableHomepage('快手', 'https://www.kuaishou.com/profile/4768338482'), false);
  assert.equal(isCollectableHomepage('快手', 'https://www.kuaishou.com/profile/3xabc-user'), true);
  assert.equal(isCollectableHomepage('咸鱼', 'https://www.goofish.com/personal?userId=1'), false);
});

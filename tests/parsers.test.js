// 采集解析层回归测试：node --test tests
// 样本结构取自各平台真实接口响应（已脱敏精简），改 adapter 前先跑这里。
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ADAPTERS,
  extractLoadableUrl,
  numOr,
  toDateTimeAuto,
  xiaohongshuInitialNotes,
  xiaohongshuTimestampFromId,
  isCollectableHomepage,
  selectKuaishouSearchIdentity,
} = require('../electron/parsers');

// ---------- numOr：口语计数解析 ----------
test('numOr 解析数字与口语计数', () => {
  assert.equal(numOr(521), 521);
  assert.equal(numOr('1234'), 1234);
  assert.equal(numOr('1,234'), 1234);
  assert.equal(numOr('1.2万'), 12000);
  assert.equal(numOr('3亿'), 300000000);
  assert.equal(numOr('5k'), 5000);
  assert.equal(numOr('2.5w'), 25000);
  assert.equal(numOr(null), null);
  assert.equal(numOr(''), null);
  assert.equal(numOr('赞'), null);
  assert.equal(numOr(NaN), null);
});

// ---------- toDateTimeAuto：秒/毫秒时间戳 ----------
test('toDateTimeAuto 秒和毫秒时间戳结果一致', () => {
  const fromSeconds = toDateTimeAuto(1700000000);
  const fromMillis = toDateTimeAuto(1700000000000);
  assert.equal(fromSeconds, fromMillis);
  assert.match(fromSeconds, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(toDateTimeAuto(0), null);
  assert.equal(toDateTimeAuto('abc'), null);
});

// ---------- extractLoadableUrl：主页链接提炼 ----------
test('extractLoadableUrl 抖音分享口令提炼短链并补斜杠', () => {
  const share = '7- 长按复制此条消息，打开抖音搜索，查看TA的更多作品。 https://v.douyin.com/iAbCdEf 复制此链接';
  assert.equal(extractLoadableUrl(share), 'https://v.douyin.com/iAbCdEf/');
});

test('extractLoadableUrl 抖音标准主页优先于短链', () => {
  const text = '主页 https://www.douyin.com/user/MS4wLjABAAAA-xyz_123 短链 https://v.douyin.com/abc/';
  assert.equal(extractLoadableUrl(text), 'https://www.douyin.com/user/MS4wLjABAAAA-xyz_123');
});

test('extractLoadableUrl B站空间链接规整到投稿页', () => {
  assert.equal(
    extractLoadableUrl('https://space.bilibili.com/12345678?spm_id_from=333.1007'),
    'https://space.bilibili.com/12345678/video',
  );
  assert.equal(
    extractLoadableUrl('https://b23.tv/AbCd12'),
    'https://b23.tv/AbCd12',
  );
});

test('extractLoadableUrl 快手与小红书主页/短链', () => {
  assert.equal(
    extractLoadableUrl('https://www.kuaishou.com/profile/3xabc-def_99'),
    'https://www.kuaishou.com/profile/3xabc-def_99',
  );
  assert.equal(
    extractLoadableUrl('看看我的主页 https://www.xiaohongshu.com/user/profile/5ff0a1b2c3d4e5f6a7b8c9d0'),
    'https://www.xiaohongshu.com/user/profile/5ff0a1b2c3d4e5f6a7b8c9d0',
  );
  assert.equal(
    extractLoadableUrl('http://xhslink.com/a/AbC123deF'),
    'http://xhslink.com/a/AbC123deF',
  );
});

test('extractLoadableUrl 无链接文本原样返回', () => {
  assert.equal(extractLoadableUrl('还没有填主页'), '还没有填主页');
  assert.equal(extractLoadableUrl(null), '');
});

// ---------- 抖音 adapter ----------
test('抖音 parse 提取互动数与发布时间', () => {
  const sample = {
    aweme_list: [
      {
        aweme_id: '7300000000000000001',
        desc: '  第一支视频  ',
        create_time: 1719800000,
        statistics: { digg_count: 5334, comment_count: 120, collect_count: 88, share_count: 45, play_count: 0 },
      },
      { desc: '缺 aweme_id 应被过滤', statistics: {} },
    ],
  };
  const works = ADAPTERS['抖音'].parse(sample);
  assert.equal(works.length, 1);
  const w = works[0];
  assert.equal(w.platform_work_id, '7300000000000000001');
  assert.equal(w.title, '第一支视频');
  assert.equal(w.work_url, 'https://www.douyin.com/video/7300000000000000001');
  assert.equal(w.likes, 5334);
  assert.equal(w.comments, 120);
  assert.equal(w.favorites, 88);
  assert.equal(w.shares, 45);
  assert.equal(w.plays, null); // 抖音公开页拿不到播放量，play_count=0 归一为 null
  assert.match(w.published_at, /^\d{4}-\d{2}-\d{2} /);
});

test('抖音 parse 非法输入返回空数组', () => {
  assert.deepEqual(ADAPTERS['抖音'].parse(null), []);
  assert.deepEqual(ADAPTERS['抖音'].parse({}), []);
  assert.deepEqual(ADAPTERS['抖音'].parse({ aweme_list: 'oops' }), []);
});

test('抖音 apiPattern 匹配作品列表接口', () => {
  assert.match('https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=x', ADAPTERS['抖音'].apiPattern);
  assert.doesNotMatch('https://www.douyin.com/aweme/v1/web/comment/list/', ADAPTERS['抖音'].apiPattern);
});

// ---------- 快手 adapter ----------
test('快手 parse 提取 GraphQL 作品列表', () => {
  const sample = {
    data: {
      visionProfilePhotoList: {
        feeds: [
          {
            photo: {
              id: '3xkuaishou001',
              caption: '快手视频标题',
              timestamp: 1719800000000, // 毫秒
              realLikeCount: '1.2万',
              likeCount: '12000',
              commentCount: 356,
              shareCount: '88',
              viewCount: '45.6万',
            },
          },
          { photo: {} }, // 无 id 应被过滤
        ],
      },
    },
  };
  const works = ADAPTERS['快手'].parse(sample);
  assert.equal(works.length, 1);
  const w = works[0];
  assert.equal(w.platform_work_id, '3xkuaishou001');
  assert.equal(w.work_url, 'https://www.kuaishou.com/short-video/3xkuaishou001');
  assert.equal(w.likes, 12000);      // realLikeCount 优先
  assert.equal(w.comments, 356);
  assert.equal(w.favorites, null);   // 快手无收藏（平台限制）
  assert.equal(w.shares, 88);
  assert.equal(w.plays, 456000);
  assert.match(w.published_at, /^\d{4}-\d{2}-\d{2} /);
});

test('快手 parse 兼容新版 REST profile feed', () => {
  const sample = {
    result: 1,
    feeds: [{
      photo: {
        id: '3xzmmhtr8a4vqai',
        caption: '考研高频词，每日打卡一遍',
        timestamp: 1784016373064,
        likeCount: 8,
        collectCount: 2,
        viewCount: 91,
      },
      comment: { us_c: 3 },
      author: {
        id: '3xarpr5pxq368tg',
        name: '小光英语 ing',
        headerUrl: 'https://p22.a.yximgs.com/uhead/avatar.jpg',
      },
    }],
  };

  assert.match('https://www.kuaishou.com/rest/v/profile/feed?caver=2', ADAPTERS['快手'].apiPattern);
  const works = ADAPTERS['快手'].parse(sample);
  assert.equal(works.length, 1);
  assert.equal(works[0].platform_work_id, '3xzmmhtr8a4vqai');
  assert.equal(works[0].likes, 8);
  assert.equal(works[0].comments, 3);
  assert.equal(works[0].favorites, 2);
  assert.equal(works[0].plays, 91);
  assert.match(works[0].published_at, /^\d{4}-\d{2}-\d{2} /);
  assert.deepEqual(ADAPTERS['快手'].profile(sample), {
    nickname: '小光英语 ing',
    avatar_url: 'https://p22.a.yximgs.com/uhead/avatar.jpg',
  });
});

test('快手搜索只采纳唯一的精确昵称账号', () => {
  const identity = selectKuaishouSearchIdentity({
    users: [
      { user_name: '相似账号', user_id: '3xother' },
      { user_name: '小光英语 ing', user_id: '3xarpr5pxq368tg', headurl: 'https://example.com/avatar.jpg' },
    ],
  }, '小光英语 ing');
  assert.equal(identity.platform_account_id, '3xarpr5pxq368tg');
  assert.equal(identity.homepage_url, 'https://www.kuaishou.com/profile/3xarpr5pxq368tg');
  assert.equal(selectKuaishouSearchIdentity({ users: [
    { user_name: '同名', user_id: '3xone' },
    { user_name: '同名', user_id: '3xtwo' },
  ] }, '同名'), null);
});

test('快手 parse 其他 GraphQL 响应返回空数组', () => {
  assert.deepEqual(ADAPTERS['快手'].parse({ data: { visionVideoDetail: {} } }), []);
});

// ---------- 小红书 adapter ----------
test('小红书 parse 提取 user_posted 笔记', () => {
  const sample = {
    data: {
      notes: [
        {
          note_id: '65f0abc123def456789012ab',
          note_card: {
            display_title: '小红书笔记标题',
            interact_info: { liked_count: '521' },
          },
        },
      ],
    },
  };
  const works = ADAPTERS['小红书'].parse(sample);
  assert.equal(works.length, 1);
  const w = works[0];
  assert.equal(w.platform_work_id, '65f0abc123def456789012ab');
  assert.equal(w.work_url, 'https://www.xiaohongshu.com/explore/65f0abc123def456789012ab');
  assert.equal(w.title, '小红书笔记标题');
  assert.equal(w.likes, 521);
  assert.equal(w.published_at, xiaohongshuTimestampFromId('65f0abc123def456789012ab'));
  assert.match(w.published_at, /^\d{4}-\d{2}-\d{2} /);
});

test('小红书提取公开主页首屏初始化笔记并移除令牌字段', () => {
  const id = '6a57322100000000170298e7';
  const state = {
    user: {
      notes: {
        _rawValue: [[{
          id,
          xsecToken: 'must-not-leave-renderer',
          noteCard: {
            noteId: id,
            displayTitle: '考研高频词，每日打卡一遍day3',
            interactInfo: { likedCount: '13', liked: false },
            user: {
              nickname: '小光英语 ing',
              avatar: 'https://example.com/avatar.jpg',
              userId: 'public-user-id',
            },
          },
        }]],
      },
    },
  };

  const notes = xiaohongshuInitialNotes(state);
  assert.equal(notes.length, 1);
  assert.equal(JSON.stringify(notes).includes('must-not-leave-renderer'), false);

  const works = ADAPTERS['小红书'].parseInitial(notes);
  assert.deepEqual(works.map(work => ({
    id: work.platform_work_id,
    title: work.title,
    likes: work.likes,
    published_at: work.published_at,
  })), [{
    id,
    title: '考研高频词，每日打卡一遍day3',
    likes: 13,
    published_at: xiaohongshuTimestampFromId(id),
  }]);
});

test('小红书首屏提取兼容 SSR 尚未水合时的普通数组', () => {
  const id = '6a5590fe000000001603d0c7';
  const otherTabId = '6a544d7f000000000f031abd';
  const notes = xiaohongshuInitialNotes({
    user: {
      notes: [[{
        id,
        noteCard: {
          noteId: id,
          displayTitle: '考研高频词，每日打卡一遍day2',
          interactInfo: { likedCount: '51' },
        },
      }], [{
        id: otherTabId,
        noteCard: {
          noteId: otherTabId,
          displayTitle: '其他标签中的内容不得混入发布作品',
          interactInfo: { likedCount: '999' },
        },
      }]],
    },
  });

  assert.equal(notes.length, 1);
  assert.equal(notes[0].id, id);
  assert.equal(notes.some(note => note.id === otherTabId), false);
});

test('小红书首屏状态缺失时显式标记为不可用', () => {
  assert.equal(xiaohongshuInitialNotes({ user: {} }), null);
  assert.equal(xiaohongshuInitialNotes({}), null);
});

test('小红书首屏只接受目标公开主页作者且发布时间可验证的作品', () => {
  const profileId = '6810b3340000000006011f98';
  const noteId = '6a57322100000000170298e7';
  const notes = xiaohongshuInitialNotes({
    user: {
      notes: [[{
        id: noteId,
        noteCard: {
          noteId,
          displayTitle: '公开作品',
          interactInfo: { likedCount: '13' },
          user: { userId: profileId, nickname: '小光英语 ing' },
        },
      }]],
    },
  });
  const works = ADAPTERS['小红书'].parseInitial(notes);
  const account = {
    platform_account_id: profileId,
    homepage_url: `https://www.xiaohongshu.com/user/profile/${profileId}`,
  };

  assert.equal(ADAPTERS['小红书'].validateInitial({ payload: notes, works, account }), true);
  notes[0].noteCard.user.userId = 'another-public-user';
  assert.equal(ADAPTERS['小红书'].validateInitial({ payload: notes, works, account }), false);
  notes[0].noteCard.user.userId = profileId;
  works[0].published_at = null;
  assert.equal(ADAPTERS['小红书'].validateInitial({ payload: notes, works, account }), false);
});

test('小红书首屏混入无法识别的新结构作品时整页校验失败', () => {
  const profileId = '6810b3340000000006011f98';
  const oldNoteId = '6a57322100000000170298e7';
  const notes = xiaohongshuInitialNotes({
    user: {
      notes: [[{
        newWorkIdentifier: 'new-format-work',
        noteCard: {
          displayTitle: '新版字段的新作品',
          user: { userId: profileId },
        },
      }, {
        id: oldNoteId,
        noteCard: {
          noteId: oldNoteId,
          displayTitle: '旧格式旧作品',
          interactInfo: { likedCount: '13' },
          user: { userId: profileId },
        },
      }]],
    },
  });
  const works = ADAPTERS['小红书'].parseInitial(notes);
  const account = { platform_account_id: profileId };

  assert.equal(ADAPTERS['小红书'].validateInitial({ payload: notes, works, account }), false);
});

test('小红书无效笔记 ID 不伪造发布时间', () => {
  assert.equal(xiaohongshuTimestampFromId('not-an-object-id'), null);
  assert.equal(xiaohongshuTimestampFromId('000000000000000000000000'), null);
  assert.equal(xiaohongshuTimestampFromId('ffffffff0000000000000000'), null);
});

test('统一采集入口拒绝快手数字内部号主页', () => {
  assert.equal(isCollectableHomepage('快手', 'https://www.kuaishou.com/profile/4768338482'), false);
  assert.equal(isCollectableHomepage('快手', 'https://www.kuaishou.com/profile/3xarpr5pxq368tg'), true);
  assert.equal(isCollectableHomepage('快手', 'https://v.kuaishou.com/AbC_123/'), true);
  assert.equal(isCollectableHomepage('小红书', 'https://www.xiaohongshu.com/user/profile/abc'), true);
});

test('小红书 apiPattern 匹配 user_posted', () => {
  assert.match('https://edith.xiaohongshu.com/api/sns/web/v1/user_posted?num=30', ADAPTERS['小红书'].apiPattern);
  assert.equal(ADAPTERS['小红书'].candidateMultiplier, 2);
  assert.equal(ADAPTERS['小红书'].forceFresh, true);
  assert.equal(ADAPTERS['小红书'].requireInitialData, true);
  assert.equal(ADAPTERS['小红书'].requireStableAfterLimit, true);
  assert.equal(ADAPTERS['小红书'].selectLatest, true);
  assert.equal(ADAPTERS['抖音'].candidateMultiplier, undefined);
  assert.equal(ADAPTERS['抖音'].selectLatest, undefined);
});

// ---------- B站 adapter ----------
test('B站 parse 提取投稿列表', () => {
  const sample = {
    data: {
      list: {
        vlist: [
          {
            bvid: 'BV1xx411c7mD',
            title: 'B站视频标题',
            created: 1719800000, // 秒
            comment: 45,
            play: 98765,
          },
        ],
      },
    },
  };
  const works = ADAPTERS['B站'].parse(sample);
  assert.equal(works.length, 1);
  const w = works[0];
  assert.equal(w.platform_work_id, 'BV1xx411c7mD');
  assert.equal(w.work_url, 'https://www.bilibili.com/video/BV1xx411c7mD/');
  assert.equal(w.comments, 45);
  assert.equal(w.plays, 98765);
  assert.equal(w.likes, null); // 列表接口无点赞（平台限制）
  assert.match(w.published_at, /^\d{4}-\d{2}-\d{2} /);
});

test('B站 apiPattern 兼容 wbi 接口', () => {
  assert.match('https://api.bilibili.com/x/space/wbi/arc/search?mid=1', ADAPTERS['B站'].apiPattern);
  assert.match('https://api.bilibili.com/x/space/arc/search?mid=1', ADAPTERS['B站'].apiPattern);
});

// ---------- profile：作者资料提取（头像/昵称随采集顺带同步） ----------
test('抖音 profile 提取作者昵称与头像', () => {
  const sample = {
    aweme_list: [{
      aweme_id: '1',
      author: { nickname: ' 小光英语 ', avatar_thumb: { url_list: ['https://p3.douyinpic.com/aweme-avatar/abc.jpeg'] } },
    }],
  };
  const p = ADAPTERS['抖音'].profile(sample);
  assert.equal(p.nickname, '小光英语');
  assert.equal(p.avatar_url, 'https://p3.douyinpic.com/aweme-avatar/abc.jpeg');
  assert.equal(ADAPTERS['抖音'].profile({ aweme_list: [] }), null);
  assert.equal(ADAPTERS['抖音'].profile({}), null);
});

test('快手 profile 提取作者名与头像', () => {
  const sample = {
    data: { visionProfilePhotoList: { feeds: [{ photo: { id: 'x' }, author: { name: '小光在成长ing', headerUrl: 'https://p.kwimgs.com/uhead/AB/head.jpg' } }] } },
  };
  const p = ADAPTERS['快手'].profile(sample);
  assert.equal(p.nickname, '小光在成长ing');
  assert.equal(p.avatar_url, 'https://p.kwimgs.com/uhead/AB/head.jpg');
});

test('小红书 profile 提取用户昵称与头像', () => {
  const sample = {
    data: { notes: [{ note_id: 'n1', user: { nickname: '半眠学姐', avatar: 'https://sns-avatar-qc.xhscdn.com/avatar/1.jpg' } }] },
  };
  const p = ADAPTERS['小红书'].profile(sample);
  assert.equal(p.nickname, '半眠学姐');
  assert.equal(p.avatar_url, 'https://sns-avatar-qc.xhscdn.com/avatar/1.jpg');
});

test('B站 profile 只有作者名（列表接口无头像）', () => {
  const sample = { data: { list: { vlist: [{ bvid: 'BV1', author: '小光在成长ing' }] } } };
  const p = ADAPTERS['B站'].profile(sample);
  assert.equal(p.nickname, '小光在成长ing');
  assert.equal(p.avatar_url, null);
});

test('profile 对非头像链接与空数据的容错', () => {
  const bad = { aweme_list: [{ author: { nickname: '', avatar_thumb: { url_list: ['data:image/png;base64,x'] } } }] };
  assert.equal(ADAPTERS['抖音'].profile(bad), null);
});

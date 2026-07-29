// 采集纯函数层：平台 adapter 的接口特征与响应解析、链接提炼、计数解析。
// 不依赖 electron，可直接用 node --test 回归（tests/parsers.test.js）。
const { extractLoadableUrl, isCollectableHomepage } = require('./platform-capabilities');

function toDateTime(seconds) {
  if (!seconds) return null;
  const d = new Date(seconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const stat = (item, key) => {
  const value = item && item.statistics ? item.statistics[key] : null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
};

// 通用互动数解析：支持数字、字符串、"1.2万"/"3亿"/"5k" 等口语计数
function numOr(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/,/g, '').trim();
  const match = text.match(/^(\d+(?:\.\d+)?)(万|亿|w|W|k|K)?$/);
  if (!match) {
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  let n = Number(match[1]);
  const unit = match[2];
  if (unit === '亿') n *= 1e8;
  else if (unit === '万' || unit === 'w' || unit === 'W') n *= 1e4;
  else if (unit === 'k' || unit === 'K') n *= 1e3;
  return Math.round(n);
}

// 秒/毫秒时间戳统一转本地时间字符串
function toDateTimeAuto(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return toDateTime(n > 1e12 ? Math.floor(n / 1000) : n);
}

// 小红书笔记 id 使用 Mongo/ObjectId 风格的前 8 位秒级时间戳。
// 列表接口本身不返回发布时间，因此用这个稳定字段恢复真实排序。
function xiaohongshuTimestampFromId(id) {
  const value = String(id || '');
  if (!/^[a-f0-9]{24}$/i.test(value)) return null;
  const seconds = Number.parseInt(value.slice(0, 8), 16);
  const nowSeconds = Math.floor(Date.now() / 1000);
  return Number.isFinite(seconds) && seconds >= 1262304000 && seconds <= nowSeconds + 86400
    ? toDateTime(seconds)
    : null;
}

// 小红书公开主页把最新一页作品随 SSR 初始化数据直接渲染，滚动接口从下一页开始。
// 此函数会在隔离渲染进程中执行，因此只返回采集需要的公开字段，主动丢弃 xsecToken 等字段。
function xiaohongshuInitialNotes(state) {
  const notesRef = state?.user?.notes;
  if (notesRef === null || notesRef === undefined) return null;
  const pages = notesRef?.value ?? notesRef?._value ?? notesRef?._rawValue ?? notesRef ?? [];
  if (!Array.isArray(pages)) return null;
  const notes = Array.isArray(pages?.[0]) ? pages[0] : (Array.isArray(pages) ? pages : []);
  return notes
    .map((item) => {
      const card = item?.noteCard || item?.note_card || item || {};
      const interact = card?.interactInfo || card?.interact_info || {};
      const user = card?.user || item?.user || {};
      const id = String(item?.id || item?.noteId || item?.note_id
        || card?.id || card?.noteId || card?.note_id || '');
      return {
        id,
        noteCard: {
          noteId: id,
          displayTitle: String(card?.displayTitle || card?.display_title || card?.title || ''),
          interactInfo: {
            likedCount: interact?.likedCount ?? interact?.liked_count ?? null,
          },
          user: {
            userId: String(user?.userId || user?.user_id || ''),
            nickname: String(user?.nickname || user?.nickName || user?.nick_name || ''),
            avatar: typeof user?.avatar === 'string' ? user.avatar : null,
          },
        },
      };
    });
}

function parseXiaohongshuNotes(notes) {
  if (!Array.isArray(notes)) return [];
  return notes
    .map((item) => {
      const note = item.note_card || item.noteCard || item;
      const id = String(item.id || item.note_id || item.noteId
        || note.id || note.note_id || note.noteId || '');
      const interact = note.interact_info || note.interactInfo || {};
      return {
        platform_work_id: id,
        title: (note.display_title || note.displayTitle || note.title || '').trim().slice(0, 200) || null,
        work_url: id ? `https://www.xiaohongshu.com/explore/${id}` : null,
        published_at: xiaohongshuTimestampFromId(id),
        likes: numOr(interact.liked_count != null ? interact.liked_count : interact.likedCount),
        comments: numOr(interact.comment_count != null ? interact.comment_count : interact.commentCount),
        favorites: numOr(interact.collected_count != null ? interact.collected_count : interact.collectedCount),
        shares: numOr(interact.share_count != null ? interact.share_count : interact.shareCount),
        plays: null,
      };
    })
    .filter(work => work.platform_work_id);
}

const XIAOHONGSHU_INITIAL_DATA_SOURCE = `(${xiaohongshuInitialNotes.toString()})(window.__INITIAL_STATE__)`;

// 从作品列表响应里顺带提取作者资料（头像/昵称）——比页面猜图可靠得多
function profileFrom(nickname, avatarUrl) {
  const nick = String(nickname || '').trim().slice(0, 80) || null;
  const avatar = typeof avatarUrl === 'string' && /^https?:\/\//.test(avatarUrl) ? avatarUrl : null;
  return nick || avatar ? { nickname: nick, avatar_url: avatar } : null;
}

function selectKuaishouSearchIdentity(json, nickname) {
  const expected = String(nickname || '').trim().toLocaleLowerCase();
  const users = Array.isArray(json && json.users) ? json.users : [];
  if (!expected) return null;
  const exact = users.filter(user => String(user?.user_name || '').trim().toLocaleLowerCase() === expected);
  if (exact.length !== 1 || !/^(?=.*[a-z])[a-z0-9._-]{3,64}$/i.test(String(exact[0].user_id || ''))) {
    return null;
  }
  return {
    platform_account_id: String(exact[0].user_id),
    homepage_url: `https://www.kuaishou.com/profile/${exact[0].user_id}`,
    nickname: String(exact[0].user_name || '').trim(),
    avatar_url: String(exact[0].headurl || ''),
  };
}

// 每个平台一个 adapter：登录页、接口特征、响应解析。
const ADAPTERS = {
  '抖音': {
    partition: 'persist:collector-douyin',
    loginUrl: 'https://www.douyin.com/',
    apiPattern: /\/aweme\/v\d+\/web\/aweme\/post\//,
    profile(json) {
      const list = json && json.aweme_list;
      const author = Array.isArray(list) && list.length ? list[0].author : null;
      if (!author) return null;
      const thumb = author.avatar_thumb || author.avatar_larger || {};
      const avatar = Array.isArray(thumb.url_list) ? thumb.url_list[0] : null;
      return profileFrom(author.nickname, avatar);
    },
    parse(json) {
      const list = json && json.aweme_list;
      if (!Array.isArray(list)) return [];
      return list
        .map((item) => ({
          platform_work_id: String(item.aweme_id || ''),
          title: (item.desc || '').trim().slice(0, 200) || null,
          work_url: item.aweme_id ? `https://www.douyin.com/video/${item.aweme_id}` : null,
          published_at: toDateTime(item.create_time),
          likes: stat(item, 'digg_count'),
          comments: stat(item, 'comment_count'),
          favorites: stat(item, 'collect_count'),
          shares: stat(item, 'share_count'),
          plays: stat(item, 'play_count') || null,
        }))
        .filter((work) => work.platform_work_id);
    },
  },

  // 快手：个人主页滚动触发 GraphQL visionProfilePhotoList，列表含 点赞/评论/分享/发布时间
  '快手': {
    partition: 'persist:collector-kuaishou',
    loginUrl: 'https://www.kuaishou.com/',
    apiPattern: /\/graphql|\/rest\/v\/profile\/feed/,
    profile(json) {
      const feeds = Array.isArray(json && json.feeds)
        ? json.feeds
        : (json && json.data && json.data.visionProfilePhotoList
          ? json.data.visionProfilePhotoList.feeds : null);
      const author = Array.isArray(feeds) && feeds.length ? feeds[0].author : null;
      if (!author) return null;
      return profileFrom(author.name, author.headerUrl || author.headurl || author.avatar);
    },
    parse(json) {
      const feeds = Array.isArray(json && json.feeds)
        ? json.feeds
        : (json && json.data && json.data.visionProfilePhotoList
          ? json.data.visionProfilePhotoList.feeds : null);
      if (!Array.isArray(feeds)) return [];
      return feeds
        .map((feed) => {
          const photo = (feed && feed.photo) || {};
          const id = String(photo.id || '');
          return {
            platform_work_id: id,
            title: (photo.caption || '').trim().slice(0, 200) || null,
            work_url: id ? `https://www.kuaishou.com/short-video/${id}` : null,
            published_at: toDateTimeAuto(photo.timestamp),
            likes: numOr(photo.realLikeCount != null ? photo.realLikeCount : photo.likeCount),
            comments: numOr(photo.commentCount != null ? photo.commentCount : feed?.comment?.us_c),
            favorites: numOr(photo.collectCount),
            shares: numOr(photo.shareCount),
            plays: numOr(photo.viewCount),
          };
        })
        .filter((work) => work.platform_work_id);
    },
  },

  // 小红书：个人主页滚动触发 user_posted，列表仅含 点赞（评论/收藏/发布时间需详情页）
  '小红书': {
    partition: 'persist:collector-xiaohongshu',
    candidateMultiplier: 2,
    forceFresh: true,
    requireInitialData: true,
    requireStableAfterLimit: true,
    selectLatest: true,
    loginUrl: 'https://www.xiaohongshu.com/',
    apiPattern: /\/api\/sns\/web\/v\d+\/user_posted/,
    initialDataSource: XIAOHONGSHU_INITIAL_DATA_SOURCE,
    parseInitial: parseXiaohongshuNotes,
    validateInitial({ payload, works, account }) {
      const expectedId = String(account?.platform_account_id || '').trim()
        || String(account?.homepage_url || '').match(/\/user\/profile\/([\w.-]+)/i)?.[1]
        || '';
      if (!expectedId || !Array.isArray(payload) || !payload.length
        || !Array.isArray(works) || works.length !== payload.length) return false;
      return payload.every((item, index) => {
        const note = item?.note_card || item?.noteCard || item || {};
        const user = note?.user || item?.user || {};
        const userId = String(user?.userId || user?.user_id || '');
        const noteId = String(item?.id || item?.noteId || item?.note_id
          || note?.id || note?.noteId || note?.note_id || '');
        return userId === expectedId
          && noteId === works[index]?.platform_work_id
          && Boolean(works[index]?.published_at);
      });
    },
    profile(json) {
      const notes = json && json.data ? (json.data.notes || json.data.items || json.data.list) : null;
      if (!Array.isArray(notes) || !notes.length) return null;
      const note = notes[0].note_card || notes[0].noteCard || notes[0];
      const user = notes[0].user || note.user;
      if (!user) return null;
      return profileFrom(user.nickname || user.nick_name || user.nickName, user.avatar);
    },
    parse(json) {
      const notes = json && json.data ? (json.data.notes || json.data.items || json.data.list) : null;
      return parseXiaohongshuNotes(notes);
    },
  },

  // B站：空间投稿页滚动触发 space/arc/search，列表含 播放/评论/发布时间（无点赞/收藏/分享）
  'B站': {
    partition: 'persist:collector-bilibili',
    loginUrl: 'https://www.bilibili.com/',
    apiPattern: /\/x\/space\/(?:wbi\/)?arc\/search/,
    profile(json) {
      // 投稿列表接口只有作者名，没有头像（头像走 acc/info，暂不采）
      const vlist = json && json.data && json.data.list ? json.data.list.vlist : null;
      if (!Array.isArray(vlist) || !vlist.length) return null;
      return profileFrom(vlist[0].author, null);
    },
    parse(json) {
      const vlist = json && json.data && json.data.list ? json.data.list.vlist : null;
      if (!Array.isArray(vlist)) return [];
      return vlist
        .map((v) => ({
          platform_work_id: String(v.bvid || ''),
          title: (v.title || '').trim().slice(0, 200) || null,
          work_url: v.bvid ? `https://www.bilibili.com/video/${v.bvid}/` : null,
          published_at: toDateTimeAuto(v.created),
          likes: null,
          comments: numOr(v.comment),
          favorites: null,
          shares: null,
          plays: numOr(v.play),
        }))
        .filter((work) => work.platform_work_id);
    },
  },
};

module.exports = {
  ADAPTERS,
  extractLoadableUrl,
  numOr,
  toDateTime,
  toDateTimeAuto,
  xiaohongshuInitialNotes,
  xiaohongshuTimestampFromId,
  isCollectableHomepage,
  selectKuaishouSearchIdentity,
  stat,
};

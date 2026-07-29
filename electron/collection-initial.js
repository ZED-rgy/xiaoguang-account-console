async function collectInitialWorks(contents, adapter, account = null) {
  if (!adapter?.initialDataSource || typeof adapter.parseInitial !== 'function') {
    return { attempted: false, available: false, works: [] };
  }
  try {
    const payload = await contents.executeJavaScript(adapter.initialDataSource, true);
    if (payload === null || payload === undefined) {
      return { attempted: true, available: false, works: [] };
    }
    const works = adapter.parseInitial(payload);
    const valid = typeof adapter.validateInitial !== 'function'
      || adapter.validateInitial({ payload, works, account });
    if (!valid) return { attempted: true, available: false, works: [] };
    return {
      attempted: true,
      available: true,
      works: Array.isArray(works) ? works : [],
    };
  } catch {
    return { attempted: true, available: false, works: [] };
  }
}

function requiredInitialDataError(adapter, result) {
  if (!adapter?.requireInitialData || (result?.available && result.works?.length)) return null;
  return '公开主页首屏公开作品数据未就绪，已停止采集以避免把续页旧作品误报为最新数据';
}

module.exports = { collectInitialWorks, requiredInitialDataError };

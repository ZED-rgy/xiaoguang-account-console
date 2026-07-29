function comparablePublishedAt(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace('T', ' ');
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized)
    ? normalized
    : null;
}

function candidateCaptureLimit(saveLimit, multiplier = 1) {
  const normalizedLimit = Math.max(1, Math.min(100, Math.floor(Number(saveLimit) || 1)));
  const normalizedMultiplier = Math.max(1, Number(multiplier) || 1);
  return Math.min(100, Math.ceil(normalizedLimit * normalizedMultiplier));
}

function createPendingRequestTracker(apiPattern) {
  const requestIds = new Set();
  return {
    observe(method, params = {}) {
      if (method === 'Network.requestWillBeSent'
        && apiPattern.test(params.request?.url || '')) {
        requestIds.add(params.requestId);
      }
      if (method === 'Network.loadingFailed') requestIds.delete(params.requestId);
    },
    has(requestId) {
      return requestIds.has(requestId);
    },
    complete(requestId) {
      requestIds.delete(requestId);
    },
    get size() {
      return requestIds.size;
    },
  };
}

function shouldStopCapture({
  candidateCount,
  captureLimit,
  previousCount = null,
  pendingCount = 0,
  stableRounds = 0,
  requireStableAfterLimit = false,
}) {
  if (candidateCount < captureLimit) return false;
  if (!requireStableAfterLimit) return true;
  return previousCount !== null
    && candidateCount === previousCount
    && pendingCount === 0
    && stableRounds >= 2;
}

function selectLatestWorks(candidates, limit) {
  const all = Array.from(candidates || []);
  const saveLimit = Math.max(0, Math.floor(Number(limit) || 0));
  const works = all
    .map((work, index) => ({ work, index, publishedAt: comparablePublishedAt(work?.published_at) }))
    .sort((left, right) => {
      if (left.publishedAt && right.publishedAt && left.publishedAt !== right.publishedAt) {
        return right.publishedAt.localeCompare(left.publishedAt);
      }
      if (left.publishedAt && !right.publishedAt) return -1;
      if (!left.publishedAt && right.publishedAt) return 1;
      return left.index - right.index;
    })
    .slice(0, saveLimit)
    .map(item => item.work);

  return {
    works,
    captured: all.length,
    truncated: Math.max(0, all.length - works.length),
    newestAt: works[0]?.published_at || null,
    oldestAt: works[works.length - 1]?.published_at || null,
  };
}

module.exports = {
  candidateCaptureLimit,
  createPendingRequestTracker,
  selectLatestWorks,
  shouldStopCapture,
};

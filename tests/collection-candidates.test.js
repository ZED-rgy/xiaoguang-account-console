const test = require('node:test');
const assert = require('node:assert/strict');

const {
  candidateCaptureLimit,
  createPendingRequestTracker,
  selectLatestWorks,
  shouldStopCapture,
} = require('../electron/collection-candidates');

function work(day) {
  const date = `2026-07-${String(day).padStart(2, '0')}`;
  return {
    platform_work_id: `work-${date}`,
    published_at: `${date} 08:00:00`,
  };
}

test('selectLatestWorks keeps the newest works when candidates exceed the save limit', () => {
  const candidates = [
    ...Array.from({ length: 10 }, (_, index) => work(index + 1)),
    ...Array.from({ length: 20 }, (_, index) => work(index + 11)),
  ];

  const result = selectLatestWorks(candidates, 20);

  assert.equal(result.captured, 30);
  assert.equal(result.truncated, 10);
  assert.equal(result.works.length, 20);
  assert.equal(result.newestAt, '2026-07-30 08:00:00');
  assert.equal(result.oldestAt, '2026-07-11 08:00:00');
  assert.deepEqual(
    result.works.map(item => item.platform_work_id),
    Array.from({ length: 20 }, (_, index) => work(30 - index).platform_work_id),
  );
});

test('pending request tracking lasts from request start through body parsing', () => {
  const tracker = createPendingRequestTracker(/\/user_posted/);
  const requestId = 'request-1';

  tracker.observe('Network.requestWillBeSent', {
    requestId,
    request: { url: 'https://edith.xiaohongshu.com/api/sns/web/v1/user_posted?num=30' },
  });
  assert.equal(tracker.size, 1);
  assert.equal(tracker.has(requestId), true);

  tracker.observe('Network.responseReceived', { requestId });
  assert.equal(tracker.size, 1);

  tracker.complete(requestId);
  assert.equal(tracker.size, 0);
});

test('candidateCaptureLimit expands only when the adapter requests overfetching', () => {
  assert.equal(candidateCaptureLimit(20), 20);
  assert.equal(candidateCaptureLimit(20, 2), 40);
  assert.equal(candidateCaptureLimit(80, 2), 100);
});

test('shouldStopCapture waits for a stable drained round when late responses are possible', () => {
  assert.equal(shouldStopCapture({ candidateCount: 40, captureLimit: 40 }), true);
  assert.equal(shouldStopCapture({
    candidateCount: 40,
    captureLimit: 40,
    requireStableAfterLimit: true,
  }), false);
  assert.equal(shouldStopCapture({
    candidateCount: 60,
    captureLimit: 40,
    previousCount: 40,
    pendingCount: 0,
    requireStableAfterLimit: true,
  }), false);
  assert.equal(shouldStopCapture({
    candidateCount: 60,
    captureLimit: 40,
    previousCount: 60,
    pendingCount: 1,
    stableRounds: 2,
    requireStableAfterLimit: true,
  }), false);
  assert.equal(shouldStopCapture({
    candidateCount: 60,
    captureLimit: 40,
    previousCount: 60,
    pendingCount: 0,
    stableRounds: 1,
    requireStableAfterLimit: true,
  }), false);
  assert.equal(shouldStopCapture({
    candidateCount: 60,
    captureLimit: 40,
    previousCount: 60,
    pendingCount: 0,
    stableRounds: 2,
    requireStableAfterLimit: true,
  }), true);
});

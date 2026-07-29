const test = require('node:test');
const assert = require('node:assert/strict');

const { collectInitialWorks, requiredInitialDataError } = require('../electron/collection-initial');

test('collectInitialWorks executes the adapter public-page extractor and parses its result', async () => {
  const calls = [];
  const contents = {
    async executeJavaScript(source, userGesture) {
      calls.push([source, userGesture]);
      return [{ id: 'new-public-work' }];
    },
  };
  const adapter = {
    initialDataSource: 'window.PUBLIC_INITIAL_WORKS',
    parseInitial: notes => notes.map(note => ({ platform_work_id: note.id })),
  };

  const result = await collectInitialWorks(contents, adapter);

  assert.deepEqual(calls, [['window.PUBLIC_INITIAL_WORKS', true]]);
  assert.deepEqual(result, {
    attempted: true,
    available: true,
    works: [{ platform_work_id: 'new-public-work' }],
  });
});

test('collectInitialWorks is a no-op for adapters without public initial data', async () => {
  const contents = {
    async executeJavaScript() {
      throw new Error('must not execute');
    },
  };

  assert.deepEqual(await collectInitialWorks(contents, {}), {
    attempted: false,
    available: false,
    works: [],
  });
});

test('collectInitialWorks keeps network collection available when initial data is absent', async () => {
  const contents = {
    async executeJavaScript() {
      throw new Error('initial state is unavailable');
    },
  };
  const adapter = {
    initialDataSource: 'window.MISSING_INITIAL_WORKS',
    parseInitial: () => { throw new Error('must not parse'); },
  };

  const result = await collectInitialWorks(contents, adapter);
  assert.deepEqual(result, {
    attempted: true,
    available: false,
    works: [],
  });
  assert.match(requiredInitialDataError({ requireInitialData: true }, result), /首屏公开作品数据/);
  assert.equal(requiredInitialDataError({}, result), null);
});

test('required initial data rejects a present payload that parses to no works', async () => {
  const contents = {
    async executeJavaScript() {
      return [{ renamedWorkIdentifier: 'unknown-shape' }];
    },
  };
  const adapter = {
    requireInitialData: true,
    initialDataSource: 'window.CHANGED_INITIAL_WORKS',
    parseInitial: () => [],
  };

  const result = await collectInitialWorks(contents, adapter, { id: 7 });

  assert.match(requiredInitialDataError(adapter, result), /首屏公开作品数据/);
});

async function prepareFreshCollection(contents) {
  await contents.session.clearCache();
  await Promise.all([
    contents.debugger.sendCommand('Network.setCacheDisabled', { cacheDisabled: true }),
    contents.debugger.sendCommand('Network.setBypassServiceWorker', { bypass: true }),
  ]);
}

function withCacheBust(value, now = Date.now()) {
  const url = new URL(value);
  url.searchParams.set('_account_console_refresh', String(now));
  return url.toString();
}

module.exports = { prepareFreshCollection, withCacheBust };

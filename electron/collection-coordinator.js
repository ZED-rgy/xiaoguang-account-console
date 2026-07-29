const { capabilities, isCollectableHomepage } = require('./platform-capabilities');

function createCollectionCoordinator(options = {}) {
  const apiOrigin = String(options.apiOrigin || 'http://127.0.0.1:8826').replace(/\/$/, '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const runPlatform = options.runPlatform;
  const repairIdentity = options.repairIdentity;

  async function get(path) {
    const response = await fetchImpl(`${apiOrigin}${path}`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail || body.message || `HTTP ${response.status}`);
    return body;
  }

  async function run(request = {}, progressWindow = null) {
    const trigger = request.trigger || 'manual';
    const [config, targetPayload] = await Promise.all([
      get('/api/collect/config'),
      get('/api/collect/targets'),
    ]);
    const configured = Array.isArray(config.platforms) && config.platforms.length
      ? config.platforms
      : capabilities.filter((item) => item.collect_supported).map((item) => item.name);
    const wantedIds = Array.isArray(request.accountIds) && request.accountIds.length
      ? new Set(request.accountIds.map(Number))
      : null;
    const selectedAccounts = wantedIds
      ? (targetPayload.data || []).filter((account) => wantedIds.has(Number(account.id)))
      : [];
    const wantedPlatforms = request.platform
      ? [request.platform]
      : (wantedIds ? [...new Set(selectedAccounts.map((account) => account.platform))] : configured);
    const candidates = (targetPayload.data || []).filter((account) => (
      wantedPlatforms.includes(account.platform) && (!wantedIds || wantedIds.has(Number(account.id)))
    ));

    const ready = [];
    for (const account of candidates) {
      if (isCollectableHomepage(account.platform, account.homepage_url)) {
        ready.push(account);
        continue;
      }
      if (!repairIdentity) continue;
      const repaired = await repairIdentity(account);
      if (repaired && isCollectableHomepage(repaired.platform, repaired.homepage_url)) ready.push(repaired);
    }

    const groups = wantedPlatforms
      .map((platform) => ({
        platform,
        accountIds: ready.filter((account) => account.platform === platform).map((account) => Number(account.id)),
      }))
      .filter((group) => group.accountIds.length);
    if (!groups.length) {
      return { ok: false, message: '没有可采集的账号（需要平台匹配且具有有效公开主页）' };
    }

    const aggregate = {
      ok: true, trigger, total: 0, success: 0, failed: 0,
      inserted: 0, updated: 0, stopped: false, errors: [],
    };
    let completedGroups = 0;
    for (const group of groups) {
      const summary = await runPlatform({
        ...request,
        platform: group.platform,
        accountIds: group.accountIds,
        trigger,
      }, progressWindow);
      if (!summary?.ok) {
        aggregate.errors.push(`${group.platform}: ${summary?.message || '采集未运行'}`);
        continue;
      }
      completedGroups += 1;
      aggregate.total += Number(summary.total || 0);
      aggregate.success += Number(summary.success || 0);
      aggregate.failed += Number(summary.failed || 0);
      aggregate.inserted += Number(summary.inserted || 0);
      aggregate.updated += Number(summary.updated || 0);
      if (summary.stopped) aggregate.stopped = true;
      if (summary.errors?.length) aggregate.errors.push(...summary.errors);
      if (aggregate.stopped) break;
    }
    if (!completedGroups) {
      return {
        ...aggregate,
        ok: false,
        message: aggregate.errors.join('；') || '采集未运行',
      };
    }
    return aggregate;
  }

  return { run };
}

module.exports = { createCollectionCoordinator };

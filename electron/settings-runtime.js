const GENERAL_DEFAULTS = {
  close_to_tray: true,
  notify_on_collect: true,
  autostart_hidden: true,
};

const SCHEDULE_DEFAULTS = {
  auto_enabled: false,
  frequency: 'daily',
  weekday: 1,
  hour: 6,
  minute: 0,
  scan_limit: 20,
  platforms: ['抖音'],
  last_auto_date: null,
};

function createSettingsRuntime(options = {}) {
  const apiOrigin = String(options.apiOrigin || 'http://127.0.0.1:8826').replace(/\/$/, '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  let general = { ...GENERAL_DEFAULTS, ...(options.general || {}) };
  let schedule = { ...SCHEDULE_DEFAULTS, ...(options.schedule || {}) };

  async function request(path, method = 'GET', patch = null) {
    const response = await fetchImpl(`${apiOrigin}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(patch == null ? {} : { body: JSON.stringify(patch) }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail || body.message || `HTTP ${response.status}`);
    return body;
  }

  async function load() {
    const [generalResult, scheduleResult] = await Promise.all([
      request('/api/general-settings'),
      request('/api/collect/config'),
    ]);
    general = { ...GENERAL_DEFAULTS, ...generalResult };
    schedule = { ...SCHEDULE_DEFAULTS, ...scheduleResult };
    return snapshot();
  }

  async function saveGeneral(patch = {}) {
    general = { ...GENERAL_DEFAULTS, ...await request('/api/general-settings', 'POST', patch) };
    return { ...general };
  }

  async function saveGeneralWithEffect(patch = {}, applyEffect, rollbackEffect) {
    await applyEffect();
    try {
      return await saveGeneral(patch);
    } catch (error) {
      try {
        await rollbackEffect();
      } catch { /* preserve the persistence error */ }
      throw error;
    }
  }

  async function saveSchedule(patch = {}) {
    schedule = { ...SCHEDULE_DEFAULTS, ...await request('/api/collect/config', 'POST', patch) };
    return { ...schedule };
  }

  function snapshot() {
    return {
      general: { ...general },
      schedule: { ...schedule, platforms: [...(schedule.platforms || [])] },
    };
  }

  return { load, saveGeneral, saveGeneralWithEffect, saveSchedule, snapshot };
}

module.exports = { createSettingsRuntime, GENERAL_DEFAULTS, SCHEDULE_DEFAULTS };

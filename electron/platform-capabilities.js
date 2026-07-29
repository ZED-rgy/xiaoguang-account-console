const capabilities = require('../shared/platforms.json');

const byName = new Map(capabilities.map((item) => [item.name, item]));

function capabilityFor(platform) {
  return byName.get(String(platform || '').trim()) || null;
}

function matchHomepage(capability, rawUrl) {
  const text = String(rawUrl || '').trim();
  for (const rule of capability?.homepage_patterns || []) {
    const match = text.match(new RegExp(rule.pattern, 'i'));
    if (match) {
      const principal = rule.principal_group ? match[Number(rule.principal_group)] : null;
      const value = rule.canonical_prefix && principal
        ? `${rule.canonical_prefix}${principal}`
        : match[0];
      return { rule, value };
    }
  }
  return null;
}

function extractLoadableUrl(raw) {
  const text = String(raw || '').trim();
  for (const capability of capabilities) {
    const matched = matchHomepage(capability, text);
    if (!matched) continue;
    let value = matched.value;
    if (matched.rule.ensure_trailing_slash && !value.endsWith('/')) value += '/';
    if (matched.rule.collect_suffix && !value.endsWith(matched.rule.collect_suffix)) {
      value = value.replace(/\/$/, '') + matched.rule.collect_suffix;
    }
    return value;
  }
  const generic = text.match(/https?:\/\/[^\s一-鿿，。、]+/);
  return generic ? generic[0] : text;
}

function isCollectableHomepage(platform, rawUrl) {
  const capability = capabilityFor(platform);
  if (!capability?.collect_supported) return false;
  const matched = matchHomepage(capability, rawUrl);
  if (!matched) return false;
  if (matched.rule.principal_requires_letter) {
    const principal = matched.value.split('/profile/')[1] || '';
    return /[a-z]/i.test(principal);
  }
  return true;
}

function isPlatformHomepage(platform, rawUrl) {
  return Boolean(matchHomepage(capabilityFor(platform), rawUrl));
}

function publicPayload() {
  return capabilities.map(({ key, name, icon, collect_supported, creator_urls }) => ({
    key, name, icon, collect_supported, creator_urls,
  }));
}

module.exports = {
  capabilities,
  capabilityFor,
  extractLoadableUrl,
  isCollectableHomepage,
  isPlatformHomepage,
  publicPayload,
};

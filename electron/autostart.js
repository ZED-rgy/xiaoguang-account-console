function createAutostartController(app, executablePath, isHidden) {
  function options(hiddenOverride) {
    const hidden = typeof hiddenOverride === 'boolean' ? hiddenOverride : isHidden();
    return {
      path: executablePath,
      args: hidden ? ['--hidden'] : [],
    };
  }

  function isEnabled(hiddenOverride) {
    const settings = app.getLoginItemSettings(options(hiddenOverride));
    return Boolean(settings.openAtLogin || settings.executableWillLaunchAtLogin);
  }

  function setEnabled(enabled, hiddenOverride) {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), ...options(hiddenOverride) });
    return isEnabled(hiddenOverride);
  }

  return { isEnabled, setEnabled };
}

module.exports = { createAutostartController };

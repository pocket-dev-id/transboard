const DevicePresence = {
  secondsSince(device, now = Date.now()) {
    const lastSeen = new Date(device.lastSeen || device.last_seen || 0).getTime();
    return lastSeen ? Math.max(0, Math.floor((now - lastSeen) / 1000)) : null;
  },

  summarize(devices, {
    now = Date.now(),
    currentWardId = '',
    parentVersion = '',
    hasConnectionProblem = false,
    connectionReason = null,
    error = null,
  } = {}) {
    const safeDevices = Array.isArray(devices) ? devices : [];
    const currentWard = String(currentWardId || '');
    const parentAppVersion = parentVersion ? String(parentVersion) : '';
    const secondsSince = device => this.secondsSince(device, now);
    const isDelayed = device => {
      const seconds = secondsSince(device);
      return seconds !== null && seconds > 20;
    };
    const isVersionMismatch = device => {
      const deviceVersion = device.appVersion ? String(device.appVersion) : '';
      return deviceVersion && parentAppVersion && deviceVersion !== parentAppVersion;
    };
    const isExam = device => device.page === 'exam-room';
    const isWardDashboard = device => device.page === 'ward-dashboard';
    const isCurrentWard = device => currentWard && String(device.wardId || '') === currentWard;
    const delayedCount = safeDevices.filter(isDelayed).length;
    const mismatchCount = safeDevices.filter(isVersionMismatch).length;
    const stateClass = error || hasConnectionProblem
      ? 'danger'
      : (delayedCount || mismatchCount ? 'warn' : (safeDevices.length ? 'ok' : 'muted'));

    return {
      devices: safeDevices,
      total: safeDevices.length,
      currentWardCount: safeDevices.filter(isCurrentWard).length,
      examCount: safeDevices.filter(isExam).length,
      wardPageCount: safeDevices.filter(isWardDashboard).length,
      unknownCount: safeDevices.filter(device => !isCurrentWard(device) && !isExam(device)).length,
      delayedCount,
      mismatchCount,
      stateClass,
      childNote: hasConnectionProblem
        ? (connectionReason === 'unauthorized' ? ' / トークン不一致' : ' / 親機再接続中')
        : '',
      warningNote: mismatchCount ? ` / 版違い${mismatchCount}` : (delayedCount ? ` / 遅延${delayedCount}` : ''),
      title: this.formatTitle(safeDevices, secondsSince, error),
    };
  },

  formatTitle(devices, secondsSince, error) {
    if (error) return '接続端末一覧を取得できませんでした';
    return devices.slice(0, 10).map(device => {
      const name = device.name || device.deviceId || device.id || '端末';
      const page = device.page || device.mode || '-';
      const ward = device.wardId || '-';
      const seconds = secondsSince(device);
      const seen = seconds === null ? '不明' : `${seconds}秒前`;
      const version = device.appVersion ? ` / v${device.appVersion}` : '';
      return `${name}: ${page} / ${ward} / ${seen}${version}`;
    }).join('\n') || '接続端末はありません';
  },
};

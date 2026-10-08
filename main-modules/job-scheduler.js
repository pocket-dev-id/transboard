'use strict';
function createJobScheduler(schedule, run, { timers = globalThis, onError = error => console.error('[Scheduler]', error) } = {}) {
  const mode = schedule?.mode || 'interval';
  const minutes = Number(schedule?.intervalMin ?? 10);
  const times = [...new Set(schedule?.times || [])];
  if (!['interval', 'time', 'realtime'].includes(mode)) throw Error('実行方式が不正です');
  if (mode === 'interval' && (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440)) throw Error('実行間隔は1〜1440分で指定してください');
  if (mode === 'time' && (!times.length || times.some(t => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)))) throw Error('実行時刻を確認してください');
  let stopped = false, pending = null, lastRun = '';
  const trigger = () => {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    pending = Promise.resolve().then(run).then(result => {
      if (result?.success === false) onError(new Error(result.message || '定期処理に失敗しました'));
      return result;
    }).catch(error => { onError(error); return { success: false, message: error.message }; })
      .finally(() => { pending = null; });
    return pending;
  };
  const tick = (now = new Date()) => {
    if (mode !== 'time') return trigger();
    const t = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${t}`;
    if (!times.includes(t) || key === lastRun) return Promise.resolve();
    lastRun = key;
    return trigger();
  };
  // Realtime jobs also rescan periodically to recover from missed SMB events.
  const timer = timers.setInterval(() => tick(), mode === 'time' ? 30000 : mode === 'realtime' ? 60000 : minutes * 60000);
  return { trigger, tick, stop() { stopped = true; timers.clearInterval(timer); } };
}
module.exports = { createJobScheduler };

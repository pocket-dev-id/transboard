/**
 * TransBoard - パフォーマンス計測ユーティリティ (品質保証 #5)
 * 処理時間が100msを超えるとコンソール警告を出力する。
 * Perf.getReport() でセッション中の計測サマリーを取得できる。
 */
const Perf = {
  _entries: [],
  _MAX_ENTRIES: 200,

  measure(label, fn) {
    const start = performance.now();
    const result = fn();
    this._record(label, performance.now() - start);
    return result;
  },

  async measureAsync(label, fn) {
    const start = performance.now();
    const result = await fn();
    this._record(label, performance.now() - start);
    return result;
  },

  _record(label, duration) {
    if (this._entries.length >= this._MAX_ENTRIES) this._entries.shift();
    this._entries.push({ label, duration, ts: Date.now() });
    if (duration > 100) {
      console.warn(`[Perf] ${label} took ${duration.toFixed(1)}ms`);
    }
  },

  getReport() {
    const grouped = {};
    for (const e of this._entries) {
      if (!grouped[e.label]) grouped[e.label] = [];
      grouped[e.label].push(e.duration);
    }
    const report = {};
    for (const [label, times] of Object.entries(grouped)) {
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      report[label] = {
        count: times.length,
        avg: avg.toFixed(1) + 'ms',
        max: Math.max(...times).toFixed(1) + 'ms',
        min: Math.min(...times).toFixed(1) + 'ms',
      };
    }
    return report;
  },

  logReport() {
    console.table(this.getReport());
  },
};

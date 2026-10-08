(function (root, factory) {
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  if (root) root.SyncPolicy = policy;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  return {
    jitter(baseMs, ratio = 0.15, minimumMs = 250, random = Math.random) {
      const jitter = baseMs * ratio;
      return Math.max(minimumMs, Math.round(baseMs + (random() * 2 - 1) * jitter));
    },
    retry(baseMs, failures, maxMs, random = Math.random) {
      const capped = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, failures - 1)));
      return this.jitter(capped, 0.25, 250, random);
    },
  };
});

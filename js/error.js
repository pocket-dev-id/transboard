/**
 * TransBoard - 共通エラーハンドラー
 * グローバル例外の捕捉・UI通知・外部ハンドラーへの通知を一元化する
 */

class AppError extends Error {
  constructor(message, { code = 'UNKNOWN', level = 'error', context = {} } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.level = level; // 'error' | 'warning' | 'info'
    this.context = context;
    this.timestamp = Date.now();
  }
}

const ErrorHandler = {
  _handlers: [],

  // 外部ハンドラーを登録する（戻り値は登録解除関数）
  register(handler) {
    this._handlers.push(handler);
    return () => {
      const idx = this._handlers.indexOf(handler);
      if (idx !== -1) this._handlers.splice(idx, 1);
    };
  },

  handle(error, context = {}) {
    const appError = error instanceof AppError
      ? error
      : new AppError(error?.message || String(error), {
          code: 'RUNTIME_ERROR',
          level: 'error',
          context: { ...context, originalName: error?.name },
        });

    console.error(`[ErrorHandler:${appError.code}]`, appError.message, appError.context);

    if (typeof UI !== 'undefined') {
      const toastLevel = appError.level === 'warning' ? 'warning' : 'danger';
      UI.toast(appError.message, toastLevel, 6000);
    }

    for (const h of this._handlers) {
      try { h(appError); } catch (e) { console.error('[ErrorHandler] ハンドラーがエラーをスローしました:', e); }
    }
  },

  // グローバル例外ハンドラーを初期化する（App.init()の最初に呼ぶ）
  init() {
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      // ネットワーク到達不能エラーは API 層で個別処理済みのため重複通知しない
      if (reason?.message?.includes('fetch') || reason?.message?.includes('Failed to fetch')) return;
      if (reason?.name === 'TypeError' && reason?.message?.includes('NetworkError')) return;

      this.handle(
        reason instanceof Error
          ? reason
          : new AppError(String(reason), { code: 'UNHANDLED_REJECTION' })
      );
      event.preventDefault();
    });

    window.addEventListener('error', (event) => {
      if (!event.message) return;
      this.handle(new AppError(event.message, {
        code: 'GLOBAL_ERROR',
        level: 'error',
        context: { file: event.filename, line: event.lineno, col: event.colno },
      }));
    });
  },
};

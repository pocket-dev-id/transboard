/**
 * TransBoard - 軽量コンポーネントパターン
 * 再利用可能なUI部品の基底クラス。
 * DOM生成・イベント管理・AppStateサブスクリプションのライフサイクルを標準化する。
 *
 * 使い方:
 *   class MyCard extends Component {
 *     template() { return `<div>${UI.escapeHTML(this._data.name)}</div>`; }
 *     bindEvents() { this.on(this.container, 'click', () => this.render()); }
 *   }
 *   const card = new MyCard('card-container');
 *   card.mount();
 */

class Component {
  constructor(containerId) {
    this._containerId = containerId;
    this._subscriptions = [];
    this._listeners = [];
  }

  get container() {
    return document.getElementById(this._containerId);
  }

  // 初回マウント（render + bindEvents を実行）
  mount() {
    this.render();
  }

  // コンテナを再描画する
  render() {
    const el = this.container;
    if (!el) return;

    el.innerHTML = '';
    const content = this.template();
    if (typeof content === 'string') {
      el.innerHTML = content;
    } else if (content instanceof Node) {
      el.appendChild(content);
    }
    this.bindEvents();
  }

  // サブクラスでオーバーライド: HTML文字列 or DOM Node を返す
  template() { return ''; }

  // サブクラスでオーバーライド: render() 後のイベントバインド
  bindEvents() {}

  // AppState のキー変更を購読して自動再描画
  watchState(key) {
    if (typeof AppState === 'undefined' || typeof AppState.subscribe !== 'function') return;
    const unsub = AppState.subscribe(key, () => this.render());
    this._subscriptions.push(unsub);
  }

  // addEventListener のラッパー（destroy() で自動解除）
  on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this._listeners.push({ target, type, handler, options });
  }

  // コンポーネントを破棄する（購読・リスナーをすべて解除しDOMを空にする）
  destroy() {
    this._subscriptions.forEach(unsub => unsub());
    this._subscriptions = [];

    this._listeners.forEach(({ target, type, handler, options }) => {
      target.removeEventListener(type, handler, options);
    });
    this._listeners = [];

    const el = this.container;
    if (el) el.innerHTML = '';
  }
}

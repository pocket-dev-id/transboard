/**
 * TransBoard - ロールベースアクセス制御 (RBAC) 基盤 (セキュリティ #5)
 *
 * 現バージョンでは「ロール」はローカル設定で保持する軽量実装。
 * スタッフマスタにロールフィールドを追加することで将来的に拡張可能。
 *
 * 使用例:
 *   if (!Auth.can('STATUS_CHANGE')) return;
 *   Auth.requirePermission('PATIENT_DISCHARGE', () => { ... });
 */
const Auth = {
  getCurrentRole() {
    return localStorage.getItem('cfg_user_role') || CONFIG.ROLES.NURSE;
  },

  setRole(role) {
    if (!Object.values(CONFIG.ROLES).includes(role)) {
      console.warn('[Auth] 不明なロール:', role);
      return;
    }
    localStorage.setItem('cfg_user_role', role);
  },

  can(permission) {
    const role = this.getCurrentRole();
    const allowed = CONFIG.PERMISSIONS[permission];
    if (!allowed) return true; // 未定義パーミッションは制限しない
    return allowed.includes(role);
  },

  requirePermission(permission, action) {
    if (!this.can(permission)) {
      if (typeof UI !== 'undefined') {
        UI.toast('この操作を行う権限がありません', 'warning');
      }
      return false;
    }
    return typeof action === 'function' ? action() : true;
  },
};

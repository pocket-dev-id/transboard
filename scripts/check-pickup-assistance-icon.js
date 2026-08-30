// お迎え介助マスタのアイコン選択機能(js/settings/masters.js)と、優先対応
// 一覧(js/priority.js)でのお迎え介助表示が正しく動作することを検証する
// 回帰テスト。
//
// - UI.pickupAssistanceIcon(js/ui.js)がマスタのicon列を正しく参照すること
// - Settings.PICKUP_ASSISTANCE_ICON_OPTIONS(js/settings/masters.js)に
//   並ぶ選択肢が、すべてcss/local-icons.cssで実際にグリフが定義された
//   faクラスであること(未定義クラスを選ぶとオフライン環境で空白表示に
//   なるため、これを機械的に防ぐ)
// - Priority._renderPriorityItem(js/priority.js)がpickup_assistance_type_id
//   のあるイベントに対してアイコン付きの表示を追加すること
//
// js/ui.js・js/config.js・js/priority.js・js/settings/masters.jsを実際に
// ロードして直接実行することで、出荷されるコードそのものの挙動を検証する。
const assert = require('assert');
const vm = require('vm');
const { readRoot: read } = require('./lib/extract-source');

// ── css/local-icons.cssで実際に定義済みのfaクラス一覧を抽出 ──
const localIconsCss = read('css/local-icons.css');
const definedIconClasses = new Set(
  [...localIconsCss.matchAll(/\.(fa-[a-z0-9-]+)::before/g)].map(m => m[1])
);
assert(definedIconClasses.size > 50, 'css/local-icons.cssからfaクラスを抽出できませんでした');

// ── PICKUP_ASSISTANCE_ICON_OPTIONSの全選択肢が実在するアイコンであること ──
{
  const mastersSource = read('js/settings/masters.js');
  const sandbox = { console, document: { getElementById: () => null }, AppState: {}, API: {}, App: {}, UI: { escapeHTML: (s) => String(s) } };
  vm.createContext(sandbox);
  vm.runInContext(`const Settings = {}; ${mastersSource}\nthis.Settings = Settings;`, sandbox);
  const { Settings } = sandbox;
  const options = Settings.PICKUP_ASSISTANCE_ICON_OPTIONS;
  assert(Array.isArray(options) && options.length > 1, 'Settings.PICKUP_ASSISTANCE_ICON_OPTIONSを取り出せませんでした');
  assert(options.some(o => o.value === ''), '「アイコン無し」の選択肢(value:"")が必要');
  for (const opt of options) {
    if (opt.value === '') continue;
    assert(
      definedIconClasses.has(opt.value),
      `PICKUP_ASSISTANCE_ICON_OPTIONSの"${opt.value}"はcss/local-icons.cssに定義がなく、オフライン環境で空白表示になります`
    );
  }
}

// ── 保存処理(create/patch)がiconフィールドを含めること ──
{
  const mastersSource = read('js/settings/masters.js');
  const openFormIdx = mastersSource.indexOf('_openPickupAssistanceTypeForm(type) {');
  const openFormEnd = mastersSource.indexOf('\n  },', openFormIdx);
  assert(openFormIdx >= 0 && openFormEnd > openFormIdx, '_openPickupAssistanceTypeFormが見つかりません');
  const body = mastersSource.slice(openFormIdx, openFormEnd);
  assert(/API\.create\('pickup_assistance_types',\s*\{[^}]*\bicon\b/.test(body), '新規追加時にiconフィールドが保存されていません');
  assert(/API\.patch\('pickup_assistance_types',\s*type\.id,\s*\{[^}]*\bicon\b/.test(body), '編集保存時にiconフィールドが保存されていません');
}

// ── UI.pickupAssistanceIcon / Priority._renderPriorityItem の動作確認 ──
{
  const uiSource = read('js/ui.js');
  const configSource = read('js/config.js');
  const prioritySource = read('js/priority.js');

  const sandbox = {
    console,
    document: { getElementById: () => null },
    localStorage: { getItem: () => null, setItem: () => {} },
    AppState: {
      pickupAssistanceTypes: [
        { id: 'pat-stretcher', name: 'ストレッチャー', icon: 'fa-bed', is_active: true },
        { id: 'pat-noicon', name: 'アイコン未設定タイプ', is_active: true },
      ],
      getStaffById: () => null,
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${configSource}\nthis.CONFIG = CONFIG;`, sandbox);
  vm.runInContext(`${uiSource}\nthis.UI = UI;`, sandbox);
  vm.runInContext(`${prioritySource}\nthis.Priority = Priority;`, sandbox);
  const { UI, Priority } = sandbox;

  // pickupAssistanceIcon: マスタでアイコン設定済みのタイプ
  assert.strictEqual(
    UI.pickupAssistanceIcon({ pickup_assistance_type_id: 'pat-stretcher' }),
    'fa-bed'
  );
  // pickupAssistanceIcon: マスタでアイコン未設定のタイプはnull
  assert.strictEqual(
    UI.pickupAssistanceIcon({ pickup_assistance_type_id: 'pat-noicon' }),
    null
  );
  // pickupAssistanceIcon: 「その他」自由記入はnull
  assert.strictEqual(
    UI.pickupAssistanceIcon({ pickup_assistance_type_id: 'other', pickup_assistance_note: 'メモ' }),
    null
  );
  // pickupAssistanceIcon: 未選択はnull
  assert.strictEqual(UI.pickupAssistanceIcon({}), null);

  const baseEvent = {
    id: 'evt-1', bed_id: 'bed-1', current_status: 'PICKUP_REQUIRED',
    escort_staff_id: null, patient_ic_tag_id: null,
  };
  const baseItem = { bed: { id: 'bed-1', bed_number: '702' }, examType: null, examRoom: null, remaining: 60000 };

  // アイコン設定済みタイプが選ばれている場合、優先対応一覧にアイコン+ラベルが出ること
  {
    const html = Priority._renderPriorityItem({
      ...baseItem,
      event: { ...baseEvent, pickup_assistance_type_id: 'pat-stretcher' },
    });
    assert(html.includes('priority-pickup-assist'), 'BUG: pickup_assistance_type_idがある場合、優先対応一覧にpriority-pickup-assistが表示されるべき');
    assert(html.includes('fa-bed'), 'BUG: マスタで設定したアイコン(fa-bed)が優先対応一覧に反映されるべき');
    assert(html.includes('ストレッチャー'), 'BUG: 選択されたお迎え介助の名称が優先対応一覧に表示されるべき');
  }

  // アイコン未設定タイプの場合、汎用アイコン(fa-hand-paper)にフォールバックすること
  {
    const html = Priority._renderPriorityItem({
      ...baseItem,
      event: { ...baseEvent, pickup_assistance_type_id: 'pat-noicon' },
    });
    assert(html.includes('priority-pickup-assist'));
    assert(html.includes('fa-hand-paper'), 'アイコン未設定タイプは汎用アイコンにフォールバックするべき');
    assert(html.includes('アイコン未設定タイプ'));
  }

  // 「その他」自由記入の場合もラベルが表示されること
  {
    const html = Priority._renderPriorityItem({
      ...baseItem,
      event: { ...baseEvent, pickup_assistance_type_id: 'other', pickup_assistance_note: '車椅子と酸素ボンベ' },
    });
    assert(html.includes('priority-pickup-assist'));
    assert(html.includes('車椅子と酸素ボンベ'));
  }

  // pickup_assistance_type_idが無い場合は表示されないこと(通常のMOVING等)
  {
    const html = Priority._renderPriorityItem({
      ...baseItem,
      event: { ...baseEvent, current_status: 'MOVING', pickup_assistance_type_id: null },
    });
    assert(!html.includes('priority-pickup-assist'), 'pickup_assistance_type_id未設定の場合はバッジを表示しないこと');
  }
}

console.log('Pickup assistance icon checks passed.');

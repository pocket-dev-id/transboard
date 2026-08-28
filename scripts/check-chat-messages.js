// 端末間チャット(chat_messages)の土台を検証する回帰テスト。
//
// チャットとアナウンス送信履歴は、30秒で消えるシグナリングキューではなく
// chat_messages テーブル(DB)を唯一の真実として保持する。この方針が崩れると
// 「リロードで履歴が消える」「受信時に起動していない端末が永久に見逃す」
// という元の問題に逆戻りするため、テーブルの結線と会話キーの一貫性を機械的に守る。
//
// 実装コードそのもの(js/ui.js の conversationKey、main.js の trimTable)を
// 取り出して直接実行し、出荷されるコードの挙動を検証する。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const mainSource = read('main.js');
const uiSource = read('js/ui.js');
const callSource = read('js/call.js');
const apiSource = read('js/api.js');

function extract(source, startMarker, endMarker) {
  const idx = source.indexOf(startMarker);
  assert(idx >= 0, `"${startMarker}" が見つかりません`);
  const end = source.indexOf(endMarker, idx);
  assert(end > idx, `"${startMarker}" の終端が見つかりません`);
  return source.slice(idx, end + endMarker.length);
}

// ── UI.conversationKey: 会話キーの一貫性 ──
const uiSandbox = { console };
vm.runInNewContext(`${uiSource}\nthis.UI = UI;`, uiSandbox);
const { UI } = uiSandbox;
assert(typeof UI.conversationKey === 'function', 'UI.conversationKeyを取り出せませんでした');

{
  // 双方向で同じキーになること。ここが崩れると、送信側と受信側が別々の会話を
  // 見ることになり、片方にしか履歴が出ない
  assert.strictEqual(
    UI.conversationKey('ward-1', 'room-3'),
    UI.conversationKey('room-3', 'ward-1'),
    'BUG: A→BとB→Aで同じ会話キーにならないと、送信側と受信側で会話が分裂する'
  );
  // 具体的な形(ソート済み連結)も固定しておく
  assert.strictEqual(UI.conversationKey('ward-1', 'room-3'), 'room-3|ward-1');
  assert.strictEqual(UI.conversationKey('room-3', 'ward-1'), 'room-3|ward-1');
  // 別の相手とは必ず別キーになること
  assert.notStrictEqual(
    UI.conversationKey('ward-1', 'room-3'),
    UI.conversationKey('ward-1', 'room-4'),
    '相手が違えば別の会話キーになること'
  );
  // 前後の空白は無視する(IDの与えられ方でキーがズレないように)
  assert.strictEqual(UI.conversationKey('  ward-1 ', 'room-3'), 'room-3|ward-1');
  // 相手が特定できないときは空文字(呼び出し元が保存/取得を中止できるように)
  assert.strictEqual(UI.conversationKey('ward-1', ''), '');
  assert.strictEqual(UI.conversationKey('', 'room-3'), '');
  assert.strictEqual(UI.conversationKey(null, undefined), '');
}

// ── main.js: chatConversationKey (会話キーのサーバー側再計算) ──
// POST時にクライアント入力のconversation_keyを信用せず、検証済みのfrom_id/to_idから
// サーバー側で独立に再計算する関数。UI.conversationKeyと同じ規則で実装されている
// ことを直接実行して確認する(規則がズレると片方の端末にしか履歴が見えなくなる)
const chatConversationKeySrc = extract(mainSource, 'function chatConversationKey(idA, idB) {', '\n}');
const chatConversationKey = new Function(`${chatConversationKeySrc}\nreturn chatConversationKey;`)();
assert(typeof chatConversationKey === 'function', 'main.jsからchatConversationKeyを取り出せませんでした');

{
  assert.strictEqual(
    chatConversationKey('ward-1', 'room-3'),
    chatConversationKey('room-3', 'ward-1'),
    'BUG: A→BとB→Aで同じ会話キーにならないと、送信側と受信側で会話が分裂する'
  );
  assert.strictEqual(chatConversationKey('ward-1', 'room-3'), 'room-3|ward-1');
  assert.strictEqual(chatConversationKey('  ward-1 ', 'room-3'), 'room-3|ward-1');
  assert.strictEqual(chatConversationKey('ward-1', ''), '');
  assert.strictEqual(chatConversationKey('', 'room-3'), '');
  assert.strictEqual(chatConversationKey(null, undefined), '');
  // js/ui.js の UI.conversationKey とサーバー側実装が食い違うと、クライアントが
  // 期待するキーとサーバーが上書きするキーがズレて履歴が見えなくなる
  assert.strictEqual(
    chatConversationKey('ward-1', 'room-3'),
    UI.conversationKey('ward-1', 'room-3'),
    'SECURITY/BUG: main.jsのchatConversationKeyとjs/ui.jsのUI.conversationKeyの規則が一致していません'
  );
}

// ── main.js: trimTable による chat_messages の上限管理 ──
const trimTableSrc = extract(mainSource, 'function trimTable(list, max, label) {', '\n}');
const maxEntriesMatch = mainSource.match(/const CHAT_MESSAGE_MAX_ENTRIES = (\d+);/);
assert(maxEntriesMatch, 'main.jsにCHAT_MESSAGE_MAX_ENTRIESが定義されていません');
const CHAT_MESSAGE_MAX_ENTRIES = Number(maxEntriesMatch[1]);
assert(CHAT_MESSAGE_MAX_ENTRIES > 0, 'CHAT_MESSAGE_MAX_ENTRIESは正の数であること');

{
  const trimTable = new Function(`${trimTableSrc}\nreturn trimTable;`)();

  // 上限以下では何も削らない
  const small = [{ id: 'a' }, { id: 'b' }];
  assert.strictEqual(trimTable(small, 10, null), false, '上限以下では削除しないこと');
  assert.strictEqual(small.length, 2);

  // 上限超過分を「古い方(配列の先頭)」から削ること。chat_messagesは
  // created_at昇順で追記されるため、先頭が最古になる
  const list = Array.from({ length: CHAT_MESSAGE_MAX_ENTRIES + 5 }, (_, i) => ({ id: `m${i}` }));
  assert.strictEqual(trimTable(list, CHAT_MESSAGE_MAX_ENTRIES, null), true, '上限超過時はtrueを返すこと');
  assert.strictEqual(list.length, CHAT_MESSAGE_MAX_ENTRIES, '上限ちょうどまで減らすこと');
  assert.strictEqual(list[0].id, 'm5', 'BUG: 古いものから削らないと、直近のやりとりが先に消えてしまう');
  assert.strictEqual(list[list.length - 1].id, `m${CHAT_MESSAGE_MAX_ENTRIES + 4}`, '最新のメッセージは残ること');
}

// ── main.js: chat_messages テーブルの結線 ──
{
  const seedsSrc = extract(mainSource, 'const SEEDS = {', '\n};');
  assert(
    /chat_messages:\s*\[\]/.test(seedsSrc),
    'SEEDS(初期DB)にchat_messages: []がありません(新規DBでテーブルが欠落します)'
  );
  assert(
    /if \(!db\.chat_messages\) \{\s*db\.chat_messages = \[\];/.test(mainSource),
    '既存DBのマイグレーションでchat_messagesを補完していません(更新した端末でテーブルが欠落します)'
  );
  assert(
    /const ALLOWED_TABLES = new Set\(\[[\s\S]*?'chat_messages'[\s\S]*?\]\);/.test(mainSource),
    'ALLOWED_TABLESにchat_messagesがありません(APIから読み書きできません)'
  );
  // 患者データ扱いから外れると、APIトークン無しで会話本文が読めてしまう
  assert(
    /const PATIENT_DATA_TABLES = new Set\(\[[^\]]*'chat_messages'[^\]]*\]\);/.test(mainSource),
    'SECURITY: chat_messagesがPATIENT_DATA_TABLESにありません。チャット本文・アナウンス文には患者名が入りうるため、APIトークン必須の患者データ扱いにしなければなりません'
  );
  // 追記専用テーブルなので楽観ロックの対象にはしない(競合誤検知で送信が落ちる)
  assert(
    !/const MASTER_REVISION_TABLES = new Set\(\[[^\]]*'chat_messages'[^\]]*\]\)/.test(mainSource),
    'chat_messagesはMASTER_REVISION_TABLESに入れないこと(追記専用のため楽観ロックは不要)'
  );
  // 上限管理が繋がっていないと無制限に肥大化する
  assert(
    /table === 'chat_messages'\s*\)\s*\{\s*trimTable\(list, CHAT_MESSAGE_MAX_ENTRIES/.test(mainSource),
    'chat_messagesの書き込み経路でtrimTableが呼ばれていません(DBが無制限に肥大化します)'
  );
  // conversation_key指定時にサーバー側で絞らないと、5秒ポーリングのたびに院内の
  // 全会話分(最大CHAT_MESSAGE_MAX_ENTRIES件)を無駄に転送することになる。
  // handover_notes(ward_id)/bed_occupancy_log(bed_id)/schedule_items(start_ms/end_ms)
  // と同じ既存パターンに揃える
  assert(
    /if \(table === 'chat_messages'\) \{\s*const conversationKey = searchParams\.get\('conversation_key'\);\s*if \(conversationKey\) \{\s*return \{ data: list\.filter\(m => m\.conversation_key === conversationKey\) \};/.test(mainSource),
    "PERF: chat_messagesのGETでconversation_key指定時にサーバー側で絞っていません。院内の全会話が5秒ポーリングごとに転送されてしまいます(handover_notesのward_id絞り込みと同じパターンで実装すること)"
  );
}

// ── main.js: chat_messagesの追記専用ガード・POST検証(セキュリティ) ──
{
  // PATCH/PUT/DELETEはapp-onlyガードで拒否し、POSTだけ通すこと
  assert(
    /if \(table === 'chat_messages' && method !== 'GET' && method !== 'POST'\) \{\s*return \{ success: false, message: 'chat_messages is append-only and cannot be modified or deleted' \};\s*\}/.test(mainSource),
    'SECURITY: chat_messagesへのPATCH/PUT/DELETEを拒否する追記専用ガードがありません。共有APIトークンを持つ任意端末が過去の会話・アナウンス履歴を書き換え・削除できてしまいます'
  );

  // kindの許可リスト
  assert(
    /const CHAT_MESSAGE_KINDS = new Set\(\['chat', 'announce'\]\);/.test(mainSource),
    'main.jsにCHAT_MESSAGE_KINDSの許可リストが定義されていません'
  );
  assert(
    /if \(!CHAT_MESSAGE_KINDS\.has\(data\.kind\)\) \{\s*return \{ success: false, message: `Invalid chat_messages kind: \$\{data\.kind\}` \};\s*\}/.test(mainSource),
    'SECURITY: chat_messagesのPOSTでkindの許可リスト検証がされていません'
  );

  // bodyの上限文字数への切り詰め
  const bodyMaxMatch = mainSource.match(/const CHAT_MESSAGE_BODY_MAX_LENGTH = (\d+);/);
  assert(bodyMaxMatch, 'main.jsにCHAT_MESSAGE_BODY_MAX_LENGTHが定義されていません');
  assert(Number(bodyMaxMatch[1]) > 0, 'CHAT_MESSAGE_BODY_MAX_LENGTHは正の数であること');
  assert(
    /data\.body = body\.slice\(0, CHAT_MESSAGE_BODY_MAX_LENGTH\);/.test(mainSource),
    'SECURITY: chat_messagesのbodyがサーバー側で上限文字数に切り詰められていません(アナウンス文言はクライアント側に文字数上限が無いためDBが無制限に肥大化します)'
  );

  // from_id/to_idの実在確認(病棟または検査室であること)
  assert(
    /const fromExists = \(db\.wards \|\| \[\]\)\.some\(w => String\(w\.id\) === String\(data\.from_id\)\)\s*\|\|\s*\(db\.exam_rooms \|\| \[\]\)\.some\(r => String\(r\.id\) === String\(data\.from_id\)\);/.test(mainSource),
    'SECURITY: chat_messagesのfrom_idが実在するward/exam_roomかサーバー側で検証されていません'
  );
  assert(
    /const toExists = \(db\.wards \|\| \[\]\)\.some\(w => String\(w\.id\) === String\(data\.to_id\)\)\s*\|\|\s*\(db\.exam_rooms \|\| \[\]\)\.some\(r => String\(r\.id\) === String\(data\.to_id\)\);/.test(mainSource),
    'SECURITY: chat_messagesのto_idが実在するward/exam_roomかサーバー側で検証されていません'
  );

  // conversation_key/id/created_atをクライアント入力のまま信用しないこと
  const postHandlerSrc = extract(mainSource, "if (method === 'POST') {", "\n  if (method === 'PUT' || method === 'PATCH') {");
  assert(
    postHandlerSrc.includes('data.conversation_key = chatConversationKey(data.from_id, data.to_id);'),
    'SECURITY: chat_messagesのconversation_keyがクライアント入力のまま保存されています(検証済みfrom_id/to_idから再計算して上書きすること)'
  );
  assert(
    postHandlerSrc.includes('delete data.id;') && postHandlerSrc.includes('data.created_at = Date.now();'),
    'SECURITY: chat_messagesのid/created_atがクライアント入力のまま保存されています。POSTのidを使い回すと既存メッセージを上書きできてしまうため、常にサーバー側で新規id・作成時刻を発行すること'
  );

  // このブロックはid自動発行(if (!data.id) {...})より前に実行されること。
  // 後ろにあると delete data.id が効かず、クライアント指定idのままindexが
  // 見つかって「上書き」経路に入ってしまう
  const chatBlockPos = postHandlerSrc.indexOf("if (table === 'chat_messages') {");
  const idGenPos = postHandlerSrc.indexOf('if (!data.id) {');
  assert(chatBlockPos >= 0, "POSTハンドラ内にif (table === 'chat_messages') {...}の検証ブロックが見つかりません");
  assert(idGenPos >= 0, 'POSTハンドラ内にid自動発行ロジックが見つかりません');
  assert(
    chatBlockPos < idGenPos,
    'SECURITY: chat_messagesの検証ブロックはid自動発行(if (!data.id))より前で実行すること。後ろだとdelete data.idが効かず、既存メッセージへの上書きを防げません'
  );
}

// ── js/api.js: 取得ヘルパー ──
{
  const fnSrc = extract(apiSource, 'async getChatMessages(conversationKey) {', '\n  },');
  assert(fnSrc.includes("getAll('chat_messages'"), 'getChatMessagesがchat_messagesを読んでいません');
  assert(
    /conversation_key === conversationKey/.test(fnSrc),
    '会話キーで絞り込んでいません(他の会話のメッセージが混ざります)'
  );
  assert(
    /\(a\.created_at \|\| 0\) - \(b\.created_at \|\| 0\)/.test(fnSrc),
    'created_at昇順(古い順)に並べていません。タイムラインの並び順が壊れます'
  );
}

// ── js/call.js: 送信経路の結線 ──
{
  // チャット送信もアナウンス履歴もこの1関数を通す(会話キー生成を1箇所に閉じ込める)
  const recordSrc = extract(callSource, 'async recordChatMessage({ fromId, toId, kind, body }) {', '\n  },');
  assert(recordSrc.includes('UI.conversationKey(fromId, toId)'), 'recordChatMessageがUI.conversationKeyを使っていません');
  assert(recordSrc.includes("API.create('chat_messages'"), 'recordChatMessageがchat_messagesへ保存していません');
  assert(/if \(!conversationKey\) return null;/.test(recordSrc), '会話キーが空のときは保存しないこと');

  // アナウンス送信時に、読み上げ(シグナリング)とは別に履歴を残していること
  const sendAnnounceSrc = extract(callSource, 'const sendAnnounce = async (text) => {', '\n    };');
  assert(
    sendAnnounceSrc.includes("type: 'speech'"),
    'アナウンスの即時読み上げ(シグナリング送信)が失われています'
  );
  assert(
    /recordChatMessage\(\{[\s\S]*?kind: 'announce'/.test(sendAnnounceSrc),
    "BUG: アナウンス送信時にkind:'announce'として履歴を残していません。送った内容が後から追えなくなります"
  );
  // 履歴の記録失敗で読み上げ送信まで失敗扱いにしない
  assert(
    /recordChatMessage\([\s\S]*?\)\s*\.catch\(/.test(sendAnnounceSrc),
    '履歴記録の失敗はcatchすること(読み上げは既に送信済みのため、送信自体を失敗扱いにしない)'
  );
}

console.log('Chat message checks passed.');

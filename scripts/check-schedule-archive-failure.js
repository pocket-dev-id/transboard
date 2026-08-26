// スケジュール取り込み後のCSVアーカイブ・削除処理(archiveScheduleFeedFile)は、
// unlinkSync/mkdirSync/renameSyncの失敗を無条件で握りつぶさず、成否を呼び出し元
// (commitScheduleFeedImport)へ返さなければならない。以前は例外を空catchで
// 捨てていたため、共有フォルダが読み取り専用等の理由でアーカイブ/削除に
// 失敗しても、DB保存(予定の登録)自体は成功しているためUIには「取り込み成功」
// としか表示されず、元CSVが監視フォルダに残り続けてインターバル/時刻指定
// モードで同じCSVを繰り返し取り込んでしまっていた。
//
// main.jsからarchiveScheduleFeedFile/commitScheduleFeedImportの実装コード
// そのものを取り出して直接実行し、出荷されるコードの挙動を検証する。
// archiveScheduleFeedFileは実際のfs呼び出しを行う関数のため、実際の一時
// ディレクトリに対して実行し、genuineなENOENT/ENOTDIR等の失敗を発生させて
// 確認する。commitScheduleFeedImportはDB(readDB/writeDB)をスタブに差し替え、
// アーカイブ結果だけを制御して集約ロジックを検証する。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

function extractFunction(startMarker) {
  const idx = source.indexOf(startMarker);
  assert(idx >= 0, `${startMarker} が見つかりません(main.jsの構造が変わった可能性があります)`);
  const end = source.indexOf('\n}', idx);
  assert(end > idx, `${startMarker} の終端(\\n})が見つかりません`);
  return source.slice(idx, end + 2);
}

const archiveSrc = extractFunction('function archiveScheduleFeedFile(filePath, feed, policy) {');
const commitSrc = extractFunction('function commitScheduleFeedImport(feed, parsedFiles) {');

function makeArchiveScheduleFeedFile() {
  const factory = new Function('fs', 'path', 'console', `${archiveSrc}\nreturn archiveScheduleFeedFile;`);
  return factory(fs, path, console);
}

function makeCommitScheduleFeedImport(deps) {
  const factory = new Function(
    'readDB', 'writeDB', 'archiveScheduleFeedFile', 'console',
    `${commitSrc}\nreturn commitScheduleFeedImport;`
  );
  return factory(deps.readDB, deps.writeDB, deps.archiveScheduleFeedFile, console);
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tb-sched-archive-'));
}

function main() {
  const archiveScheduleFeedFile = makeArchiveScheduleFeedFile();
  const feed = { id: 'feed-1', name: 'テストフィード' };

  // ── archiveScheduleFeedFile: 実際のfsに対する成功/失敗を検証 ──

  // 1) action: skip はファイルに触れず成功を返す
  {
    const dir = mkTmpDir();
    const filePath = path.join(dir, 'a.csv');
    fs.writeFileSync(filePath, 'x');
    const result = archiveScheduleFeedFile(filePath, feed, { action: 'skip' });
    assert.deepStrictEqual(result, { success: true, message: null }, 'skipは常に成功扱いであること');
    assert.ok(fs.existsSync(filePath), 'skipではファイルを削除・移動しないこと');
  }

  // 2) action: delete 成功
  {
    const dir = mkTmpDir();
    const filePath = path.join(dir, 'a.csv');
    fs.writeFileSync(filePath, 'x');
    const result = archiveScheduleFeedFile(filePath, feed, { action: 'delete' });
    assert.strictEqual(result.success, true, '削除成功時はsuccess:trueを返すこと');
    assert.ok(!fs.existsSync(filePath), 'ファイルが実際に削除されること');
  }

  // 3) BUG FIX: action: delete 失敗(対象ファイルが存在しない)は成功を騙らないこと
  {
    const dir = mkTmpDir();
    const filePath = path.join(dir, 'does-not-exist.csv');
    const result = archiveScheduleFeedFile(filePath, feed, { action: 'delete' });
    assert.strictEqual(result.success, false, 'BUG FIX: 削除に失敗した場合success:falseを返すこと(黙って成功扱いにしないこと)');
    assert.ok(typeof result.message === 'string' && result.message.length > 0, '失敗理由のメッセージを返すこと');
  }

  // 4) action: archive 成功
  {
    const dir = mkTmpDir();
    const filePath = path.join(dir, 'a.csv');
    fs.writeFileSync(filePath, 'x');
    const result = archiveScheduleFeedFile(filePath, feed, { action: 'archive' });
    assert.strictEqual(result.success, true, 'アーカイブ成功時はsuccess:trueを返すこと');
    assert.ok(fs.existsSync(path.join(dir, 'archive', 'a.csv')), 'archive/配下へ実際に移動されること');
    assert.ok(!fs.existsSync(filePath), '元の場所からは無くなっていること');
  }

  // 5) BUG FIX: action: archive で移動先のarchiveディレクトリを作成できない
  //    場合(同名の通常ファイルが既に存在する等)、成功を騙らないこと
  {
    const dir = mkTmpDir();
    const filePath = path.join(dir, 'a.csv');
    fs.writeFileSync(filePath, 'x');
    // 'archive' という名前の通常ファイルを先に置いておくと、mkdirSyncが
    // ディレクトリとして作成できずENOTDIR相当で失敗する
    fs.writeFileSync(path.join(dir, 'archive'), 'not a directory');
    const result = archiveScheduleFeedFile(filePath, feed, { action: 'archive' });
    assert.strictEqual(result.success, false, 'BUG FIX: アーカイブフォルダを作成できない場合success:falseを返すこと');
    assert.ok(fs.existsSync(filePath), '移動できなかった場合、元のCSVは監視フォルダに残ること(黙って消えないこと)');
  }

  // 6) BUG FIX: action: archive でrenameSync自体が失敗した場合(移動元が
  //    レース状態等で既に無い)も成功を騙らないこと
  {
    const dir = mkTmpDir();
    const filePath = path.join(dir, 'does-not-exist.csv');
    const result = archiveScheduleFeedFile(filePath, feed, { action: 'archive' });
    assert.strictEqual(result.success, false, 'BUG FIX: 移動元のCSVが既に無い場合success:falseを返すこと');
  }

  // ── commitScheduleFeedImport: アーカイブ失敗の集約ロジックを検証 ──
  // (DBはスタブに差し替え、アーカイブ結果だけを制御する)

  function makeCommitDeps({ dbSaveSucceeds = true, archiveResults = {} } = {}) {
    let savedItems = null;
    const readDB = () => ({ schedule_items: [] });
    const writeDB = (db) => { savedItems = db.schedule_items; return dbSaveSucceeds; };
    const archiveScheduleFeedFileStub = (filePath) => archiveResults[filePath] || { success: true, message: null };
    return {
      deps: { readDB, writeDB, archiveScheduleFeedFile: archiveScheduleFeedFileStub },
      getSavedItems: () => savedItems,
    };
  }

  const parsedFilesOk = [
    { filePath: '/watch/a.csv', success: true, items: [{ id: 'x1' }], rowCount: 1 },
    { filePath: '/watch/b.csv', success: true, items: [{ id: 'x2' }], rowCount: 1 },
  ];

  // 7) 全ファイルのアーカイブが成功する通常ケース: archiveWarningはnull
  {
    const { deps } = makeCommitDeps();
    const commitScheduleFeedImport = makeCommitScheduleFeedImport(deps);
    const result = commitScheduleFeedImport(feed, parsedFilesOk);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.importedCount, 2);
    assert.strictEqual(result.archiveWarning, null, 'アーカイブが全て成功していればarchiveWarningはnullであること');
  }

  // 8) BUG FIX: 1件のアーカイブが失敗した場合、DB保存(予定の登録)自体は成功
  //    しているためsuccess:trueは維持しつつ、archiveWarningでその事実を
  //    呼び出し元へ伝えること(黙って成功扱いにしないこと)
  {
    const { deps, getSavedItems } = makeCommitDeps({
      archiveResults: { '/watch/a.csv': { success: false, message: 'a.csvの削除に失敗しました: EACCES' } },
    });
    const commitScheduleFeedImport = makeCommitScheduleFeedImport(deps);
    const result = commitScheduleFeedImport(feed, parsedFilesOk);
    assert.strictEqual(result.success, true, '予定のDB保存自体は成功しているため、アーカイブ失敗だけでsuccess:falseにはしないこと');
    assert.strictEqual(result.importedCount, 2, '保存された予定件数はアーカイブ失敗の影響を受けないこと');
    assert.ok(getSavedItems() && getSavedItems().length === 2, '予定は実際にDBへ保存されていること(部分成功の実体)');
    assert.ok(typeof result.archiveWarning === 'string' && result.archiveWarning.length > 0,
      'BUG FIX: アーカイブ失敗が1件でもあれば、archiveWarningとして呼び出し元(通知・手動取り込みAPI)へ伝わること');
    assert.ok(result.archiveWarning.includes('EACCES'), '失敗理由を含んだメッセージであること');
  }

  // 9) 複数ファイルのアーカイブが失敗した場合、両方の理由が含まれること
  {
    const { deps } = makeCommitDeps({
      archiveResults: {
        '/watch/a.csv': { success: false, message: 'a.csv失敗理由' },
        '/watch/b.csv': { success: false, message: 'b.csv失敗理由' },
      },
    });
    const commitScheduleFeedImport = makeCommitScheduleFeedImport(deps);
    const result = commitScheduleFeedImport(feed, parsedFilesOk);
    assert.strictEqual(result.success, true);
    assert.ok(result.archiveWarning.includes('a.csv失敗理由') && result.archiveWarning.includes('b.csv失敗理由'),
      '複数件アーカイブに失敗した場合、すべての理由がarchiveWarningに含まれること');
  }

  // 10) DB保存自体が失敗した場合は、従来通りsuccess:falseであること(アーカイブは
  //     一切呼ばれない=元CSVは監視フォルダに残ったままになる想定通りの挙動)
  {
    let archiveCalled = false;
    const { deps } = makeCommitDeps({ dbSaveSucceeds: false });
    deps.archiveScheduleFeedFile = () => { archiveCalled = true; return { success: true, message: null }; };
    const commitScheduleFeedImport = makeCommitScheduleFeedImport(deps);
    const result = commitScheduleFeedImport(feed, parsedFilesOk);
    assert.strictEqual(result.success, false, 'DB保存自体に失敗した場合はsuccess:falseのままであること');
    assert.strictEqual(archiveCalled, false, 'DB保存に失敗した場合、アーカイブ処理は呼ばれないこと(保存できていないCSVを消してしまわないこと)');
  }

  console.log('Schedule archive failure reporting checks passed.');
}

main();

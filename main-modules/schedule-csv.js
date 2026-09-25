'use strict';

// 予定CSVの日時解釈と、監視フォルダからのヘッダ読み取り。
// DBの読み書きは行わない(呼び出し元が読んだdbを引数で受け取る)。

const fs = require('fs');
const path = require('path');

// 文字コード判定とSMB認証はmain.js側に残っているため注入で受け取る。
// 既定はどちらも「判定しない/認証しない」= ローカルフォルダのUTF-8以外として
// 扱う保守的な動作にしておき、configureScheduleCsv()で本物に差し替える
let isUtf8 = () => false;
let authenticateSMBSync = () => null;

function configureScheduleCsv(deps) {
  isUtf8 = deps.isUtf8;
  authenticateSMBSync = deps.authenticateSMBSync;
}

// 時刻部分の区切り文字は現場のCSV/機器出力によって : (半角/全角) と . が
// 混在するため、いずれも許容する（例: 13:05:30 / 13：05 / 13.05.30 / 13.05）
const SCHEDULE_TIME_RE_SRC = '(\\d{1,2})[：:.](\\d{2})(?:[：:.](\\d{2}))?';

// 日付部分の正規表現は呼び出しのたびに再構築せず、モジュールスコープで1度だけ
// コンパイルしておく(CSV取り込みは行ごとにparseScheduleDatetimeMsを呼ぶため)
const SCHEDULE_DATE_YMD_RE = new RegExp(`^(\\d{4})[\\/\\-](\\d{1,2})[\\/\\-](\\d{1,2})(?:[\\s　T]+${SCHEDULE_TIME_RE_SRC})?`);
// MM/DD/YYYY・DD/MM/YYYYはどちらも数値列の形状が同じで、月日どちらの意味に
// 取るかは呼び出し側(tryParseScheduleDatetimeMdy/Dmy)が決める
const SCHEDULE_DATE_SLASH_RE = new RegExp(`^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})(?:\\s+${SCHEDULE_TIME_RE_SRC})?`);

// 年月日時分秒からDateを生成する。JavaScriptのDateコンストラクタは範囲外の値
// (2月31日→3月3日前後、13月→翌年1月、25時→翌日1時等)を拒否せず自動的に
// 繰り上げてしまうため、CSVの入力ミスがエラーにならず全く別の日時の予定として
// 取り込まれてしまう。range検証に加え、構築後の値を入力値と突き合わせ、
// 繰り上がっていれば(=食い違っていれば)採用しない
function buildValidatedScheduleDateMs(y, mo, dy, h, mi, se) {
  if (!(mo >= 1 && mo <= 12)) return null;
  if (!(dy >= 1 && dy <= 31)) return null;
  if (!(h >= 0 && h <= 23)) return null;
  if (!(mi >= 0 && mi <= 59)) return null;
  if (!(se >= 0 && se <= 59)) return null;
  const d = new Date(y, mo - 1, dy, h, mi, se);
  if (isNaN(d.getTime())) return null;
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== dy ||
    d.getHours() !== h || d.getMinutes() !== mi || d.getSeconds() !== se) {
    // 例: 2026年2月31日を渡すと2026年3月3日を返してくる等、範囲外の値が
    // 繰り上げられて別の日時になった場合はここで食い違う
    return null;
  }
  return d.getTime();
}

// YYYY-MM-DD / YYYY/MM/DD HH:mm[:ss] (日付区切りは - / のいずれも可、
// ISO 8601のT区切りを含む。時刻区切りは : ： . のいずれも可)
function tryParseScheduleDatetimeYmd(combined) {
  const m = combined.match(SCHEDULE_DATE_YMD_RE);
  if (!m) return null;
  const [, y, mo, dy, h = '0', mi = '0', se = '0'] = m;
  return buildValidatedScheduleDateMs(Number(y), Number(mo), Number(dy), Number(h), Number(mi), Number(se));
}

// MM/DD/YYYY・DD/MM/YYYYはどちらも「数値/数値/YYYY」で形状が同じで、月日の
// どちらの意味に取るかが違うだけのため、共通ロジックに集約する
// (時刻区切りは : ： . のいずれも可)
function tryParseScheduleDatetimeSlash(combined, swapDayMonth) {
  const m = combined.match(SCHEDULE_DATE_SLASH_RE);
  if (!m) return null;
  const [, g1, g2, y, h = '0', mi = '0', se = '0'] = m;
  const mo = swapDayMonth ? g2 : g1;
  const dy = swapDayMonth ? g1 : g2;
  return buildValidatedScheduleDateMs(Number(y), Number(mo), Number(dy), Number(h), Number(mi), Number(se));
}

// MM/DD/YYYY HH:mm[:ss]
function tryParseScheduleDatetimeMdy(combined) {
  return tryParseScheduleDatetimeSlash(combined, false);
}

// DD/MM/YYYY HH:mm[:ss]。自動判定のフォールバック対象には含めない
// (mdyとの曖昧さがあるため、明示的にformat指定された場合のみ使う)
function tryParseScheduleDatetimeDmy(combined) {
  return tryParseScheduleDatetimeSlash(combined, true);
}

// formatは'auto'|'ymd'|'mdy'|'dmy'|未指定。明示的に指定された場合は該当の
// パターンを最優先で試し、それで解決しなければ(未指定/'auto'の場合も含めて)
// 従来通りymd→mdyの順の自動判定へフォールバックする(dmyは自動判定の対象に
// 含めない。これによりformat省略時の挙動を完全に後方互換に保つ)
function parseScheduleDatetimeMs(dateStr, timeStr, format) {
  if (!dateStr) return null;
  const combined = timeStr ? `${dateStr.trim()} ${timeStr.trim()}` : dateStr.trim();

  if (format === 'ymd') {
    const ms = tryParseScheduleDatetimeYmd(combined);
    if (ms !== null) return ms;
  } else if (format === 'mdy') {
    const ms = tryParseScheduleDatetimeMdy(combined);
    if (ms !== null) return ms;
  } else if (format === 'dmy') {
    const ms = tryParseScheduleDatetimeDmy(combined);
    if (ms !== null) return ms;
  }

  // どちらの形式にも一致しない場合、Dateコンストラクタへ丸投げして「解釈でき
  // てしまう」ことに賭けない(範囲外の値を無検証で繰り上げて別の日時として
  // 受理してしまう恐れがあるため)。この2形式が現場CSVの実質すべてをカバーする
  const ymdMs = tryParseScheduleDatetimeYmd(combined);
  if (ymdMs !== null) return ymdMs;
  return tryParseScheduleDatetimeMdy(combined);
}

const MAX_CSV_FILE_BYTES = 20 * 1024 * 1024;
const MAX_CSV_ROWS = 100000;
const MAX_BACKUP_FILE_BYTES = 100 * 1024 * 1024;

function assertCsvFileSize(filePath) {
  const size = fs.statSync(filePath).size;
  if (size > MAX_CSV_FILE_BYTES) {
    throw new Error(`CSVファイルが大きすぎます（上限${MAX_CSV_FILE_BYTES / 1024 / 1024}MB）`);
  }
}

const SCHEDULE_CSV_ENCODINGS = new Set([
  'auto',
  'utf-8',
  'shift-jis',
  'utf-16le',
  'utf-16be',
  'euc-jp',
]);

function normalizeScheduleCsvEncoding(value) {
  const normalized = String(value || 'auto').trim().toLowerCase();
  return SCHEDULE_CSV_ENCODINGS.has(normalized) ? normalized : 'auto';
}

function decodeScheduleCsvBuffer(buffer, requestedEncoding = 'auto') {
  let encoding = normalizeScheduleCsvEncoding(requestedEncoding);
  if (encoding === 'auto') {
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      encoding = 'utf-8';
    } else if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      encoding = 'utf-16le';
    } else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      encoding = 'utf-16be';
    } else if (isUtf8(buffer)) {
      encoding = 'utf-8';
    } else {
      encoding = 'shift-jis';
    }
  }

  let text = new TextDecoder(encoding).decode(buffer);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text, encoding };
}

// 監視フォルダのパスから、それを使っているスケジュールフィードを引き当てる。
// ヘッダ読み込み時にそのフィードのSMB認証情報を使うために必要。
function findFeedForFolder(db, folderPath) {
  const target = String(folderPath || '').trim();
  if (!target) return null;
  const resolved = path.resolve(target).toLowerCase();
  return (db.schedule_feeds || []).find(feed => {
    const dir = String(feed?.watch_dir || '').trim();
    return dir && path.resolve(dir).toLowerCase() === resolved;
  }) || null;
}

function readScheduleCsvHeaders(folderPath, requestedEncoding = 'auto', credentials = null) {
  try {
    const authResult = authenticateSMBSync(folderPath, credentials);
    if (authResult && authResult.success === false) {
      return { success: false, ok: false, reason: authResult.message };
    }
    const files = fs.readdirSync(folderPath).filter(f => f.toLowerCase().endsWith('.csv'));
    if (files.length === 0) return { success: false, ok: false, reason: 'no_csv' };
    const firstFile = path.join(folderPath, files[0]);
    assertCsvFileSize(firstFile);
    const buffer = fs.readFileSync(firstFile);
    const { text, encoding } = decodeScheduleCsvBuffer(buffer, requestedEncoding);
    const lines = text.split(/\r?\n/);
    const firstLine = lines[0] || '';
    // カンマ区切りとタブ区切りを自動判定
    const sep = firstLine.includes('\t') ? '\t' : ',';
    const headers = firstLine.split(sep).map(h => h.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
    // 列マッピング設定画面で「この設定だと実際どう解釈されるか」をプレビュー
    // できるよう、先頭データ行も{ヘッダ名: 値}の形で1件だけ返す。ファイルを
    // 読み込み直さずに済むよう、この呼び出し1回でヘッダとサンプルの両方を賄う
    const secondLine = lines[1] || '';
    let sampleRow = null;
    if (secondLine.trim()) {
      const cells = secondLine.split(sep).map(c => c.replace(/^["']|["']$/g, '').trim());
      sampleRow = {};
      headers.forEach((h, i) => { sampleRow[h] = cells[i] != null ? cells[i] : ''; });
    }
    return { success: true, ok: true, headers, filename: files[0], encoding, sampleRow };
  } catch (e) {
    return { success: false, ok: false, reason: e.message };
  }
}

// 列マッピング設定画面のプレビュー専用。ファイル/SMBアクセスは行わず、
// 既に取得済みのsampleRow(readScheduleCsvHeadersが返す先頭データ行)に対して
// 既存のparseScheduleDatetimeMsをそのまま適用するだけの薄いラッパー。
// dateColが未入力/sampleRowに無い場合は「まだ判定できない」であって
// エラーではないため、ms: nullを返す(呼び出し元でプレビュー非表示に使う)
function previewScheduleDatetime(sampleRow, mode, dateCol, timeCol, dateFormat) {
  if (!sampleRow || !dateCol || !Object.prototype.hasOwnProperty.call(sampleRow, dateCol)) {
    return { success: true, ms: null };
  }
  const dateVal = sampleRow[dateCol];
  const timeVal = mode === 'combined' ? null : (timeCol ? sampleRow[timeCol] : null);
  const ms = parseScheduleDatetimeMs(dateVal, timeVal, dateFormat);
  return { success: true, ms };
}

module.exports = {
  configureScheduleCsv,
  SCHEDULE_TIME_RE_SRC,
  parseScheduleDatetimeMs,
  buildValidatedScheduleDateMs,
  previewScheduleDatetime,
  MAX_CSV_FILE_BYTES,
  MAX_CSV_ROWS,
  MAX_BACKUP_FILE_BYTES,
  assertCsvFileSize,
  normalizeScheduleCsvEncoding,
  decodeScheduleCsvBuffer,
  findFeedForFolder,
  readScheduleCsvHeaders,
};

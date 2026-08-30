// scripts/check-*.jsの多くが、main.js/js/*.jsから実装コードそのものを
// 文字列マーカーで抜き出してnew Function/vmで直接実行する、という同じ手法を
// 使っている。ROOT解決・ファイル読み込み・マーカー抽出のボイラープレートが
// 各ファイルで個別に(境界規約も微妙に違う形で)重複していたため、ここに
// 共通化する。抽出対象(マーカー文字列そのもの)は各テストファイル固有のため
// 引き続き呼び出し側が指定する。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

// ROOTからの相対パスでファイルを読み込む
function readRoot(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

// startMarkerの出現位置から、行頭に戻る'\n}'(トップレベル関数の閉じ括弧)
// までを抜き出す。fromIdxを指定すると、その位置以降で最初に見つかった
// startMarkerを使う(同名マーカーが複数箇所にある場合の絞り込み用)
function extractByBraceEnd(source, startMarker, fromIdx = 0) {
  const startIdx = source.indexOf(startMarker, fromIdx);
  if (startIdx < 0) return null;
  const endIdx = source.indexOf('\n}', startIdx);
  if (endIdx < 0) return null;
  return source.slice(startIdx, endIdx + 2);
}

// startMarker〜endMarkerの間(両端を含む)を抜き出す任意境界版
function extractBetweenMarkers(source, startMarker, endMarker, fromIdx = 0) {
  const startIdx = source.indexOf(startMarker, fromIdx);
  if (startIdx < 0) return null;
  const endIdx = source.indexOf(endMarker, startIdx);
  if (endIdx < 0) return null;
  return source.slice(startIdx, endIdx + endMarker.length);
}

// startMarker(メソッドの先頭、例: 'async loadMasters(...) {')の直後から
// '\n  },'(メソッド定義の閉じ)までの本体だけを取り出す(マーカー自体は含まない)。
// 呼び出し元がハーネス内で独自のラッパー関数シグネチャに本体だけを差し込むために使う
function extractMethodBody(source, startMarker) {
  const startIdx = source.indexOf(startMarker);
  if (startIdx < 0) return null;
  const bodyStart = startIdx + startMarker.length;
  const endIdx = source.indexOf('\n  },', bodyStart);
  if (endIdx < 0) return null;
  return source.slice(bodyStart, endIdx);
}

// fromMarkerの位置から、functionMarker(fromMarkerより後にある関数定義)の
// '\n}'終端までを抜き出す。定数定義+それを使う関数、のように依存関係のある
// 2つの宣言をまとめて1つのFunction化可能なスニペットとして取り出すために使う
function extractThroughFunctionEnd(source, fromMarker, functionMarker) {
  const startIdx = source.indexOf(fromMarker);
  if (startIdx < 0) return null;
  const fnIdx = source.indexOf(functionMarker);
  if (fnIdx < startIdx) return null;
  const endIdx = source.indexOf('\n}', fnIdx);
  if (endIdx < 0) return null;
  return source.slice(startIdx, endIdx + 2);
}

module.exports = {
  ROOT,
  readRoot,
  extractByBraceEnd,
  extractBetweenMarkers,
  extractMethodBody,
  extractThroughFunctionEnd,
};

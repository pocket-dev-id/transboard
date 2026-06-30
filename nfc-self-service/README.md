# NFC Self Service

二要素認証登録用のNFCカード情報を、各利用者がセルフサービスで取得して提出するための小さなElectronアプリです。

## できること

- PC/SC対応NFCリーダーからカードUIDを読み取る
- 職員番号、氏名、所属、メールアドレスを入力する
- UIDとUIDのSHA-256ハッシュを提出用データとして生成する
- JSONをクリップボードへコピーする
- JSONまたはCSVとして保存する

## 起動

```powershell
npm start
```

親プロジェクト配下で使う場合、親側の `node_modules` にElectronが入っていればこのフォルダ内から起動できます。

## 注意

- UIDはカード固有情報です。提出・保管の取り扱いは院内/組織のルールに従ってください。
- UID生値を提出したくない運用では、`uidHashSha256` を登録キーとして使う設計にしてください。
- 読み取り方式は既存TransBoardの `nfc-reader.ps1` と同じPC/SC + APDU `FF CA 00 00 00` 方式です。

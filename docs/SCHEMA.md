# TransBoard データベーススキーマ定義 (データ #3)

TransBoard はSQLiteを使用せず、JSONファイル（`transboard-db.json`）を独自ローカルデータベースとして使用します。
保存先は `app.getPath('userData')` 配下（Windows: `%APPDATA%\TransBoard\`）です。

---

## テーブル一覧

| テーブル名 | 概要 |
|---|---|
| `wards` | 病棟マスタ |
| `beds` | ベッドマスタ（患者在籍情報を含む） |
| `bed_types` | ベッド種別マスタ（一般／隔離／ICU等） |
| `exam_rooms` | 検査室マスタ |
| `exam_types` | 検査種別マスタ |
| `staffs` | スタッフマスタ |
| `system_settings` | システム設定（key-valueペア） |
| `transfer_events` | 移送イベント（移送1件ごとのレコード） |
| `transfer_status_logs` | ステータス変更ログ（監査証跡） |
| `audit_logs` | 操作監査ログ（患者登録・設定変更等） |
| `calls` | 通話セッション記録 |
| `import_logs` | CSVインポート履歴 |
| `schedule_feeds` | スケジュールフィード定義 |
| `schedule_items` | スケジュールアイテム |

---

## テーブル詳細

### `wards` — 病棟マスタ

| フィールド | 型 | 説明 |
|---|---|---|
| `id` | string | 主キー（例: `ward-1`） |
| `name` | string | 病棟名（例: `東2病棟`） |
| `order` | number | 表示順 |

---

### `beds` — ベッドマスタ

| フィールド | 型 | 説明 |
|---|---|---|
| `id` | string | 主キー |
| `ward_id` | string | 所属病棟ID |
| `bed_number` | string | ベッド番号（例: `101`） |
| `room_number` | string \| null | 病室番号 |
| `bed_type_code` | string | ベッド種別（`normal` / `isolation` / `icu`） |
| `order` | number | 表示順 |
| `patient_id` | string \| null | 患者ID（CSV/ODBC同期） |
| `patient_name` | string \| null | 患者氏名 |
| `is_present` | boolean | 現在在床中か |

---

### `transfer_events` — 移送イベント

| フィールド | 型 | 説明 |
|---|---|---|
| `id` | string | 主キー（例: `evt-1234567890-abc12`） |
| `ward_id` | string | 移送元病棟ID |
| `bed_id` | string | 対象ベッドID |
| `exam_room_id` | string | 移送先検査室ID |
| `exam_type_id` | string | 検査種別ID |
| `current_status` | string | 現在ステータス（下記参照） |
| `escort_staff_id` | string \| null | 付き添いスタッフID |
| `estimated_pickup_at` | number \| null | 迎え目安時刻（Unixms） |
| `registered_at` | number | 互換用の登録日時（新規データでは移送開始日時と同値） |
| `departed_at` | number \| null | 出棟日時 |
| `arrived_at` | number \| null | 到着日時 |
| `exam_started_at` | number \| null | 検査開始日時 |
| `returned_at` | number \| null | 帰棟日時 |
| `cancelled_at` | number \| null | キャンセル日時 |
| `note` | string | 備考 |
| `created_at` | number | レコード作成日時 |
| `patient_ic_tag_id` | string \| null | NFC/ICタグID |

**ステータス遷移:**
```
IN_BED → MOVING → ARRIVED → IN_EXAM → NEARLY_DONE → PICKUP_REQUIRED → RETURNED
                                                                         ↘ CANCELLED
```

`DEPART_REGISTERED` は旧データの読み取り互換用にのみ保持され、起動時に `MOVING` へ移行されます。

---

### `transfer_status_logs` — ステータス変更ログ

| フィールド | 型 | 説明 |
|---|---|---|
| `id` | string | 主キー |
| `transfer_event_id` | string | 移送イベントID |
| `from_status` | string \| null | 変更前ステータス |
| `to_status` | string | 変更後ステータス |
| `changed_by` | string | 変更者識別子 |
| `changed_at` | number | 変更日時（Unixms） |
| `note` | string | 備考 |

---

### `audit_logs` — 操作監査ログ

| フィールド | 型 | 説明 |
|---|---|---|
| `id` | string | 主キー |
| `action` | string | 操作種別（`PATIENT_REGISTER`, `PATIENT_DISCHARGE`, `SETTINGS_CHANGE`, 等） |
| `target_type` | string | 対象データ種別（`bed`, `system_settings`, 等） |
| `target_id` | string \| null | 対象レコードID |
| `staff_id` | string \| null | 操作スタッフID |
| `details` | string | 操作詳細（JSON文字列） |
| `created_at` | number | 操作日時（Unixms） |

---

### `system_settings` — システム設定

key-valueペアで管理。重要なキー一覧:

| `id` (key) | 初期値 | 説明 |
|---|---|---|
| `theme_style` | `light` | テーマ（`light`/`dark`/`blue`/`high-contrast`/`cvd`） |
| `share_mode` | `parent` | 動作モード（`parent`/`client`） |
| `parent_ip` | `` | 子機が接続する親機のIPアドレス |
| `admin_passcode` | `0000` | 設定画面保護パスコード（SHA256ハッシュ形式 `SHA256:...`） |
| `event_retention_days` | `0` | イベント保持日数（0=無制限） |
| `smb_password` | `` | SMBパスワード（`ENCRYPTED:`プレフィックス付きで暗号化保存） |
| `odbc_connection_string` | `` | ODBC接続文字列（`ENCRYPTED:`プレフィックス付きで暗号化保存） |
| `api_token` | `` | 子機↔親機のAPI認証トークン（`ENCRYPTED:`プレフィックス付きで暗号化保存、初回起動時に自動生成） |

---

## データファイルの場所

| OS | パス |
|---|---|
| Windows | `%APPDATA%\TransBoard\transboard-db.json` |
| macOS | `~/Library/Application Support/TransBoard/transboard-db.json` |
| Linux | `~/.config/TransBoard/transboard-db.json` |

DBファイル自体もsafeStorageが利用可能な環境では`ENCDB1:`プレフィックス付きで全体が暗号化される（フィールド単位の暗号化とは別の保護層）。暗号化不可の環境では平文で保存され、設定画面にその旨の警告が表示される。

## バックアップ

設定画面の「データベースバックアップ」ボタンから2つの形式を選択できる:
- **パスワード暗号化**（既定・推奨）: AES-256-GCMでパスワード保護。患者情報を含めたまま他PCへの移行にも使える
- **患者情報を除去した平文**: 患者氏名・ID等を`null`化して出力。障害調査用途向け

復元時は元の形式（暗号化・平文どちらも）を自動判別する。

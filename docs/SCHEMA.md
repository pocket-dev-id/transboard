# TransBoard データベーススキーマ定義 (データ #3)

TransBoard はSQLiteを使用せず、JSONファイル（`db.json`）を独自ローカルデータベースとして使用します。
保存先は `app.getPath('userData')` 配下（Windows: `%APPDATA%\transboard\`）です。

---

## テーブル一覧

| テーブル名 | 概要 |
|---|---|
| `wards` | 病棟マスタ |
| `beds` | ベッドマスタ（患者在籍情報を含む） |
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
| `bed_occupancy_log` | ベッドの在室ログ（検査室移送の有無に関わらず入院〜退院の滞在を記録） |

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

病棟画面では、患者がすでに帰棟している場合に限り `IN_EXAM → RETURNED` の直接完了も選択できます。

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
| `acknowledged_at` | number \| null | 病棟が通知を確認した日時（Unixms） |
| `acknowledged_by_ward_id` | string \| null | 確認した病棟ID |
| `acknowledged_by` | string \| null | 確認した病棟の表示名 |

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

### `bed_occupancy_log` — ベッドの在室ログ

`transfer_events` は検査室への移送が発生した場合にしか作られないため、移送を伴わない
入退院（登録・編集・退院、CSV取込による一括反映）を追跡できない。本テーブルは `beds`
テーブルの在室者の変化を検知して1入院〜退院の滞在ごとに1レコードを記録する。
`audit_logs`とは異なり患者氏名・IDはマスクされない（`beds`/`transfer_events`と同じ
患者データテーブルとして保護される）。

**同一患者の判定規則:** 前後の状態を比較し、**両者に患者IDがある場合のみ患者IDで判定、
片方でも欠けていれば氏名で判定する**。CSV取込が氏名のみで登録した病床に後から患者IDを
補記しても、別患者への入れ替わりと誤判定せず同一の滞在として扱うため。患者IDの
「変更」は入れ替わりとして扱う。同一患者と判定された場合は滞在を分割せず、在室中の
レコードの `patient_id` / `patient_name` / `admission_date` を最新値へ追従させる。

※ この規則の導入以前は「患者ID優先・なければ氏名」の単一キーで比較していたため、
患者IDの後付けで同一入院が2件に分割された記録が残っている場合がある。同一患者だったと
確実に判定する手段が無いため、過去データの遡及マージは行わない。

| フィールド | 型 | 説明 |
|---|---|---|
| `id` | string | 主キー |
| `bed_id` | string | 対象ベッドID |
| `ward_id` | string \| null | 記録時点の所属病棟ID |
| `patient_name` | string \| null | 患者氏名 |
| `patient_id` | string \| null | 患者ID |
| `admission_date` | number \| null | 入院日時（このPATCH/POSTで明示的に指定されなかった場合は検知時刻と同値。前の入居者の値を持ち越さない） |
| `started_at` | number | 在室開始日時（サーバー側で検知した時刻） |
| `ended_at` | number \| null | 在室終了日時（在室中は`null`） |
| `end_reason` | string \| null | 終了理由（`discharged` / `overwritten_by_new_admission` / `csv_cleared` / `bed_deleted`、在室中は`null`） |
| `source` | string | 記録元（`manual_register` / `manual_discharge` / `csv_import` / `csv_clear` / `unknown`） |
| `created_at` | number | レコード作成日時 |

本機能導入前に既に退院済みだった（移送を伴わない）滞在は復元不能なため記録されない。

**書き込み保護:** `audit_logs`と同様に外部からの直接POST/PATCH/DELETEを拒否する
（GETのみ許可）。本テーブルは`beds`テーブルへの書き込みの副作用として親機内部
でのみ更新されるサーバー管理テーブルであり、直接の書き換え・改ざんを防ぐ。

**保持ポリシー:** `bed_occupancy_retention_days`（既定7日）より古い退院済みレコードは
自動削除される。掃除は `beds` への書き込み時と起動時に親機側で自動実行され、
移送イベントの削除（`event_retention_days`）のようにレコードを1件ずつ削除するのではなく、
既存の書き込みに相乗りするため追加のI/Oは発生しない。

- **在室中のレコード（`ended_at` が `null`）は日数に関わらず削除されない。** 病床あたり
  最大1件しか存在せず、病床が削除された場合も `bed_deleted` でクローズされるため、
  在室中のレコードが積み残ることはない。
- 件数上限（20,000件）も併用するが、これは通常運用では作動しない安全弁であり、
  保持期間を勝手に切り詰めないよう十分高い値に設定されている。期間削除と基準を
  揃えるため、上限超過時は `ended_at` が古い順に削除する。
- 保持期間の設定値が `0` や負値の場合も最低1日にクランプされ、全件削除にはならない。

なお `event_retention_days`（既定は無期限）とは独立した設定のため、在室レコードが
削除された後もその滞在中の移送イベントが残る場合がある。その移送は病床履歴パネルで
単独行として表示される（本機能導入前と同じ表示に自然に劣化する）。これは意図した挙動。

病床履歴パネルは保持期間を含む注記を表示する。

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
| `bed_occupancy_retention_days` | `7` | 病床の入退室記録の保持日数（在室中のレコードは対象外。0以下は1日にクランプ） |
| `smb_password` | `` | SMBパスワード（`ENCRYPTED:`プレフィックス付きで暗号化保存） |
| `odbc_connection_string` | `` | ODBC接続文字列（`ENCRYPTED:`プレフィックス付きで暗号化保存） |
| `api_token` | `` | 子機↔親機のAPI認証トークン（`ENCRYPTED:`プレフィックス付きで暗号化保存、初回起動時に自動生成） |
| `smb_password__<feedId>` | （無し） | スケジュールフィード個別のSMBパスワード（`ENCRYPTED:`プレフィックス付きで暗号化保存）。下記 `schedule_feeds` を参照 |

`smb_password` / `odbc_connection_string` / `api_token` / `admin_passcode` および
`smb_password__` で始まるIDは機密扱いで、次の4つの保護がまとめて適用される:
保存時のsafeStorage暗号化・子機への非開示（一覧取得では `********`、単体取得と
書き込みは拒否）・監査ログでの `[changed]` 化・平文バックアップでの `[REDACTED]` 化。

---

### `schedule_feeds` — スケジュール取り込み定義

任意のCSVを定期的に取り込み、タイムライン・病床マップに予定として表示するための設定。
1レコードが1つの「取り込み」に対応する。

| フィールド | 型 | 説明 |
|---|---|---|
| `id` | string | フィードID（UI側で `feed-<timestamp>` として採番） |
| `name` | string | 取り込み名 |
| `color` | string | 表示色（`#rrggbb`） |
| `watch_dir` | string | 監視フォルダ。ローカルパスまたはUNCパス（`\\server\share`） |
| `encoding` | string | `auto` / `utf-8` / `shift-jis` など |
| `schedule` | object | `{ mode: 'realtime'\|'interval'\|'time', intervalMin?, times? }` |
| `mapping` | object | CSV列の対応（`col_date` / `col_time` / `col_title` / `col_id` / `col_duration_min`） |
| `retention_policy` | object | `{ action }` 取り込み済みデータの扱い |
| `show_on_bed_map` | boolean | 病床マップへ表示するか |
| `bed_map_icon` / `bed_map_abbreviation` / `bed_map_bold` | string / string / boolean | 病床マップのバッジ表示 |
| `is_active` | boolean | 取り込みの有効/無効（無効時は取り込みも表示も止まる） |
| `ward_ids` | string[] | 対象病棟。空配列 = 全病棟 |
| `smb_auth_mode` | string | `inherit`（既定・フィールド自体が無い場合も同じ） / `current` / `custom` |
| `smb_username` | string | `smb_auth_mode` が `custom` のときのユーザー名（機密ではない） |

**SMB認証情報の扱い**: UNCパスの監視フォルダに接続するための資格情報は、
`smb_auth_mode` で「共通設定（`system_settings` の `smb_auth_mode` /
`smb_username` / `smb_password`）を継承する」か「フィード個別に指定する」かを選ぶ。
パスワードだけは **このレコードには保存せず**、`system_settings` の
`smb_password__<feedId>` に置く。上記4つの保護機構がいずれも `system_settings`
のみを対象としているため、フィードのレコードへ直接書くと平文で保存・配信されて
しまうことによる。フィードを削除すると対応する設定行も併せて削除される。

なお Windows はサーバー単位でしか資格情報を保持できないため、同一サーバーに対して
複数のフィードが異なる資格情報を指定することはできない（システムエラー1219）。
その場合は保存時に警告が表示される。

---

## データファイルの場所

| OS | パス |
|---|---|
| Windows | `%APPDATA%\transboard\db.json` |
| macOS | `~/Library/Application Support/transboard/db.json` |
| Linux | `~/.config/transboard/db.json` |

DBファイル自体もsafeStorageが利用可能な環境では`ENCDB1:`プレフィックス付きで全体が暗号化される（フィールド単位の暗号化とは別の保護層）。暗号化不可の環境では平文で保存され、設定画面にその旨の警告が表示される。

## バックアップ

設定画面の「データベースバックアップ」ボタンから2つの形式を選択できる:
- **パスワード暗号化**（既定・推奨）: AES-256-GCMでパスワード保護。患者情報を含めたまま他PCへの移行にも使える
- **患者情報を除去した平文**: 患者氏名・ID等を`null`化して出力。障害調査用途向け

復元時は元の形式（暗号化・平文どちらも）を自動判別する。

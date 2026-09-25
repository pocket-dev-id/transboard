; TransBoard: サイレントインストール時に配布設定(provisioning.json)を投入するフック。
;
; main.js の applyProvisioningFile() が起動時に読む
; "<プロファイル>\AppData\Roaming\transboard\provisioning.json" を、
; インストーラのコマンドライン引数から生成・配置する。
; 「あらかじめAPIキーと親機を引数で指定したサイレントインストーラ」
; (1台ずつ持ち歩いてインストールする運用)向けの機能。
;
; 対応する2つの投入方法(どちらも使える):
;
;   1) /PROVISIONING=<path>
;      事前に用意したprovisioning.json(例: transboard-deployerが生成した
;      もの)をそのまま配置する。APIトークンをこのインストーラの
;      コマンドラインには一切載せずに済む、より安全な方法。
;
;   2) 個別引数: /PARENTIP= /ROLE= /WARDID= /APITOKEN= /MANAGED=
;      /DEVICENAME= /PREVENTSLEEP=(1|0) /ALWAYSONTOP=(1|0)
;      その場でJSONを組み立てて配置する。ファイルを別途用意する手間が
;      省ける代わりに、/APITOKEN= を使うとAPIトークンがこのインストーラ
;      プロセスのコマンドラインとしてWin32_Process.CommandLine経由で
;      見える状態になる(main.jsのauthenticateSMBSync()と同じ既知の
;      トレードオフ。可能なら1)を使うこと)。
;      /PREVENTSLEEP= /ALWAYSONTOP= は指定しなければ書き出さない
;      (main.js側は「未指定」を「利用者が既に選んだ設定を上書きしない」
;      という意味で扱うため、"0"を明示した場合とは区別している)。
;
; どちらのモードかは /PROVISIONING= の有無で自動判定する。
; 両方の引数セットが渡されなければ何もせず、通常のインストールと
; 挙動は変わらない。
;
; 配置先ディレクトリ:
;   /ACCOUNT=<共通アカウント名> を指定した場合は
;   "C:\Users\<ACCOUNT>\AppData\Roaming\transboard" を直接組み立てる。
;   未指定なら $APPDATA (=インストーラを実行しているユーザーのプロファイル)
;   を使う。
;   per-machineビルドをPsExecの既定(資格情報省略時はSYSTEMコンテキスト)で
;   実行すると、$APPDATA はSYSTEM自身のプロファイルに解決されてしまい、
;   実際に使う共通アカウントからは見えない。そのため一括配布時は
;   /ACCOUNT= を必ず指定すること。
;   (プロファイルパスが既定と異なる環境(ローミングプロファイル等)には
;   対応しない)
;
; ここで書き出す内容の妥当性(version・有効期限・トークン形式など)は
; main.js の applyProvisioningFile() が起動時に検証する。不正な内容でも
; 起動時に安全に破棄されるだけなので、ここでは最小限の組み立てのみ行う。

; GetParameters・GetOptionsマクロは共にFileFunc.nsh内で定義されている。
; 独立したGetOptions用ヘッダファイルはNSIS 3.xには存在しないため、
; それを別途includeしようとすると実機ビルドで
; "!include: could not find" として失敗する
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!macro customInstall
  ${GetParameters} $R0

  ; 配置先ディレクトリの決定
  ClearErrors
  ${GetOptions} "$R0" "/ACCOUNT=" $R1
  ${If} ${Errors}
    StrCpy $R9 "$APPDATA\transboard"
  ${Else}
    StrCpy $R9 "C:\Users\$R1\AppData\Roaming\transboard"
  ${EndIf}

  ; --- モード1: 事前生成済みのprovisioning.jsonをそのまま配置 ---
  ClearErrors
  ${GetOptions} "$R0" "/PROVISIONING=" $R2
  ${IfNot} ${Errors}
    ${If} ${FileExists} "$R2"
      CreateDirectory "$R9"
      CopyFiles /SILENT "$R2" "$R9\provisioning.json"
    ${EndIf}
  ${Else}
    ; --- モード2: 個別引数からその場でJSONを組み立てる ---
    ClearErrors
    ${GetOptions} "$R0" "/PARENTIP=" $R3
    ClearErrors
    ${GetOptions} "$R0" "/ROLE=" $R4
    ClearErrors
    ${GetOptions} "$R0" "/WARDID=" $R5
    ClearErrors
    ${GetOptions} "$R0" "/APITOKEN=" $R6
    ClearErrors
    ${GetOptions} "$R0" "/MANAGED=" $R7
    ClearErrors
    ${GetOptions} "$R0" "/DEVICENAME=" $0
    ClearErrors
    ${GetOptions} "$R0" "/PREVENTSLEEP=" $1
    ClearErrors
    ${GetOptions} "$R0" "/ALWAYSONTOP=" $2

    ${If} "$R3$R4$R5$R6$R7$0$1$2" != ""
      CreateDirectory "$R9"
      FileOpen $R8 "$R9\provisioning.json" w
      FileWrite $R8 '{$\r$\n'
      FileWrite $R8 '  "version": 1,$\r$\n'
      ${If} "$R3" != ""
        FileWrite $R8 '  "shareMode": "client",$\r$\n'
        FileWrite $R8 '  "parentIp": "$R3",$\r$\n'
      ${Else}
        FileWrite $R8 '  "shareMode": "parent",$\r$\n'
      ${EndIf}
      ${If} "$R4" != ""
        FileWrite $R8 '  "terminalRole": "$R4",$\r$\n'
      ${EndIf}
      ${If} "$R5" != ""
        FileWrite $R8 '  "wardId": "$R5",$\r$\n'
      ${EndIf}
      ${If} "$0" != ""
        FileWrite $R8 '  "deviceName": "$0",$\r$\n'
      ${EndIf}
      ${If} "$R6" != ""
        FileWrite $R8 '  "apiToken": "$R6",$\r$\n'
      ${EndIf}
      ${If} "$1" == "1"
        FileWrite $R8 '  "preventSleep": true,$\r$\n'
      ${ElseIf} "$1" == "0"
        FileWrite $R8 '  "preventSleep": false,$\r$\n'
      ${EndIf}
      ${If} "$2" == "1"
        FileWrite $R8 '  "alwaysOnTop": true,$\r$\n'
      ${ElseIf} "$2" == "0"
        FileWrite $R8 '  "alwaysOnTop": false,$\r$\n'
      ${EndIf}
      ${If} "$R7" == "1"
        FileWrite $R8 '  "managed": true$\r$\n'
      ${Else}
        FileWrite $R8 '  "managed": false$\r$\n'
      ${EndIf}
      FileWrite $R8 '}$\r$\n'
      FileClose $R8
    ${EndIf}
  ${EndIf}
!macroend

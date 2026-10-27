# LINE朝清掃 出欠自動集計システム (line-cleaning-attendance)

LINEグループ内の朝清掃出欠申告（「明日は参加します」「今日の掃除は休みます」など）を自動収集し、**データベースを介さずにGoogleスプレッドシートへリアルタイム直接反映**するシステムです。

手動転記作業をゼロにし、**継続運用費用0円（完全無料枠）** でミニマルに運用できます。

---

## 1. システム構成・アーキテクチャ（データベース不要構成）

```text
[ 通常のLINEグループ ]
         │
         │ 社員の投稿（「明日は参加します」「今日の掃除は休みます」等）
         ▼
[ LINE公式アカウント / Messaging API ]
         │
         │ Webhook (HTTPS POST + x-line-signature)
         ▼
[ Cloudflare Workers (TypeScript) ]
   ├─ ① HMAC-SHA256 署名検証 (不正リクエストを401拒否)
   ├─ ② グループID照合（許可リスト外のアクセスを遮断）
   ├─ ③ Webhook検証リクエスト (events: []) の即時200応答
   ├─ ④ 出欠申告の自然言語判定（出席予定／欠席／遅刻／要確認、対象日の自動推定）
   │    ※ 雑談や業務連絡などの出欠に関係ない投稿は安全に無視
   ├─ ⑤ LINEへ即座に 200 OK を返却 (LINEタイムアウト防止)
   └─ ⑥ Googleスプレッドシートへリアルタイム反映 (ctx.waitUntil で非同期実行)
         │
         │ HTTPS POST (x-api-key 認証付き)
         ▼
[ Google Apps Script (GAS) Webアプリ ]
   └─ スプレッドシートの「出欠一覧」シートへUPSERT（同じ日付＋同じ社員は上書き更新）
```

---

## 2. セキュリティ・プライバシー対策

本プロジェクトはGitHub等で公開（オープンソース/パブリックリポジトリ）されることを前提に、徹底したセキュリティ配慮を行っています。

1. **秘密情報・個人情報のコード直書き禁止**
   - LINEのチャネルシークレット、GASのWebhook URL、APIトークンなどはコード内に一切含めません。
   - ローカル環境では `.dev.vars`（`.gitignore` 対象）、本番環境では Cloudflare Workers Secrets (`wrangler secret put`) を使用して管理します。
2. **HMAC-SHA256 署名検証と定数時間比較**
   - LINEサーバーから送信される `x-line-signature` ヘッダーを生のリクエスト本文から検証します。
   - 検証には定数時間比較（Timing-Safe Equal）を用いてタイミング攻撃（サイドチャネル攻撃）を防止します。
3. **送信元グループIDのホワイトリスト照合**
   - 許可されたLINEグループ以外からのイベント（個人チャットや無関係なグループなど）は即座に除外します。
4. **プライバシー保護・ログの最小化**
   - 会話の本文（テキスト）や個人を特定する情報はログに出力しません。
   - 監査・動作確認に必要な最小限のメタデータ（イベント種別、イベントID、送信元種別）のみを出力します。
5. **スプレッドシートWebアプリの保護**
   - GAS Webアプリに対して共有シークレットキー（`x-api-key`）による認証を導入し、第三者による不正書き込みを防止します。

---

## 3. ディレクトリ構成

```text
line-cleaning-attendance/
├── src/
│   ├── index.ts           # メインエントリーポイント (fetch / handleWebhook)
│   ├── line.ts            # Webhook署名検証・イベント解析・ユーザープロファイル取得
│   ├── attendance.ts      # 出欠判定・日付推定ロジック (自然言語ルールベース)
│   ├── sheets.ts          # Googleスプレッドシート連携クライアント (GAS HTTP POST)
│   └── types.ts           # 型定義
├── gas/
│   └── Code.js            # Google Apps Script (GAS) 用コピペコード
├── test/
│   └── line.test.ts       # 署名検証・出欠判定・結合テスト (Vitest 22テスト)
├── wrangler.jsonc         # Cloudflare Workers設定
├── package.json
├── tsconfig.json
├── .dev.vars.example      # 環境変数テンプレート
├── .gitignore
└── README.md
```

---

## 4. Googleスプレッドシート & GAS のセットアップ手順（約3分）

本システムでは、スプレッドシートの Google Apps Script (GAS) を利用してデータを受け取ります。

1. **スプレッドシートの準備**:
   - Google Driveで新規スプレッドシートを作成します（名前例: `朝清掃出欠表`）。
2. **Apps Script の設定**:
   - スプレッドシートのメニューバーから **「拡張機能」>「Apps Script」** を開きます。
   - エディタ内の既存コードを削除し、このリポジトリの [`gas/Code.js`](file:///Volumes/SSD/98_InSync_Backup/private/GitHub/line-cleaning-attendance/gas/Code.js) の内容をすべて貼り付けて保存します。
3. **APIシークレットの設定（推奨）**:
   - 画面左の歯車アイコン（プロジェクトの設定）を開き、「スクリプト プロパティ」を追加します。
     - プロパティ: `API_SECRET`
     - 値: 任意のランダムな英数字（例: `secret_token_12345`）
4. **ウェブアプリとしてデプロイ**:
   - 画面右上の **「デプロイ」>「新しいデプロイ」** をクリックします。
   - 左上の歯車アイコンから「ウェブアプリ」を選択します。
     - 説明: `LINE出欠Webhook`
     - 次のユーザーとして実行: **「自分」**
     - アクセスできるユーザー: **「全員」**（※Workerから送信するため）
   - 「デプロイ」をクリックし、初回のみアクセス権限の承認画面が出たら「アクセスを承認」します。
   - 発行された **「ウェブアプリURL」**（`https://script.google.com/macros/s/.../exec`）をコピーします。
   *(※このURLは Workers 側の `SHEETS_WEBHOOK_URL` に設定します)*

> [!NOTE]
> 初回送信時に、スプレッドシート内に自動的に **「出欠一覧」** シートと **「社員名簿」** シートが作成されます。
> 「社員名簿」シートに「社員名」と「LINE表示名（またはLINEユーザーID）」を登録しておくと、LINEのニックネームから正規の社員名に自動変換して記録されます。

---

## 5. ローカル開発・テスト手順

### 5.1 インストール
```bash
git clone <repository-url>
cd line-cleaning-attendance
npm install
```

### 5.2 環境変数設定
```bash
cp .dev.vars.example .dev.vars
```
`.dev.vars` を開き、以下の値を入力します：
```ini
LINE_CHANNEL_SECRET=your_line_channel_secret_here
SHEETS_WEBHOOK_URL=https://script.google.com/macros/s/.../exec
SHEETS_API_SECRET=your_custom_sheets_api_secret
ALLOWED_LINE_GROUP_ID=
TZ=Asia/Tokyo
```

### 5.3 テストの実行
```bash
# 全22件の単体・結合テストを実行
npm run test

# TypeScript 型チェック
npm run typecheck
```

### 5.4 ローカルサーバーの起動
```bash
npm run dev
```

---

## 6. Cloudflare Workers へのデプロイ手順

### 6.1 デプロイ
```bash
npx wrangler login
npm run deploy
```
デプロイ後、公開URL（例: `https://line-cleaning-attendance.<subdomain>.workers.dev`）が発行されます。

### 6.2 シークレットの設定（必須）
Cloudflareダッシュボードまたはコマンドラインから設定します：
```bash
# 1. LINE Channel Secret (必須)
npx wrangler secret put LINE_CHANNEL_SECRET

# 2. GAS Webhook URL (必須)
npx wrangler secret put SHEETS_WEBHOOK_URL

# 3. GAS 認証用シークレット (任意・推奨)
npx wrangler secret put SHEETS_API_SECRET

# 4. LINE Channel Access Token (任意: LINEの登録名を取得したい場合)
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN

# 5. 許可するLINEグループID (任意: 指定グループ外のアクセスを遮断する場合)
npx wrangler secret put ALLOWED_LINE_GROUP_ID
```

---

## 7. LINE 公式アカウント / Developers コンソールの設定

1. **LINE Official Account Manager**:
   - アカウント設定 > 「応答設定」:
     - 応答モード: **Bot**
     - あいさつメッセージ / 応答メッセージ: **オフ**
2. **LINE Developers コンソール**:
   - 「Messaging API設定」タブ:
     - **グループ・複数人トークへの参加**: **「グループトーク・複数人トークへの参加を許可する」** を有効化
     - **Webhookの利用**: **オン**
     - **Webhook URL**: `https://<発行されたWorkerのURL>/webhook` を入力して更新
     - **「検証」** ボタンをクリックし、「成功」と表示されることを確認
3. 社内のLINEグループに作成したBotを追加します。

---

## 8. 出欠判定ルール（対応表現の例）

| 投稿例 | 自動判定結果 | 備考 |
|---|---|---|
| 「明日は参加します」 | 翌日 / **出席予定** | 「明日」「あす」から翌日を自動計算 |
| 「今日の掃除は休みます」 | 当日 / **欠席** | 「今日」「本日」から当日を自動計算 |
| 「電車遅延のため遅れます」 | 当日 / **遅刻** | 遅刻キーワード検知 |
| 「やっぱり参加できます！」 | 対象日 / **出席予定** | 先行する欠席申告を訂正 |
| 「10/30は参加します」 | 2026-10-30 / **出席予定** | 日付指定の直接認識 |
| 「間に合いそうです」 | 当日 / **要確認** | 曖昧表現は要確認フラグ |
| 「了解です」「お疲れ様です」 | *(無視)* | 出欠と無関係なメッセージはスキップ |

---

## 9. ライセンス

MIT License

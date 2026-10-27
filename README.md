# LINE朝清掃 出欠自動集計システム (line-cleaning-attendance)

LINEグループ内の朝清掃出欠申告（「明日は参加します」「今日の掃除は休みます」など）を自動収集し、定時に解釈・集計してGoogleスプレッドシートへ反映するシステムです。手動転記作業をゼロにし、**継続運用費用0円（完全無料枠）** での運用を目指します。

---

## 1. システム構成・アーキテクチャ

```text
[ 通常のLINEグループ ]
         │
         │ 新規メッセージ投稿 (Webhook)
         ▼
[ LINE公式アカウント / Messaging API ]
         │
         │ HTTPS POST (x-line-signature)
         ▼
[ Cloudflare Workers (TypeScript) ]
   ├─ ① HMAC-SHA256 署名検証 (Web Crypto API)
   ├─ ② グループID照合（許可リスト外のアクセス遮断）
   ├─ ③ Webhook検証リクエスト (events: []) の即時200応答
   ├─ ④ 出欠申告イベント抽出・重複除外 (Phase 1 完了)
   ├─ ⑤ Cloudflare D1 保存 (Phase 2)
   └─ ⑥ Workers Cron Trigger による定時集計 (Phase 3)
         │
         ▼
[ Google スプレッドシート ] (Phase 4)
   └─ 日付別・社員別出欠一覧の冪等更新 (UPSERT)
```

---

## 2. セキュリティ・プライバシー対策

本プロジェクトはGitHub等で公開（オープンソース/パブリックリポジトリ）されることを前提に、徹底したセキュリティ配慮を行っています。

1. **秘密情報・個人情報のコード直書き禁止**
   - `LINE_CHANNEL_SECRET`、`ALLOWED_LINE_GROUP_ID`、Google認証情報、スプレッドシートIDなどはソースコードやコミット履歴に一切含めません。
   - ローカル環境では `.dev.vars`（`.gitignore` 対象）、本番環境では Cloudflare Workers Secrets (`wrangler secret put`) を使用して注入します。
2. **HMAC-SHA256 署名検証とタイミング攻撃対策**
   - LINEサーバーから送信される `x-line-signature` ヘッダーを生のリクエスト本文から検証します。
   - 検証には定数時間比較（Timing-Safe Equal）を用いてタイミング攻撃（サイドチャネル攻撃）を防止します。
3. **送信元グループIDのホワイトリスト照合**
   - 許可されたLINEグループ以外からのイベント（個人チャットや無関係なグループなど）は即座に除外します。
4. **プライバシー保護・ログの最小化**
   - 監査・動作確認に必要な最小限のメタデータ（イベント種別、イベントID、送信元種別）のみをログに出力します。
   - 会話の本文（テキスト）や個人を特定する情報はログに出力しません。
5. **重複リクエスト・再送への対応**
   - LINE Messaging API の再送フラグ（`deliveryContext.isRedelivery`）およびイベントIDによる重複排除機構を備えています。

---

## 3. ディレクトリ構成

```text
line-cleaning-attendance/
├── src/
│   ├── index.ts           # メインエントリーポイント (fetch / scheduled)
│   ├── line.ts            # Webhook署名検証・イベント解析・グループ検証
│   ├── attendance.ts      # 出欠ルール判定スケルトン (Phase 3用)
│   ├── repository.ts      # D1データベースリポジトリスケルトン (Phase 2用)
│   ├── sheets.ts          # Googleスプレッドシート連携スケルトン (Phase 4用)
│   └── types.ts           # 型定義 (LINE Webhook、環境変数、出欠モデル)
├── migrations/
│   └── 0001_initial.sql   # D1データベース初期スキーマ (Phase 2用)
├── test/
│   └── line.test.ts       # 単体テスト・結合テスト (Vitest)
├── wrangler.jsonc         # Cloudflare Workers設定
├── package.json
├── tsconfig.json
├── .dev.vars.example      # 環境変数テンプレート
├── .gitignore
└── README.md
```

---

## 4. ローカル開発・テスト手順

### 4.1 必要要件
- Node.js 18.0.0 以上
- npm 9.0.0 以上

### 4.2 インストール
```bash
git clone <repository-url>
cd line-cleaning-attendance
npm install
```

### 4.3 ローカル環境変数の設定
`.dev.vars.example` をコピーして `.dev.vars` を作成します。
```bash
cp .dev.vars.example .dev.vars
```
`.dev.vars` を開き、LINE Developers で取得した `LINE_CHANNEL_SECRET` を設定します。
```ini
LINE_CHANNEL_SECRET=your_line_channel_secret_here
ALLOWED_LINE_GROUP_ID=
TZ=Asia/Tokyo
```

### 4.4 テストの実行
Vitest による署名検証、改ざん検知、グループIDフィルタ、HTTPハンドラーのテストを実行します。
```bash
npm run test
```
型チェックを実行する場合:
```bash
npm run typecheck
```

### 4.5 ローカル開発サーバーの起動
Cloudflare Workers のローカル開発サーバー（Wrangler）を起動します。
```bash
npm run dev
```
起動すると `http://localhost:8787` でリクエストを受け付けます。

#### ローカルでの動作確認例
別ターミナルでヘルスチェックを確認:
```bash
curl http://localhost:8787/health
# レスポンス例: {"status":"ok","service":"line-cleaning-attendance","time":"..."}
```

署名なしで Webhook エンドポイントを叩いた場合（拒否されることを確認）:
```bash
curl -X POST http://localhost:8787/webhook \
  -H "Content-Type: application/json" \
  -d '{"events":[]}'
# レスポンス例: {"error":"Missing x-line-signature header"} (Status: 401)
```

---

## 5. LINE Developers / 公式アカウントの設定手順

### 5.1 LINE公式アカウントの作成
1. [LINE Official Account Manager](https://manager.line.biz/) にログインします。
2. 新規アカウントを作成（例: `社内掃除出欠Bot`）。未認証アカウントでOKです。
3. アカウント設定で「チャットの応答方法」を **「Bot」** に設定し、**「あいさつメッセージ」「応答メッセージ」をオフ**にします（Botが自動で定型文返信を行わないようにするため）。

### 5.2 LINE Developers の設定
1. [LINE Developers コンソール](https://developers.line.biz/console/) にログインします。
2. 5.1 で作成したアカウントに紐づくプロバイダーおよび「Messaging API」チャネルを開きます。
3. **「チャネル基本設定」タブ**:
   - `Channel secret`（チャネルシークレット）をコピー（Workers の `LINE_CHANNEL_SECRET` に使用）。
4. **「Messaging API設定」タブ**:
   - **グループ・複数人トークへの参加**: **「グループトーク・複数人トークへの参加を許可する」** に設定（※必須）。
   - **Webhookの利用**: **「Webhookの利用」をオン** に設定。
   - **Webhook URL**: Cloudflare Workers のデプロイ先URL（例: `https://line-cleaning-attendance.<subdomain>.workers.dev/webhook`）を入力。

---

## 6. Cloudflare Workers へのデプロイ手順

### 6.1 Cloudflare へのログイン
初回デプロイ時は Wrangler からログインします。
```bash
npx wrangler login
```

### 6.2 シークレットの設定
本番環境のシークレットを暗号化して Cloudflare に登録します（Git には一切残りません）。
```bash
# 1. LINE Channel Secret の登録 (必須)
npx wrangler secret put LINE_CHANNEL_SECRET
# プロンプトが表示されたら、LINE Developers で取得したシークレットを入力して Enter

# 2. 許可するLINEグループIDの登録 (グループ確定後に設定)
npx wrangler secret put ALLOWED_LINE_GROUP_ID
```

### 6.3 デプロイ
```bash
npm run deploy
```
デプロイが完了すると、コンソールに公開URLが表示されます:
```text
https://line-cleaning-attendance.<your-subdomain>.workers.dev
```

### 6.4 LINE Developers コンソールでの検証
1. LINE Developers の「Messaging API設定」タブを開きます。
2. **Webhook URL** に `https://line-cleaning-attendance.<your-subdomain>.workers.dev/webhook` を入力し「更新」をクリック。
3. **「検証」** ボタンをクリックし、「成功」と表示されることを確認します（Workerが空イベント配列を検知して 200 OK を返します）。
4. 社内のLINEグループに作成したBotを追加します。

---

## 7. 開発フェーズとロードマップ

- [x] **Phase 1: Webhook受信・署名検証・セキュリティ基盤（完了）**
  - Cloudflare Workers + TypeScript プロジェクト構築
  - HMAC-SHA256 署名検証、定数時間比較によるタイミング攻撃対策
  - 送信元グループID検証、空イベント検証対応、最小限ロギング
  - 機密情報除外設計（.gitignore、.dev.vars.example）
  - Vitest 単体テスト・結合テスト完備
- [ ] **Phase 2: データ保存・社員紐付け**
  - Cloudflare D1 データベースのプロビジョニング (`wrangler d1 create`)
  - マイグレーション適用 (`0001_initial.sql`)
  - イベント重複排除と社員マスタ（LINE User ID ⇔ 社員ID）の管理
- [ ] **Phase 3: 出欠ルール判定・定時Cron集計**
  - 自然言語ルールベース判定（出席予定、欠席、遅刻、要確認）
  - Workers Cron Trigger（日本時間7:30等の定時実行）
  - 訂正申告の優先・冪等集計
- [ ] **Phase 4: Googleスプレッドシート連携**
  - サービスアカウント認証または安全な連携方式によるUPSERT反映
  - シート構成（日付×社員一覧）の更新
- [ ] **Phase 5: 本番運用・告知**
  - 社員へのアナウンス、例外処理（要確認ログの運用）の確立

---

## 8. ライセンス

MIT License

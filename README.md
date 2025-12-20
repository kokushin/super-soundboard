# Discord VC 効果音ボット (Super Soundboard)

質問や改善案があったとしても、元々私的利用のクソアプリとして開発したので受け付けておりません。ごめんね！

https://qiita.com/kokushin/items/a21f2045a033b689383e

## 概要

Super Soundboard は、音声認識したキーワードをトリガーに Discord のボイスチャンネルへ効果音を流すローカルアプリです。Node.js で動く Discord Bot（音の再生）と、Chrome で動く STT（音声認識）フロントエンドを WebSocket で連携させるため、高価なサーバーや Whisper などの追加モデルは不要です。

## 必要なもの (Windows / Mac)

- **共通**: Node.js 20 以上、Google Chrome（Web Speech API が安定しているため推奨）、Discord アカウント。
- **Windows**: ffmpeg（[公式ビルド](https://github.com/BtbN/FFmpeg-Builds/releases) からダウンロードし、`PATH` に追加）、PowerShell 5 以上。
- **macOS**: Homebrew または MacPorts。`brew install ffmpeg` で ffmpeg を導入してください。
- **音源**: MP3 ファイルを `bot-node/sounds/` に配置します。著作権を確認のうえ使用してください。

## 設定手順

### ローカル環境の構築

1. 任意のフォルダーで `git clone https://github.com/kokushin/super-soundboard` を実行し、`cd super-soundboard`。
2. 依存パッケージを一括で導入します。
   ```bash
   npm run init
   ```
   これによりリポジトリ直下、`bot-node/`、`stt-web/` の `npm install` が一度に走ります。

### Discord API Key の取得と設定

1. [Discord Developer Portal](https://discord.com/developers/applications) で新規アプリケーションを作成。
2. 「General Information」タブにある **Application ID** をコピー → これが `DISCORD_APP_ID` です。
3. 「Bot」タブで Bot を追加し、表示された **Token** をコピー（必要に応じて Regenerate） → これが `DISCORD_TOKEN` です。
4. Discord クライアントの「設定 > 詳細設定」で Developer Mode をオンにし、Bot を招待したいサーバー名を右クリックして **ID をコピー** → これが `GUILD_ID` です。
5. `bot-node/.env.example` を `.env` にリネームし、以下を入力します。
   ```
   DISCORD_TOKEN=取得した Bot Token
   DISCORD_APP_ID=アプリケーション ID
   GUILD_ID=Botを招待するサーバー(ギルド)の ID
   WS_PORT=3210 など任意の空きポート
   ```

### Discord Bot の作成、権限設定とサーバ連携

1. Developer Portal の 「OAuth2 > URL Generator」で `bot` と `applications.commands` を選択します。
2. 下部の **Bot Permissions** で少なくとも「Send Messages」「Connect」「Speak」「Use Slash Commands」をチェックし、必要に応じて追加権限を付与します。
3. ページ最下部の URL をコピーし、ブラウザで開きます。Discord にログインしている状態で、招待したいサーバーをプルダウンから選択し、「続行」→「認証」の順に進み、表示された CAPTCHA を完了すると Bot がサーバーに参加します（サーバーで「サーバーを管理」権限が必要）。
4. 初回のみ Bot のスラッシュコマンドを登録します。
   ```bash
   cd bot-node
   npm run deploy:commands
   ```

### 検出ワードと音源の設定

1. リポジトリ直下の `config.json` を編集します。
   ```json
   {
     "wsPort": 3210,
     "lang": "ja-JP",
     "cooldownMs": 2500,
     "mappings": [{ "keywords": ["なにこれ", "何これ"], "file": "nanikore.mp3", "volume": 1 }]
   }
   ```
2. `keywords` には認識したい発話を配列で指定します。最初の要素がデフォルト再生に使われます。
3. `file` は `bot-node/sounds/` 配下の mp3 名。相対パスも指定できます。
4. `volume` は 0〜2 の範囲で調整可能。2.0 で約 2 倍、0 で無音になります。

## 使い方

### アプリ起動

1. ルートディレクトリで以下を実行して Bot と Web UI を同時に立ち上げます。
   ```bash
   npm run dev
   ```
2. 運用時は `npm run build` → `npm run start` でビルド済み環境を利用できます。

### Discord の操作

1. Bot がオンラインになったら、対象サーバーの任意のテキストチャンネルで `/join` を実行して VC に参加させます。
2. `/testplay` を使うと現在の設定でサウンドが再生されるかを確認できます。
3. 切断したい場合は `/leave` を送信してください。

### Chrome の操作

1. `npm run dev` 実行中に表示される `stt-web` の URL（例: `http://127.0.0.1:5173`）を Chrome で開きます。
2. ページでマイク権限を許可し、「Start」ボタンを押すと音声認識が開始されます。
3. 登録済みのワードを発話すると WebSocket 経由で Bot に通知され、Discord VC へ効果音が流れます。

## FAQ

- **Q. 音が再生されません。**  
  A. `bot-node/sounds/` に mp3 が存在するか、`config.json` のパスが正しいか確認してください。`npm run dev` のターミナルに「Sound file not found」が出ていないかもチェックしましょう。

- **Q. Chrome で「Web Speech API が使えません」と表示されます。**  
  A. Chrome 最新版で開き、アドレスバー左側のマイク権限を許可してください。Safari や Firefox では動作しません。

- **Q. Bot が VC に入っているのにキーワードを認識してくれません。**  
  A. `config.json` の `wsPort` と `.env` の `WS_PORT` が一致しているか確認し、`npm run dev` を再起動してください。また、`cooldownMs` の値が短すぎると連続ヒットが制限されます。

- **Q. 別のサーバーでも使いたい場合は？**  
  A. Bot を追加したいサーバーの ID を `.env` の `GUILD_ID` に追記して `npm run deploy:commands` を再実行するか、各サーバー用にアプリケーションを分けて運用してください。

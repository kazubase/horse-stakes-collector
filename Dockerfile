# ベースイメージとしてNode.js 20のslimバージョンを使用
FROM node:20-slim

# Playwrightの依存関係をインストール
# これらの依存関係は、ヘッドレスブラウザが動作するために必要です。
# apt-get updateの後に--no-install-recommendsとrm -rf /var/lib/apt/lists/*を使い、イメージサイズを最小限に抑えます。
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm-dev \
    libgbm-dev \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxtst6 \
    xdg-utils \
    libu2f-udev \
    libvulkan1 \
    libxkbcommon0 \
    libxrandr2 \
    wget \
    curl \
    gnupg \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# アプリケーションの作業ディレクトリを設定
WORKDIR /app

# package.jsonとロックファイルをコピーし、依存関係をインストール
# これにより、コードの変更があっても依存関係の再インストールを避けることができます。
COPY package*.json ./
RUN npm install

# アプリケーションの依存関係をインストール
RUN npm ci --omit=dev

# Playwrightのブラウザをインストール
# Chromiumをインストールし、環境変数PLAYWRIGHT_BROWSERS_PATHを設定して永続化を確保
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright/
RUN npx playwright install chromium

# ソースコードをコンテナにコピー
COPY src ./src
COPY drizzle.config.ts tsconfig.json ecosystem.config.cjs Procfile ./
# .envファイルも存在する場合はコピー
# COPY .env ./ || true # .envが存在しない場合でもエラーにならないようにする

# アプリケーションを起動するコマンド
# daily-odds-collector.ts が一度実行されたら終了するように設計されていることを前提とします。
CMD [ "npm", "start" ]

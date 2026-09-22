#!/bin/sh
set -e

BGUTIL_VERSION="2.0.0"

echo "📦 Installation de BgUtils PO Token Provider v${BGUTIL_VERSION}..."

rm -rf bgutil-ytdlp-pot-provider

git clone --depth 1 --branch "${BGUTIL_VERSION}" \
  https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git \
  bgutil-ytdlp-pot-provider

cd bgutil-ytdlp-pot-provider/server

npm ci
npx tsc

echo "✅ BgUtils v${BGUTIL_VERSION} compilé."

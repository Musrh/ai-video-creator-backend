#!/bin/sh
set -e

BGUTIL_VERSION="2.0.0"

echo "📦 Installation de BgUtils PO Token Provider v${BGUTIL_VERSION}..."

rm -rf bgutil-ytdlp-pot-provider

git clone --single-branch --branch "${BGUTIL_VERSION}" \
  https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git \
  bgutil-ytdlp-pot-provider

cd bgutil-ytdlp-pot-provider

mkdir -p "$HOME/yt-dlp-plugins/bgutil-ytdlp-pot-provider"
cp -r plugin/* "$HOME/yt-dlp-plugins/bgutil-ytdlp-pot-provider/"

cd server

npm ci
npx tsc

echo "✅ BgUtils v${BGUTIL_VERSION} installé."
echo "📁 Plugin : $HOME/yt-dlp-plugins/bgutil-ytdlp-pot-provider/"
echo "📁 Provider : $PWD/build/"

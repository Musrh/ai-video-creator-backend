#!/bin/sh
set -e

BGUTIL_VERSION="2.0.0"

echo "========================================"
echo "Installation yt-dlp + BgUtils"
echo "========================================"

echo "Python :"
python3 --version || true

echo "Installation de yt-dlp..."

python3 -m pip install --upgrade yt-dlp

echo "Version yt-dlp :"
python3 -m yt_dlp --version

echo "Installation de BgUtils PO Token Provider..."

rm -rf bgutil-ytdlp-pot-provider

git clone 
--single-branch 
--branch "${BGUTIL_VERSION}" 
https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git 
bgutil-ytdlp-pot-provider

cd bgutil-ytdlp-pot-provider

echo "Installation du serveur BgUtils..."

cd server

npm ci

npx tsc

cd ../..

echo "Installation du plugin yt-dlp..."

mkdir -p "$HOME/yt-dlp-plugins/bgutil-ytdlp-pot-provider"

cp -r 
bgutil-ytdlp-pot-provider/plugin/* 
"$HOME/yt-dlp-plugins/bgutil-ytdlp-pot-provider/"

echo "========================================"
echo "Installation terminee"
echo "========================================"

echo "yt-dlp :"
python3 -m yt_dlp --version

echo "Plugin :"
ls -la "$HOME/yt-dlp-plugins/bgutil-ytdlp-pot-provider"

echo "BgUtils :"
ls -la bgutil-ytdlp-pot-provider/server/build

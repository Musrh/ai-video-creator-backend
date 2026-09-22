#!/bin/sh
set -e

BGUTIL_VERSION="2.0.0"
BGUTIL_REPOSITORY="https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git"

echo "========================================"
echo "Installation yt-dlp + BgUtils"
echo "========================================"

echo "Python :"
python3 --version

echo ""
echo "Installation de yt-dlp..."

python3 -m pip install --upgrade yt-dlp

echo ""
echo "Version yt-dlp :"
python3 -m yt_dlp --version

echo ""
echo "Installation de BgUtils PO Token Provider..."
echo "Repository : ${BGUTIL_REPOSITORY}"
echo "Version : ${BGUTIL_VERSION}"

rm -rf bgutil-ytdlp-pot-provider

git clone 
--single-branch 
--branch "${BGUTIL_VERSION}" 
"${BGUTIL_REPOSITORY}" 
bgutil-ytdlp-pot-provider

echo ""
echo "BgUtils telecharge."

cd bgutil-ytdlp-pot-provider

echo ""
echo "Installation du serveur BgUtils..."

cd server

npm ci

echo ""
echo "Compilation du serveur BgUtils..."

npx tsc

cd ../..

echo ""
echo "Installation du plugin yt-dlp..."

mkdir -p 
"$HOME/yt-dlp-plugins/bgutil-ytdlp-pot-provider"

cp -r 
bgutil-ytdlp-pot-provider/plugin/. 
"$HOME/yt-dlp-plugins/bgutil-ytdlp-pot-provider/"

echo ""
echo "========================================"
echo "Installation terminee"
echo "========================================"

echo ""
echo "yt-dlp :"
python3 -m yt_dlp --version

echo ""
echo "Plugin BgUtils :"
ls -la 
"$HOME/yt-dlp-plugins/bgutil-ytdlp-pot-provider"

echo ""
echo "Serveur BgUtils :"
ls -la 
bgutil-ytdlp-pot-provider/server/build

echo ""
echo "========================================"
echo "OK : yt-dlp + BgUtils installes"
echo "========================================"

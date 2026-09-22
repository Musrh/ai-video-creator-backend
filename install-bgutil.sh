#!/bin/sh
set -e

BGUTIL_VERSION="2.0.0"
BGUTIL_URL="https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/${BGUTIL_VERSION}.tar.gz"

echo "========================================"
echo "Installation yt-dlp + BgUtils"
echo "========================================"

echo ""
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
echo "Version : ${BGUTIL_VERSION}"

rm -rf bgutil-ytdlp-pot-provider
rm -rf "bgutil-ytdlp-pot-provider-${BGUTIL_VERSION}"
rm -f bgutil.tar.gz

echo ""
echo "Telechargement de BgUtils..."

curl -L 
--fail 
--retry 3 
-o bgutil.tar.gz 
"${BGUTIL_URL}"

echo ""
echo "Extraction de BgUtils..."

tar -xzf bgutil.tar.gz

rm -f bgutil.tar.gz

if [ ! -d "bgutil-ytdlp-pot-provider-${BGUTIL_VERSION}" ]; then
echo "ERREUR : dossier BgUtils introuvable apres extraction."
exit 1
fi

mv 
"bgutil-ytdlp-pot-provider-${BGUTIL_VERSION}" 
bgutil-ytdlp-pot-provider

echo ""
echo "BgUtils telecharge avec succes."

echo ""
echo "Installation du serveur BgUtils..."

cd bgutil-ytdlp-pot-provider/server

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
echo "Verification du plugin..."

ls -la 
"$HOME/yt-dlp-plugins/bgutil-ytdlp-pot-provider"

echo ""
echo "Verification du serveur BgUtils..."

ls -la 
bgutil-ytdlp-pot-provider/server/build

echo ""
echo "========================================"
echo "Installation terminee avec succes"
echo "========================================"

echo ""
echo "Version yt-dlp :"
python3 -m yt_dlp --version

echo ""
echo "BgUtils :"
echo "Version ${BGUTIL_VERSION}"

echo ""
echo "Plugin :"
echo "$HOME/yt-dlp-plugins/bgutil-ytdlp-pot-provider/"

echo ""
echo "Serveur :"
echo "bgutil-ytdlp-pot-provider/server/build/"

echo ""
echo "========================================"
echo "OK"
echo "========================================"

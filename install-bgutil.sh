#!/bin/sh
set -e

BGUTIL_VERSION="2.0.0"
BGUTIL_URL="https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/${BGUTIL_VERSION}.tar.gz"

echo "Installation yt-dlp + BgUtils"

echo "Python:"
python3 --version

echo "Installation de yt-dlp..."
python3 -m pip install --break-system-packages --upgrade yt-dlp || python3 -m pip install --upgrade yt-dlp

echo "Version yt-dlp:"
python3 -m yt_dlp --version

echo "Installation de BgUtils PO Token Provider..."
echo "Version: ${BGUTIL_VERSION}"

rm -rf bgutil-ytdlp-pot-provider
rm -rf "bgutil-ytdlp-pot-provider-${BGUTIL_VERSION}"
rm -f bgutil.tar.gz

echo "Telechargement de BgUtils..."
curl -L --fail --retry 3 --retry-delay 2 -o bgutil.tar.gz "$BGUTIL_URL"

echo "Extraction de BgUtils..."
tar -xzf bgutil.tar.gz
rm -f bgutil.tar.gz

if [ ! -d "bgutil-ytdlp-pot-provider-${BGUTIL_VERSION}" ]; then
  echo "ERREUR: dossier BgUtils introuvable apres extraction."
  exit 1
fi

mv "bgutil-ytdlp-pot-provider-${BGUTIL_VERSION}" bgutil-ytdlp-pot-provider

echo "BgUtils telecharge avec succes."

echo "Installation du serveur BgUtils..."
cd bgutil-ytdlp-pot-provider/server
npm ci
echo "Compilation du serveur BgUtils..."
npx tsc
cd ../..

# ⚠️ Emplacement corrigé : ni $HOME/yt-dlp-plugins, ni un dossier "par défaut" quelconque —
# un chemin relatif au projet (./yt-dlp-plugins), que transcribe.js pointe explicitement via
# l'option --plugin-dirs de yt-dlp. $HOME/yt-dlp-plugins n'est PAS un emplacement standard
# reconnu par yt-dlp (vérifié dans sa documentation officielle des emplacements de plugins),
# ce qui explique très probablement pourquoi le plugin restait invisible malgré l'installation.
echo "Installation du plugin yt-dlp (chemin relatif au projet)..."
mkdir -p "./yt-dlp-plugins/bgutil-ytdlp-pot-provider"
cp -r bgutil-ytdlp-pot-provider/plugin/. "./yt-dlp-plugins/bgutil-ytdlp-pot-provider/"

echo "Verification du plugin..."
ls -la "./yt-dlp-plugins/bgutil-ytdlp-pot-provider"

echo "Verification du serveur BgUtils..."
ls -la bgutil-ytdlp-pot-provider/server/build

echo "Installation terminee avec succes."
echo "Version yt-dlp:"
python3 -m yt_dlp --version
echo "BgUtils: Version ${BGUTIL_VERSION}"
echo "Plugin: ./yt-dlp-plugins/bgutil-ytdlp-pot-provider/"
echo "Serveur: bgutil-ytdlp-pot-provider/server/build/"
echo "OK"

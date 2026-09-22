```sh
#!/bin/sh
set -e

BGUTIL_VERSION="2.0.0"
BGUTIL_URL="https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/${BGUTIL_VERSION}.tar.gz"

SEPARATOR="========================================"

printf '%s\n' "$SEPARATOR"
printf '%s\n' "Installation yt-dlp + BgUtils"
printf '%s\n' "$SEPARATOR"

printf '\n%s\n' "Python :"
python3 --version

printf '\n%s\n' "Installation de yt-dlp..."
python3 -m pip install --upgrade yt-dlp

printf '\n%s\n' "Version yt-dlp :"
python3 -m yt_dlp --version

printf '\n%s\n' "Installation de BgUtils PO Token Provider..."
printf '%s\n' "Version : ${BGUTIL_VERSION}"

rm -rf bgutil-ytdlp-pot-provider
rm -rf "bgutil-ytdlp-pot-provider-${BGUTIL_VERSION}"
rm -f bgutil.tar.gz

printf '\n%s\n' "Telechargement de BgUtils..."

curl -L \
  --fail \
  --retry 3 \
  --retry-delay 2 \
  -o bgutil.tar.gz \
  "$BGUTIL_URL"

printf '\n%s\n' "Extraction de BgUtils..."

tar -xzf bgutil.tar.gz
rm -f bgutil.tar.gz

if [ ! -d "bgutil-ytdlp-pot-provider-${BGUTIL_VERSION}" ]; then
  printf '%s\n' "ERREUR : dossier BgUtils introuvable apres extraction."
  exit 1
fi

mv \
  "bgutil-ytdlp-pot-provider-${BGUTIL_VERSION}" \
  bgutil-ytdlp-pot-provider

printf '\n%s\n' "BgUtils telecharge avec succes."

printf '\n%s\n' "Installation du serveur BgUtils..."

cd bgutil-ytdlp-pot-provider/server

npm ci

printf '\n%s\n' "Compilation du serveur BgUtils..."

npx tsc

cd ../..

printf '\n%s\n' "Installation du plugin yt-dlp..."

mkdir -p \
  "$HOME/yt-dlp-plugins/bgutil-ytdlp-pot-provider"

cp -r \
  bgutil-ytdlp-pot-provider/plugin/. \
  "$HOME/yt-dlp-plugins/bgutil-ytdlp-pot-provider/"

printf '\n%s\n' "Verification du plugin..."

ls -la \
  "$HOME/yt-dlp-plugins/bgutil-ytdlp-pot-provider"

printf '\n%s\n' "Verification du serveur BgUtils..."

ls -la \
  bgutil-ytdlp-pot-provider/server/build

printf '\n%s\n' "$SEPARATOR"
printf '%s\n' "Installation terminee avec succes"
printf '%s\n' "$SEPARATOR"

printf '\n%s\n' "Version yt-dlp :"
python3 -m yt_dlp --version

printf '\n%s\n' "BgUtils :"
printf '%s\n' "Version ${BGUTIL_VERSION}"

printf '\n%s\n' "Plugin :"
printf '%s\n' "$HOME/yt-dlp-plugins/bgutil-ytdlp-pot-provider/"

printf '\n%s\n' "Serveur :"
printf '%s\n' "bgutil-ytdlp-pot-provider/server/build/"

printf '\n%s\n' "$SEPARATOR"
printf '%s\n' "OK"
printf '%s\n' "$SEPARATOR"
```

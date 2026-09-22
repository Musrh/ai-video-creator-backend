
#!/bin/sh
set -e

echo "📦 Installation de BgUtils PO Token Provider..."

rm -rf bgutil-ytdlp-pot-provider

git clone --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git bgutil-ytdlp-pot-provider

cd bgutil-ytdlp-pot-provider/server

npm ci
npx tsc

echo "✅ BgUtils installé et compilé."

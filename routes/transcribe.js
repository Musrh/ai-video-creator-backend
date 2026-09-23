const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const FormData = require('form-data');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const { spawn } = require('child_process');

ffmpeg.setFfmpegPath(ffmpegPath);

const router = express.Router();

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

fs.ensureDirSync(UPLOADS_DIR);

const upload = multer({
dest: UPLOADS_DIR
});

// Dossier où install-bgutil.sh a copié le plugin.
// Le chemin est relatif au projet afin de ne pas dépendre
// d'un emplacement global du système.
const PLUGIN_DIR = path.join(
__dirname,
'..',
'yt-dlp-plugins'
);

// Dossier où install-bgutil.sh installe yt-dlp.
// Python devra recevoir ce dossier via PYTHONPATH.
const YTDLP_PACKAGES_DIR = path.join(
__dirname,
'..',
'.python-packages'
);

const PLATFORM_HOSTS = [
'youtube.com',
'youtu.be',
'm.youtube.com',
'tiktok.com',
'vm.tiktok.com',
'vt.tiktok.com'
];

function isPlatformUrl(url) {
try {
const host = new URL(url).hostname.toLowerCase();

```
return PLATFORM_HOSTS.some(
  (platform) =>
    host === platform ||
    host.endsWith('.' + platform)
);
```

} catch {
return false;
}
}

// YouTube bloque souvent les téléchargements venant d'IP de serveurs cloud
// ("Sign in to confirm you're not a bot"). De vrais cookies exportés
// depuis un navigateur connecté peuvent permettre l'accès.
let cachedCookiesPath = null;

function getCookiesFilePath() {
if (!process.env.YOUTUBE_COOKIES_BASE64) {
console.log(
'YOUTUBE_COOKIES_BASE64 non configuré.'
);

```
return null;
```

}

if (cachedCookiesPath) {
return cachedCookiesPath;
}

const filePath = path.join(
os.tmpdir(),
'yt-cookies.txt'
);

try {
const content = Buffer.from(
process.env.YOUTUBE_COOKIES_BASE64,
'base64'
).toString('utf8');

```
fs.writeFileSync(
  filePath,
  content
);

cachedCookiesPath = filePath;

console.log(
  'Cookies YouTube préparés.'
);

return filePath;
```

} catch (error) {
console.error(
'Erreur création cookies YouTube:',
error.message
);

```
return null;
```

}
}

// Serveur BgUtils PO Token.
// Il est compilé par install-bgutil.sh et démarré par server.js.
const BGUTIL_BASE_URL =
process.env.BGUTIL_BASE_URL ||
'http://127.0.0.1:4416';

console.log(
'BgUtils URL: ' + BGUTIL_BASE_URL
);

function downloadWithYtDlp(url, destPath) {
return new Promise((resolve, reject) => {
console.log(
'Téléchargement avec yt-dlp Python: ' +
url
);

```
const args = [
  '-m',
  'yt_dlp',

  url,

  '--output',
  destPath,

  // Flux vidéo + audio séparés si disponibles,
  // sinon meilleur flux combiné.
  '--format',
  'bv*+ba/best',

  '--no-playlist',

  '--extractor-args',
  'youtube:player_client=mweb;youtubepot-bgutilhttp:base_url=' +
    BGUTIL_BASE_URL,

  '--no-check-certificates',

  '--no-warnings',

  // Emplacement explicite du plugin BgUtils.
  '--plugin-dirs',
  PLUGIN_DIR,

  // Permet à yt-dlp de trouver FFmpeg pour fusionner
  // vidéo + audio lorsque les flux sont séparés.
  '--ffmpeg-location',
  ffmpegPath
];

const cookiesPath =
  getCookiesFilePath();

if (cookiesPath) {
  args.push(
    '--cookies',
    cookiesPath
  );

  console.log(
    'Cookies YouTube activés.'
  );
}

// IMPORTANT :
// yt-dlp est installé par install-bgutil.sh dans
// .python-packages.
//
// On transmet explicitement ce dossier à Python afin que
// "python3 -m yt_dlp" puisse trouver le module.
const ytDlpEnv = {
  ...process.env,

  PYTHONPATH:
    process.env.PYTHONPATH
      ? YTDLP_PACKAGES_DIR +
        path.delimiter +
        process.env.PYTHONPATH
      : YTDLP_PACKAGES_DIR
};

console.log(
  'Dossier yt-dlp Python: ' +
    YTDLP_PACKAGES_DIR
);

console.log(
  'PYTHONPATH: ' +
    ytDlpEnv.PYTHONPATH
);

console.log(
  'Commande: python3 ' +
    args.join(' ')
);

const processYtDlp = spawn(
  'python3',
  args,
  {
    env: ytDlpEnv
  }
);

let stdout = '';
let stderr = '';

processYtDlp.stdout.on(
  'data',
  (data) => {
    const text =
      data.toString();

    stdout += text;

    console.log(
      '[yt-dlp] ' +
        text.trim()
    );
  }
);

processYtDlp.stderr.on(
  'data',
  (data) => {
    const text =
      data.toString();

    stderr += text;

    console.error(
      '[yt-dlp] ' +
        text.trim()
    );
  }
);

processYtDlp.on(
  'error',
  (error) => {
    console.error(
      'Erreur lancement yt-dlp:',
      error.message
    );

    reject(error);
  }
);

processYtDlp.on(
  'close',
  async (code) => {
    try {
      if (code !== 0) {
        reject(
          new Error(
            'yt-dlp Python terminé avec le code ' +
              code +
              ': ' +
              stderr
          )
        );

        return;
      }

      if (
        await fs.pathExists(
          destPath
        )
      ) {
        console.log(
          'Vidéo téléchargée: ' +
            destPath
        );

        resolve(destPath);

        return;
      }

      // yt-dlp peut parfois écrire une extension différente.
      const directory =
        path.dirname(destPath);

      const baseName =
        path.basename(
          destPath,
          path.extname(destPath)
        );

      const files =
        await fs.readdir(
          directory
        );

      const match =
        files.find(
          (file) =>
            file.startsWith(
              baseName
            )
        );

      if (match) {
        const finalPath =
          path.join(
            directory,
            match
          );

        console.log(
          'Vidéo trouvée: ' +
            finalPath
        );

        resolve(finalPath);

        return;
      }

      reject(
        new Error(
          'yt-dlp: fichier vidéo introuvable après téléchargement.'
        )
      );
    } catch (error) {
      reject(error);
    }
  }
);
```

});
}

// Téléchargement direct pour les URL qui ne sont pas YouTube/TikTok.
async function downloadDirect(
url,
destPath
) {
console.log(
'Téléchargement direct: ' +
url
);

const response =
await axios.get(
url,
{
responseType: 'stream'
}
);

const writer =
fs.createWriteStream(
destPath
);

response.data.pipe(writer);

return new Promise(
(resolve, reject) => {
writer.on(
'finish',
() => {
console.log(
'Téléchargement direct terminé: ' +
destPath
);

```
      resolve(destPath);
    }
  );

  writer.on(
    'error',
    reject
  );

  response.data.on(
    'error',
    reject
  );
}
```

);
}

// Point d'entrée unique :
// YouTube/TikTok -> yt-dlp
// Autres URL -> téléchargement HTTP direct.
async function downloadVideo(
url,
destPath
) {
if (
isPlatformUrl(url)
) {
return downloadWithYtDlp(
url,
destPath
);
}

return downloadDirect(
url,
destPath
);
}

function extractAudio(
videoPath,
audioPath
) {
return new Promise(
(resolve, reject) => {
console.log(
'Extraction audio: ' +
videoPath
);

```
  ffmpeg(videoPath)
    .noVideo()
    .audioCodec(
      'libmp3lame'
    )
    .format('mp3')
    .on(
      'end',
      () => {
        console.log(
          'Extraction audio terminée.'
        );

        resolve();
      }
    )
    .on(
      'error',
      (error) => {
        console.error(
          'Erreur FFmpeg:',
          error.message
        );

        reject(error);
      }
    )
    .save(audioPath);
}
```

);
}

async function transcribeAudio(
audioPath
) {
if (
!process.env.OPENAI_API_KEY
) {
throw new Error(
'OPENAI_API_KEY manquant dans .env'
);
}

console.log(
'Transcription OpenAI Whisper...'
);

const form =
new FormData();

form.append(
'file',
fs.createReadStream(
audioPath
)
);

form.append(
'model',
'whisper-1'
);

const headers = {
...form.getHeaders(),

```
Authorization:
  'Bearer ' +
  process.env.OPENAI_API_KEY
```

};

const response =
await axios.post(
'https://api.openai.com/v1/audio/transcriptions',
form,
{
headers,
maxBodyLength:
Infinity
}
);

console.log(
'Transcription terminée.'
);

return response.data.text;
}

router.post(
'/transcribe',
upload.single('video'),
async (req, res) => {
const tmpFiles = [];

```
try {
  let videoPath;

  // 1. Fichier vidéo envoyé directement.
  if (req.file) {
    videoPath =
      req.file.path;

    tmpFiles.push(
      videoPath
    );

    console.log(
      'Vidéo reçue: ' +
        videoPath
    );
  }

  // 2. URL vidéo envoyée.
  else if (
    req.body &&
    req.body.videoUrl
  ) {
    const target =
      path.join(
        UPLOADS_DIR,
        'src_' +
          Date.now() +
          '.mp4'
      );

    videoPath =
      await downloadVideo(
        req.body.videoUrl,
        target
      );

    tmpFiles.push(
      videoPath
    );
  }

  // 3. Rien fourni.
  else {
    return res
      .status(400)
      .json({
        error:
          'Fournissez video ou videoUrl.'
      });
  }

  // Extraction audio MP3.
  const audioPath =
    path.join(
      UPLOADS_DIR,
      'audio_' +
        Date.now() +
        '.mp3'
    );

  tmpFiles.push(
    audioPath
  );

  await extractAudio(
    videoPath,
    audioPath
  );

  // Transcription Whisper.
  const transcript =
    await transcribeAudio(
      audioPath
    );

  return res.json({
    transcript,
    sourceVideoPath:
      videoPath
  });
} catch (error) {
  console.error(
    'Erreur transcription:',
    (error.response &&
      error.response.data) ||
      error.message
  );

  return res
    .status(500)
    .json({
      error:
        (error.response &&
          error.response.data &&
          error.response.data.error &&
          error.response.data.error.message) ||
        error.message
    });
} finally {
  // Nettoyage des fichiers temporaires.
  for (const file of tmpFiles) {
    try {
      await fs.remove(
        file
      );
    } catch {
      // Ignore les erreurs de nettoyage.
    }
  }
}
```

}
);

module.exports = router;

module.exports.downloadVideo =
downloadVideo;

module.exports.extractAudio =
extractAudio;

module.exports.transcribeAudio =
transcribeAudio;

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

const UPLOADS_DIR = path.join(os.tmpdir(), 'ai-video-uploads');
fs.ensureDirSync(UPLOADS_DIR);

const upload = multer({
dest: UPLOADS_DIR,
limits: {
fileSize: 500 * 1024 * 1024
}
});

/* ============================================================
PYTHON
============================================================ */

const PYTHON_BIN_PATH_FILE = path.join(
__dirname,
'..',
'python-bin-path.txt'
);

function getPythonBin() {
try {
if (fs.existsSync(PYTHON_BIN_PATH_FILE)) {
const pythonPath = fs.readFileSync(
PYTHON_BIN_PATH_FILE,
'utf8'
).trim();

```
  if (pythonPath && fs.existsSync(pythonPath)) {
    console.log('🐍 Python utilisé:', pythonPath);
    return pythonPath;
  }
}
```

} catch (error) {
console.warn(
'⚠️ Impossible de lire python-bin-path.txt:',
error.message
);
}

console.log('🐍 Python fallback: python3');
return 'python3';
}

/* ============================================================
YT-DLP / PLUGINS
============================================================ */

const PLUGIN_DIR = path.join(
__dirname,
'..',
'yt-dlp-plugins'
);

const BGUTIL_BASE_URL =
process.env.BGUTIL_BASE_URL ||
'http://127.0.0.1:4416';

const PLATFORM_HOSTS = [
'youtube.com',
'youtu.be',
'm.youtube.com',
'tiktok.com',
'vm.tiktok.com',
'vt.tiktok.com'
];

/* ============================================================
URL PLATFORM CHECK
============================================================ */

function isPlatformUrl(url) {
try {
const parsed = new URL(url);
const hostname = parsed.hostname.toLowerCase();

```
return PLATFORM_HOSTS.some((host) => {
  return (
    hostname === host ||
    hostname.endsWith('.' + host)
  );
});
```

} catch (error) {
return false;
}
}

/* ============================================================
YOUTUBE URL CLEANING
============================================================ */

function cleanYoutubeUrl(url) {
try {
const parsed = new URL(url);
const hostname = parsed.hostname.toLowerCase();

```
let videoId = null;

if (
  hostname === 'youtu.be' ||
  hostname.endsWith('.youtu.be')
) {
  videoId = parsed.pathname.replace(/^\/+/, '').split('/')[0];
}

if (
  hostname === 'youtube.com' ||
  hostname === 'www.youtube.com' ||
  hostname === 'm.youtube.com'
) {
  videoId = parsed.searchParams.get('v');

  if (!videoId) {
    const match = parsed.pathname.match(
      /\/(?:shorts|embed|live)\/([^/?]+)/
    );

    if (match) {
      videoId = match[1];
    }
  }
}

if (videoId) {
  return (
    'https://www.youtube.com/watch?v=' +
    encodeURIComponent(videoId)
  );
}

return url;
```

} catch (error) {
return url;
}
}

/* ============================================================
YOUTUBE COOKIES
============================================================ */

let cachedCookiesPath = null;

function getCookiesFilePath() {
if (!process.env.YOUTUBE_COOKIES_BASE64) {
console.log(
'ℹ️ YOUTUBE_COOKIES_BASE64 non configuré.'
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
  content,
  'utf8'
);

cachedCookiesPath = filePath;

console.log(
  '🍪 Cookies YouTube préparés:',
  filePath
);

return filePath;
```

} catch (error) {
console.error(
'❌ Erreur création cookies YouTube:',
error.message
);

```
return null;
```

}
}

/* ============================================================
YT-DLP COMMON ARGS
============================================================ */

function buildCommonArgs(playerClient) {
if (!playerClient) {
playerClient = 'mweb';
}

const extractorArgs =
'youtube:player_client=' +
playerClient +
';youtubepot-bgutilhttp:base_url=' +
BGUTIL_BASE_URL;

const args = [
'--no-playlist',
'--extractor-args',
extractorArgs,
'--no-check-certificates',
'--no-warnings',
'--plugin-dirs',
PLUGIN_DIR
];

const cookiesPath = getCookiesFilePath();

if (cookiesPath) {
args.push(
'--cookies',
cookiesPath
);
}

return args;
}

/* ============================================================
RUN YT-DLP
============================================================ */

function runYtDlp(args) {
return new Promise((resolve) => {
const pythonBin = getPythonBin();

```
console.log('');
console.log('▶️ yt-dlp commande:');
console.log(
  pythonBin +
  ' -m yt_dlp ' +
  args.join(' ')
);

const child = spawn(
  pythonBin,
  ['-m', 'yt_dlp', ...args],
  {
    env: {
      ...process.env
    }
  }
);

let stdout = '';
let stderr = '';

child.stdout.on('data', (data) => {
  const text = data.toString();

  stdout += text;

  console.log(
    '[yt-dlp stdout]',
    text.trim()
  );
});

child.stderr.on('data', (data) => {
  const text = data.toString();

  stderr += text;

  console.error(
    '[yt-dlp stderr]',
    text.trim()
  );
});

child.on('error', (error) => {
  console.error(
    '❌ Erreur spawn yt-dlp:',
    error.message
  );

  resolve({
    code: -1,
    stdout,
    stderr:
      stderr +
      '\n' +
      error.message
  });
});

child.on('close', (code) => {
  console.log(
    'yt-dlp terminé avec code:',
    code
  );

  resolve({
    code,
    stdout,
    stderr
  });
});
```

});
}

/* ============================================================
DETECT REAL MEDIA FORMATS
============================================================ */

function hasUsableFormats(stdout) {
if (!stdout) {
return false;
}

const lines = stdout.split(/\r?\n/);

const usableExtensions = new Set([
'mp4',
'webm',
'm4a',
'mp3',
'opus',
'aac',
'flac',
'wav'
]);

for (const rawLine of lines) {
const line = rawLine.trim();

```
if (!line) {
  continue;
}

// Header
if (
  line.startsWith('ID ') ||
  line.startsWith('ID\t')
) {
  continue;
}

// yt-dlp informational lines
if (line.startsWith('[')) {
  continue;
}

// Separator
if (/^-{3,}/.test(line)) {
  continue;
}

// Storyboards sb0, sb1, sb2, sb3
if (/^sb[0-9]+\s+/i.test(line)) {
  continue;
}

const match = line.match(
  /^(\d+)\s+([a-zA-Z0-9]+)\s+/
);

if (!match) {
  continue;
}

const extension = match[2].toLowerCase();

// Storyboard / image container
if (extension === 'mhtml') {
  continue;
}

if (usableExtensions.has(extension)) {
  return true;
}
```

}

return false;
}

/* ============================================================
DOWNLOAD WITH YT-DLP
============================================================ */

async function downloadWithYtDlp(
url,
destPath
) {
const cleanUrl = cleanYoutubeUrl(url);

console.log('');
console.log('========================================');
console.log('🎬 DOWNLOAD YOUTUBE / TIKTOK');
console.log('========================================');
console.log('URL originale:', url);
console.log('URL nettoyée:', cleanUrl);
console.log('Destination:', destPath);

const clients = [
'mweb',
'tv',
'web'
];

let lastStdout = '';
let lastStderr = '';

for (const client of clients) {
console.log('');
console.log(
'🔎 Test yt-dlp player client:',
client
);

```
const diagnosticArgs = [
  '--list-formats',
  ...buildCommonArgs(client),
  cleanUrl
];

const diagnostic =
  await runYtDlp(
    diagnosticArgs
  );

lastStdout = diagnostic.stdout;
lastStderr = diagnostic.stderr;

console.log('');
console.log(
  '--- Diagnostic --list-formats ---'
);
console.log(
  diagnostic.stdout || '(stdout vide)'
);

if (diagnostic.stderr) {
  console.log(
    '--- Diagnostic stderr ---'
  );
  console.log(
    diagnostic.stderr
  );
}

const formatsAvailable =
  diagnostic.code === 0 &&
  hasUsableFormats(
    diagnostic.stdout
  );

if (!formatsAvailable) {
  console.log(
    '⚠️ Aucun format média utilisable avec client:',
    client
  );

  continue;
}

console.log(
  '✅ Formats média disponibles avec:',
  client
);

console.log(
  '⬇️ Tentative téléchargement avec:',
  client
);

const downloadArgs = [
  ...buildCommonArgs(client),
  '--format',
  'best',
  '--ffmpeg-location',
  ffmpegPath,
  '--output',
  destPath,
  cleanUrl
];

const download =
  await runYtDlp(
    downloadArgs
  );

lastStdout = download.stdout;
lastStderr = download.stderr;

if (
  download.code === 0 &&
  fs.existsSync(destPath)
) {
  console.log(
    '✅ Vidéo téléchargée:',
    destPath
  );

  return destPath;
}

/*
 * yt-dlp peut modifier l'extension finale.
 * On recherche donc un fichier proche du nom demandé.
 */

try {
  const directory =
    path.dirname(destPath);

  const baseName =
    path.basename(
      destPath,
      path.extname(destPath)
    );

  const files =
    await fs.readdir(directory);

  const candidate =
    files.find((file) =>
      file.startsWith(baseName)
    );

  if (candidate) {
    const candidatePath =
      path.join(
        directory,
        candidate
      );

    console.log(
      '✅ Fichier trouvé après téléchargement:',
      candidatePath
    );

    return candidatePath;
  }
} catch (error) {
  console.warn(
    '⚠️ Recherche fichier téléchargé:',
    error.message
  );
}

console.log(
  '❌ Téléchargement échoué avec client:',
  client
);
```

}

throw new Error(
'yt-dlp a échoué avec tous les clients YouTube disponibles.\n' +
'--- Dernier stdout ---\n' +
(lastStdout || '(vide)') +
'\n--- Dernier stderr ---\n' +
(lastStderr || '(vide)')
);
}

/* ============================================================
DIRECT HTTP DOWNLOAD
============================================================ */

async function downloadDirect(
url,
destPath
) {
console.log(
'⬇️ Téléchargement direct:',
url
);

const response =
await axios({
method: 'GET',
url,
responseType: 'stream',
timeout: 120000,
maxContentLength:
500 * 1024 * 1024,
maxBodyLength:
500 * 1024 * 1024
});

const writer =
fs.createWriteStream(
destPath
);

response.data.pipe(writer);

await new Promise(
(resolve, reject) => {
writer.on(
'finish',
resolve
);

```
  writer.on(
    'error',
    reject
  );
}
```

);

return destPath;
}

/* ============================================================
DOWNLOAD VIDEO
============================================================ */

async function downloadVideo(
url,
destPath
) {
if (!url) {
throw new Error(
'URL vidéo manquante.'
);
}

if (isPlatformUrl(url)) {
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

/* ============================================================
EXTRACT AUDIO
============================================================ */

function extractAudio(
videoPath,
audioPath
) {
return new Promise(
(resolve, reject) => {
console.log('');
console.log(
'🎵 Extraction audio FFmpeg'
);

```
  console.log(
    'Vidéo:',
    videoPath
  );

  console.log(
    'Audio:',
    audioPath
  );

  ffmpeg(videoPath)
    .noVideo()
    .audioCodec('libmp3lame')
    .format('mp3')
    .on('start', (commandLine) => {
      console.log(
        'FFmpeg:',
        commandLine
      );
    })
    .on('progress', (progress) => {
      if (
        progress.percent !== undefined
      ) {
        console.log(
          'FFmpeg progress:',
          Math.round(
            progress.percent
          ) + '%'
        );
      }
    })
    .on('end', () => {
      console.log(
        '✅ Audio extrait:',
        audioPath
      );

      resolve(audioPath);
    })
    .on('error', (error) => {
      console.error(
        '❌ Erreur FFmpeg:',
        error.message
      );

      reject(error);
    })
    .save(audioPath);
}
```

);
}

/* ============================================================
OPENAI WHISPER
============================================================ */

async function transcribeAudio(
audioPath
) {
if (!process.env.OPENAI_API_KEY) {
throw new Error(
'OPENAI_API_KEY manquante.'
);
}

console.log('');
console.log(
'🧠 Transcription OpenAI Whisper...'
);

const form =
new FormData();

form.append(
'file',
fs.createReadStream(audioPath)
);

form.append(
'model',
'whisper-1'
);

const response =
await axios.post(
'https://api.openai.com/v1/audio/transcriptions',
form,
{
headers: {
...form.getHeaders(),
Authorization:
'Bearer ' +
process.env.OPENAI_API_KEY
},
maxContentLength:
Infinity,
maxBodyLength:
Infinity,
timeout: 600000
}
);

console.log(
'✅ Transcription terminée.'
);

return response.data.text || '';
}

/* ============================================================
POST /transcribe
============================================================ */

router.post(
'/transcribe',
upload.single('video'),
async (req, res) => {
let videoPath = null;
let audioPath = null;

```
try {
  console.log('');
  console.log(
    '========================================'
  );
  console.log(
    '🎬 NOUVELLE DEMANDE /transcribe'
  );
  console.log(
    '========================================'
  );

  const uploadedFile =
    req.file;

  const videoUrl =
    req.body &&
    req.body.videoUrl
      ? req.body.videoUrl.trim()
      : null;

  /*
   * --------------------------------------------------------
   * SOURCE : FICHIER UPLOADÉ
   * --------------------------------------------------------
   */

  if (uploadedFile) {
    console.log(
      '📁 Vidéo uploadée:',
      uploadedFile.path
    );

    videoPath =
      uploadedFile.path;
  }

  /*
   * --------------------------------------------------------
   * SOURCE : URL
   * --------------------------------------------------------
   */

  else if (videoUrl) {
    console.log(
      '🌐 URL vidéo:',
      videoUrl
    );

    const timestamp =
      Date.now();

    videoPath = path.join(
      UPLOADS_DIR,
      'src_' +
        timestamp +
        '.mp4'
    );

    videoPath =
      await downloadVideo(
        videoUrl,
        videoPath
      );
  }

  /*
   * --------------------------------------------------------
   * AUCUNE SOURCE
   * --------------------------------------------------------
   */

  else {
    return res.status(400).json({
      error:
        'Veuillez envoyer une vidéo ou fournir videoUrl.'
    });
  }

  /*
   * --------------------------------------------------------
   * AUDIO
   * --------------------------------------------------------
   */

  const audioName =
    'audio_' +
    Date.now() +
    '.mp3';

  audioPath =
    path.join(
      UPLOADS_DIR,
      audioName
    );

  await extractAudio(
    videoPath,
    audioPath
  );

  /*
   * --------------------------------------------------------
   * TRANSCRIPTION
   * --------------------------------------------------------
   */

  const transcript =
    await transcribeAudio(
      audioPath
    );

  /*
   * --------------------------------------------------------
   * RESPONSE
   * --------------------------------------------------------
   */

  return res.json({
    success: true,
    transcript,
    sourceVideoPath:
      videoPath
  });
} catch (error) {
  console.error('');
  console.error(
    '❌ ERREUR /transcribe'
  );
  console.error(
    error.message
  );

  if (error.response) {
    console.error(
      'HTTP status:',
      error.response.status
    );

    console.error(
      'HTTP data:',
      error.response.data
    );
  }

  return res.status(500).json({
    success: false,
    error:
      error.message ||
      'Erreur pendant la transcription.'
  });
} finally {
  /*
   * --------------------------------------------------------
   * NETTOYAGE
   * --------------------------------------------------------
   */

  try {
    if (
      videoPath &&
      fs.existsSync(videoPath)
    ) {
      await fs.remove(
        videoPath
      );

      console.log(
        '🧹 Vidéo temporaire supprimée.'
      );
    }
  } catch (error) {
    console.warn(
      '⚠️ Nettoyage vidéo:',
      error.message
    );
  }

  try {
    if (
      audioPath &&
      fs.existsSync(audioPath)
    ) {
      await fs.remove(
        audioPath
      );

      console.log(
        '🧹 Audio temporaire supprimé.'
      );
    }
  } catch (error) {
    console.warn(
      '⚠️ Nettoyage audio:',
      error.message
    );
  }
}
```

}
);

/* ============================================================
EXPORTS
============================================================ */

module.exports = router;

module.exports.downloadVideo =
downloadVideo;

module.exports.extractAudio =
extractAudio;

module.exports.transcribeAudio =
transcribeAudio;

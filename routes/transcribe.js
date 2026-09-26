```js
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

// ============================================================
// DOSSIER UPLOADS
// ============================================================

const UPLOADS_DIR = path.join(
  __dirname,
  '..',
  'uploads'
);

fs.ensureDirSync(UPLOADS_DIR);

const upload = multer({
  dest: UPLOADS_DIR,
});

// ============================================================
// PYTHON / yt-dlp
// ============================================================

const PYTHON_BIN_PATH_FILE = path.join(
  __dirname,
  '..',
  'python-bin-path.txt'
);

function getPythonBin() {
  try {
    const content = fs
      .readFileSync(
        PYTHON_BIN_PATH_FILE,
        'utf8'
      )
      .trim();

    if (content) {
      return content;
    }
  } catch {
    // Fichier absent :
    // utilisation de python3
  }

  return 'python3';
}

// ============================================================
// PLUGIN yt-dlp / BGUTIL
// ============================================================

const PLUGIN_DIR = path.join(
  __dirname,
  '..',
  'yt-dlp-plugins'
);

// ============================================================
// PLATEFORMES SUPPORTÉES
// ============================================================

const PLATFORM_HOSTS = [
  'youtube.com',
  'youtu.be',
  'm.youtube.com',
  'tiktok.com',
  'vm.tiktok.com',
  'vt.tiktok.com',
];

function isPlatformUrl(url) {
  try {
    const host = new URL(url)
      .hostname
      .toLowerCase();

    return PLATFORM_HOSTS.some(
      (platform) =>
        host === platform ||
        host.endsWith('.' + platform)
    );
  } catch {
    return false;
  }
}

// ============================================================
// NETTOYAGE URL YOUTUBE
// ============================================================

function cleanYoutubeUrl(url) {
  try {
    const parsed = new URL(url);

    const hostname =
      parsed.hostname.toLowerCase();

    // --------------------------------------------------------
    // youtube.com
    // --------------------------------------------------------

    if (
      hostname === 'youtube.com' ||
      hostname === 'www.youtube.com' ||
      hostname === 'm.youtube.com'
    ) {
      const videoId =
        parsed.searchParams.get('v');

      if (videoId) {
        return (
          'https://www.youtube.com/watch?v=' +
          videoId
        );
      }
    }

    // --------------------------------------------------------
    // youtu.be
    // --------------------------------------------------------

    if (
      hostname === 'youtu.be' ||
      hostname === 'www.youtu.be'
    ) {
      const videoId =
        parsed.pathname
          .replace(/^\/+/, '')
          .split('/')[0];

      if (videoId) {
        return (
          'https://www.youtube.com/watch?v=' +
          videoId
        );
      }
    }

    return url;
  } catch {
    return url;
  }
}

// ============================================================
// COOKIES YOUTUBE
// ============================================================

let cachedCookiesPath = null;

function getCookiesFilePath() {
  if (
    !process.env.YOUTUBE_COOKIES_BASE64
  ) {
    console.log(
      'YOUTUBE_COOKIES_BASE64 non configuré.'
    );

    return null;
  }

  if (cachedCookiesPath) {
    return cachedCookiesPath;
  }

  const filePath = path.join(
    os.tmpdir(),
    'yt-cookies.txt'
  );

  try {
    const content = Buffer
      .from(
        process.env.YOUTUBE_COOKIES_BASE64,
        'base64'
      )
      .toString('utf8');

    fs.writeFileSync(
      filePath,
      content
    );

    cachedCookiesPath =
      filePath;

    console.log(
      'Cookies YouTube préparés.'
    );

    return filePath;
  } catch (error) {
    console.error(
      'Erreur création cookies YouTube:',
      error.message
    );

    return null;
  }
}

// ============================================================
// BGUTIL PO TOKEN
// ============================================================

const BGUTIL_BASE_URL =
  process.env.BGUTIL_BASE_URL ||
  'http://127.0.0.1:4416';

console.log(
  'BgUtils URL: ' +
    BGUTIL_BASE_URL
);

// ============================================================
// ARGUMENTS yt-dlp
// ============================================================

function buildCommonArgs(playerClient) {
  if (!playerClient) {
    playerClient = 'mweb';
  }

  // IMPORTANT :
  // Construction sans template literal/backticks.
  //
  // Cela évite l'erreur :
  // SyntaxError: Unexpected identifier 'youtube'
  //

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
    PLUGIN_DIR,
  ];

  const cookiesPath =
    getCookiesFilePath();

  if (cookiesPath) {
    args.push(
      '--cookies',
      cookiesPath
    );
  }

  return args;
}

// ============================================================
// EXECUTION yt-dlp
// ============================================================

function runYtDlp(args) {
  return new Promise(
    (resolve, reject) => {
      console.log(
        '\n========================================'
      );

      console.log(
        'Commande yt-dlp:'
      );

      console.log(
        getPythonBin() +
          ' ' +
          args.join(' ')
      );

      console.log(
        '========================================\n'
      );

      const proc = spawn(
        getPythonBin(),
        args,
        {
          env: {
            ...process.env,
          },
        }
      );

      let stdout = '';
      let stderr = '';

      proc.stdout.on(
        'data',
        (data) => {
          const text =
            data.toString();

          stdout += text;

          console.log(
            '[yt-dlp stdout] ' +
              text.trim()
          );
        }
      );

      proc.stderr.on(
        'data',
        (data) => {
          const text =
            data.toString();

          stderr += text;

          console.error(
            '[yt-dlp stderr] ' +
              text.trim()
          );
        }
      );

      proc.on(
        'error',
        (error) => {
          reject(error);
        }
      );

      proc.on(
        'close',
        (code) => {
          console.log(
            'yt-dlp terminé avec le code ' +
              code
          );

          resolve({
            code,
            stdout,
            stderr,
          });
        }
      );
    }
  );
}

// ============================================================
// DÉTECTION DES FORMATS
// ============================================================

function hasUsableFormats(stdout) {
  if (!stdout) {
    return false;
  }

  const lines =
    stdout.split('\n');

  for (
    const line of lines
  ) {
    const trimmed =
      line.trim();

    if (!trimmed) {
      continue;
    }

    // En-tête
    if (
      /^ID\s+EXT\s+/i.test(
        trimmed
      )
    ) {
      continue;
    }

    // Lignes système
    if (
      trimmed.startsWith('[') ||
      trimmed.startsWith('-')
    ) {
      continue;
    }

    // Ligne de format yt-dlp
    if (
      /^\d+\s+\w+\s+/i.test(
        trimmed
      )
    ) {
      return true;
    }
  }

  return false;
}

// ============================================================
// TÉLÉCHARGEMENT yt-dlp
// ============================================================

async function downloadWithYtDlp(
  url,
  destPath
) {
  console.log(
    '\n========================================'
  );

  console.log(
    'Téléchargement avec yt-dlp'
  );

  console.log(
    'URL originale: ' +
      url
  );

  console.log(
    '========================================\n'
  );

  // ----------------------------------------------------------
  // Nettoyage URL YouTube
  // ----------------------------------------------------------

  const cleanUrl =
    cleanYoutubeUrl(url);

  if (cleanUrl !== url) {
    console.log(
      'URL YouTube nettoyée: ' +
        cleanUrl
    );
  }

  // ----------------------------------------------------------
  // CLIENTS À TESTER
  // ----------------------------------------------------------

  const clients = [
    'mweb',
    'tv',
    'web',
  ];

  let lastResult = null;

  // ==========================================================
  // TEST CLIENT PAR CLIENT
  // ==========================================================

  for (
    const client of clients
  ) {
    console.log(
      '\n========================================'
    );

    console.log(
      'TEST CLIENT YOUTUBE: ' +
        client
    );

    console.log(
      '========================================\n'
    );

    // --------------------------------------------------------
    // DIAGNOSTIC --list-formats
    // --------------------------------------------------------

    const listArgs = [
      '-m',
      'yt_dlp',

      '--list-formats',

      ...buildCommonArgs(
        client
      ),

      cleanUrl,
    ];

    const listResult =
      await runYtDlp(
        listArgs
      ).catch(
        (error) => ({
          code: 1,
          stdout: '',
          stderr:
            error.message,
        })
      );

    lastResult =
      listResult;

    console.log(
      '\n========== DIAGNOSTIC ' +
        client +
        ' ==========\n'
    );

    if (
      listResult.stdout
    ) {
      console.log(
        listResult.stdout
      );
    }

    if (
      listResult.stderr
    ) {
      console.error(
        listResult.stderr
      );
    }

    console.log(
      '\n========== FIN DIAGNOSTIC ' +
        client +
        ' ==========\n'
    );

    // --------------------------------------------------------
    // FORMATS DISPONIBLES ?
    // --------------------------------------------------------

    const formatsAvailable =
      listResult.code === 0 &&
      hasUsableFormats(
        listResult.stdout
      );

    if (!formatsAvailable) {
      console.log(
        '❌ Aucun format exploitable avec ' +
          client
      );

      continue;
    }

    console.log(
      '✅ Formats disponibles avec ' +
        client
    );

    // --------------------------------------------------------
    // TÉLÉCHARGEMENT
    // --------------------------------------------------------

    const downloadArgs = [
      '-m',
      'yt_dlp',

      cleanUrl,

      '--output',
      destPath,

      '--ffmpeg-location',
      ffmpegPath,

      ...buildCommonArgs(
        client
      ),
    ];

    console.log(
      '\n🚀 Téléchargement avec ' +
        client +
        '...\n'
    );

    const downloadResult =
      await runYtDlp(
        downloadArgs
      );

    lastResult =
      downloadResult;

    // --------------------------------------------------------
    // ÉCHEC
    // --------------------------------------------------------

    if (
      downloadResult.code !== 0
    ) {
      console.error(
        '❌ Échec téléchargement avec ' +
          client
      );

      console.error(
        downloadResult.stderr
      );

      continue;
    }

    // --------------------------------------------------------
    // FICHIER EXACT
    // --------------------------------------------------------

    if (
      await fs.pathExists(
        destPath
      )
    ) {
      console.log(
        '✅ Vidéo téléchargée: ' +
          destPath
      );

      return destPath;
    }

    // --------------------------------------------------------
    // EXTENSION DIFFÉRENTE
    // --------------------------------------------------------

    const directory =
      path.dirname(
        destPath
      );

    const baseName =
      path.basename(
        destPath,
        path.extname(
          destPath
        )
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
        '✅ Vidéo trouvée: ' +
          finalPath
      );

      return finalPath;
    }

    console.error(
      '❌ Fichier vidéo introuvable après téléchargement avec ' +
        client
    );
  }

  // ==========================================================
  // TOUS LES CLIENTS ONT ÉCHOUÉ
  // ==========================================================

  let diagnostic = '';

  if (lastResult) {
    diagnostic =
      (
        lastResult.stdout ||
        ''
      ) +
      (
        lastResult.stderr
          ? '\n' +
            lastResult.stderr
          : ''
      );
  }

  throw new Error(
    'yt-dlp n’a trouvé aucun format exploitable ou le téléchargement a échoué.' +
      '\n\n--- Diagnostic ---\n' +
      diagnostic
  );
}

// ============================================================
// TÉLÉCHARGEMENT DIRECT
// ============================================================

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
        responseType:
          'stream',
      }
    );

  const writer =
    fs.createWriteStream(
      destPath
    );

  response.data.pipe(
    writer
  );

  return new Promise(
    (
      resolve,
      reject
    ) => {
      writer.on(
        'finish',
        () => {
          console.log(
            'Téléchargement direct terminé: ' +
              destPath
          );

          resolve(
            destPath
          );
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
  );
}

// ============================================================
// DOWNLOAD VIDEO
// ============================================================

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

// ============================================================
// EXTRACTION AUDIO
// ============================================================

function extractAudio(
  videoPath,
  audioPath
) {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      console.log(
        'Extraction audio: ' +
          videoPath
      );

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
        .save(
          audioPath
        );
    }
  );
}

// ============================================================
// TRANSCRIPTION OPENAI WHISPER
// ============================================================

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

    Authorization:
      'Bearer ' +
      process.env.OPENAI_API_KEY,
  };

  const response =
    await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',

      form,

      {
        headers,
        maxBodyLength:
          Infinity,
      }
    );

  console.log(
    'Transcription terminée.'
  );

  return response.data.text;
}

// ============================================================
// ROUTE /transcribe
// ============================================================

router.post(
  '/transcribe',

  upload.single(
    'video'
  ),

  async (
    req,
    res
  ) => {
    const tmpFiles = [];

    try {
      let videoPath;

      // ======================================================
      // FICHIER UPLOADÉ
      // ======================================================

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

      // ======================================================
      // URL VIDÉO
      // ======================================================

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

      // ======================================================
      // RIEN FOURNI
      // ======================================================

      else {
        return res
          .status(400)
          .json({
            error:
              'Fournissez video ou videoUrl.',
          });
      }

      // ======================================================
      // EXTRACTION AUDIO
      // ======================================================

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

      // ======================================================
      // WHISPER
      // ======================================================

      const transcript =
        await transcribeAudio(
          audioPath
        );

      return res.json({
        transcript,

        sourceVideoPath:
          videoPath,
      });
    } catch (error) {
      console.error(
        'Erreur transcription:',
        (
          error.response &&
          error.response.data
        ) ||
          error.message
      );

      return res
        .status(500)
        .json({
          error:
            (
              error.response &&
              error.response.data &&
              error.response.data.error &&
              error.response.data.error.message
            ) ||
            error.message,
        });
    } finally {
      // ======================================================
      // NETTOYAGE FICHIERS TEMPORAIRES
      // ======================================================

      for (
        const file of tmpFiles
      ) {
        try {
          await fs.remove(
            file
          );
        } catch {
          // ignore
        }
      }
    }
  }
);

// ============================================================
// EXPORTS
// ============================================================

module.exports =
  router;

module.exports.downloadVideo =
  downloadVideo;

module.exports.extractAudio =
  extractAudio;

module.exports.transcribeAudio =
  transcribeAudio;
```

**Après avoir remplacé le fichier**, vérifie bien que la recherche de :

```text
`youtube:player_client=
```

ne retourne plus rien dans `transcribe.js`.

Ensuite commit/push et laisse Railway redéployer. Le `SyntaxError` devrait disparaître ; le prochain log intéressant sera celui des tests **mweb → tv → web**.

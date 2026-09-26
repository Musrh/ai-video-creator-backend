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

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
fs.ensureDirSync(UPLOADS_DIR);

const upload = multer({
  dest: UPLOADS_DIR,
});

// ============================================================
// PYTHON
// ============================================================

const PYTHON_BIN_PATH_FILE = path.join(
  __dirname,
  '..',
  'python-bin-path.txt'
);

function getPythonBin() {
  try {
    const content = fs
      .readFileSync(PYTHON_BIN_PATH_FILE, 'utf8')
      .trim();

    if (content) {
      return content;
    }
  } catch {
    // fallback
  }

  return 'python3';
}

// ============================================================
// YT-DLP PLUGIN
// ============================================================

const PLUGIN_DIR = path.join(
  __dirname,
  '..',
  'yt-dlp-plugins'
);

// ============================================================
// PLATEFORMES
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
    const host = new URL(url).hostname.toLowerCase();

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

    const hostname = parsed.hostname.toLowerCase();

    // YouTube
    if (
      hostname === 'youtube.com' ||
      hostname === 'www.youtube.com' ||
      hostname === 'm.youtube.com'
    ) {
      const videoId = parsed.searchParams.get('v');

      if (videoId) {
        return (
          'https://www.youtube.com/watch?v=' +
          videoId
        );
      }
    }

    // youtu.be
    if (
      hostname === 'youtu.be' ||
      hostname === 'www.youtu.be'
    ) {
      const videoId = parsed.pathname
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
  if (!process.env.YOUTUBE_COOKIES_BASE64) {
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
    const content = Buffer.from(
      process.env.YOUTUBE_COOKIES_BASE64,
      'base64'
    ).toString('utf8');

    fs.writeFileSync(
      filePath,
      content
    );

    cachedCookiesPath = filePath;

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
// ARGUMENTS COMMUNS YT-DLP
// ============================================================

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
// EXECUTION YT-DLP
// ============================================================

function runYtDlp(args) {
  return new Promise(
    (resolve, reject) => {
      const pythonBin =
        getPythonBin();

      console.log(
        '\n========================================'
      );

      console.log(
        'Commande yt-dlp:'
      );

      console.log(
        pythonBin +
          ' ' +
          args.join(' ')
      );

      console.log(
        '========================================\n'
      );

      const proc = spawn(
        pythonBin,
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
        reject
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
// VÉRIFICATION DES FORMATS
// ============================================================

function hasUsableFormats(stdout) {
  if (!stdout) {
    return false;
  }

  const lines =
    stdout.split('\n');

  const validExtensions = [
    'mp4',
    'webm',
    'm4a',
    'mp3',
    'opus',
    'aac',
    'flac',
    'wav',
  ];

  for (const line of lines) {
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

    // Messages yt-dlp
    if (
      trimmed.startsWith('[')
    ) {
      continue;
    }

    // Ligne de séparation
    if (
      trimmed.startsWith('-')
    ) {
      continue;
    }

    // Storyboards YouTube
    if (
      /^sb\d+\s+/i.test(
        trimmed
      )
    ) {
      continue;
    }

    const match =
      trimmed.match(
        /^(\d+)\s+([a-zA-Z0-9]+)\s+/
      );

    if (!match) {
      continue;
    }

    const ext =
      match[2].toLowerCase();

    // Storyboard mhtml
    if (ext === 'mhtml') {
      continue;
    }

    if (
      validExtensions.includes(
        ext
      )
    ) {
      return true;
    }
  }

  return false;
}

// ============================================================
// TÉLÉCHARGEMENT YOUTUBE / TIKTOK
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

  const cleanUrl =
    cleanYoutubeUrl(url);

  if (cleanUrl !== url) {
    console.log(
      'URL YouTube nettoyée: ' +
        cleanUrl
    );
  }

  // On teste plusieurs clients.
  //
  // mweb peut parfois ne retourner que
  // les storyboards.
  //
  // Dans ce cas on passe automatiquement
  // à tv puis web.

  const clients = [
    'mweb',
    'tv',
    'web',
  ];

  let lastResult = null;

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
    // 1. DIAGNOSTIC --list-formats
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
    // 2. VÉRIFICATION
    // --------------------------------------------------------

    const formatsAvailable =
      listResult.code === 0 &&
      hasUsableFormats(
        listResult.stdout
      );

    if (
      !formatsAvailable
    ) {
      console.log(
        '❌ Aucun format vidéo/audio exploitable avec ' +
          client
      );

      console.log(
        '➡️ Passage au client suivant...'
      );

      continue;
    }

    console.log(
      '✅ Formats exploitables avec ' +
        client
    );

    // --------------------------------------------------------
    // 3. TÉLÉCHARGEMENT
    // --------------------------------------------------------

    const downloadArgs = [
      '-m',
      'yt_dlp',

      cleanUrl,

      '--output',
      destPath,

      // On laisse yt-dlp choisir le meilleur
      // format vidéo/audio réellement disponible.
      '--format',
      'best',

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
    // 4. ÉCHEC
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

      console.log(
        '➡️ Essai avec le client suivant...'
      );

      continue;
    }

    // --------------------------------------------------------
    // 5. FICHIER TROUVÉ
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

    // yt-dlp peut modifier
    // légèrement le nom du fichier.

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

  // ========================================================
  // TOUS LES CLIENTS ONT ÉCHOUÉ
  // ========================================================

  let diagnostic = '';

  if (lastResult) {
    diagnostic =
      (lastResult.stdout ||
        '') +
      (
        lastResult.stderr
          ? '\n' +
            lastResult.stderr
          : ''
      );
  }

  throw new Error(
    'yt-dlp n’a trouvé aucun format vidéo/audio exploitable avec les clients mweb, tv ou web.' +
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
    (resolve, reject) => {
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
// CHOIX DU TÉLÉCHARGEMENT
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
    (resolve, reject) => {
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
        .save(audioPath);
    }
  );
}

// ============================================================
// TRANSCRIPTION WHISPER
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
  upload.single('video'),
  async (req, res) => {
    const tmpFiles = [];

    try {
      let videoPath;

      // ------------------------------------------------------
      // FICHIER UPLOADÉ
      // ------------------------------------------------------

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

      // ------------------------------------------------------
      // URL VIDÉO
      // ------------------------------------------------------

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

      // ------------------------------------------------------
      // RIEN
      // ------------------------------------------------------

      else {
        return res
          .status(400)
          .json({
            error:
              'Fournissez video ou videoUrl.',
          });
      }

      // ------------------------------------------------------
      // EXTRACTION AUDIO
      // ------------------------------------------------------

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

      // ------------------------------------------------------
      // TRANSCRIPTION
      // ------------------------------------------------------

      const transcript =
        await transcribeAudio(
          audioPath
        );

      // ------------------------------------------------------
      // RÉPONSE
      // ------------------------------------------------------

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
      // ------------------------------------------------------
      // NETTOYAGE
      // ------------------------------------------------------

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

module.exports = router;

module.exports.downloadVideo =
  downloadVideo;

module.exports.extractAudio =
  extractAudio;

module.exports.transcribeAudio =
  transcribeAudio;
```

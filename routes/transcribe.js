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

const upload = multer({ dest: UPLOADS_DIR });

// ============================================================
// PYTHON / yt-dlp
// ============================================================

// Emplacement du fichier écrit par install-bgutil.sh,
// contenant le chemin EXACT du python3 utilisé pour installer yt-dlp.
const PYTHON_BIN_PATH_FILE = path.join(__dirname, '..', 'python-bin-path.txt');

function getPythonBin() {
  try {
    const content = fs.readFileSync(PYTHON_BIN_PATH_FILE, 'utf8').trim();

    if (content) {
      return content;
    }
  } catch {
    // Fichier absent : on retombe sur python3 générique.
  }

  return 'python3';
}

// Dossier où install-bgutil.sh a copié le plugin.
const PLUGIN_DIR = path.join(__dirname, '..', 'yt-dlp-plugins');

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

// Transforme par exemple :
//
// https://m.youtube.com/watch?v=60gpH_Qlgt8&pp=xxxx
//
// en :
//
// https://www.youtube.com/watch?v=60gpH_Qlgt8
//
// On supprime ainsi les paramètres inutiles comme pp=...
function cleanYoutubeUrl(url) {
  try {
    const parsed = new URL(url);

    const hostname = parsed.hostname.toLowerCase();

    // --------------------------------------------------------
    // youtube.com / www.youtube.com / m.youtube.com
    // --------------------------------------------------------
    if (
      hostname === 'youtube.com' ||
      hostname === 'www.youtube.com' ||
      hostname === 'm.youtube.com'
    ) {
      const videoId = parsed.searchParams.get('v');

      if (videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
    }

    // --------------------------------------------------------
    // youtu.be
    // --------------------------------------------------------
    if (
      hostname === 'youtu.be' ||
      hostname === 'www.youtu.be'
    ) {
      const videoId = parsed.pathname
        .replace(/^\/+/, '')
        .split('/')[0];

      if (videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
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
    console.log('YOUTUBE_COOKIES_BASE64 non configuré.');
    return null;
  }

  if (cachedCookiesPath) {
    return cachedCookiesPath;
  }

  const filePath = path.join(os.tmpdir(), 'yt-cookies.txt');

  try {
    const content = Buffer
      .from(process.env.YOUTUBE_COOKIES_BASE64, 'base64')
      .toString('utf8');

    fs.writeFileSync(filePath, content);

    cachedCookiesPath = filePath;

    console.log('Cookies YouTube préparés.');

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

console.log('BgUtils URL: ' + BGUTIL_BASE_URL);

// ============================================================
// ARGUMENTS COMMUNS yt-dlp
// ============================================================

function buildCommonArgs() {
  const args = [
    '--no-playlist',

    '--extractor-args',

    // IMPORTANT :
    // On teste maintenant web + mweb.
    //
    // Le précédent mweb ne retournait que les storyboards sb0-sb3.
    //
    'youtube:player_client=tv,web,mweb;youtubepot-bgutilhttp:base_url=' +
  BGUTIL_BASE_URL,

    '--no-check-certificates',

    '--no-warnings',

    '--plugin-dirs',
    PLUGIN_DIR,
  ];

  const cookiesPath = getCookiesFilePath();

  if (cookiesPath) {
    args.push('--cookies', cookiesPath);
  }

  return args;
}

// ============================================================
// EXECUTION yt-dlp
// ============================================================

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    console.log(
      'Commande: ' +
        getPythonBin() +
        ' ' +
        args.join(' ')
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

    proc.stdout.on('data', (data) => {
      const text = data.toString();

      stdout += text;

      console.log(
        '[yt-dlp] ' +
          text.trim()
      );
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();

      stderr += text;

      console.error(
        '[yt-dlp] ' +
          text.trim()
      );
    });

    proc.on('error', reject);

    proc.on('close', (code) => {
      resolve({
        code,
        stdout,
        stderr,
      });
    });
  });
}

// ============================================================
// TÉLÉCHARGEMENT YOUTUBE / TIKTOK
// ============================================================

async function downloadWithYtDlp(url, destPath) {
  console.log(
    'Téléchargement avec yt-dlp Python: ' +
      url
  );

  // ----------------------------------------------------------
  // Nettoyage de l'URL uniquement pour YouTube
  // ----------------------------------------------------------

  const cleanUrl = cleanYoutubeUrl(url);

  if (cleanUrl !== url) {
    console.log(
      'URL YouTube nettoyée: ' +
        cleanUrl
    );
  }

  const commonArgs = buildCommonArgs();

  // ----------------------------------------------------------
  // IMPORTANT :
  // Aucun --format best ici.
  //
  // On laisse yt-dlp choisir les formats réellement
  // disponibles.
  // ----------------------------------------------------------

  const downloadArgs = [
    '-m',
    'yt_dlp',

    cleanUrl,

    '--output',
    destPath,

    '--ffmpeg-location',
    ffmpegPath,

    ...commonArgs,
  ];

  const result = await runYtDlp(downloadArgs);

  // ----------------------------------------------------------
  // DIAGNOSTIC
  // ----------------------------------------------------------

  if (result.code !== 0) {
    console.log(
      'Échec du téléchargement — lancement du diagnostic --list-formats...'
    );

    const listArgs = [
      '-m',
      'yt_dlp',

      cleanUrl,

      '--list-formats',

      ...commonArgs,
    ];

    const listResult = await runYtDlp(
      listArgs
    ).catch((e) => ({
      stdout: '',
      stderr: e.message,
    }));

    throw new Error(
      'yt-dlp a échoué : ' +
        result.stderr +
        '\n--- Diagnostic --list-formats ---\n' +
        (listResult.stdout ||
          '(aucune sortie)') +
        (
          listResult.stderr
            ? '\n' + listResult.stderr
            : ''
        )
    );
  }

  // ----------------------------------------------------------
  // Fichier exactement demandé
  // ----------------------------------------------------------

  if (await fs.pathExists(destPath)) {
    console.log(
      'Vidéo téléchargée: ' +
        destPath
    );

    return destPath;
  }

  // ----------------------------------------------------------
  // Recherche si yt-dlp a utilisé une extension différente
  // ----------------------------------------------------------

  const directory = path.dirname(destPath);

  const baseName = path.basename(
    destPath,
    path.extname(destPath)
  );

  const files = await fs.readdir(
    directory
  );

  const match = files.find(
    (file) =>
      file.startsWith(baseName)
  );

  if (match) {
    const finalPath = path.join(
      directory,
      match
    );

    console.log(
      'Vidéo trouvée: ' +
        finalPath
    );

    return finalPath;
  }

  throw new Error(
    'yt-dlp: fichier vidéo introuvable après téléchargement.'
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

  const response = await axios.get(
    url,
    {
      responseType: 'stream',
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
  );
}

// ============================================================
// DOWNLOAD VIDEO
// ============================================================

async function downloadVideo(
  url,
  destPath
) {
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
        .audioCodec('libmp3lame')
        .format('mp3')
        .on('end', () => {
          console.log(
            'Extraction audio terminée.'
          );

          resolve();
        })
        .on('error', (error) => {
          console.error(
            'Erreur FFmpeg:',
            error.message
          );

          reject(error);
        })
        .save(audioPath);
    }
  );
}

// ============================================================
// TRANSCRIPTION OPENAI WHISPER
// ============================================================

async function transcribeAudio(
  audioPath
) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY manquant dans .env'
    );
  }

  console.log(
    'Transcription OpenAI Whisper...'
  );

  const form = new FormData();

  form.append(
    'file',
    fs.createReadStream(audioPath)
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

  const response = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',

    form,

    {
      headers,
      maxBodyLength: Infinity,
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
        videoPath = req.file.path;

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
      // RIEN FOURNI
      // ------------------------------------------------------

      else {
        return res.status(400).json({
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
      // WHISPER
      // ------------------------------------------------------

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

      return res.status(500).json({
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
      // NETTOYAGE DES FICHIERS TEMPORAIRES
      // ------------------------------------------------------

      for (const file of tmpFiles) {
        try {
          await fs.remove(file);
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

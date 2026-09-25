const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const FormData = require('form-data');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');

const router = express.Router();

// =====================================================================
// Upload
// =====================================================================

const upload = multer({
  dest: path.join(os.tmpdir(), 'ai-video-uploads')
});

// =====================================================================
// Python
// =====================================================================

const PYTHON_BIN_PATH_FILE = path.join(
  __dirname,
  '..',
  'python-bin.txt'
);

function getPythonBin() {
  try {
    if (fs.existsSync(PYTHON_BIN_PATH_FILE)) {
      const value = fs
        .readFileSync(PYTHON_BIN_PATH_FILE, 'utf8')
        .trim();

      if (value) {
        return value;
      }
    }
  } catch (err) {
    console.warn(
      '⚠️ Impossible de lire python-bin.txt:',
      err.message
    );
  }

  return process.env.PYTHON_BIN || 'python';
}

// =====================================================================
// yt-dlp / BgUtils
// =====================================================================

const PLUGIN_DIR = path.join(
  __dirname,
  '..',
  'yt-dlp-plugins'
);

const BGUTIL_BASE_URL =
  process.env.BGUTIL_BASE_URL ||
  'http://127.0.0.1:4416';

// =====================================================================
// Plateformes autorisées
// =====================================================================

const PLATFORM_HOSTS = [
  'youtube.com',
  'www.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'm.youtube.com',
  'tiktok.com',
  'www.tiktok.com',
  'vm.tiktok.com'
];

// =====================================================================
// Cookies YouTube
// =====================================================================

function createYoutubeCookiesFile() {
  const base64 = process.env.YOUTUBE_COOKIES_BASE64;

  if (!base64) {
    console.log('🍪 Aucun cookie YouTube configuré.');
    return null;
  }

  try {
    const cookiesPath = path.join(
      os.tmpdir(),
      `youtube-cookies-${Date.now()}.txt`
    );

    fs.writeFileSync(
      cookiesPath,
      Buffer.from(base64, 'base64')
    );

    console.log(
      '🍪 Cookies YouTube temporaires créés.'
    );

    return cookiesPath;
  } catch (err) {
    console.warn(
      '⚠️ Impossible de créer le fichier cookies:',
      err.message
    );

    return null;
  }
}

// =====================================================================
// Vérification URL
// =====================================================================

function isSupportedPlatformUrl(value) {
  try {
    const parsed = new URL(value);

    const hostname = parsed.hostname
      .toLowerCase()
      .replace(/^www\./, '');

    return PLATFORM_HOSTS.some(host => {
      const normalizedHost = host
        .toLowerCase()
        .replace(/^www\./, '');

      return (
        hostname === normalizedHost ||
        hostname.endsWith(`.${normalizedHost}`)
      );
    });
  } catch (_) {
    return false;
  }
}

// =====================================================================
// Téléchargement yt-dlp
// =====================================================================

async function downloadWithYtDlp(url, destPath) {
  const pythonBin = getPythonBin();

  console.log('');
  console.log('================================================');
  console.log('📥 Téléchargement avec yt-dlp');
  console.log('================================================');
  console.log('URL:', url);
  console.log('Python:', pythonBin);
  console.log('Destination:', destPath);
  console.log('BgUtils:', BGUTIL_BASE_URL);
  console.log('Plugin:', PLUGIN_DIR);
  console.log('FFmpeg:', ffmpegPath);
  console.log('================================================');

  await fs.ensureDir(path.dirname(destPath));

  const cookiesPath = createYoutubeCookiesFile();

  // IMPORTANT :
  // Aucun --format ici.
  // yt-dlp utilise donc sa sélection par défaut.
  const args = [
    '-m',
    'yt_dlp',

    url,

    '--output',
    destPath,

    '--merge-output-format',
    'mp4',

    '--no-playlist',

    '--extractor-args',
    `youtube:player_client=mweb;youtubepot-bgutilhttp:base_url=${BGUTIL_BASE_URL}`,

    '--no-check-certificates',

    '--no-warnings',

    '--plugin-dirs',
    PLUGIN_DIR,

    '--ffmpeg-location',
    ffmpegPath
  ];

  // Ajouter les cookies uniquement s'ils existent
  if (cookiesPath) {
    args.push(
      '--cookies',
      cookiesPath
    );
  }

  console.log('');
  console.log('▶️ yt-dlp arguments:');
  console.log(args.join(' '));
  console.log('');

  return new Promise((resolve, reject) => {
    const child = spawn(
      pythonBin,
      args,
      {
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );

    let stdout = '';
    let stderr = '';

    // ---------------------------------------------------------------
    // stdout
    // ---------------------------------------------------------------

    child.stdout.on('data', chunk => {
      const text = chunk.toString();

      stdout += text;

      const lines = text.split(/\r?\n/);

      for (const line of lines) {
        if (line.trim()) {
          console.log(
            `[yt-dlp] ${line}`
          );
        }
      }
    });

    // ---------------------------------------------------------------
    // stderr
    // ---------------------------------------------------------------

    child.stderr.on('data', chunk => {
      const text = chunk.toString();

      stderr += text;

      const lines = text.split(/\r?\n/);

      for (const line of lines) {
        if (line.trim()) {
          console.error(
            `[yt-dlp] ${line}`
          );
        }
      }
    });

    // ---------------------------------------------------------------
    // Erreur lancement
    // ---------------------------------------------------------------

    child.on('error', async err => {
      if (cookiesPath) {
        await fs
          .remove(cookiesPath)
          .catch(() => {});
      }

      reject(
        new Error(
          `Impossible de lancer yt-dlp: ${err.message}`
        )
      );
    });

    // ---------------------------------------------------------------
    // Process terminé
    // ---------------------------------------------------------------

    child.on('close', async code => {
      if (cookiesPath) {
        await fs
          .remove(cookiesPath)
          .catch(() => {});
      }

      // -------------------------------------------------------------
      // Erreur yt-dlp
      // -------------------------------------------------------------

      if (code !== 0) {
        const details =
          stderr.trim() ||
          stdout.trim() ||
          'Erreur inconnue yt-dlp';

        console.error('');
        console.error(
          '❌ yt-dlp terminé avec le code:',
          code
        );
        console.error(details);
        console.error('');

        reject(
          new Error(
            `yt-dlp Python terminé avec le code ${code}: ${details}`
          )
        );

        return;
      }

      // -------------------------------------------------------------
      // Fichier demandé trouvé
      // -------------------------------------------------------------

      if (await fs.pathExists(destPath)) {
        const stats = await fs.stat(destPath);

        console.log('');
        console.log(
          '✅ Vidéo téléchargée:',
          destPath
        );

        console.log(
          '📦 Taille:',
          stats.size,
          'octets'
        );

        resolve(destPath);

        return;
      }

      // -------------------------------------------------------------
      // Recherche d'un fichier généré avec un autre nom/extension
      // -------------------------------------------------------------

      const directory = path.dirname(destPath);

      const requestedName = path.basename(destPath);

      let files = [];

      try {
        files = await fs.readdir(directory);
      } catch (_) {
        files = [];
      }

      const baseName = path.basename(
        destPath,
        path.extname(destPath)
      );

      const candidates = files
        .filter(
          file =>
            file === requestedName ||
            file.startsWith(baseName)
        )
        .map(file =>
          path.join(directory, file)
        );

      // -------------------------------------------------------------
      // Fichiers vidéo
      // -------------------------------------------------------------

      const videoCandidates =
        candidates.filter(file => {
          const ext = path
            .extname(file)
            .toLowerCase();

          return [
            '.mp4',
            '.mkv',
            '.webm',
            '.mov'
          ].includes(ext);
        });

      if (videoCandidates.length > 0) {
        console.log(
          '✅ Fichier vidéo téléchargé trouvé:',
          videoCandidates[0]
        );

        resolve(
          videoCandidates[0]
        );

        return;
      }

      // -------------------------------------------------------------
      // Autre fichier trouvé
      // -------------------------------------------------------------

      if (candidates.length > 0) {
        console.log(
          '✅ Fichier téléchargé trouvé:',
          candidates[0]
        );

        resolve(
          candidates[0]
        );

        return;
      }

      // -------------------------------------------------------------
      // Aucun fichier
      // -------------------------------------------------------------

      reject(
        new Error(
          'yt-dlp indique que le téléchargement est terminé, mais aucun fichier vidéo n’a été trouvé.'
        )
      );
    });
  });
}

// =====================================================================
// Téléchargement vidéo
// =====================================================================

async function downloadVideo(url, destPath) {
  if (!url) {
    throw new Error(
      'URL vidéo manquante.'
    );
  }

  if (!isSupportedPlatformUrl(url)) {
    throw new Error(
      'Plateforme vidéo non supportée.'
    );
  }

  return downloadWithYtDlp(
    url,
    destPath
  );
}

// =====================================================================
// Extraction audio avec FFmpeg
// =====================================================================

async function extractAudio(
  videoPath,
  outputPath
) {
  if (!videoPath) {
    throw new Error(
      'Fichier vidéo manquant.'
    );
  }

  if (!await fs.pathExists(videoPath)) {
    throw new Error(
      `Fichier vidéo introuvable: ${videoPath}`
    );
  }

  console.log('');
  console.log(
    '🎵 Extraction audio avec FFmpeg'
  );
  console.log(
    'Vidéo:',
    videoPath
  );
  console.log(
    'Audio:',
    outputPath
  );
  console.log(
    'FFmpeg:',
    ffmpegPath
  );

  await fs.ensureDir(
    path.dirname(outputPath)
  );

  return new Promise(
    (resolve, reject) => {
      ffmpeg(videoPath)
        .setFfmpegPath(ffmpegPath)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioBitrate('128k')
        .output(outputPath)
        .on('start', commandLine => {
          console.log(
            '▶️ FFmpeg:',
            commandLine
          );
        })
        .on('progress', progress => {
          if (
            progress &&
            progress.percent !== undefined
          ) {
            console.log(
              `🎵 Progression audio: ${progress.percent.toFixed(1)}%`
            );
          }
        })
        .on('end', () => {
          console.log(
            '✅ Extraction audio terminée:',
            outputPath
          );

          resolve(outputPath);
        })
        .on('error', err => {
          console.error(
            '❌ Erreur FFmpeg:',
            err.message
          );

          reject(
            new Error(
              `Erreur FFmpeg: ${err.message}`
            )
          );
        })
        .run();
    }
  );
}

// =====================================================================
// Transcription OpenAI Whisper
// =====================================================================

async function transcribeAudio(
  audioPath
) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY manquante.'
    );
  }

  if (!await fs.pathExists(audioPath)) {
    throw new Error(
      `Fichier audio introuvable: ${audioPath}`
    );
  }

  console.log('');
  console.log(
    '📝 Transcription avec OpenAI Whisper...'
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

  const response = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization:
          `Bearer ${process.env.OPENAI_API_KEY}`
      },

      maxContentLength:
        Infinity,

      maxBodyLength:
        Infinity,

      timeout:
        10 * 60 * 1000
    }
  );

  console.log(
    '✅ Transcription terminée.'
  );

  return response.data.text || '';
}

// =====================================================================
// POST /transcribe
// =====================================================================

router.post(
  '/transcribe',
  upload.fields([
    {
      name: 'video',
      maxCount: 1
    },
    {
      name: 'sourceVideo',
      maxCount: 1
    }
  ]),
  async (req, res) => {
    let uploadedVideoPath = null;
    let downloadedVideoPath = null;
    let audioPath = null;

    try {
      console.log('');
      console.log(
        '================================================'
      );
      console.log(
        '🎬 NOUVELLE DEMANDE DE TRANSCRIPTION'
      );
      console.log(
        '================================================'
      );

      // -------------------------------------------------------------
      // Vérification API key
      // -------------------------------------------------------------

      if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({
          error:
            'OPENAI_API_KEY manquante sur le serveur.'
        });
      }

      // -------------------------------------------------------------
      // Récupération fichier uploadé
      // -------------------------------------------------------------

      const videoFile =
        req.files?.video?.[0] ||
        req.files?.sourceVideo?.[0];

      // -------------------------------------------------------------
      // Récupération URL
      // -------------------------------------------------------------

      const videoUrl =
        req.body?.videoUrl ||
        req.body?.url ||
        null;

      console.log(
        '📌 URL reçue:',
        videoUrl || 'Aucune'
      );

      console.log(
        '📌 Fichier reçu:',
        videoFile
          ? videoFile.path
          : 'Aucun'
      );

      // -------------------------------------------------------------
      // Aucun fichier et aucune URL
      // -------------------------------------------------------------

      if (!videoFile && !videoUrl) {
        return res.status(400).json({
          error:
            'Veuillez fournir une vidéo ou une URL vidéo.'
        });
      }

      // =============================================================
      // CAS 1 : FICHIER UPLOADÉ
      // =============================================================

      if (videoFile) {
        uploadedVideoPath =
          videoFile.path;

        console.log('');
        console.log(
          '📂 Vidéo uploadée:',
          uploadedVideoPath
        );

        const extension =
          path.extname(
            videoFile.originalname || ''
          ) || '.mp4';

        const normalizedVideoPath =
          path.join(
            os.tmpdir(),
            `source-${Date.now()}${extension}`
          );

        await fs.move(
          uploadedVideoPath,
          normalizedVideoPath,
          {
            overwrite: true
          }
        );

        uploadedVideoPath =
          normalizedVideoPath;

        downloadedVideoPath =
          normalizedVideoPath;

        console.log(
          '✅ Vidéo prête:',
          downloadedVideoPath
        );
      }

      // =============================================================
      // CAS 2 : URL YOUTUBE / TIKTOK
      // =============================================================

      else if (videoUrl) {
        if (
          !isSupportedPlatformUrl(
            videoUrl
          )
        ) {
          return res.status(400).json({
            error:
              'URL YouTube/TikTok non supportée.'
          });
        }

        downloadedVideoPath =
          path.join(
            '/app/uploads',
            `src_${Date.now()}.mp4`
          );

        await fs.ensureDir(
          '/app/uploads'
        );

        console.log('');
        console.log(
          '🌐 Téléchargement depuis:',
          videoUrl
        );

        await downloadVideo(
          videoUrl,
          downloadedVideoPath
        );

        console.log(
          '✅ Vidéo source disponible:',
          downloadedVideoPath
        );
      }

      // =============================================================
      // EXTRACTION AUDIO
      // =============================================================

      audioPath = path.join(
        os.tmpdir(),
        `audio-${Date.now()}.mp3`
      );

      await extractAudio(
        downloadedVideoPath,
        audioPath
      );

      // =============================================================
      // TRANSCRIPTION
      // =============================================================

      const transcript =
        await transcribeAudio(
          audioPath
        );

      // =============================================================
      // RÉPONSE
      // =============================================================

      console.log('');
      console.log(
        '================================================'
      );
      console.log(
        '✅ TRANSCRIPTION TERMINÉE'
      );
      console.log(
        '================================================'
      );

      return res.json({
        transcript,
        sourceVideoPath:
          downloadedVideoPath
      });
    } catch (error) {
      console.error('');
      console.error(
        '================================================'
      );
      console.error(
        '❌ ERREUR TRANSCRIPTION'
      );
      console.error(
        '================================================'
      );
      console.error(
        error?.message ||
          error
      );
      console.error(
        '================================================'
      );

      return res.status(500).json({
        error:
          error?.message ||
          'Erreur pendant la transcription.'
      });
    } finally {
      // -------------------------------------------------------------
      // Nettoyage audio
      // -------------------------------------------------------------

      if (audioPath) {
        await fs
          .remove(audioPath)
          .catch(() => {});
      }

      // -------------------------------------------------------------
      // Nettoyage fichier uploadé temporaire
      // -------------------------------------------------------------

      if (
        uploadedVideoPath &&
        uploadedVideoPath !==
          downloadedVideoPath
      ) {
        await fs
          .remove(uploadedVideoPath)
          .catch(() => {});
      }

      // IMPORTANT :
      // downloadedVideoPath n'est PAS supprimé ici.
      //
      // Il peut être utilisé ensuite par /analyze-source.
    }
  }
);

// =====================================================================
// Export
// =====================================================================

module.exports = router;

module.exports.downloadVideo =
  downloadVideo;

module.exports.extractAudio =
  extractAudio;

module.exports.transcribeAudio =
  transcribeAudio;

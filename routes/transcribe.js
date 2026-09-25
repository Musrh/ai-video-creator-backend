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

/* ============================================================
   CONFIGURATION
   ============================================================ */

const upload = multer({
  dest: path.join(os.tmpdir(), 'ai-video-uploads')
});

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

/* ============================================================
   PLUGIN YT-DLP / BGUTIL PO TOKEN
   ============================================================ */

const PLUGIN_DIR = path.join(
  __dirname,
  '..',
  'yt-dlp-plugins'
);

const BGUTIL_BASE_URL =
  process.env.BGUTIL_BASE_URL ||
  'http://127.0.0.1:4416';

/* ============================================================
   PLATEFORMES SUPPORTÉES
   ============================================================ */

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

/* ============================================================
   COOKIES YOUTUBE
   ============================================================ */

function createYoutubeCookiesFile() {
  const base64 = process.env.YOUTUBE_COOKIES_BASE64;

  if (!base64) {
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

/* ============================================================
   VÉRIFICATION URL PLATEFORME
   ============================================================ */

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

/* ============================================================
   DOWNLOAD YOUTUBE / TIKTOK AVEC YT-DLP
   ============================================================ */

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

  await fs.ensureDir(
    path.dirname(destPath)
  );

  const cookiesPath =
    createYoutubeCookiesFile();

  /*
   * ==========================================================
   * SÉLECTION DU FORMAT
   * ==========================================================
   *
   * On ne fait PAS :
   *
   *   --format best
   *
   * car certains contenus YouTube n'ont pas de format
   * progressif "best" disponible.
   *
   * On demande :
   *
   * 1. meilleur MP4 vidéo + meilleur M4A audio
   * 2. meilleur MP4 vidéo/audio disponible
   * 3. meilleur format global disponible
   *
   * FFmpeg fusionnera automatiquement vidéo + audio.
   */

const formatSelector =
  'bestvideo*+bestaudio/best';

const args = [
  '-m',
  'yt_dlp',

  url,

  '--output',
  destPath,

  '--format',
  formatSelector,

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

   

  /*
   * Cookies facultatifs
   */

  if (cookiesPath) {
    args.push(
      '--cookies',
      cookiesPath
    );
  }

  console.log('');
  console.log('🎯 Format selector:');
  console.log(formatSelector);

  console.log('');
  console.log('▶️ yt-dlp arguments:');
  console.log(args.join(' '));
  console.log('');

  return new Promise((resolve, reject) => {

    const child = spawn(
      pythonBin,
      args,
      {
        stdio: [
          'ignore',
          'pipe',
          'pipe'
        ]
      }
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {

      const text =
        chunk.toString();

      stdout += text;

      const lines =
        text.split(/\r?\n/);

      for (const line of lines) {
        if (line.trim()) {
          console.log(
            `[yt-dlp] ${line}`
          );
        }
      }
    });

    child.stderr.on('data', chunk => {

      const text =
        chunk.toString();

      stderr += text;

      const lines =
        text.split(/\r?\n/);

      for (const line of lines) {
        if (line.trim()) {
          console.error(
            `[yt-dlp] ${line}`
          );
        }
      }
    });

    child.on(
      'error',
      async err => {

        if (cookiesPath) {
          await fs.remove(
            cookiesPath
          ).catch(() => {});
        }

        reject(
          new Error(
            `Impossible de lancer yt-dlp: ${err.message}`
          )
        );
      }
    );

    child.on(
      'close',
      async code => {

        if (cookiesPath) {
          await fs.remove(
            cookiesPath
          ).catch(() => {});
        }

        /*
         * ======================================================
         * ERREUR YT-DLP
         * ======================================================
         */

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

        /*
         * ======================================================
         * VÉRIFICATION FICHIER FINAL
         * ======================================================
         */

        if (
          await fs.pathExists(
            destPath
          )
        ) {

          const stats =
            await fs.stat(
              destPath
            );

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

        /*
         * ======================================================
         * RECHERCHE D'UN FICHIER GÉNÉRÉ
         * ======================================================
         */

        const directory =
          path.dirname(destPath);

        const requestedName =
          path.basename(destPath);

        let files = [];

        try {
          files =
            await fs.readdir(
              directory
            );
        } catch (_) {}

        const baseName =
          path.basename(
            destPath,
            path.extname(destPath)
          );

        const candidates =
          files
            .filter(file => {

              return (
                file === requestedName ||
                file.startsWith(baseName)
              );
            })
            .map(file =>
              path.join(
                directory,
                file
              )
            );

        /*
         * On privilégie les fichiers vidéo.
         */

        const videoCandidates =
          candidates.filter(file => {

            const ext =
              path.extname(file)
                .toLowerCase();

            return [
              '.mp4',
              '.mkv',
              '.webm',
              '.mov'
            ].includes(ext);
          });

        if (
          videoCandidates.length > 0
        ) {

          console.log(
            '✅ Fichier vidéo téléchargé trouvé:',
            videoCandidates[0]
          );

          resolve(
            videoCandidates[0]
          );

          return;
        }

        /*
         * Dernier recours
         */

        if (
          candidates.length > 0
        ) {

          console.log(
            '✅ Fichier téléchargé trouvé:',
            candidates[0]
          );

          resolve(
            candidates[0]
          );

          return;
        }

        /*
         * Aucun fichier
         */

        reject(
          new Error(
            'yt-dlp indique que le téléchargement est terminé, mais aucun fichier vidéo n’a été trouvé.'
          )
        );
      }
    );
  });
}

/* ============================================================
   TÉLÉCHARGEMENT VIDÉO
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

  if (
    !isSupportedPlatformUrl(url)
  ) {
    throw new Error(
      'URL vidéo non supportée.'
    );
  }

  return downloadWithYtDlp(
    url,
    destPath
  );
}

/* ============================================================
   EXTRACTION AUDIO AVEC FFMPEG
   ============================================================ */

async function extractAudio(
  videoPath,
  outputPath
) {

  if (!videoPath) {
    throw new Error(
      'Chemin vidéo manquant pour extraction audio.'
    );
  }

  if (
    !await fs.pathExists(
      videoPath
    )
  ) {
    throw new Error(
      `Vidéo introuvable: ${videoPath}`
    );
  }

  if (!outputPath) {

    outputPath =
      path.join(
        os.tmpdir(),
        `audio-${Date.now()}.mp3`
      );
  }

  await fs.ensureDir(
    path.dirname(outputPath)
  );

  console.log(
    '🎵 Extraction audio:',
    videoPath
  );

  return new Promise(
    (resolve, reject) => {

      ffmpeg(videoPath)

        .setFfmpegPath(
          ffmpegPath
        )

        .noVideo()

        .audioCodec(
          'libmp3lame'
        )

        .audioBitrate(
          '128k'
        )

        .format(
          'mp3'
        )

        .on(
          'start',
          commandLine => {

            console.log(
              '▶️ FFmpeg:',
              commandLine
            );
          }
        )

        .on(
          'progress',
          progress => {

            if (
              progress &&
              typeof progress.percent ===
                'number'
            ) {

              console.log(
                `🎵 Audio: ${progress.percent.toFixed(1)}%`
              );
            }
          }
        )

        .on(
          'end',
          () => {

            console.log(
              '✅ Extraction audio terminée:',
              outputPath
            );

            resolve(
              outputPath
            );
          }
        )

        .on(
          'error',
          err => {

            console.error(
              '❌ Erreur FFmpeg:',
              err.message
            );

            reject(
              new Error(
                `Erreur extraction audio: ${err.message}`
              )
            );
          }
        )

        .save(
          outputPath
        );
    }
  );
}

/* ============================================================
   TRANSCRIPTION WHISPER
   ============================================================ */

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

  if (!audioPath) {
    throw new Error(
      'Fichier audio manquant.'
    );
  }

  if (
    !await fs.pathExists(
      audioPath
    )
  ) {
    throw new Error(
      `Fichier audio introuvable: ${audioPath}`
    );
  }

  console.log(
    '📝 Transcription Whisper:',
    audioPath
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

  try {

    const response =
      await axios.post(
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
            300000
        }
      );

    const transcript =
      response.data?.text ||
      '';

    if (
      !transcript.trim()
    ) {
      throw new Error(
        'Whisper a retourné une transcription vide.'
      );
    }

    console.log(
      '✅ Transcription terminée.'
    );

    return transcript.trim();

  } catch (err) {

    console.error(
      '❌ Erreur Whisper:',
      err.response?.data ||
      err.message
    );

    if (
      err.response?.data?.error?.message
    ) {

      throw new Error(
        `Whisper : ${err.response.data.error.message}`
      );
    }

    throw err;
  }
}

/* ============================================================
   ROUTE POST /transcribe
   ============================================================ */

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

    let videoPath =
      null;

    let audioPath =
      null;

    try {

      const videoUrl =
        req.body?.videoUrl ||
        req.body?.url ||
        '';

      const uploadedVideo =
        req.files?.video?.[0] ||
        req.files?.sourceVideo?.[0] ||
        null;

      /*
       * ======================================================
       * CAS 1 : FICHIER UPLOADÉ
       * ======================================================
       */

      if (
        uploadedVideo
      ) {

        videoPath =
          uploadedVideo.path;

        console.log(
          '📁 Vidéo uploadée:',
          videoPath
        );
      }

      /*
       * ======================================================
       * CAS 2 : URL YOUTUBE / TIKTOK
       * ======================================================
       */

      else if (
        videoUrl
      ) {

        const extension =
          '.mp4';

        videoPath =
          path.join(
            __dirname,
            '..',
            'uploads',
            `src_${Date.now()}${extension}`
          );

        await fs.ensureDir(
          path.dirname(videoPath)
        );

        videoPath =
          await downloadVideo(
            videoUrl,
            videoPath
          );
      }

      /*
       * ======================================================
       * AUCUNE SOURCE
       * ======================================================
       */

      else {

        return res
          .status(400)
          .json({
            error:
              'Aucune vidéo ou URL vidéo fournie.'
          });
      }

      /*
       * ======================================================
       * EXTRACTION AUDIO
       * ======================================================
       */

      audioPath =
        path.join(
          os.tmpdir(),
          `audio-${Date.now()}.mp3`
        );

      await extractAudio(
        videoPath,
        audioPath
      );

      /*
       * ======================================================
       * WHISPER
       * ======================================================
       */

      const transcript =
        await transcribeAudio(
          audioPath
        );

      /*
       * ======================================================
       * RÉPONSE
       * ======================================================
       */

      return res.json({
        transcript,

        sourceVideoPath:
          videoPath
      });

    } catch (err) {

      console.error(
        '❌ /transcribe:',
        err.response?.data ||
        err.message
      );

      return res
        .status(500)
        .json({
          error:
            err.message ||
            'Erreur transcription vidéo.'
        });

    } finally {

      /*
       * ======================================================
       * SUPPRESSION AUDIO TEMPORAIRE
       * ======================================================
       */

      if (
        audioPath
      ) {

        await fs.remove(
          audioPath
        ).catch(() => {});
      }

      /*
       * ======================================================
       * IMPORTANT
       *
       * La vidéo téléchargée depuis YouTube/TikTok
       * n'est PAS supprimée ici.
       *
       * /analyze-source peut donc la réutiliser.
       *
       * Les fichiers uploadés Multer restent également
       * gérés séparément.
       * ======================================================
       */
    }
  }
);

/* ============================================================
   EXPORTS
   ============================================================ */

module.exports =
  router;

module.exports.downloadVideo =
  downloadVideo;

module.exports.extractAudio =
  extractAudio;

module.exports.transcribeAudio =
  transcribeAudio;

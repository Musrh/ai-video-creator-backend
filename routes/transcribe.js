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
const ytDlp = require('yt-dlp-exec');

ffmpeg.setFfmpegPath(ffmpegPath);

const router = express.Router();

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

fs.ensureDirSync(UPLOADS_DIR);

const upload = multer({
  dest: UPLOADS_DIR,
});

// ============================================================
// Plateformes supportées
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
    const host = new URL(url).hostname.replace(/^www\./, '');

    return PLATFORM_HOSTS.some(
      (h) => host === h || host.endsWith('.' + h)
    );
  } catch {
    return false;
  }
}

// ============================================================
// YouTube cookies
// ============================================================
//
// YOUTUBE_COOKIES_BASE64 contient le contenu de cookies.txt
// exporté depuis Firefox.
//
// On conserve exactement ce fonctionnement.
// ============================================================

let cachedCookiesPath = null;

function getCookiesFilePath() {
  if (!process.env.YOUTUBE_COOKIES_BASE64) {
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

    fs.writeFileSync(filePath, content);

    cachedCookiesPath = filePath;

    console.log(
      '🍪 Fichier cookies YouTube préparé.'
    );

    return filePath;
  } catch (err) {
    console.error(
      '❌ Impossible de créer yt-cookies.txt:',
      err.message
    );

    return null;
  }
}

// ============================================================
// BgUtils PO Token Provider
// ============================================================
//
// Le serveur BgUtils lancé dans server.js écoute sur :
// http://127.0.0.1:4416
//
// On peut modifier cette adresse avec BGUTIL_BASE_URL
// dans Railway si nécessaire.
// ============================================================

const BGUTIL_BASE_URL =
  process.env.BGUTIL_BASE_URL ||
  'http://127.0.0.1:4416';

// ============================================================
// Téléchargement avec yt-dlp
// ============================================================

async function downloadWithYtDlp(url, destPath) {
  console.log('▶️ Téléchargement avec yt-dlp :', url);

  const options = {
    output: destPath,

    format: 'best',

    noPlaylist: true,

    // --------------------------------------------------------
    // YouTube
    // --------------------------------------------------------
    //
    // On conserve le client Android utilisé précédemment.
    //
    // BgUtils fournit maintenant le PO Token via son serveur
    // HTTP local.
    //
    // Les deux arguments sont envoyés dans le même
    // extractor-args, séparés par ";".
    // --------------------------------------------------------

    extractorArgs:
      `youtube:player_client=android;` +
      `youtubepot-bgutilhttp:base_url=${BGUTIL_BASE_URL}`,

    // Évite certains problèmes de certificats côté serveur.
    noCheckCertificates: true,

    noWarnings: true,
  };

  // ----------------------------------------------------------
  // Cookies YouTube
  // ----------------------------------------------------------

  const cookiesPath = getCookiesFilePath();

  if (cookiesPath) {
    options.cookies = cookiesPath;

    console.log(
      '🍪 Cookies YouTube activés pour yt-dlp.'
    );
  } else {
    console.log(
      'ℹ️ Aucun YOUTUBE_COOKIES_BASE64 configuré.'
    );
  }

  // ----------------------------------------------------------
  // Téléchargement
  // ----------------------------------------------------------

  try {
    await ytDlp(url, options);
  } catch (err) {
    console.error(
      '❌ yt-dlp erreur:',
      err.stderr || err.message
    );

    throw err;
  }

  // ----------------------------------------------------------
  // Vérification du fichier produit
  // ----------------------------------------------------------

  if (await fs.pathExists(destPath)) {
    console.log(
      '✅ Vidéo téléchargée :',
      destPath
    );

    return destPath;
  }

  // Certains formats peuvent produire un nom légèrement
  // différent de celui demandé.
  const dir = path.dirname(destPath);

  const base = path.basename(
    destPath,
    path.extname(destPath)
  );

  const files = await fs.readdir(dir);

  const match = files.find(
    (f) => f.startsWith(base)
  );

  if (match) {
    const finalPath = path.join(dir, match);

    console.log(
      '✅ Vidéo trouvée :',
      finalPath
    );

    return finalPath;
  }

  throw new Error(
    'yt-dlp: fichier vidéo introuvable après téléchargement.'
  );
}

// ============================================================
// Téléchargement direct
// ============================================================

async function downloadDirect(url, destPath) {
  console.log(
    '⬇️ Téléchargement direct :',
    url
  );

  const response = await axios.get(url, {
    responseType: 'stream',
  });

  const writer = fs.createWriteStream(destPath);

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      console.log(
        '✅ Téléchargement direct terminé :',
        destPath
      );

      resolve(destPath);
    });

    writer.on('error', reject);

    response.data.on('error', reject);
  });
}

// ============================================================
// Choix du mode de téléchargement
// ============================================================

async function downloadVideo(url, destPath) {
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
// Extraction audio
// ============================================================

function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    console.log(
      '🎵 Extraction audio :',
      videoPath
    );

    ffmpeg(videoPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .format('mp3')
      .on('end', () => {
        console.log(
          '✅ Extraction audio terminée.'
        );

        resolve();
      })
      .on('error', (err) => {
        console.error(
          '❌ Erreur ffmpeg:',
          err.message
        );

        reject(err);
      })
      .save(audioPath);
  });
}

// ============================================================
// Transcription OpenAI Whisper
// ============================================================

async function transcribeAudio(audioPath) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY manquant dans .env'
    );
  }

  console.log(
    '📝 Transcription OpenAI Whisper...'
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

  const { data } = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization:
          `Bearer ${process.env.OPENAI_API_KEY}`,
      },

      maxBodyLength: Infinity,
    }
  );

  console.log(
    '✅ Transcription terminée.'
  );

  return data.text;
}

// ============================================================
// POST /api/transcribe
// ============================================================

router.post(
  '/transcribe',
  upload.single('video'),
  async (req, res) => {
    const tmpFiles = [];

    try {
      let videoPath;

      // ------------------------------------------------------
      // 1. Fichier envoyé directement
      // ------------------------------------------------------

      if (req.file) {
        videoPath = req.file.path;

        tmpFiles.push(videoPath);

        console.log(
          '📁 Vidéo reçue par upload :',
          videoPath
        );
      }

      // ------------------------------------------------------
      // 2. URL vidéo
      // ------------------------------------------------------

      else if (req.body.videoUrl) {
        const target = path.join(
          UPLOADS_DIR,
          `src_${Date.now()}.mp4`
        );

        videoPath = await downloadVideo(
          req.body.videoUrl,
          target
        );

        tmpFiles.push(videoPath);
      }

      // ------------------------------------------------------
      // 3. Rien fourni
      // ------------------------------------------------------

      else {
        return res.status(400).json({
          error:
            'Fournissez "video" (upload) ou "videoUrl".',
        });
      }

      // ------------------------------------------------------
      // Extraction audio
      // ------------------------------------------------------

      const audioPath = path.join(
        UPLOADS_DIR,
        `audio_${Date.now()}.mp3`
      );

      tmpFiles.push(audioPath);

      await extractAudio(
        videoPath,
        audioPath
      );

      // ------------------------------------------------------
      // Transcription
      // ------------------------------------------------------

      const transcript =
        await transcribeAudio(audioPath);

      // ------------------------------------------------------
      // Réponse
      // ------------------------------------------------------

      res.json({
        transcript,
        sourceVideoPath: videoPath,
      });
    } catch (err) {
      console.error(
        '❌ Erreur transcription:',
        err.response?.data ||
        err.stderr ||
        err.message
      );

      res.status(500).json({
        error:
          err.response?.data?.error?.message ||
          err.stderr ||
          err.message,
      });
    } finally {
      // ------------------------------------------------------
      // Nettoyage
      // ------------------------------------------------------

      for (const file of tmpFiles) {
        try {
          await fs.remove(file);
        } catch {
          // Ignore les erreurs de nettoyage
        }
      }
    }
  }
);

// ============================================================
// Exports utilisés par video.js
// ============================================================

module.exports = router;

module.exports.downloadVideo =
  downloadVideo;

module.exports.extractAudio =
  extractAudio;

module.exports.transcribeAudio =
  transcribeAudio;
```

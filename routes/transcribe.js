
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
  dest: UPLOADS_DIR
});

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
    const host = new URL(url).hostname.replace(/^www\./, '');

    return PLATFORM_HOSTS.some(function (h) {
      return host === h || host.endsWith('.' + h);
    });
  } catch (err) {
    return false;
  }
}

// ============================================================
// COOKIES YOUTUBE
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

    fs.writeFileSync(
      filePath,
      content
    );

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
// BGUTIL PO TOKEN
// ============================================================

const BGUTIL_BASE_URL =
  process.env.BGUTIL_BASE_URL ||
  'http://127.0.0.1:4416';

console.log(
  '🔐 BgUtils URL: ' + BGUTIL_BASE_URL
);

// ============================================================
// YT-DLP
// ============================================================

async function downloadWithYtDlp(url, destPath) {
  console.log(
    '▶️ Téléchargement avec yt-dlp: ' + url
  );

  const options = {
    output: destPath,

    format: 'best',

    noPlaylist: true,

    extractorArgs:
      'youtube:player_client=android;' +
      'youtubepot-bgutilhttp:base_url=' +
      BGUTIL_BASE_URL,

    noCheckCertificates: true,

    noWarnings: true
  };

  const cookiesPath = getCookiesFilePath();

  if (cookiesPath) {
    options.cookies = cookiesPath;

    console.log(
      '🍪 Cookies YouTube activés.'
    );
  } else {
    console.log(
      'ℹ️ YOUTUBE_COOKIES_BASE64 non configuré.'
    );
  }

  try {
    await ytDlp(
      url,
      options
    );
  } catch (err) {
    console.error(
      '❌ yt-dlp erreur:',
      err.stderr || err.message
    );

    throw err;
  }

  if (await fs.pathExists(destPath)) {
    console.log(
      '✅ Vidéo téléchargée: ' + destPath
    );

    return destPath;
  }

  const dir = path.dirname(destPath);

  const base = path.basename(
    destPath,
    path.extname(destPath)
  );

  const files = await fs.readdir(dir);

  const match = files.find(function (file) {
    return file.startsWith(base);
  });

  if (match) {
    const finalPath = path.join(
      dir,
      match
    );

    console.log(
      '✅ Vidéo trouvée: ' + finalPath
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

async function downloadDirect(url, destPath) {
  console.log(
    '⬇️ Téléchargement direct: ' + url
  );

  const response = await axios.get(
    url,
    {
      responseType: 'stream'
    }
  );

  const writer = fs.createWriteStream(
    destPath
  );

  response.data.pipe(writer);

  return new Promise(function (resolve, reject) {
    writer.on(
      'finish',
      function () {
        console.log(
          '✅ Téléchargement direct terminé: ' +
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
  });
}

// ============================================================
// TÉLÉCHARGEMENT VIDÉO
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
// EXTRACTION AUDIO
// ============================================================

function extractAudio(
  videoPath,
  audioPath
) {
  return new Promise(function (resolve, reject) {
    console.log(
      '🎵 Extraction audio: ' + videoPath
    );

    ffmpeg(videoPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .format('mp3')
      .on(
        'end',
        function () {
          console.log(
            '✅ Extraction audio terminée.'
          );

          resolve();
        }
      )
      .on(
        'error',
        function (err) {
          console.error(
            '❌ Erreur FFmpeg:',
            err.message
          );

          reject(err);
        }
      )
      .save(audioPath);
  });
}

// ============================================================
// TRANSCRIPTION OPENAI
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

  const headers = {
    ...form.getHeaders(),

    Authorization:
      'Bearer ' +
      process.env.OPENAI_API_KEY
  };

  const response = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    form,
    {
      headers: headers,
      maxBodyLength: Infinity
    }
  );

  console.log(
    '✅ Transcription terminée.'
  );

  return response.data.text;
}

// ============================================================
// POST /api/transcribe
// ============================================================

router.post(
  '/transcribe',
  upload.single('video'),
  async function (req, res) {
    const tmpFiles = [];

    try {
      let videoPath;

      if (req.file) {
        videoPath = req.file.path;

        tmpFiles.push(
          videoPath
        );

        console.log(
          '📁 Vidéo reçue: ' + videoPath
        );

      } else if (req.body.videoUrl) {

        const target = path.join(
          UPLOADS_DIR,
          'src_' +
          Date.now() +
          '.mp4'
        );

        videoPath = await downloadVideo(
          req.body.videoUrl,
          target
        );

        tmpFiles.push(
          videoPath
        );

      } else {

        return res.status(400).json({
          error:
            'Fournissez "video" (upload) ou "videoUrl".'
        });
      }

      const audioPath = path.join(
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

      const transcript =
        await transcribeAudio(
          audioPath
        );

      return res.json({
        transcript: transcript,
        sourceVideoPath: videoPath
      });

    } catch (err) {

      console.error(
        '❌ Erreur transcription:',
        err.response &&
        err.response.data
          ? err.response.data
          : err.stderr ||
            err.message
      );

      return res.status(500).json({
        error:
          err.response &&
          err.response.data &&
          err.response.data.error &&
          err.response.data.error.message
            ? err.response.data.error.message
            : err.stderr ||
              err.message
      });

    } finally {

      for (const file of tmpFiles) {
        try {
          await fs.remove(file);
        } catch (err) {
          // Ignore les erreurs de nettoyage.
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


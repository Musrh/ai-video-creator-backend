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
const upload = multer({ dest: UPLOADS_DIR });

const PLATFORM_HOSTS = [
  'youtube.com', 'youtu.be', 'm.youtube.com',
  'tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com',
];

function isPlatformUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return PLATFORM_HOSTS.some((platform) => host === platform || host.endsWith('.' + platform));
  } catch {
    return false;
  }
}

// YouTube bloque souvent les téléchargements venant d'IP de serveurs cloud
// ("Sign in to confirm you're not a bot"). De vrais cookies (d'un compte YouTube connecté,
// exportés depuis un navigateur) contournent généralement ce blocage. Le contenu du fichier
// cookies.txt est stocké en base64 dans YOUTUBE_COOKIES_BASE64, réécrit sur disque une seule fois.
let cachedCookiesPath = null;
function getCookiesFilePath() {
  if (!process.env.YOUTUBE_COOKIES_BASE64) {
    console.log('YOUTUBE_COOKIES_BASE64 non configuré.');
    return null;
  }
  if (cachedCookiesPath) return cachedCookiesPath;

  const filePath = path.join(os.tmpdir(), 'yt-cookies.txt');
  try {
    const content = Buffer.from(process.env.YOUTUBE_COOKIES_BASE64, 'base64').toString('utf8');
    fs.writeFileSync(filePath, content);
    cachedCookiesPath = filePath;
    console.log('Cookies YouTube préparés.');
    return filePath;
  } catch (error) {
    console.error('Erreur création cookies YouTube:', error.message);
    return null;
  }
}

// Serveur BgUtils PO Token (lancé séparément, voir server.js) : génère le jeton "Proof of
// Origin" que YouTube exige de plus en plus souvent, en plus des cookies.
const BGUTIL_BASE_URL = process.env.BGUTIL_BASE_URL || 'http://127.0.0.1:4416';
console.log('BgUtils URL: ' + BGUTIL_BASE_URL);

// Télécharge une vidéo YouTube/TikTok via yt-dlp (gère extraction du flux + fusion audio/vidéo)
async function downloadWithYtDlp(url, destPath) {
  console.log('Téléchargement avec yt-dlp: ' + url);

  const options = {
    output: destPath,
    format: 'best',
    noPlaylist: true,
    // Client mweb + fourniture du PO Token via le serveur BgUtils local
    extractorArgs:
      'youtube:player_client=mweb;' +
      'youtubepot-bgutilhttp:base_url=' + BGUTIL_BASE_URL,
    noCheckCertificates: true,
    noWarnings: true,
    // "bv*+ba" nécessite une fusion audio/vidéo par ffmpeg : on indique explicitement le
    // binaire fourni par ffmpeg-static, plutôt que de compter sur un ffmpeg global du système.
    ffmpegLocation: ffmpegPath,
  };

  const cookiesPath = getCookiesFilePath();
  if (cookiesPath) {
    options.cookies = cookiesPath;
    console.log('Cookies YouTube activés.');
  }

  try {
    await ytDlp(url, options);
  } catch (error) {
    console.error('Erreur yt-dlp:', error.stderr || error.message);
    throw error;
  }

  if (await fs.pathExists(destPath)) {
    console.log('Vidéo téléchargée: ' + destPath);
    return destPath;
  }

  // yt-dlp peut parfois écrire une extension différente : on vérifie
  const directory = path.dirname(destPath);
  const baseName = path.basename(destPath, path.extname(destPath));
  const files = await fs.readdir(directory);
  const match = files.find((file) => file.startsWith(baseName));
  if (match) {
    const finalPath = path.join(directory, match);
    console.log('Vidéo trouvée: ' + finalPath);
    return finalPath;
  }

  throw new Error('yt-dlp: fichier vidéo introuvable après téléchargement.');
}

// Télécharge une vidéo depuis une URL directe (mp4, mov, etc.) via un flux HTTP simple
async function downloadDirect(url, destPath) {
  console.log('Téléchargement direct: ' + url);
  const response = await axios.get(url, { responseType: 'stream' });
  const writer = fs.createWriteStream(destPath);
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      console.log('Téléchargement direct terminé: ' + destPath);
      resolve(destPath);
    });
    writer.on('error', reject);
    response.data.on('error', reject);
  });
}

// Point d'entrée unique : détecte YouTube/TikTok vs URL directe
async function downloadVideo(url, destPath) {
  if (isPlatformUrl(url)) return downloadWithYtDlp(url, destPath);
  return downloadDirect(url, destPath);
}

function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    console.log('Extraction audio: ' + videoPath);
    ffmpeg(videoPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .format('mp3')
      .on('end', () => {
        console.log('Extraction audio terminée.');
        resolve();
      })
      .on('error', (error) => {
        console.error('Erreur FFmpeg:', error.message);
        reject(error);
      })
      .save(audioPath);
  });
}

async function transcribeAudio(audioPath) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY manquant dans .env');
  }
  console.log('Transcription OpenAI Whisper...');

  const form = new FormData();
  form.append('file', fs.createReadStream(audioPath));
  form.append('model', 'whisper-1');

  const { data } = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    form,
    {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      maxBodyLength: Infinity,
    }
  );

  console.log('Transcription terminée.');
  return data.text;
}

// POST /api/transcribe  — soit { videoUrl } en JSON, soit un fichier "video" en multipart
router.post('/transcribe', upload.single('video'), async (req, res) => {
  const tmpFiles = [];
  try {
    let videoPath;

    if (req.file) {
      videoPath = req.file.path;
      tmpFiles.push(videoPath);
      console.log('Vidéo reçue: ' + videoPath);
    } else if (req.body.videoUrl) {
      const target = path.join(UPLOADS_DIR, `src_${Date.now()}.mp4`);
      videoPath = await downloadVideo(req.body.videoUrl, target);
      tmpFiles.push(videoPath);
    } else {
      return res.status(400).json({ error: 'Fournissez "video" (upload) ou "videoUrl".' });
    }

    const audioPath = path.join(UPLOADS_DIR, `audio_${Date.now()}.mp3`);
    tmpFiles.push(audioPath);
    await extractAudio(videoPath, audioPath);

    const transcript = await transcribeAudio(audioPath);

    res.json({ transcript, sourceVideoPath: videoPath });
  } catch (error) {
    console.error(
      'Erreur transcription:',
      (error.response && error.response.data) || error.stderr || error.message
    );
    res.status(500).json({
      error:
        (error.response && error.response.data && error.response.data.error && error.response.data.error.message) ||
        error.stderr ||
        error.message,
    });
  } finally {
    for (const file of tmpFiles) {
      await fs.remove(file).catch(() => {});
    }
  }
});

module.exports = router;
module.exports.downloadVideo = downloadVideo;
module.exports.extractAudio = extractAudio;
module.exports.transcribeAudio = transcribeAudio;

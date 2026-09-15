const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const FormData = require('form-data');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const ytDlp = require('yt-dlp-exec');
ffmpeg.setFfmpegPath(ffmpegPath);

const router = express.Router();
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const upload = multer({ dest: UPLOADS_DIR });

const PLATFORM_HOSTS = [
  'youtube.com', 'youtu.be', 'm.youtube.com',
  'tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com',
];

function isPlatformUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return PLATFORM_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}

// Télécharge une vidéo YouTube/TikTok via yt-dlp (gère extraction du flux + fusion audio/vidéo)
async function downloadWithYtDlp(url, destPath) {
  // destPath se termine par .mp4 ; yt-dlp choisit lui-même le meilleur format compatible mp4
  await ytDlp(url, {
    output: destPath,
    format: 'mp4/best[ext=mp4]/best',
    noPlaylist: true,
    noCheckCertificates: true,
    noWarnings: true,
  });
  // yt-dlp peut parfois écrire une extension différente si mp4 indisponible : on vérifie
  if (!(await fs.pathExists(destPath))) {
    const dir = path.dirname(destPath);
    const base = path.basename(destPath, path.extname(destPath));
    const match = (await fs.readdir(dir)).find((f) => f.startsWith(base));
    if (match) return path.join(dir, match);
    throw new Error('yt-dlp: fichier vidéo introuvable après téléchargement.');
  }
  return destPath;
}

// Télécharge une vidéo depuis une URL directe (mp4, mov, etc.) via un flux HTTP simple
async function downloadDirect(url, destPath) {
  const response = await axios.get(url, { responseType: 'stream' });
  const writer = fs.createWriteStream(destPath);
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', () => resolve(destPath));
    writer.on('error', reject);
  });
}

// Point d'entrée unique : détecte YouTube/TikTok vs URL directe
async function downloadVideo(url, destPath) {
  if (isPlatformUrl(url)) {
    return downloadWithYtDlp(url, destPath);
  }
  return downloadDirect(url, destPath);
}

function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .format('mp3')
      .on('end', resolve)
      .on('error', reject)
      .save(audioPath);
  });
}

async function transcribeAudio(audioPath) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY manquant dans .env');
  }
  const form = new FormData();
  form.append('file', fs.createReadStream(audioPath));
  form.append('model', 'whisper-1');

  const { data } = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      maxBodyLength: Infinity,
    }
  );
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
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  } finally {
    // Nettoyage des fichiers audio temporaires (on garde la vidéo pour le montage final)
    fs.remove(tmpFiles[tmpFiles.length - 1]).catch(() => {});
  }
});

module.exports = router;
module.exports.downloadVideo = downloadVideo;
module.exports.extractAudio = extractAudio;
module.exports.transcribeAudio = transcribeAudio;

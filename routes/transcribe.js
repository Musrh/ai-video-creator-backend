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

// Emplacement du fichier écrit par install-bgutil.sh, contenant le chemin EXACT du python3
// utilisé pour installer yt-dlp — on réutilise ce même binaire au runtime, plutôt que de
// refaire confiance à "python3" via le PATH (qui peut résoudre différemment selon le contexte).
const PYTHON_BIN_PATH_FILE = path.join(__dirname, '..', 'python-bin-path.txt');
function getPythonBin() {
  try {
    const content = fs.readFileSync(PYTHON_BIN_PATH_FILE, 'utf8').trim();
    if (content) return content;
  } catch {
    // fichier absent (install-bgutil.sh pas encore exécuté, ou ancienne version) : on retombe
    // sur "python3" générique, au risque du souci d'origine.
  }
  return 'python3';
}

// Dossier où install-bgutil.sh a copié le plugin (chemin relatif au projet, pas $HOME —
// $HOME n'est pas un emplacement de plugin reconnu par yt-dlp). Passé explicitement à
// yt-dlp via --plugin-dirs pour ne dépendre d'aucun emplacement "par défaut" deviné.
const PLUGIN_DIR = path.join(__dirname, '..', 'yt-dlp-plugins');

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
// exportés depuis un navigateur) contournent généralement ce blocage.
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

// Serveur BgUtils PO Token (compilé par install-bgutil.sh, démarré séparément — voir
// server.js). Génère le jeton "Proof of Origin" que YouTube exige de plus en plus souvent.
const BGUTIL_BASE_URL = process.env.BGUTIL_BASE_URL || 'http://127.0.0.1:4416';
console.log('BgUtils URL: ' + BGUTIL_BASE_URL);

function downloadWithYtDlp(url, destPath) {
  return new Promise((resolve, reject) => {
    console.log('Téléchargement avec yt-dlp Python: ' + url);

    const args = [
      '-m', 'yt_dlp',
      url,
      '--output', destPath,
      // "bv*+ba" (flux séparés à fusionner) en priorité, repli sur "best" (déjà combiné) si
      // le client ne propose pas de flux adaptatifs pour cette vidéo.
     '--format', 'best[ext=mp4]/best',
      '--no-playlist',
      '--extractor-args',
      'youtube:player_client=mweb;youtubepot-bgutilhttp:base_url=' + BGUTIL_BASE_URL,
      '--no-check-certificates',
      '--no-warnings',
      // Emplacement explicite du plugin — voir commentaire sur PLUGIN_DIR plus haut.
      '--plugin-dirs', PLUGIN_DIR,
      // Nécessaire pour que yt-dlp sache fusionner vidéo+audio (format bv*+ba) : sans ça,
      // il cherche un "ffmpeg" global sur le PATH, qui peut être absent.
      '--ffmpeg-location', ffmpegPath,
    ];

    const cookiesPath = getCookiesFilePath();
    if (cookiesPath) {
      args.push('--cookies', cookiesPath);
      console.log('Cookies YouTube activés.');
    }

    console.log('Commande: ' + getPythonBin() + ' ' + args.join(' '));

    const processYtDlp = spawn(getPythonBin(), args, { env: { ...process.env } });

    let stdout = '';
    let stderr = '';

    processYtDlp.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      console.log('[yt-dlp] ' + text.trim());
    });

    processYtDlp.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      console.error('[yt-dlp] ' + text.trim());
    });

    processYtDlp.on('error', (error) => {
      console.error('Erreur lancement yt-dlp:', error.message);
      reject(error);
    });

    processYtDlp.on('close', async (code) => {
      try {
        if (code !== 0) {
          reject(new Error('yt-dlp Python terminé avec le code ' + code + ': ' + stderr));
          return;
        }

        if (await fs.pathExists(destPath)) {
          console.log('Vidéo téléchargée: ' + destPath);
          resolve(destPath);
          return;
        }

        // yt-dlp peut parfois écrire une extension différente : on vérifie
        const directory = path.dirname(destPath);
        const baseName = path.basename(destPath, path.extname(destPath));
        const files = await fs.readdir(directory);
        const match = files.find((file) => file.startsWith(baseName));
        if (match) {
          const finalPath = path.join(directory, match);
          console.log('Vidéo trouvée: ' + finalPath);
          resolve(finalPath);
          return;
        }

        reject(new Error('yt-dlp: fichier vidéo introuvable après téléchargement.'));
      } catch (error) {
        reject(error);
      }
    });
  });
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

  const headers = { ...form.getHeaders(), Authorization: 'Bearer ' + process.env.OPENAI_API_KEY };

  const response = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    form,
    { headers, maxBodyLength: Infinity }
  );

  console.log('Transcription terminée.');
  return response.data.text;
}

router.post('/transcribe', upload.single('video'), async (req, res) => {
  const tmpFiles = [];
  try {
    let videoPath;

    if (req.file) {
      videoPath = req.file.path;
      tmpFiles.push(videoPath);
      console.log('Vidéo reçue: ' + videoPath);
    } else if (req.body && req.body.videoUrl) {
      const target = path.join(UPLOADS_DIR, 'src_' + Date.now() + '.mp4');
      videoPath = await downloadVideo(req.body.videoUrl, target);
      tmpFiles.push(videoPath);
    } else {
      return res.status(400).json({ error: 'Fournissez video ou videoUrl.' });
    }

    const audioPath = path.join(UPLOADS_DIR, 'audio_' + Date.now() + '.mp3');
    tmpFiles.push(audioPath);
    await extractAudio(videoPath, audioPath);

    const transcript = await transcribeAudio(audioPath);

    return res.json({ transcript, sourceVideoPath: videoPath });
  } catch (error) {
    console.error(
      'Erreur transcription:',
      (error.response && error.response.data) || error.message
    );
    return res.status(500).json({
      error:
        (error.response && error.response.data && error.response.data.error && error.response.data.error.message) ||
        error.message,
    });
  } finally {
    for (const file of tmpFiles) {
      try {
        await fs.remove(file);
      } catch {
        // ignore
      }
    }
  }
});

module.exports = router;
module.exports.downloadVideo = downloadVideo;
module.exports.extractAudio = extractAudio;
module.exports.transcribeAudio = transcribeAudio;

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

// Emplacement du fichier écrit par install-bgutil.sh.
// Ce fichier contient le chemin exact du Python utilisé pour installer yt-dlp.
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
    // Si le fichier n'existe pas, on utilise python3.
  }

  return 'python3';
}

// Dossier où install-bgutil.sh a copié le plugin yt-dlp.
const PLUGIN_DIR = path.join(__dirname, '..', 'yt-dlp-plugins');

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
        host === platform || host.endsWith(`.${platform}`)
    );
  } catch {
    return false;
  }
}

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
    const content = Buffer.from(
      process.env.YOUTUBE_COOKIES_BASE64,
      'base64'
    ).toString('utf8');

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

const BGUTIL_BASE_URL =
  process.env.BGUTIL_BASE_URL ||
  'http://127.0.0.1:4416';

console.log('BgUtils URL:', BGUTIL_BASE_URL);

// Options communes utilisées par le téléchargement et le diagnostic.
function buildCommonArgs() {
  const args = [
    '--no-playlist',

    '--extractor-args',
    `youtube:player_client=mweb;youtubepot-bgutilhttp:base_url=${BGUTIL_BASE_URL}`,

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

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const pythonBin = getPythonBin();

    console.log(
      'Commande:',
      pythonBin,
      args.join(' ')
    );

    const process = spawn(pythonBin, args, {
      env: {
        ...process.env,
      },
    });

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data) => {
      const output = data.toString();

      stdout += output;

      console.log('[yt-dlp]', output.trim());
    });

    process.stderr.on('data', (data) => {
      const output = data.toString();

      stderr += output;

      console.error('[yt-dlp]', output.trim());
    });

    process.on('error', (error) => {
      reject(error);
    });

    process.on('close', (code) => {
      resolve({
        code,
        stdout,
        stderr,
      });
    });
  });
}

// Télécharge une vidéo YouTube ou TikTok avec yt-dlp.
//
// La sélection suivante est importante :
// - bestvideo* : meilleur flux vidéo disponible
// - bestaudio : meilleur flux audio disponible
// - /best : fallback vers un flux audio/vidéo combiné
//
// Certains clients YouTube ne proposent pas de flux combiné.
// Dans ce cas, yt-dlp télécharge séparément l'audio et la vidéo,
// puis FFmpeg les fusionne en MP4.
async function downloadWithYtDlp(url, destPath) {
  console.log(
    'Téléchargement avec yt-dlp Python:',
    url
  );

  const commonArgs = buildCommonArgs();

  const downloadArgs = [
    '-m',
    'yt_dlp',

    url,

    '--output',
    destPath,

    '--format',
    'bestvideo*+bestaudio/best',

    '--merge-output-format',
    'mp4',

    '--ffmpeg-location',
    ffmpegPath,

    ...commonArgs,
  ];

  const result = await runYtDlp(downloadArgs);

  if (result.code !== 0) {
    console.log(
      'Échec du téléchargement.',
      'Lancement du diagnostic --list-formats...'
    );

    const listArgs = [
      '-m',
      'yt_dlp',
      url,
      '--list-formats',
      ...commonArgs,
    ];

    const listResult = await runYtDlp(listArgs).catch(
      (error) => ({
        stdout: '',
        stderr: error.message,
      })
    );

    throw new Error(
      'yt-dlp a échoué:\n' +
        result.stderr +
        '\n--- Diagnostic --list-formats ---\n' +
        (listResult.stdout || '(aucune sortie)') +
        (listResult.stderr
          ? `\n${listResult.stderr}`
          : '')
    );
  }

  if (await fs.pathExists(destPath)) {
    console.log(
      'Vidéo téléchargée:',
      destPath
    );

    return destPath;
  }

  const directory = path.dirname(destPath);
  const baseName = path.basename(
    destPath,
    path.extname(destPath)
  );

  const files = await fs.readdir(directory);

  const matchingFile = files.find((file) =>
    file.startsWith(baseName)
  );

  if (matchingFile) {
    const finalPath = path.join(
      directory,
      matchingFile
    );

    console.log(
      'Vidéo trouvée:',
      finalPath
    );

    return finalPath;
  }

  throw new Error(
    'yt-dlp: fichier vidéo introuvable après téléchargement.'
  );
}

// Télécharge une vidéo depuis une URL directe.
async function downloadDirect(url, destPath) {
  console.log(
    'Téléchargement direct:',
    url
  );

  const response = await axios.get(url, {
    responseType: 'stream',
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  const writer = fs.createWriteStream(destPath);

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      console.log(
        'Téléchargement direct terminé:',
        destPath
      );

      resolve(destPath);
    });

    writer.on('error', reject);
    response.data.on('error', reject);
  });
}

async function downloadVideo(url, destPath) {
  if (isPlatformUrl(url)) {
    return downloadWithYtDlp(url, destPath);
  }

  return downloadDirect(url, destPath);
}

function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    console.log(
      'Extraction audio:',
      videoPath
    );

    ffmpeg(videoPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .format('mp3')
      .on('end', () => {
        console.log('Extraction audio terminée.');

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
  });
}

async function transcribeAudio(audioPath) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY manquant dans les variables d’environnement.'
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
      `Bearer ${process.env.OPENAI_API_KEY}`,
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

router.post(
  '/transcribe',
  upload.single('video'),
  async (req, res) => {
    const temporaryFiles = [];

    try {
      let videoPath;

      if (req.file) {
        videoPath = req.file.path;

        temporaryFiles.push(videoPath);

        console.log(
          'Vidéo reçue:',
          videoPath
        );
      } else if (
        req.body &&
        req.body.videoUrl
      ) {
        const targetPath = path.join(
          UPLOADS_DIR,
          `src_${Date.now()}.mp4`
        );

        videoPath = await downloadVideo(
          req.body.videoUrl,
          targetPath
        );

        temporaryFiles.push(videoPath);
      } else {
        return res.status(400).json({
          error:
            'Fournissez un fichier video ou une videoUrl.',
        });
      }

      const audioPath = path.join(
        UPLOADS_DIR,
        `audio_${Date.now()}.mp3`
      );

      temporaryFiles.push(audioPath);

      await extractAudio(
        videoPath,
        audioPath
      );

      const transcript = await transcribeAudio(
        audioPath
      );

      return res.json({
        transcript,
      });
    } catch (error) {
      const errorMessage =
        error.response &&
        error.response.data &&
        error.response.data.error &&
        error.response.data.error.message
          ? error.response.data.error.message
          : error.message;

      console.error(
        'Erreur transcription:',
        error.response?.data || error.message
      );

      return res.status(500).json({
        error: errorMessage,
      });
    } finally {
      for (const file of temporaryFiles) {
        try {
          await fs.remove(file);
        } catch {
          // Ignore les erreurs de nettoyage.
        }
      }
    }
  }
);

module.exports = router;

module.exports.downloadVideo =
  downloadVideo;

module.exports.extractAudio =
  extractAudio;

module.exports.transcribeAudio =
  transcribeAudio;

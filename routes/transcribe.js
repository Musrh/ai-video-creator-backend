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
const parsed = new URL(url);
const host = parsed.hostname.toLowerCase();

```
for (const platform of PLATFORM_HOSTS) {
  if (host === platform) {
    return true;
  }

  if (host.endsWith('.' + platform)) {
    return true;
  }
}

return false;
```

} catch (error) {
return false;
}
}

let cachedCookiesPath = null;

function getCookiesFilePath() {

if (!process.env.YOUTUBE_COOKIES_BASE64) {

```
console.log(
  'YOUTUBE_COOKIES_BASE64 non configure.'
);

return null;
```

}

if (cachedCookiesPath) {
return cachedCookiesPath;
}

const filePath = path.join(
os.tmpdir(),
'yt-cookies.txt'
);

try {

```
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
  'Cookies YouTube prepares.'
);

return filePath;
```

} catch (error) {

```
console.error(
  'Erreur creation cookies YouTube:',
  error.message
);

return null;
```

}
}

const BGUTIL_BASE_URL =
process.env.BGUTIL_BASE_URL ||
'http://127.0.0.1:4416';

console.log(
'BgUtils URL: ' + BGUTIL_BASE_URL
);

function downloadWithYtDlp(url, destPath) {

return new Promise(function (resolve, reject) {

```
console.log(
  'Telechargement avec yt-dlp Python: ' + url
);

const args = [
  '-m',
  'yt_dlp',

  url,

  '--output',
  destPath,

  '--format',
  'bv*+ba/b',

  '--no-playlist',

  '--extractor-args',
  'youtube:player_client=mweb;youtubepot-bgutilhttp:base_url=' +
  BGUTIL_BASE_URL,

  '--no-check-certificates',

  '--no-warnings'
];

const cookiesPath =
  getCookiesFilePath();

if (cookiesPath) {

  args.push(
    '--cookies',
    cookiesPath
  );

  console.log(
    'Cookies YouTube actives.'
  );
}

console.log(
  'Commande: python3 ' +
  args.join(' ')
);

const processYtDlp = spawn(
  'python3',
  args,
  {
    env: {
      ...process.env
    }
  }
);

let stdout = '';
let stderr = '';

processYtDlp.stdout.on(
  'data',
  function (data) {

    const text = data.toString();

    stdout += text;

    console.log(
      '[yt-dlp] ' + text.trim()
    );
  }
);

processYtDlp.stderr.on(
  'data',
  function (data) {

    const text = data.toString();

    stderr += text;

    console.error(
      '[yt-dlp] ' + text.trim()
    );
  }
);

processYtDlp.on(
  'error',
  function (error) {

    reject(error);
  }
);

processYtDlp.on(
  'close',
  async function (code) {

    if (code !== 0) {

      const error =
        new Error(
          'yt-dlp Python termine avec le code ' +
          code +
          ': ' +
          stderr
        );

      reject(error);

      return;
    }

    if (
      await fs.pathExists(
        destPath
      )
    ) {

      console.log(
        'Video telechargee: ' +
        destPath
      );

      resolve(destPath);

      return;
    }

    const directory =
      path.dirname(destPath);

    const baseName =
      path.basename(
        destPath,
        path.extname(destPath)
      );

    const files =
      await fs.readdir(directory);

    const match =
      files.find(
        function (file) {

          return file.startsWith(
            baseName
          );
        }
      );

    if (match) {

      const finalPath =
        path.join(
          directory,
          match
        );

      console.log(
        'Video trouvee: ' +
        finalPath
      );

      resolve(finalPath);

      return;
    }

    reject(
      new Error(
        'yt-dlp: fichier video introuvable apres telechargement.'
      )
    );
  }
);
```

});
}

async function downloadDirect(
url,
destPath
) {

console.log(
'Telechargement direct: ' + url
);

const response =
await axios.get(
url,
{
responseType: 'stream'
}
);

const writer =
fs.createWriteStream(
destPath
);

response.data.pipe(writer);

return new Promise(
function (resolve, reject) {

```
  writer.on(
    'finish',
    function () {

      console.log(
        'Telechargement direct termine: ' +
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
```

);
}

async function downloadVideo(
url,
destPath
) {

if (isPlatformUrl(url)) {

```
return downloadWithYtDlp(
  url,
  destPath
);
```

}

return downloadDirect(
url,
destPath
);
}

function extractAudio(
videoPath,
audioPath
) {

return new Promise(
function (resolve, reject) {

```
  console.log(
    'Extraction audio: ' +
    videoPath
  );

  ffmpeg(videoPath)

    .noVideo()

    .audioCodec('libmp3lame')

    .format('mp3')

    .on(
      'end',
      function () {

        console.log(
          'Extraction audio terminee.'
        );

        resolve();
      }
    )

    .on(
      'error',
      function (error) {

        console.error(
          'Erreur FFmpeg:',
          error.message
        );

        reject(error);
      }
    )

    .save(audioPath);
}
```

);
}

async function transcribeAudio(
audioPath
) {

if (!process.env.OPENAI_API_KEY) {

```
throw new Error(
  'OPENAI_API_KEY manquant dans .env'
);
```

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

```
Authorization:
  'Bearer ' +
  process.env.OPENAI_API_KEY
```

};

const response =
await axios.post(
'https://api.openai.com/v1/audio/transcriptions',
form,
{
headers: headers,
maxBodyLength: Infinity
}
);

console.log(
'Transcription terminee.'
);

return response.data.text;
}

router.post(
'/transcribe',

upload.single('video'),

async function (req, res) {

```
const tmpFiles = [];

try {

  let videoPath;

  if (req.file) {

    videoPath =
      req.file.path;

    tmpFiles.push(
      videoPath
    );

    console.log(
      'Video recue: ' +
      videoPath
    );

  } else if (
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

  } else {

    return res.status(400).json({
      error:
        'Fournissez video ou videoUrl.'
    });
  }

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

  const transcript =
    await transcribeAudio(
      audioPath
    );

  return res.json({

    transcript:
      transcript,

    sourceVideoPath:
      videoPath

  });

} catch (error) {

  console.error(
    'Erreur transcription:',

    error.response &&
    error.response.data
      ? error.response.data
      : error.message
  );

  return res.status(500).json({

    error:
      error.response &&
      error.response.data &&
      error.response.data.error &&
      error.response.data.error.message

        ? error.response.data.error.message

        : error.message

  });

} finally {

  for (
    const file of tmpFiles
  ) {

    try {

      await fs.remove(
        file
      );

    } catch (error) {

    }
  }
}
```

}
);

module.exports = router;

module.exports.downloadVideo =
downloadVideo;

module.exports.extractAudio =
extractAudio;

module.exports.transcribeAudio =
transcribeAudio;

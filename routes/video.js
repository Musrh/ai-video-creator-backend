const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);

const { generateVideoContent, generateInspiration } = require('./text');
const { synthesize } = require('./voice');
const { downloadVideo, extractAudio, transcribeAudio } = require('./transcribe');
const { requireVerifiedQuota, consumeFreeGeneration } = require('./otp');

const router = express.Router();
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const upload = multer({ dest: UPLOADS_DIR });

const W = 1080;
const H = 1920; // format vertical (Reels/Shorts/TikTok)

// Construit la vidéo finale : fond (vidéo source en boucle, ou fond généré) + narration + titre incrusté
function buildFinalVideo({ backgroundPath, audioPath, titleText, outPath }) {
  return new Promise((resolve, reject) => {
    const safeTitle = (titleText || '').replace(/[':\\]/g, '').slice(0, 60);
    const drawtext = `drawtext=text='${safeTitle}':fontcolor=white:fontsize=54:` +
      `box=1:boxcolor=black@0.45:boxborderw=20:x=(w-text_w)/2:y=120:enable='between(t,0,5)'`;

    // Avec une vidéo source : elle devient l'input 0 (bouclée), l'audio l'input 1.
    // Sans vidéo source : le fond coloré est généré DIRECTEMENT dans le graphe de filtres
    // (pas via un input séparé "-f lavfi", qui dépend d'un module pas toujours présent selon
    // le build ffmpeg utilisé) — l'audio devient alors l'unique input, à l'index 0.
    function buildCommand(withDrawtext) {
      const cmd = ffmpeg();
      const textFilter = withDrawtext ? `,${drawtext}` : '';

      if (backgroundPath) {
        cmd.input(backgroundPath).inputOptions(['-stream_loop', '-1']);
        cmd.input(audioPath);
        cmd.complexFilter([
          `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}${textFilter}[v]`,
        ]);
        cmd.outputOptions(['-map', '[v]', '-map', '1:a:0', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p']);
      } else {
        cmd.input(audioPath);
        cmd.complexFilter([
          `color=c=0x1a1a2e:s=${W}x${H}:r=30${textFilter}[v]`,
        ]);
        cmd.outputOptions(['-map', '[v]', '-map', '0:a:0', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p']);
      }
      return cmd;
    }

    buildCommand(true)
      .on('end', () => resolve(outPath))
      .on('error', (err) => {
        // Repli sans texte incrusté si drawtext échoue (ex: police manquante sur le système)
        buildCommand(false)
          .on('end', () => resolve(outPath))
          .on('error', (err2) => reject(err2))
          .save(outPath);
      })
      .save(outPath);
  });
}

// --- Montage segmenté : une image + une narration par paragraphe, concaténés en une vidéo ---

function ffprobeDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data.format.duration);
    });
  });
}

// segments: [{ imagePath, audioPath, duration }], dans l'ordre d'apparition souhaité
function buildSegmentedVideo({ segments, titleText, outPath }) {
  return new Promise((resolve, reject) => {
    const safeTitle = (titleText || '').replace(/[':\\]/g, '').slice(0, 60);
    const drawtext = `drawtext=text='${safeTitle}':fontcolor=white:fontsize=54:` +
      `box=1:boxcolor=black@0.45:boxborderw=20:x=(w-text_w)/2:y=120:enable='between(t,0,5)'`;

    const cmd = ffmpeg();
    segments.forEach((seg) => {
      cmd.input(seg.imagePath).inputOptions(['-loop', '1', '-t', String(seg.duration)]);
    });
    segments.forEach((seg) => {
      cmd.input(seg.audioPath);
    });

    const n = segments.length;
    const scaleChains = segments
      .map((_, i) => `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30[v${i}]`)
      .join(';');
    const vConcatInputs = segments.map((_, i) => `[v${i}]`).join('');
    const aConcatInputs = segments.map((_, i) => `[${n + i}:a]`).join('');

    const filterComplex =
      `${scaleChains};` +
      `${vConcatInputs}concat=n=${n}:v=1:a=0[vconcat];` +
      `${aConcatInputs}concat=n=${n}:v=0:a=1[aconcat];` +
      `[vconcat]${drawtext}[v]`;

    cmd
      .complexFilter(filterComplex.split(';'))
      .outputOptions(['-map', '[v]', '-map', '[aconcat]', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p'])
      .on('end', () => resolve(outPath))
      .on('error', (err) => {
        // Repli sans texte incrusté si drawtext échoue
        const fallback = ffmpeg();
        segments.forEach((seg) => {
          fallback.input(seg.imagePath).inputOptions(['-loop', '1', '-t', String(seg.duration)]);
        });
        segments.forEach((seg) => {
          fallback.input(seg.audioPath);
        });
        const fallbackFilter =
          `${scaleChains};` +
          `${vConcatInputs}concat=n=${n}:v=1:a=0[vconcat];` +
          `${aConcatInputs}concat=n=${n}:v=0:a=1[aconcat]`;
        fallback
          .complexFilter(fallbackFilter.split(';'))
          .outputOptions(['-map', '[vconcat]', '-map', '[aconcat]', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p'])
          .on('end', () => resolve(outPath))
          .on('error', (err2) => reject(err2))
          .save(outPath);
      })
      .save(outPath);
  });
}

function parseListField(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  try {
    const parsed = JSON.parse(v);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // pas du JSON : on retombe sur une liste séparée par des virgules
  }
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Récupère (upload / URL / fichier déjà connu) la vidéo source + son transcript.
// Ne re-télécharge pas et ne re-transcrit pas si des infos existent déjà.
async function resolveSource({ file, videoUrl, sourceFile, sourceInfo }) {
  let backgroundPath = null;
  let transcript = sourceInfo || null;

  if (file) {
    backgroundPath = file.path;
  } else if (sourceFile) {
    const candidate = path.join(UPLOADS_DIR, path.basename(sourceFile));
    if (await fs.pathExists(candidate)) backgroundPath = candidate;
  } else if (videoUrl) {
    const target = path.join(UPLOADS_DIR, `src_${Date.now()}.mp4`);
    backgroundPath = await downloadVideo(videoUrl, target);
  }

  if (backgroundPath && !transcript && process.env.OPENAI_API_KEY) {
    const audioTmp = path.join(UPLOADS_DIR, `srcaudio_${Date.now()}.mp3`);
    try {
      await extractAudio(backgroundPath, audioTmp);
      transcript = await transcribeAudio(audioTmp);
    } catch (e) {
      console.warn('Transcription de la vidéo source ignorée:', e.message);
    } finally {
      fs.remove(audioTmp).catch(() => {});
    }
  }

  return { backgroundPath, transcript };
}

// POST /api/analyze-source
// (Pas de contrôle de quota ici : seul Whisper est utilisé, pas Claude ni ElevenLabs.)
router.post('/analyze-source', upload.single('sourceVideo'), async (req, res) => {
  try {
    const { videoUrl } = req.body;
    if (!req.file && !videoUrl) {
      return res.status(400).json({ error: 'Fournissez "sourceVideo" (upload) ou "videoUrl".' });
    }
    const { backgroundPath, transcript } = await resolveSource({ file: req.file, videoUrl });
    if (!backgroundPath) return res.status(400).json({ error: "Impossible de récupérer la vidéo source." });

    const inspiration = transcript
      ? await generateInspiration({ transcript })
      : { description: '', keywords: [], hashtags: [] };

    res.json({
      sourceFile: path.basename(backgroundPath),
      transcript: transcript || '',
      description: inspiration.description,
      keywords: inspiration.keywords,
      hashtags: inspiration.hashtags,
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/generate-video — protégée par requireVerifiedQuota (numéro OU email vérifié + quota)
router.post('/generate-video', requireVerifiedQuota, upload.single('sourceVideo'), async (req, res) => {
  try {
    const { subject, videoUrl, sourceFile, sourceInfo, voiceId, script, description } = req.body;
    if (!subject) return res.status(400).json({ error: 'Le champ "subject" est requis.' });
    if (!voiceId) return res.status(400).json({ error: 'Le champ "voiceId" est requis (voir /api/voices).' });

    const { backgroundPath, transcript } = await resolveSource({
      file: req.file,
      videoUrl,
      sourceFile,
      sourceInfo,
    });

    let content;
    if (script && description) {
      content = {
        script,
        description,
        keywords: parseListField(req.body.keywords),
        hashtags: parseListField(req.body.hashtags),
      };
    } else {
      content = await generateVideoContent({ subject, sourceInfo: transcript });
    }

    const narrationPath = await synthesize(content.script, voiceId);

    const outPath = path.join(OUTPUT_DIR, `video_${Date.now()}.mp4`);
    await buildFinalVideo({ backgroundPath, audioPath: narrationPath, titleText: subject, outPath });

    await consumeFreeGeneration(req.verifiedKey);

    res.json({
      videoUrl: `/output/${path.basename(outPath)}`,
      audioUrl: `/output/${path.basename(narrationPath)}`,
      script: content.script,
      description: content.description,
      keywords: content.keywords,
      hashtags: content.hashtags,
      sourceFile: backgroundPath ? path.basename(backgroundPath) : null,
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/regenerate-voice
router.post('/regenerate-voice', async (req, res) => {
  try {
    const { script, voiceId, sourceFile, subject } = req.body;
    if (!script) return res.status(400).json({ error: 'Le champ "script" est requis.' });
    if (!voiceId) return res.status(400).json({ error: 'Le champ "voiceId" est requis.' });

    let backgroundPath = null;
    if (sourceFile) {
      const candidate = path.join(UPLOADS_DIR, path.basename(sourceFile));
      if (await fs.pathExists(candidate)) backgroundPath = candidate;
    }

    const narrationPath = await synthesize(script, voiceId);
    const outPath = path.join(OUTPUT_DIR, `video_${Date.now()}.mp4`);
    await buildFinalVideo({ backgroundPath, audioPath: narrationPath, titleText: subject, outPath });

    res.json({
      videoUrl: `/output/${path.basename(outPath)}`,
      audioUrl: `/output/${path.basename(narrationPath)}`,
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/generate-video-segments — protégée par requireVerifiedQuota, comme /generate-video
router.post('/generate-video-segments', requireVerifiedQuota, upload.array('images', 20), async (req, res) => {
  try {
    const { voiceId, subject } = req.body;
    if (!voiceId) return res.status(400).json({ error: 'Le champ "voiceId" est requis.' });

    let texts;
    try {
      texts = JSON.parse(req.body.segments);
    } catch {
      return res.status(400).json({ error: 'Le champ "segments" doit être un JSON valide (tableau de textes).' });
    }
    if (!Array.isArray(texts) || texts.length === 0) {
      return res.status(400).json({ error: 'Au moins un paragraphe est requis.' });
    }
    if (!req.files || req.files.length !== texts.length) {
      return res.status(400).json({ error: 'Il faut exactement une image par paragraphe.' });
    }

    const segments = [];
    for (let i = 0; i < texts.length; i += 1) {
      const audioPath = await synthesize(texts[i], voiceId);
      const duration = await ffprobeDuration(audioPath);
      segments.push({ imagePath: req.files[i].path, audioPath, duration });
    }

    const outPath = path.join(OUTPUT_DIR, `video_${Date.now()}.mp4`);
    await buildSegmentedVideo({ segments, titleText: subject, outPath });

    await consumeFreeGeneration(req.verifiedKey);

    res.json({
      videoUrl: `/output/${path.basename(outPath)}`,
      script: texts.join('\n\n'),
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

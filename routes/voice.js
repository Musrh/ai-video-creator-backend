const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const FormData = require('form-data');

const router = express.Router();
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const upload = multer({ dest: UPLOADS_DIR });

const EL_BASE = 'https://api.elevenlabs.io/v1';

function headers() {
  if (!process.env.ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY manquant dans .env');
  }
  return { 'xi-api-key': process.env.ELEVENLABS_API_KEY };
}

// GET /api/voices — liste des voix disponibles (préréglées + clonées)
router.get('/voices', async (req, res) => {
  try {
    const { data } = await axios.get(`${EL_BASE}/voices`, { headers: headers() });
    const voices = data.voices.map((v) => ({
      id: v.voice_id,
      name: v.name,
      category: v.category,
      preview_url: v.preview_url,
    }));
    res.json({ voices });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/voices/clone — multipart: name, sample (fichier audio) -> crée une voix clonée
router.post('/voices/clone', upload.single('sample'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Fichier audio "sample" requis.' });
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Champ "name" requis.' });

    const form = new FormData();
    form.append('name', name);
    form.append('files', fs.createReadStream(req.file.path), req.file.originalname || 'sample.mp3');
    form.append('description', `Voix clonée à partir d'un fichier uploadé (${new Date().toISOString()})`);

    const { data } = await axios.post(`${EL_BASE}/voices/add`, form, {
      headers: { ...headers(), ...form.getHeaders() },
      maxBodyLength: Infinity,
    });

    await fs.remove(req.file.path).catch(() => {});
    res.json({ voiceId: data.voice_id, name });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/voice/synthesize — { text, voiceId } -> génère un mp3 de narration
async function synthesize(text, voiceId) {
  const response = await axios.post(
    `${EL_BASE}/text-to-speech/${voiceId}`,
    {
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    },
    { headers: { ...headers(), 'content-type': 'application/json' }, responseType: 'arraybuffer' }
  );
  const filename = `narration_${Date.now()}.mp3`;
  const outPath = path.join(OUTPUT_DIR, filename);
  await fs.writeFile(outPath, response.data);
  return outPath;
}

router.post('/voice/synthesize', async (req, res) => {
  try {
    const { text, voiceId } = req.body;
    if (!text || !voiceId) return res.status(400).json({ error: 'Champs "text" et "voiceId" requis.' });
    const outPath = await synthesize(text, voiceId);
    res.json({ audioUrl: `/output/${path.basename(outPath)}` });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.synthesize = synthesize;

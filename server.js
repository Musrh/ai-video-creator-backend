require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');

const app = express();
const PORT = process.env.PORT || 3000;

// Dossiers de travail
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');
fs.ensureDirSync(UPLOADS_DIR);
fs.ensureDirSync(OUTPUT_DIR);

app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Fichiers statiques : sorties générées uniquement (le frontend est un déploiement séparé)
app.use('/output', express.static(OUTPUT_DIR));

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'ai-video-creator-backend' });
});

// Routes API
app.use('/api', require('./routes/text'));
app.use('/api', require('./routes/transcribe'));
app.use('/api', require('./routes/voice'));
app.use('/api', require('./routes/video'));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
    elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY),
  });
});

app.listen(PORT, () => {
  console.log(`✅ AI Video Creator lancé sur http://localhost:${PORT}`);
});

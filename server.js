require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// Dossiers de travail
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');

fs.ensureDirSync(UPLOADS_DIR);
fs.ensureDirSync(OUTPUT_DIR);

app.use(cors({
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',')
    : '*',
}));

// ============================================================
// BgUtils PO Token Provider
// ============================================================
//
// Le provider est installé par install-bgutil.sh dans :
// bgutil-ytdlp-pot-provider/server/build/main.js
//
// Il écoute sur 127.0.0.1:4416 par défaut.
// ============================================================

let bgutilProcess = null;

function startBgutil() {
  const bgutilMain = path.join(
    __dirname,
    'bgutil-ytdlp-pot-provider',
    'server',
    'build',
    'main.js'
  );

  if (!fs.existsSync(bgutilMain)) {
    console.warn('⚠️ BgUtils introuvable :');
    console.warn(bgutilMain);
    console.warn('⚠️ Le serveur continue sans BgUtils.');
    return;
  }

  console.log('📦 Démarrage du serveur BgUtils PO Token...');

  bgutilProcess = spawn(
    process.execPath,
    [
      bgutilMain,
      '--port',
      '4416',
      '--host',
      '127.0.0.1',
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
      },
    }
  );

  bgutilProcess.on('error', (err) => {
    console.error(
      '❌ Erreur de démarrage BgUtils:',
      err.message
    );
  });

  bgutilProcess.on('exit', (code, signal) => {
    if (code !== 0) {
      console.warn(
        `⚠️ BgUtils arrêté (code=${code}, signal=${signal})`
      );
    } else {
      console.log('🟢 BgUtils arrêté proprement.');
    }

    bgutilProcess = null;
  });

  console.log(
    '🟢 BgUtils PO Token Provider lancé sur 127.0.0.1:4416'
  );
}

// Démarrer BgUtils avant l'API Express
startBgutil();

// ============================================================
// Webhook Stripe
// ============================================================
//
// DOIT être monté AVANT express.json(), avec son propre parseur
// raw, car Stripe vérifie une signature calculée sur le corps
// non transformé.
// ============================================================

app.post(
  '/api/payment/stripe/webhook',
  express.raw({ type: 'application/json' }),
  require('./routes/stripeWebhook')
);

// Le reste de l'API peut utiliser le parsing JSON/urlencoded classique
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Fichiers statiques : sorties générées uniquement
app.use('/output', express.static(OUTPUT_DIR));

// ============================================================
// Route principale
// ============================================================

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'ai-video-creator-backend',
  });
});

// ============================================================
// Routes API
// ============================================================

app.use('/api', require('./routes/text'));
app.use('/api', require('./routes/transcribe'));
app.use('/api', require('./routes/voice'));
app.use('/api', require('./routes/video'));
app.use('/api', require('./routes/otp'));
app.use('/api', require('./routes/paypal'));
app.use('/api', require('./routes/cmi'));
app.use('/api', require('./routes/stripe'));

// ============================================================
// Health check
// ============================================================

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
    elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY),
    smsProvider: Boolean(
      process.env.SMS_PROVIDER_URL &&
      process.env.SMS_PROVIDER_API_KEY
    ),
    paypal: Boolean(
      process.env.PAYPAL_CLIENT_ID &&
      process.env.PAYPAL_CLIENT_SECRET
    ),
    cmi: Boolean(
      process.env.CMI_STORE_ID &&
      process.env.CMI_STORE_KEY
    ),
    stripe: Boolean(
      process.env.STRIPE_SECRET_KEY &&
      process.env.STRIPE_WEBHOOK_SECRET
    ),
    bgutil: Boolean(bgutilProcess),
  });
});

// ============================================================
// Démarrage Express
// ============================================================

const server = app.listen(PORT, () => {
  console.log(
    `✅ AI Video Creator lancé sur http://localhost:${PORT}`
  );
});

// ============================================================
// Arrêt propre
// ============================================================

function shutdown(signal) {
  console.log(`🛑 Signal ${signal} reçu. Arrêt du serveur...`);

  if (bgutilProcess) {
    console.log('🛑 Arrêt de BgUtils...');
    bgutilProcess.kill('SIGTERM');
  }

  server.close(() => {
    console.log('✅ Serveur Express arrêté.');
    process.exit(0);
  });

  // Sécurité : forcer l'arrêt après 10 secondes
  setTimeout(() => {
    console.warn('⚠️ Arrêt forcé.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

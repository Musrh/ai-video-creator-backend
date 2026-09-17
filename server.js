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

// --- Webhook Stripe : DOIT être monté AVANT express.json(), avec son propre parseur
// "raw" (corps brut), car Stripe vérifie une signature calculée sur le corps non transformé.
// Si cette route passait après express.json(), la vérification de signature échouerait toujours.
app.post(
  '/api/payment/stripe/webhook',
  express.raw({ type: 'application/json' }),
  require('./routes/stripeWebhook')
);

// Le reste de l'API peut utiliser le parsing JSON/urlencoded classique
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
app.use('/api', require('./routes/otp'));
app.use('/api', require('./routes/paypal'));
app.use('/api', require('./routes/cmi'));
app.use('/api', require('./routes/stripe')); // /payment/stripe/create (le webhook est déjà monté plus haut)

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
    elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY),
    smsProvider: Boolean(process.env.SMS_PROVIDER_URL && process.env.SMS_PROVIDER_API_KEY),
    paypal: Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
    cmi: Boolean(process.env.CMI_STORE_ID && process.env.CMI_STORE_KEY),
    stripe: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET),
  });
});

app.listen(PORT, () => {
  console.log(`✅ AI Video Creator lancé sur http://localhost:${PORT}`);
});

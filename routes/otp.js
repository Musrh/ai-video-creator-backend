const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { signToken, verifyToken } = require('./authToken');

const router = express.Router();
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'otp-store.json');

const FREE_GENERATIONS = 2;
const CODE_TTL_MS = 5 * 60 * 1000; // le code expire après 5 minutes
const RESEND_COOLDOWN_MS = 60 * 1000; // 1 renvoi de code max par minute

// --- Stockage simple par fichier JSON ---
// ⚠️ Comme /uploads et /output, ce fichier est réinitialisé à chaque redéploiement Railway
// (stockage éphémère). Pour un vrai usage en production, migrez vers une vraie base de données
// (ex. Postgres via un plugin Railway) ou un Volume monté sur /data.
async function readStore() {
  await fs.ensureDir(DATA_DIR);
  await fs.ensureFile(STORE_PATH);
  try {
    const content = await fs.readFile(STORE_PATH, 'utf8');
    return content.trim() ? JSON.parse(content) : {};
  } catch {
    return {};
  }
}
async function writeStore(store) {
  await fs.ensureDir(DATA_DIR);
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2));
}

function normalizePhone(phone) {
  return String(phone || '').trim().replace(/[^\d+]/g, '');
}

function defaultEntry() {
  return {
    verified: false,
    freeUsed: 0,
    paidCredits: 0, // crédits vidéo-unique achetés, non encore consommés
    subscriptionUntil: null, // timestamp ms ; accès illimité tant que non expiré
  };
}

// --- Envoi du SMS ---
// ⚠️ À adapter selon la documentation de votre fournisseur SMS marocain retenu :
// l'endpoint, les en-têtes d'authentification et le format du corps de requête varient
// d'un fournisseur à l'autre. Ceci est un exemple générique (Bearer token + JSON), à ajuster.
async function sendSmsViaProvider(phone, message) {
  if (!process.env.SMS_PROVIDER_URL || !process.env.SMS_PROVIDER_API_KEY) {
    throw new Error('SMS_PROVIDER_URL / SMS_PROVIDER_API_KEY manquants dans .env');
  }
  await axios.post(
    process.env.SMS_PROVIDER_URL,
    { to: phone, message },
    { headers: { Authorization: `Bearer ${process.env.SMS_PROVIDER_API_KEY}`, 'content-type': 'application/json' } }
  );
}

// POST /api/otp/send — { phone } -> génère un code à 6 chiffres et l'envoie par SMS
router.post('/otp/send', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone || phone.length < 8) return res.status(400).json({ error: 'Numéro de téléphone invalide.' });

    const store = await readStore();
    const entry = store[phone] || defaultEntry();

    if (entry.lastSentAt && Date.now() - entry.lastSentAt < RESEND_COOLDOWN_MS) {
      return res.status(429).json({ error: 'Veuillez patienter avant de redemander un code.' });
    }

    const code = String(crypto.randomInt(100000, 999999));
    entry.codeHash = crypto.createHash('sha256').update(code).digest('hex');
    entry.codeExpiresAt = Date.now() + CODE_TTL_MS;
    entry.lastSentAt = Date.now();
    store[phone] = entry;
    await writeStore(store);

    await sendSmsViaProvider(phone, `Votre code de vérification AI Video Creator : ${code}`);

    res.json({ ok: true });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/otp/verify — { phone, code } -> valide le code, renvoie un jeton signé
router.post('/otp/verify', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const { code } = req.body;
    if (!phone || !code) return res.status(400).json({ error: 'Téléphone et code requis.' });

    const store = await readStore();
    const entry = store[phone];
    if (!entry || !entry.codeHash) return res.status(400).json({ error: 'Aucun code en attente pour ce numéro.' });
    if (Date.now() > entry.codeExpiresAt) return res.status(400).json({ error: 'Code expiré, redemandez-en un.' });

    const codeHash = crypto.createHash('sha256').update(String(code)).digest('hex');
    if (codeHash !== entry.codeHash) return res.status(400).json({ error: 'Code incorrect.' });

    entry.verified = true;
    entry.codeHash = null;
    entry.codeExpiresAt = null;
    store[phone] = entry;
    await writeStore(store);

    const token = signToken(phone);
    res.json({ ok: true, token });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

function computeQuotaView(entry) {
  const now = Date.now();
  const subscriptionActive = Boolean(entry.subscriptionUntil && entry.subscriptionUntil > now);
  return {
    freeUsed: entry.freeUsed || 0,
    freeRemaining: Math.max(0, FREE_GENERATIONS - (entry.freeUsed || 0)),
    paidCredits: entry.paidCredits || 0,
    subscriptionActive,
    subscriptionUntil: entry.subscriptionUntil || null,
  };
}

// GET /api/otp/status — header x-verify-token -> statut du quota pour ce numéro
router.get('/otp/status', async (req, res) => {
  try {
    const payload = verifyToken(req.headers['x-verify-token']);
    if (!payload) return res.status(401).json({ error: 'Non vérifié.' });

    const store = await readStore();
    const entry = store[payload.phone];
    if (!entry || !entry.verified) return res.status(401).json({ error: 'Non vérifié.' });

    res.json({ phone: payload.phone, ...computeQuotaView(entry) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Middleware réutilisé par les routes de génération vidéo (video.js) ---
// Bloque si le numéro n'est pas vérifié, ou si free + crédits payés + abonnement sont tous épuisés.
async function requireVerifiedQuota(req, res, next) {
  const payload = verifyToken(req.headers['x-verify-token']);
  if (!payload || !payload.phone) {
    return res.status(401).json({ error: 'Vérification par SMS requise.' });
  }
  const store = await readStore();
  const entry = store[payload.phone];
  if (!entry || !entry.verified) {
    return res.status(401).json({ error: 'Numéro non vérifié.' });
  }

  const view = computeQuotaView(entry);
  const hasAccess = view.freeRemaining > 0 || view.subscriptionActive || view.paidCredits > 0;
  if (!hasAccess) {
    return res.status(402).json({
      error: 'Quota gratuit épuisé. Le paiement est nécessaire pour continuer.',
      paymentRequired: true,
    });
  }
  req.verifiedPhone = payload.phone;
  next();
}

// Consomme un essai après une génération réussie, dans l'ordre : gratuit -> abonnement (illimité,
// rien à décrémenter) -> crédit payé à l'unité.
async function consumeFreeGeneration(phone) {
  if (!phone) return;
  const store = await readStore();
  const entry = store[phone];
  if (!entry) return;

  const view = computeQuotaView(entry);
  if (view.freeRemaining > 0) {
    entry.freeUsed = (entry.freeUsed || 0) + 1;
  } else if (view.subscriptionActive) {
    // rien à décrémenter : accès illimité jusqu'à expiration de l'abonnement
  } else if (view.paidCredits > 0) {
    entry.paidCredits = (entry.paidCredits || 0) - 1;
  }

  store[phone] = entry;
  await writeStore(store);
}

// Appelé par les modules de paiement (paypal.js / cmi.js) une fois un paiement confirmé.
async function markPaidSingle(phone, credits = 1) {
  const p = normalizePhone(phone);
  const store = await readStore();
  const entry = store[p] || defaultEntry();
  entry.paidCredits = (entry.paidCredits || 0) + credits;
  store[p] = entry;
  await writeStore(store);
}

async function markPaidSubscription(phone, days = 30) {
  const p = normalizePhone(phone);
  const store = await readStore();
  const entry = store[p] || defaultEntry();
  const now = Date.now();
  const base = entry.subscriptionUntil && entry.subscriptionUntil > now ? entry.subscriptionUntil : now;
  entry.subscriptionUntil = base + days * 24 * 60 * 60 * 1000;
  store[p] = entry;
  await writeStore(store);
}

module.exports = router;
module.exports.requireVerifiedQuota = requireVerifiedQuota;
module.exports.consumeFreeGeneration = consumeFreeGeneration;
module.exports.markPaidSingle = markPaidSingle;
module.exports.markPaidSubscription = markPaidSubscription;
module.exports.normalizePhone = normalizePhone;
module.exports.FREE_GENERATIONS = FREE_GENERATIONS;

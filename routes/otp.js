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
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Un identifiant vérifié est soit un numéro, soit un email — stocké dans le même magasin,
// sous une clé préfixée par son type pour éviter toute collision entre les deux ("phone:..."
// vs "email:..."). "type" doit être 'phone' ou 'email'.
function normalizeIdentifier(rawValue, type) {
  if (type === 'email') {
    const email = normalizeEmail(rawValue);
    return { key: `email:${email}`, value: email, valid: isValidEmail(email) };
  }
  const phone = normalizePhone(rawValue);
  return { key: `phone:${phone}`, value: phone, valid: phone.length >= 8 };
}

function defaultEntry(type, value) {
  return {
    type, // 'phone' | 'email'
    value,
    verified: false,
    freeUsed: 0,
    paidCredits: 0, // crédits vidéo-unique achetés, non encore consommés
    subscriptionUntil: null, // timestamp ms ; accès illimité tant que non expiré
  };
}

// --- Envoi du SMS ---
// ⚠️ À adapter selon la documentation de votre fournisseur SMS marocain retenu.
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

// --- Envoi de l'email (API HTTPS Brevo — PAS leur relais SMTP, qui serait bloqué sur Railway) ---
// ⚠️ Ne PAS utiliser smtp-relay.brevo.com ici : Railway bloque tous les ports SMTP sortants
// (25, 465, 587) sur les plans Free/Trial/Hobby. On utilise uniquement api.brevo.com, un appel
// HTTPS classique (port 443, jamais bloqué).
// Brevo ne demande de vérifier qu'UNE SEULE adresse email (code à 6 chiffres envoyé à cette
// adresse, pas de domaine requis) puis permet d'envoyer vers n'importe quel destinataire.
async function sendEmailViaProvider(email, code) {
  if (!process.env.BREVO_API_KEY || !process.env.EMAIL_FROM) {
    throw new Error('BREVO_API_KEY / EMAIL_FROM manquants dans .env');
  }
  await axios.post(
    'https://api.brevo.com/v3/smtp/email',
    {
      sender: { email: process.env.EMAIL_FROM },
      to: [{ email }],
      subject: 'Votre code de vérification AI Video Creator',
      htmlContent: `<p>Votre code de vérification est : <strong>${code}</strong></p><p>Il expire dans 5 minutes.</p>`,
    },
    { headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' } }
  );
}

// POST /api/otp/send — { identifier, type: 'phone' | 'email' }
router.post('/otp/send', async (req, res) => {
  try {
    const { type } = req.body;
    if (!['phone', 'email'].includes(type)) {
      return res.status(400).json({ error: 'Le champ "type" doit être "phone" ou "email".' });
    }
    const { key, value, valid } = normalizeIdentifier(req.body.identifier, type);
    if (!valid) {
      return res.status(400).json({ error: type === 'email' ? 'Email invalide.' : 'Numéro de téléphone invalide.' });
    }

    const store = await readStore();
    const entry = store[key] || defaultEntry(type, value);

    if (entry.lastSentAt && Date.now() - entry.lastSentAt < RESEND_COOLDOWN_MS) {
      return res.status(429).json({ error: 'Veuillez patienter avant de redemander un code.' });
    }

    const code = String(crypto.randomInt(100000, 999999));

    // On envoie D'ABORD le code, et on n'enregistre le hash + le délai anti-spam qu'une
    // fois l'envoi confirmé réussi — sinon un envoi en échec bloquerait les tentatives
    // suivantes pendant 60s pour rien.
    if (type === 'email') {
      await sendEmailViaProvider(value, code);
    } else {
      await sendSmsViaProvider(value, `Votre code de vérification AI Video Creator : ${code}`);
    }

    entry.codeHash = crypto.createHash('sha256').update(code).digest('hex');
    entry.codeExpiresAt = Date.now() + CODE_TTL_MS;
    entry.lastSentAt = Date.now();
    store[key] = entry;
    await writeStore(store);

    res.json({ ok: true });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/otp/verify — { identifier, type, code } -> valide le code, renvoie un jeton signé
router.post('/otp/verify', async (req, res) => {
  try {
    const { type, code } = req.body;
    if (!['phone', 'email'].includes(type)) {
      return res.status(400).json({ error: 'Le champ "type" doit être "phone" ou "email".' });
    }
    const { key, value, valid } = normalizeIdentifier(req.body.identifier, type);
    if (!valid || !code) return res.status(400).json({ error: 'Identifiant et code requis.' });

    const store = await readStore();
    const entry = store[key];
    if (!entry || !entry.codeHash) return res.status(400).json({ error: 'Aucun code en attente pour cet identifiant.' });
    if (Date.now() > entry.codeExpiresAt) return res.status(400).json({ error: 'Code expiré, redemandez-en un.' });

    const codeHash = crypto.createHash('sha256').update(String(code)).digest('hex');
    if (codeHash !== entry.codeHash) return res.status(400).json({ error: 'Code incorrect.' });

    entry.verified = true;
    entry.codeHash = null;
    entry.codeExpiresAt = null;
    store[key] = entry;
    await writeStore(store);

    const token = signToken(key);
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

// GET /api/otp/status — header x-verify-token -> statut du quota pour cet identifiant
router.get('/otp/status', async (req, res) => {
  try {
    const payload = verifyToken(req.headers['x-verify-token']);
    if (!payload) return res.status(401).json({ error: 'Non vérifié.' });

    const store = await readStore();
    const entry = store[payload.identifier];
    if (!entry || !entry.verified) return res.status(401).json({ error: 'Non vérifié.' });

    res.json({ identifier: entry.value, type: entry.type, ...computeQuotaView(entry) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/otp/debug-exhaust — header x-verify-token -> épuise artificiellement le quota
// gratuit de cet identifiant, pour tester le paywall/paiement sans consommer 2 vraies
// générations (donc sans dépenser Anthropic/ElevenLabs à chaque test).
// ⚠️ Désactivée par défaut : ne fonctionne que si ENABLE_DEBUG_ROUTES=true est présent dans
// .env. Retirez cette variable (ou mettez-la à autre chose) avant d'ouvrir l'app à de vrais
// visiteurs — cette route permet à n'importe qui de modifier SON PROPRE quota, sans affecter
// les autres, mais elle n'a aucune utilité une fois en production.
router.post('/otp/debug-exhaust', async (req, res) => {
  if (process.env.ENABLE_DEBUG_ROUTES !== 'true') {
    return res.status(404).json({ error: 'Route désactivée.' });
  }
  try {
    const payload = verifyToken(req.headers['x-verify-token']);
    if (!payload) return res.status(401).json({ error: 'Non vérifié.' });

    const store = await readStore();
    const entry = store[payload.identifier];
    if (!entry || !entry.verified) return res.status(401).json({ error: 'Non vérifié.' });

    entry.freeUsed = FREE_GENERATIONS;
    store[payload.identifier] = entry;
    await writeStore(store);

    res.json({ ok: true, ...computeQuotaView(entry) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Middleware réutilisé par les routes de génération vidéo (video.js) ---
async function requireVerifiedQuota(req, res, next) {
  const payload = verifyToken(req.headers['x-verify-token']);
  if (!payload || !payload.identifier) {
    return res.status(401).json({ error: 'Vérification requise.' });
  }
  const store = await readStore();
  const entry = store[payload.identifier];
  if (!entry || !entry.verified) {
    return res.status(401).json({ error: 'Identifiant non vérifié.' });
  }

  const view = computeQuotaView(entry);
  const hasAccess = view.freeRemaining > 0 || view.subscriptionActive || view.paidCredits > 0;
  if (!hasAccess) {
    return res.status(402).json({
      error: 'Quota gratuit épuisé. Le paiement est nécessaire pour continuer.',
      paymentRequired: true,
    });
  }
  req.verifiedKey = payload.identifier; // clé interne ("phone:..." ou "email:...")
  req.verifiedValue = entry.value; // valeur lisible (le numéro ou l'email)
  next();
}

// Consomme un essai après une génération réussie, dans l'ordre : gratuit -> abonnement
// (illimité, rien à décrémenter) -> crédit payé à l'unité. "key" = clé interne complète.
async function consumeFreeGeneration(key) {
  if (!key) return;
  const store = await readStore();
  const entry = store[key];
  if (!entry) return;

  const view = computeQuotaView(entry);
  if (view.freeRemaining > 0) {
    entry.freeUsed = (entry.freeUsed || 0) + 1;
  } else if (view.subscriptionActive) {
    // rien à décrémenter
  } else if (view.paidCredits > 0) {
    entry.paidCredits = (entry.paidCredits || 0) - 1;
  }

  store[key] = entry;
  await writeStore(store);
}

// Appelés par les modules de paiement une fois un paiement confirmé.
// "identifier" et "type" viennent des métadonnées enregistrées à la création du paiement.
async function markPaidSingle(identifier, type, credits = 1) {
  const { key, value } = normalizeIdentifier(identifier, type);
  const store = await readStore();
  const entry = store[key] || defaultEntry(type, value);
  entry.paidCredits = (entry.paidCredits || 0) + credits;
  store[key] = entry;
  await writeStore(store);
}

async function markPaidSubscription(identifier, type, days = 30) {
  const { key, value } = normalizeIdentifier(identifier, type);
  const store = await readStore();
  const entry = store[key] || defaultEntry(type, value);
  const now = Date.now();
  const base = entry.subscriptionUntil && entry.subscriptionUntil > now ? entry.subscriptionUntil : now;
  entry.subscriptionUntil = base + days * 24 * 60 * 60 * 1000;
  store[key] = entry;
  await writeStore(store);
}

module.exports = router;
module.exports.requireVerifiedQuota = requireVerifiedQuota;
module.exports.consumeFreeGeneration = consumeFreeGeneration;
module.exports.markPaidSingle = markPaidSingle;
module.exports.markPaidSubscription = markPaidSubscription;
module.exports.normalizeIdentifier = normalizeIdentifier;
module.exports.FREE_GENERATIONS = FREE_GENERATIONS;

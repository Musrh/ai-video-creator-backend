const express = require('express');
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { markPaidSingle, markPaidSubscription, normalizePhone } = require('./otp');

const router = express.Router();
const DATA_DIR = path.join(__dirname, '..', 'data');
const PENDING_PATH = path.join(DATA_DIR, 'cmi-pending.json');

// ⚠️⚠️ MODULE NON TESTÉ CONTRE UN VRAI COMPTE MARCHAND CMI ⚠️⚠️
// Ce fichier suit le schéma standard des passerelles CMI/PayFor au Maroc :
// redirection vers une page de paiement hébergée par CMI, paramètres transmis par
// formulaire POST, hash SHA512 (paramètres triés alphabétiquement + Store Key).
// MAIS les noms exacts des champs, leur ordre, l'algorithme de hash précis (ver1/ver2/ver3)
// et l'URL de la passerelle dépendent du "kit d'intégration" que CMI remet à l'affiliation
// marchand (accès à un environnement de test + documentation technique détaillée).
// => Une fois ce kit reçu, comparez chaque champ ci-dessous à leur documentation et ajustez.

const PRICE_SINGLE_MAD = process.env.PRICE_SINGLE_MAD || '20';
const PRICE_SUBSCRIPTION_MAD = process.env.PRICE_SUBSCRIPTION_MAD || '10';

async function readPending() {
  await fs.ensureDir(DATA_DIR);
  await fs.ensureFile(PENDING_PATH);
  try {
    const content = await fs.readFile(PENDING_PATH, 'utf8');
    return content.trim() ? JSON.parse(content) : {};
  } catch {
    return {};
  }
}
async function writePending(store) {
  await fs.writeFile(PENDING_PATH, JSON.stringify(store, null, 2));
}

// Hash SHA512(paramètres triés alphabétiquement, concaténés par "|", + Store Key), en base64.
// ⚠️ À vérifier précisément contre la doc CMI reçue (l'algorithme exact peut différer).
function computeHash(params, storeKey) {
  const sortedKeys = Object.keys(params).sort();
  const hashString = sortedKeys.map((k) => params[k]).join('|') + '|' + storeKey;
  return crypto.createHash('sha512').update(hashString, 'utf8').digest('base64');
}

// POST /api/payment/cmi/create — { phone, plan: 'single' | 'subscription' }
// Renvoie les paramètres à POSTer (via un vrai formulaire HTML, PAS un fetch) vers la page
// de paiement hébergée CMI — c'est une redirection de navigateur complète, pas un appel API.
router.post('/payment/cmi/create', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const { plan } = req.body;
    if (!phone || !['single', 'subscription'].includes(plan)) {
      return res.status(400).json({ error: 'Champs "phone" et "plan" ("single" ou "subscription") requis.' });
    }
    if (!process.env.CMI_STORE_ID || !process.env.CMI_STORE_KEY || !process.env.CMI_GATEWAY_URL || !process.env.CMI_RETURN_BASE_URL) {
      return res.status(500).json({
        error: 'CMI_STORE_ID / CMI_STORE_KEY / CMI_GATEWAY_URL / CMI_RETURN_BASE_URL manquants dans .env (fournis par CMI à l\'affiliation).',
      });
    }

    const amount = plan === 'single' ? PRICE_SINGLE_MAD : PRICE_SUBSCRIPTION_MAD;
    const oid = `oid_${Date.now()}`;
    const returnBase = process.env.CMI_RETURN_BASE_URL.replace(/\/$/, '');

    const params = {
      clientid: process.env.CMI_STORE_ID,
      oid,
      amount,
      currency: '504', // 504 = MAD (code ISO 4217 numérique), à confirmer dans la doc CMI
      okUrl: `${returnBase}/api/payment/cmi/callback`,
      failUrl: `${returnBase}/api/payment/cmi/callback`,
      rnd: String(Date.now()),
      storetype: '3d_pay_hosting',
      hashAlgorithm: 'ver3',
      lang: 'fr',
    };
    params.hash = computeHash(params, process.env.CMI_STORE_KEY);

    // Correspondance oid -> (phone, plan), lue au retour dans /callback
    const pending = await readPending();
    pending[oid] = { phone, plan, createdAt: Date.now() };
    await writePending(pending);

    res.json({ gatewayUrl: process.env.CMI_GATEWAY_URL, params });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payment/cmi/callback — CMI redirige ici (succès ou échec) après paiement.
// ⚠️ À COMPLÉTER : la vérification du hash retourné par CMI et les noms exacts des champs
// de la réponse (ex. "ProcReturnCode", "mdStatus", "Response"...) dépendent de leur doc.
// Ne JAMAIS déclarer un paiement validé sans avoir vérifié ce hash — sinon n'importe qui
// peut appeler cette URL manuellement pour se débloquer gratuitement.
router.post('/payment/cmi/callback', async (req, res) => {
  try {
    const { oid } = req.body;
    if (!oid) return res.status(400).send('oid manquant.');

    const pending = await readPending();
    const info = pending[oid];
    if (!info) return res.status(400).send('Commande inconnue.');

    // --- TODO avant mise en production ---
    // 1. Recalculer le hash attendu à partir de req.body + CMI_STORE_KEY et le comparer
    //    à req.body.hash (nom de champ exact à confirmer dans la doc CMI).
    // 2. Vérifier le code de statut de la transaction (ex. req.body.ProcReturnCode === '00').
    // Tant que ces deux vérifications ne sont pas en place, NE PAS activer cette route en prod.
    return res.status(501).send('Callback CMI à finaliser (vérification du hash) avant mise en production.');

    // Une fois les vérifications ci-dessus en place, décommentez :
    // if (info.plan === 'subscription') {
    //   await markPaidSubscription(info.phone, 30);
    // } else {
    //   await markPaidSingle(info.phone, 1);
    // }
    // delete pending[oid];
    // await writePending(pending);
    // const frontendUrl = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',')[0] : '/';
    // res.redirect(`${frontendUrl}?payment=success`);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Erreur serveur.');
  }
});

module.exports = router;

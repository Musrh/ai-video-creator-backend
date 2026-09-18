const express = require('express');
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { markPaidSingle, markPaidSubscription } = require('./otp');

const router = express.Router();
const DATA_DIR = path.join(__dirname, '..', 'data');
const PENDING_PATH = path.join(DATA_DIR, 'cmi-pending.json');

// ⚠️⚠️ MODULE NON TESTÉ CONTRE UN VRAI COMPTE MARCHAND CMI ⚠️⚠️
// Voir les commentaires détaillés plus bas — à finaliser une fois le kit d'intégration CMI reçu.

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

function computeHash(params, storeKey) {
  const sortedKeys = Object.keys(params).sort();
  const hashString = sortedKeys.map((k) => params[k]).join('|') + '|' + storeKey;
  return crypto.createHash('sha512').update(hashString, 'utf8').digest('base64');
}

// POST /api/payment/cmi/create — { identifier, type: 'phone'|'email', plan: 'single'|'subscription' }
router.post('/payment/cmi/create', async (req, res) => {
  try {
    const { identifier, type, plan } = req.body;
    if (!identifier || !['phone', 'email'].includes(type) || !['single', 'subscription'].includes(plan)) {
      return res.status(400).json({ error: 'Champs "identifier", "type" ("phone"|"email") et "plan" requis.' });
    }
    if (!process.env.CMI_STORE_ID || !process.env.CMI_STORE_KEY || !process.env.CMI_GATEWAY_URL || !process.env.CMI_RETURN_BASE_URL) {
      return res.status(500).json({
        error: 'CMI_STORE_ID / CMI_STORE_KEY / CMI_GATEWAY_URL / CMI_RETURN_BASE_URL manquants dans .env.',
      });
    }

    const amount = plan === 'single' ? PRICE_SINGLE_MAD : PRICE_SUBSCRIPTION_MAD;
    const oid = `oid_${Date.now()}`;
    const returnBase = process.env.CMI_RETURN_BASE_URL.replace(/\/$/, '');

    const params = {
      clientid: process.env.CMI_STORE_ID,
      oid,
      amount,
      currency: '504', // MAD, à confirmer dans la doc CMI
      okUrl: `${returnBase}/api/payment/cmi/callback`,
      failUrl: `${returnBase}/api/payment/cmi/callback`,
      rnd: String(Date.now()),
      storetype: '3d_pay_hosting',
      hashAlgorithm: 'ver3',
      lang: 'fr',
    };
    params.hash = computeHash(params, process.env.CMI_STORE_KEY);

    const pending = await readPending();
    pending[oid] = { identifier, type, plan, createdAt: Date.now() };
    await writePending(pending);

    res.json({ gatewayUrl: process.env.CMI_GATEWAY_URL, params });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payment/cmi/callback
// ⚠️ À COMPLÉTER : vérification du hash retourné par CMI avant de valider quoi que ce soit.
router.post('/payment/cmi/callback', async (req, res) => {
  try {
    const { oid } = req.body;
    if (!oid) return res.status(400).send('oid manquant.');

    const pending = await readPending();
    const info = pending[oid];
    if (!info) return res.status(400).send('Commande inconnue.');

    // --- TODO avant mise en production ---
    // 1. Recalculer le hash attendu à partir de req.body + CMI_STORE_KEY et le comparer.
    // 2. Vérifier le code de statut de la transaction.
    return res.status(501).send('Callback CMI à finaliser (vérification du hash) avant mise en production.');

    // Une fois les vérifications ci-dessus en place, décommentez :
    // if (info.plan === 'subscription') {
    //   await markPaidSubscription(info.identifier, info.type, 30);
    // } else {
    //   await markPaidSingle(info.identifier, info.type, 1);
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

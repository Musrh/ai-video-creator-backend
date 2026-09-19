const express = require('express');
const axios = require('axios');
const { markPaidSingle, markPaidSubscription } = require('./otp');

const router = express.Router();

const PAYPAL_API = process.env.PAYPAL_ENV === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

const PRICE_SINGLE_USD = process.env.PRICE_SINGLE_USD || '2.00';
const PRICE_SUBSCRIPTION_USD = process.env.PRICE_SUBSCRIPTION_USD || '1.00';

async function getAccessToken() {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET manquants dans .env');
  }
  const { data } = await axios.post(
    `${PAYPAL_API}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      auth: { username: process.env.PAYPAL_CLIENT_ID, password: process.env.PAYPAL_CLIENT_SECRET },
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }
  );
  return data.access_token;
}

function frontendUrl() {
  const raw = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.trim() : '';
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error(
      `FRONTEND_URL invalide ou manquant ("${raw}") — doit être l'URL complète de votre frontend (avec son sous-chemin GitHub Pages éventuel), ex. https://musrh.github.io/ai-video-creator-frontend`
    );
  }
  return raw.replace(/\/$/, '');
}

// POST /api/payment/paypal/create — { identifier, type: 'phone'|'email', plan: 'single'|'subscription' }
router.post('/payment/paypal/create', async (req, res) => {
  try {
    const { identifier, type, plan } = req.body;
    if (!identifier || !['phone', 'email'].includes(type) || !['single', 'subscription'].includes(plan)) {
      return res.status(400).json({ error: 'Champs "identifier", "type" ("phone"|"email") et "plan" requis.' });
    }
    if (!process.env.PAYPAL_RETURN_BASE_URL) {
      return res.status(500).json({ error: 'PAYPAL_RETURN_BASE_URL manquant dans .env (URL publique de ce backend).' });
    }

    const amount = plan === 'single' ? PRICE_SINGLE_USD : PRICE_SUBSCRIPTION_USD;
    const accessToken = await getAccessToken();
    const returnBase = process.env.PAYPAL_RETURN_BASE_URL.replace(/\/$/, '');

    const { data } = await axios.post(
      `${PAYPAL_API}/v2/checkout/orders`,
      {
        intent: 'CAPTURE',
        purchase_units: [
          {
            // Encodé dans custom_id, relu au retour pour savoir qui débloquer sur quelle formule
            custom_id: `${type}|${identifier}|${plan}`,
            amount: { currency_code: 'USD', value: amount },
            description: plan === 'single' ? 'AI Video Creator — 1 vidéo' : 'AI Video Creator — Abonnement mensuel',
          },
        ],
        application_context: {
          return_url: `${returnBase}/api/payment/paypal/capture`,
          cancel_url: `${returnBase}/api/payment/paypal/cancel`,
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
        },
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' } }
    );

    const approveLink = (data.links || []).find((l) => l.rel === 'approve');
    if (!approveLink) throw new Error('Lien d\'approbation PayPal introuvable dans la réponse.');

    res.json({ approveUrl: approveLink.href });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payment/paypal/capture — PayPal redirige ici après approbation (?token=ORDER_ID)
router.get('/payment/paypal/capture', async (req, res) => {
  try {
    const orderId = req.query.token;
    if (!orderId) return res.status(400).send('Paramètre "token" manquant.');

    const accessToken = await getAccessToken();
    const { data } = await axios.post(
      `${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`,
      {},
      { headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' } }
    );

    const status = data.status;
    const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
    const customId = capture?.custom_id || data.purchase_units?.[0]?.custom_id || '';
    const [type, identifier, plan] = customId.split('|');

    if (status === 'COMPLETED' && identifier) {
      if (plan === 'subscription') {
        await markPaidSubscription(identifier, type, 30);
      } else {
        await markPaidSingle(identifier, type, 1);
      }
      return res.redirect(`${frontendUrl()}?payment=success`);
    }

    res.redirect(`${frontendUrl()}?payment=failed`);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.redirect(`${frontendUrl()}?payment=error`);
  }
});

router.get('/payment/paypal/cancel', (req, res) => {
  res.redirect(`${frontendUrl()}?payment=cancelled`);
});

module.exports = router;

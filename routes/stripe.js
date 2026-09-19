const express = require('express');
const Stripe = require('stripe');

const router = express.Router();

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY manquant dans .env');
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

const PRICE_SINGLE_USD = process.env.PRICE_SINGLE_USD || '2.00';
const PRICE_SUBSCRIPTION_USD = process.env.PRICE_SUBSCRIPTION_USD || '1.00';

function frontendUrl() {
  const raw = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.trim() : '';
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error(
      `FRONTEND_URL invalide ou manquant ("${raw}") — doit être l'URL complète de votre frontend (avec son sous-chemin GitHub Pages éventuel), ex. https://musrh.github.io/ai-video-creator-frontend`
    );
  }
  return raw.replace(/\/$/, '');
}

// POST /api/payment/stripe/create — { identifier, type: 'phone'|'email', plan: 'single'|'subscription' }
router.post('/payment/stripe/create', async (req, res) => {
  try {
    const { identifier, type, plan } = req.body;
    if (!identifier || !['phone', 'email'].includes(type) || !['single', 'subscription'].includes(plan)) {
      return res.status(400).json({ error: 'Champs "identifier", "type" ("phone"|"email") et "plan" requis.' });
    }

    const stripe = getStripe();
    const amount = plan === 'single' ? PRICE_SINGLE_USD : PRICE_SUBSCRIPTION_USD;
    const amountCents = Math.round(parseFloat(amount) * 100);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: amountCents,
            product_data: {
              name: plan === 'single' ? 'AI Video Creator — 1 vidéo' : 'AI Video Creator — Abonnement mensuel (30 jours)',
            },
          },
          quantity: 1,
        },
      ],
      // Le webhook lit ces métadonnées pour savoir quel identifiant débloquer, sur quelle formule.
      metadata: { identifier, type, plan },
      success_url: `${frontendUrl()}?payment=success`,
      cancel_url: `${frontendUrl()}?payment=cancelled`,
    });

    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

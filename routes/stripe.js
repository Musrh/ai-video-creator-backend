const express = require('express');
const Stripe = require('stripe');
const { normalizePhone } = require('./otp');

const router = express.Router();

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY manquant dans .env');
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

// Prix modifiables à tout moment sans toucher au code (variables d'environnement Railway).
const PRICE_SINGLE_USD = process.env.PRICE_SINGLE_USD || '2.00';
const PRICE_SUBSCRIPTION_USD = process.env.PRICE_SUBSCRIPTION_USD || '1.00';

function frontendUrl() {
  return process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',')[0] : '/';
}

// POST /api/payment/stripe/create — { phone, plan: 'single' | 'subscription' }
// Crée une session Stripe Checkout et renvoie l'URL vers laquelle rediriger l'utilisateur.
// Note : les deux formules sont créées comme un paiement ponctuel ("mode: payment"), y compris
// l'abonnement mensuel (qui débloque 30 jours d'accès plutôt qu'un vrai abonnement Stripe
// récurrent) — plus simple à démarrer ; on pourra migrer vers "mode: subscription" plus tard
// si vous voulez un renouvellement automatique.
router.post('/payment/stripe/create', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const { plan } = req.body;
    if (!phone || !['single', 'subscription'].includes(plan)) {
      return res.status(400).json({ error: 'Champs "phone" et "plan" ("single" ou "subscription") requis.' });
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
      // Le webhook lit ces métadonnées pour savoir quel numéro débloquer, sur quelle formule.
      metadata: { phone, plan },
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

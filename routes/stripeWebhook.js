const Stripe = require('stripe');
const { markPaidSingle, markPaidSubscription } = require('./otp');

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY manquant dans .env');
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

// ⚠️ Ce handler doit être monté dans server.js AVANT express.json(), avec son propre
// middleware express.raw({ type: 'application/json' }) — Stripe exige le corps de requête
// BRUT (non parsé) pour recalculer et vérifier la signature. Si express.json() global
// a déjà consommé le corps avant d'arriver ici, la vérification échouera systématiquement.
module.exports = async function stripeWebhookHandler(req, res) {
  let stripe;
  try {
    stripe = getStripe();
  } catch (err) {
    console.error(err.message);
    return res.status(500).send('Configuration Stripe manquante.');
  }

  const sig = req.headers['stripe-signature'];
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('STRIPE_WEBHOOK_SECRET manquant dans .env');
    return res.status(500).send('Webhook secret manquant.');
  }

  let event;
  try {
    // req.body doit être un Buffer brut ici (voir express.raw() dans server.js)
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Signature Stripe invalide:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { phone, plan } = session.metadata || {};
    if (phone) {
      if (plan === 'subscription') {
        await markPaidSubscription(phone, 30);
      } else {
        await markPaidSingle(phone, 1);
      }
    } else {
      console.warn('Webhook Stripe reçu sans "phone" en métadonnée — impossible de débloquer un accès.');
    }
  }

  res.json({ received: true });
};

const crypto = require('crypto');

// Changez cette valeur via la variable d'environnement OTP_TOKEN_SECRET en production
// (sinon tous les jetons deviennent invalides à chaque redémarrage si vous changez le secret par défaut).
const SECRET = process.env.OTP_TOKEN_SECRET || 'change-me-in-env';

function signToken(phone) {
  const payload = JSON.stringify({ phone, iat: Date.now() });
  const b64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [b64, sig] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', SECRET).update(b64).digest('base64url');
  if (sig !== expectedSig) return null;
  try {
    return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')); // { phone, iat }
  } catch {
    return null;
  }
}

module.exports = { signToken, verifyToken };

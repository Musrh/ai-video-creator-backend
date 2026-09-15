const express = require('express');
const axios = require('axios');
const router = express.Router();

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
// Choisissez le modèle Anthropic adapté à votre usage/budget (voir docs.claude.com)
const MODEL = 'claude-sonnet-5';

async function callClaude(prompt, maxTokens = 1000) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY manquant dans .env');
  }
  const { data } = await axios.post(
    ANTHROPIC_URL,
    {
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    }
  );
  return data.content.map((b) => b.text || '').join('\n').trim();
}

// Génère description / mots-clés / hashtags + script de narration
async function generateVideoContent({ subject, sourceInfo }) {
  const prompt = `Tu es un expert en création de contenu vidéo pour réseaux sociaux.

Sujet demandé par l'utilisateur : "${subject}"
${sourceInfo ? `Informations extraites d'une vidéo source (transcription) :\n"""${sourceInfo.slice(0, 6000)}"""` : "Aucune vidéo source fournie, utilise tes connaissances générales."}

Réponds STRICTEMENT en JSON valide, sans texte avant/après, avec ce format :
{
  "script": "texte de narration pour la vidéo, 100 à 180 mots, clair et engageant",
  "description": "description optimisée pour la vidéo, 2 à 4 phrases",
  "keywords": ["mot-clé1", "mot-clé2", "..."],
  "hashtags": ["#exemple1", "#exemple2", "..."]
}`;

  const raw = await callClaude(prompt, 1200);
  const cleaned = raw.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Réponse IA non-JSON : ' + cleaned.slice(0, 200));
  }
}

// Génère description / mots-clés / hashtags "d'inspiration" à partir du contenu d'une vidéo source
// (indépendamment du sujet final) — sert de base éditable avant la génération de la vidéo.
async function generateInspiration({ transcript }) {
  const prompt = `Voici la transcription d'une vidéo source :
"""${(transcript || '').slice(0, 6000)}"""

À partir de ce contenu, propose, à titre d'inspiration (l'utilisateur pourra tout modifier) :
- une description courte de ce dont parle cette vidéo
- des mots-clés pertinents
- des hashtags pertinents

Réponds STRICTEMENT en JSON valide, sans texte avant/après :
{
  "description": "...",
  "keywords": ["...", "..."],
  "hashtags": ["#...", "#..."]
}`;

  const raw = await callClaude(prompt, 600);
  const cleaned = raw.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Réponse IA non-JSON : ' + cleaned.slice(0, 200));
  }
}

router.post('/generate-text', async (req, res) => {
  try {
    const { subject, sourceInfo } = req.body;
    if (!subject) return res.status(400).json({ error: 'Le champ "subject" est requis.' });
    const result = await generateVideoContent({ subject, sourceInfo });
    res.json(result);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.generateVideoContent = generateVideoContent;
module.exports.generateInspiration = generateInspiration;

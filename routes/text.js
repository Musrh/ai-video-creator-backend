const express = require('express');
const axios = require('axios');

const router = express.Router();

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5';

/**
 * ============================================================
 * APPEL API ANTHROPIC
 * ============================================================
 */
async function callClaude(prompt, maxTokens = 1000) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY manquant dans .env');
  }

  try {
    const response = await axios.post(
      ANTHROPIC_URL,
      {
        model: MODEL,
        max_tokens: maxTokens,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        timeout: 120000
      }
    );

    const data = response.data;

    if (!data || !Array.isArray(data.content)) {
      console.error('❌ Réponse Anthropic inattendue :', data);
      throw new Error('Réponse Anthropic invalide.');
    }

    const text = data.content
      .filter(block => block && block.type === 'text')
      .map(block => block.text || '')
      .join('\n')
      .trim();

    if (!text) {
      console.error('❌ Réponse Anthropic vide :', data);
      throw new Error('Réponse Anthropic vide.');
    }

    return text;

  } catch (err) {
    console.error(
      '❌ Erreur Anthropic :',
      err.response?.data || err.message
    );

    if (err.response?.data?.error?.message) {
      throw new Error(
        `Anthropic : ${err.response.data.error.message}`
      );
    }

    throw err;
  }
}


/**
 * ============================================================
 * EXTRACTION ROBUSTE DU JSON RETOURNÉ PAR CLAUDE
 * ============================================================
 *
 * Claude peut parfois retourner :
 *
 * {
 *   ...
 * }
 *
 * ou :
 *
 * ```json
 * {
 *   ...
 * }
 * ```
 *
 * ou :
 *
 * Voici le résultat :
 * {
 *   ...
 * }
 *
 * Cette fonction récupère automatiquement le JSON.
 */
function parseClaudeJSON(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Réponse IA vide ou invalide.');
  }

  let text = raw.trim();

  console.log('🤖 Réponse brute Claude :');
  console.log(text.slice(0, 3000));

  // ----------------------------------------------------------
  // Supprimer les blocs Markdown éventuels
  // ----------------------------------------------------------

  text = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // ----------------------------------------------------------
  // Tentative 1 : JSON direct
  // ----------------------------------------------------------

  try {
    return JSON.parse(text);
  } catch (_) {
    // On continue
  }

  // ----------------------------------------------------------
  // Tentative 2 : chercher un objet JSON {...}
  // ----------------------------------------------------------

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');

  if (
    firstBrace !== -1 &&
    lastBrace !== -1 &&
    lastBrace > firstBrace
  ) {
    const jsonCandidate = text.slice(
      firstBrace,
      lastBrace + 1
    );

    try {
      return JSON.parse(jsonCandidate);
    } catch (_) {
      // On continue
    }
  }

  // ----------------------------------------------------------
  // Tentative 3 : chercher un tableau JSON [...]
  // ----------------------------------------------------------

  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');

  if (
    firstBracket !== -1 &&
    lastBracket !== -1 &&
    lastBracket > firstBracket
  ) {
    const jsonCandidate = text.slice(
      firstBracket,
      lastBracket + 1
    );

    try {
      return JSON.parse(jsonCandidate);
    } catch (_) {
      // On continue
    }
  }

  // ----------------------------------------------------------
  // Impossible de récupérer le JSON
  // ----------------------------------------------------------

  console.error(
    '❌ Impossible de parser la réponse Claude :'
  );

  console.error(text.slice(0, 3000));

  throw new Error(
    'Réponse IA non-JSON : ' +
    text.slice(0, 500)
  );
}


/**
 * ============================================================
 * NORMALISATION DES DONNÉES D'INSPIRATION
 * ============================================================
 */
function normalizeInspiration(result) {
  return {
    description:
      typeof result.description === 'string'
        ? result.description.trim()
        : '',

    keywords:
      Array.isArray(result.keywords)
        ? result.keywords
            .filter(item => typeof item === 'string')
            .map(item => item.trim())
            .filter(Boolean)
        : [],

    hashtags:
      Array.isArray(result.hashtags)
        ? result.hashtags
            .filter(item => typeof item === 'string')
            .map(item => item.trim())
            .filter(Boolean)
        : []
  };
}


/**
 * ============================================================
 * GÉNÉRATION DU CONTENU VIDÉO
 * ============================================================
 */
async function generateVideoContent({
  subject,
  sourceInfo
}) {

  const prompt = `Tu es un expert en création de contenu vidéo pour les réseaux sociaux.

Sujet demandé par l'utilisateur :
"${subject}"

${
  sourceInfo
    ? `Informations extraites d'une vidéo source (transcription) :
"""
${sourceInfo.slice(0, 6000)}
"""`
    : 'Aucune vidéo source fournie. Utilise tes connaissances générales.'
}

IMPORTANT :

Ta réponse doit être UNIQUEMENT un objet JSON valide.

Ne mets :
- aucun texte avant le JSON
- aucun texte après le JSON
- aucun commentaire
- aucune explication
- aucun bloc Markdown
- aucun \`\`\`json

Utilise exactement cette structure :

{
  "script": "texte de narration pour la vidéo, 100 à 180 mots, clair et engageant",
  "description": "description optimisée pour la vidéo, 2 à 4 phrases",
  "keywords": ["mot-clé1", "mot-clé2", "mot-clé3"],
  "hashtags": ["#exemple1", "#exemple2", "#exemple3"]
}`;

  const raw = await callClaude(prompt, 1200);

  const result = parseClaudeJSON(raw);

  return {
    script:
      typeof result.script === 'string'
        ? result.script.trim()
        : '',

    description:
      typeof result.description === 'string'
        ? result.description.trim()
        : '',

    keywords:
      Array.isArray(result.keywords)
        ? result.keywords
            .filter(item => typeof item === 'string')
            .map(item => item.trim())
            .filter(Boolean)
        : [],

    hashtags:
      Array.isArray(result.hashtags)
        ? result.hashtags
            .filter(item => typeof item === 'string')
            .map(item => item.trim())
            .filter(Boolean)
        : []
  };
}


/**
 * ============================================================
 * GÉNÉRATION DE L'INSPIRATION À PARTIR DE LA TRANSCRIPTION
 * ============================================================
 */
async function generateInspiration({ transcript }) {

  const cleanTranscript = (transcript || '').slice(0, 6000);

  // Si aucune transcription n'est disponible,
  // on ne demande pas inutilement à Claude de générer du contenu.
  if (!cleanTranscript.trim()) {
    return {
      description: '',
      keywords: [],
      hashtags: []
    };
  }

  const prompt = `Voici la transcription d'une vidéo source :

"""
${cleanTranscript}
"""

À partir de cette transcription, propose, à titre d'inspiration
(l'utilisateur pourra tout modifier) :

1. Une description courte de ce dont parle cette vidéo.
2. Des mots-clés pertinents.
3. Des hashtags pertinents.

IMPORTANT :

Ta réponse doit être UNIQUEMENT un objet JSON valide.

Ne mets :
- aucun texte avant le JSON
- aucun texte après le JSON
- aucune explication
- aucun commentaire
- aucun bloc Markdown
- aucun \`\`\`json

Utilise exactement cette structure :

{
  "description": "description courte de la vidéo",
  "keywords": ["mot-clé1", "mot-clé2", "mot-clé3"],
  "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3"]
}`;

  const raw = await callClaude(prompt, 600);

  const result = parseClaudeJSON(raw);

  return normalizeInspiration(result);
}


/**
 * ============================================================
 * ROUTE /generate-text
 * ============================================================
 */
router.post('/generate-text', async (req, res) => {

  try {

    const {
      subject,
      sourceInfo
    } = req.body;

    if (!subject) {
      return res.status(400).json({
        error: 'Le champ "subject" est requis.'
      });
    }

    const result = await generateVideoContent({
      subject,
      sourceInfo
    });

    return res.json(result);

  } catch (err) {

    console.error(
      '❌ /generate-text :',
      err.response?.data || err.message
    );

    return res.status(500).json({
      error: err.message || 'Erreur génération IA.'
    });
  }
});


/**
 * ============================================================
 * EXPORTS
 * ============================================================
 */
module.exports = router;

module.exports.generateVideoContent =
  generateVideoContent;

module.exports.generateInspiration =
  generateInspiration;

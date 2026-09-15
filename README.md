# AI Video Creator — Backend (API)

API Node.js/Express qui génère script, description, mots-clés, hashtags (Claude), transcrit une vidéo source YouTube/TikTok/upload (yt-dlp + Whisper), synthétise/clone une voix (ElevenLabs) et assemble la vidéo finale (ffmpeg).

Ce dépôt est **l'API seule**. L'interface utilisateur vit dans un dépôt séparé : `ai-video-creator-frontend`.

## Variables d'environnement

Copiez `.env.example` en `.env` :

```
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
ELEVENLABS_API_KEY=...
CORS_ORIGIN=https://votre-frontend.vercel.app
```

`CORS_ORIGIN` doit lister l'URL (ou les URLs, séparées par des virgules) de votre frontend déployé, pour que le navigateur soit autorisé à appeler cette API. Laissez vide en développement local pour tout autoriser.

## Lancer en local

```bash
npm install
cp .env.example .env   # puis remplissez vos clés
npm start
```

API disponible sur `http://localhost:3000`. Testez avec `GET /api/health`.

## Déployer sur Railway

1. Poussez ce dépôt sur GitHub.
2. Sur [railway.app](https://railway.app) : **New Project → Deploy from GitHub repo** → sélectionnez ce dépôt.
3. Railway détecte Node.js automatiquement (`package.json`) et exécute `npm install` puis `npm start`.
4. Onglet **Variables** : ajoutez `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `CORS_ORIGIN` (mettez l'URL de votre frontend une fois déployé). Ne définissez pas `PORT`, Railway le fournit automatiquement.
5. **Settings → Networking → Generate Domain** pour obtenir une URL publique (ex: `https://ai-video-backend-production.up.railway.app`). C'est cette URL que vous collerez dans la config du frontend.

### Points d'attention

- **Stockage éphémère** : `uploads/` et `output/` sont réinitialisés à chaque redéploiement. Pour conserver les vidéos, ajoutez un Volume Railway monté sur `output/`, ou uploadez le résultat vers un stockage externe (S3, Cloudflare R2...).
- **Temps de traitement** : une génération complète (transcription + IA + TTS + ffmpeg) prend 1 à 2 minutes ; surveillez d'éventuels timeouts du proxy sur de grosses vidéos.
- **Ressources** : ffmpeg et yt-dlp sont gourmands en CPU/mémoire ; surveillez l'onglet Metrics et ajustez le plan Railway si nécessaire.

## Endpoints

| Endpoint | Rôle |
|---|---|
| `GET /api/health` | Vérifie que les clés API sont bien configurées |
| `GET /api/voices` | Liste des voix disponibles |
| `POST /api/voices/clone` | Clone une voix à partir d'un échantillon audio |
| `POST /api/analyze-source` | Transcrit une vidéo source (upload ou URL YouTube/TikTok/directe) et propose une description/mots-clés/hashtags d'inspiration |
| `POST /api/generate-video` | Génère script + contenu + narration + montage final |
| `POST /api/regenerate-voice` | Refait uniquement la narration + le montage avec une autre voix |
| `POST /api/generate-text` | Génère description/mots-clés/hashtags/script seuls (sans montage vidéo) |

Les fichiers générés (vidéo, audio) sont servis sous `/output/<nom-du-fichier>`.

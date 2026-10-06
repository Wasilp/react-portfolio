# e-signature

Portail public de signature électronique (Next.js 16). Le particulier reçoit un lien chiffré
`/sign/v1.<iv>.<données>.<tag>` (AES-256-GCM, clé partagée avec le backend), consulte le document, puis **l'accepte et le signe** (signature dessinée) ou
**le refuse**. Le portail n'a pas de base de données : il appelle un backend (Laravel) dont le
contrat est décrit dans **[docs/API.md](docs/API.md)**. Ce backend est **simulé** (mock) pour
l'instant.

Le design est volontairement minimal : le branding du client sera appliqué ensuite
(variables CSS dans `src/app/globals.css`).

## Démarrer

```bash
npm install
cp .env.example .env.local   # mock activé par défaut
npm run dev
```

1. Ouvrir http://localhost:3000/dev → « Créer une demande de signature » (PDF facultatif :
   sans fichier, un devis d'exemple est généré).
2. Cliquer sur le lien généré → signer ou refuser.
3. Revenir sur `/dev` : les webhooks émis par le mock apparaissent en bas.

Ou en ligne de commande :
```bash
curl -s -X POST localhost:3000/api/mock/v1/signature-requests \
  -H 'Content-Type: application/json' \
  -d '{"title":"Devis D-2026-0012","signer_name":"Jean Dupont","signer_email":"jean@example.com","external_ref":"quote:42"}'
# → { "id": "…", "token": "…", "signing_url": "http://localhost:3000/sign/…" }
```

## Ce qui est fait

- Lien chiffré et authentifié (AES-256-GCM) : un caractère modifié → « Lien invalide » ; expiration
  intégrée. Code PHP de génération dans [docs/API.md](docs/API.md) §2.
- Document téléchargé côté serveur depuis l'URL du lien (origines autorisées uniquement), hash
  vérifié avant affichage ; l'URL de stockage n'est jamais exposée au navigateur.
- Chaque appel au backend transporte le lien, qui vérifie qu'il correspond à la demande.
- Affichage du PDF avec pdf.js (fonctionne sur mobile, où les PDF en iframe ne s'affichent pas).
- Consentement obligatoire, nom, signature au doigt ou à la souris, bouton « Effacer ».
- Refus avec motif facultatif.
- États finaux : signé (avec téléchargement du PDF signé), refusé, expiré, annulé, lien invalide.
- Intégrité : le hash du document (issu du lien) est renvoyé à la signature ; le backend refuse si
  le document a changé.
- Le navigateur ne voit jamais le backend : appels côté serveur uniquement (Server Actions, proxy PDF).
- En-têtes `no-referrer`, `no-store`, `noindex` sur `/sign/*`.
- Mock du backend : stockage en mémoire, PDF signé avec page de certificat (hash, signataire,
  horodatage, IP, user-agent), webhooks signés HMAC.

## Structure

```
src/app/sign/[token]/      page, formulaire, zone de signature, viewer PDF, actions, proxys PDF
src/lib/link-token.ts      chiffrement / déchiffrement des liens
src/lib/document.ts        téléchargement + vérification du document
src/lib/signature-api/     contrat (schémas zod) + client serveur du backend
src/lib/mock/              backend simulé (store en mémoire, PDF, webhooks)
src/app/api/mock/v1/       routes HTTP du mock (même contrat que le backend réel)
src/app/dev/               console de dev (mock uniquement)
e2e/                       tests Playwright (desktop + mobile)
docs/API.md                contrat d'intégration : routes, payloads, erreurs, webhooks
```

## Scripts

| Commande | |
|---|---|
| `npm run dev` | serveur de dev |
| `npm run build` / `npm start` | production |
| `npm run lint` | ESLint |
| `npm run typecheck` | types des routes + `tsc` |
| `npm run test:e2e` | Playwright (build + start sur le port 3100, mock activé). Chromium déjà installé ailleurs : `PW_CHROMIUM_PATH=/chemin/vers/chromium npm run test:e2e` |

## Limites connues (mock)

- Les données sont en mémoire : elles disparaissent au redémarrage.
- Pas de limite de requêtes : à faire dans le backend réel (ou devant le portail).
- Signature électronique « simple » (eIDAS) : pas d'OTP ni de vérification d'identité.

# Contrat d'intégration — portail de signature

Ce portail Next.js est **uniquement le front public** : il reçoit un lien à jeton, affiche le
document, et laisse le particulier **accepter et signer** ou **refuser**. Toutes les données et
toutes les règles (statuts, expiration, hash, PDF signé, webhooks) vivent dans le **backend**
(Laravel). Ce document liste ce que le backend doit exposer pour que l'intégration soit un
simple changement de `SIGNATURE_API_URL`.

Un mock complet de ce contrat tourne dans le projet (`MOCK_API=true`, base `/api/mock`) :
c'est l'implémentation de référence (`src/lib/mock/store.ts`).

```
Laravel (app pro) ──1. crée la demande──► Backend signature ──2. renvoie signing_url
                                               ▲   │
            4. lit / signe / refuse (server)   │   │ 5. webhook signé HMAC
Particulier ──3. ouvre /sign/{token}──► Portail Next ┘   └──► Laravel (app pro)
```

## 1. Routes du portail (Next)

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/sign/{token}` | Page de signature. Affiche le document et le formulaire, ou l'état final (signé, refusé, expiré, annulé). 404 « Lien invalide » si le jeton est inconnu ou mal formé |
| POST | `/sign/{token}` (Server Action) | Signer : `signer_name`, `signature_png`, `consent`, `document_sha256` → backend `…/sign` |
| POST | `/sign/{token}` (Server Action) | Refuser : `reason` facultatif → backend `…/decline` |
| GET | `/sign/{token}/document` | Proxy du PDF original (`inline`) |
| GET | `/sign/{token}/signed` | Proxy du PDF signé (`attachment`) |
| GET | `/dev` | **Mock uniquement** : console pour créer un lien de test et voir les webhooks émis |

Le navigateur ne parle **jamais** au backend : toutes les requêtes passent par le serveur Next
(Server Components, Server Actions, route handlers). L'URL et la clé du backend restent côté serveur.

En-têtes sur `/sign/*` : `Referrer-Policy: no-referrer` (le jeton ne fuit pas vers des sites
tiers), `Cache-Control: no-store`, `X-Robots-Tag: noindex`.

## 2. Jeton (« URL encodée »)

- Généré par le backend : **32 octets aléatoires en base64url** (43 caractères), ex.
  `rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=')` (ou `Str::random(43)`).
- Opaque : il ne contient **aucune donnée** (pas d'id, pas d'email). Le portail vérifie juste
  son format (`^[A-Za-z0-9_-]{32,256}$`) avant d'appeler le backend.
- Le backend stocke **uniquement `sha256(token)`** et cherche par ce hash. Le jeton en clair
  n'existe que dans le lien envoyé au signataire.
- Révocable (annulation) et expirant (`expires_at`).

URL envoyée au particulier : `{PORTAL_URL}/sign/{token}`.

## 3. API que le backend doit exposer (appelée par le portail)

Base : `SIGNATURE_API_URL` (ex. `https://api.example.com`). Toutes les routes sont préfixées
par `/v1/public/signature-requests/{token}`.

En-têtes envoyés par le portail sur chaque appel :

| En-tête | Valeur |
|---|---|
| `Authorization` | `Bearer {SIGNATURE_API_KEY}` (identifie le portail ; à vérifier côté backend) |
| `X-Signer-Ip` | IP du particulier (pour l'audit) |
| `X-Signer-User-Agent` | User-agent du particulier (pour l'audit) |

### `GET /v1/public/signature-requests/{token}`
Renvoie la demande. **Le premier appel passe le statut de `pending` à `viewed`** (audit +
webhook `signature_request.viewed`). Une demande expirée est renvoyée avec `status: "expired"`.

```json
{
  "id": "9f1c…",
  "status": "viewed",
  "title": "Devis D-2026-0012",
  "message": "Bonjour, voici le devis pour votre installation.",
  "issuer": { "name": "SolarPro SRL", "logo_url": null },
  "signer": { "name": "Jean Dupont", "email": "jean.dupont@example.com" },
  "document": { "filename": "devis.pdf", "sha256": "1f19…e05", "size": 2381 },
  "expires_at": "2026-10-20T17:03:48.431Z",
  "signed_at": null,
  "declined_at": null,
  "decline_reason": null
}
```
`status` ∈ `pending | viewed | signed | declined | expired | canceled`.

### `GET /v1/public/signature-requests/{token}/document`
Le PDF original. `Content-Type: application/pdf`, `Content-Disposition: inline; filename="…"`.

### `POST /v1/public/signature-requests/{token}/sign`
```json
{
  "signer_name": "Jean Dupont",
  "signature_png": "data:image/png;base64,iVBOR…",
  "consent": true,
  "document_sha256": "1f19…e05"
}
```
Règles côté backend :
1. Statut `pending` ou `viewed`, sinon **409** (ou **410** si expiré).
2. `document_sha256` doit être égal au hash stocké, sinon **409 `document_changed`**.
3. Verrou de ligne (`lockForUpdate`) : deux soumissions simultanées → une seule signature.
4. Enregistrer l'audit (IP, user-agent, horodatage UTC, consentement), générer le PDF signé
   (original + signature apposée + page de certificat), passer à `signed`.
5. Après le commit : webhook `signature_request.signed`.

Réponse **200** : la demande mise à jour (même format que le GET).

### `POST /v1/public/signature-requests/{token}/decline`
```json
{ "reason": "Prix trop élevé" }
```
`reason` peut être `null`. Mêmes règles de statut. Réponse **200** : la demande mise à jour.
Webhook `signature_request.declined`.

### `GET /v1/public/signature-requests/{token}/signed-document`
Le PDF signé (`application/pdf`). **404 `not_signed`** tant que la demande n'est pas signée.

### Erreurs
Toujours sous la forme :
```json
{ "error": { "code": "expired", "message": "Ce lien a expiré." } }
```

| HTTP | `code` | Quand | Affichage portail |
|---|---|---|---|
| 404 | `not_found` | jeton inconnu | page « Lien invalide » |
| 410 | `expired` | lien expiré | page « Lien expiré » |
| 409 | `already_signed`, `already_declined`, `already_canceled` | action sur une demande finale | message du backend |
| 409 | `document_changed` | hash différent | « Le document a été modifié, rechargez » |
| 422 | `validation_failed` | payload invalide | « Vérifiez le formulaire » |

Le `message` des 404, 409 et 410 est montré tel quel au particulier : à rédiger en français.

## 4. Côté émetteur (app pro → backend), hors portail

Le portail n'en a pas besoin, mais l'app pro doit pouvoir créer une demande. Format du mock :

### `POST /v1/signature-requests` (auth : clé de l'app pro)
`multipart/form-data` ou JSON :

| Champ | Type | Note |
|---|---|---|
| `document` | PDF | facultatif dans le mock (un devis d'exemple est généré) |
| `title` | string | |
| `message` | string? | affiché au-dessus du document |
| `issuer_name` | string | nom du pro |
| `signer_name`, `signer_email` | string | |
| `external_ref` | string? | ex. `quote:42`, renvoyé dans les webhooks |
| `expires_in_days` | int | défaut 14 |

Réponse **201** :
```json
{ "id": "9f1c…", "token": "7mQ…", "signing_url": "https://sign.example.com/sign/7mQ…" }
```
Le jeton n'est renvoyé **qu'une fois**, à la création.

## 5. Webhooks (backend → app pro)

Événements : `signature_request.created`, `.viewed`, `.signed`, `.declined`, `.expired`
(+ `.canceled` côté backend réel).

```http
POST {webhook_url}
Content-Type: application/json
X-Esign-Event-Id: 2b7e…
X-Esign-Signature: t=1760000000,v1=<hex hmac_sha256(secret, t + "." + raw_body)>

{
  "id": "2b7e…",
  "type": "signature_request.signed",
  "created_at": "2026-10-06T17:03:49.322Z",
  "data": { "signature_request_id": "9f1c…", "external_ref": "quote:42", "status": "signed" }
}
```

Vérification côté Laravel :
```php
[$t, $v1] = [/* parse "t=…,v1=…" */];
abort_if(abs(time() - (int) $t) > 300, 400);                         // anti-rejeu
$expected = hash_hmac('sha256', $t.'.'.$request->getContent(), config('services.esign.webhook_secret'));
abort_unless(hash_equals($expected, $v1), 401);
// idempotence : ignorer un X-Esign-Event-Id déjà traité
```
Le PDF n'est pas dans le webhook : le récupérer via l'API (`signed-document`).

Dans le mock, chaque webhook est journalisé (console + `/dev` + `GET /api/mock/v1/events`) et
envoyé en vrai si `MOCK_WEBHOOK_URL` est défini (signé avec `MOCK_WEBHOOK_SECRET`).

## 6. Variables d'environnement du portail

| Variable | Rôle |
|---|---|
| `SIGNATURE_API_URL` | Base du backend (sans `/` final). Mock : `http://localhost:3000/api/mock` |
| `SIGNATURE_API_KEY` | Envoyée en `Bearer` au backend, côté serveur uniquement |
| `MOCK_API` | `true` active le mock et `/dev`. **Jamais en production** |
| `MOCK_WEBHOOK_URL` / `MOCK_WEBHOOK_SECRET` | Envoi réel des webhooks du mock |
| `PORTAL_URL` | Origine publique utilisée par le mock pour construire `signing_url` |

## 7. Checklist d'intégration (demain)

1. Implémenter les 5 routes publiques (§3) et la création (§4) dans Laravel. Le mock sert de
   référence ; les tests e2e (`npm run test:e2e`) décrivent le comportement attendu.
2. `SIGNATURE_API_URL` → Laravel, `MOCK_API=false`.
3. Brancher le webhook (§5) sur la mise à jour du devis (+ `action_confirm` Odoo, cf. spec 02).
4. Appliquer le branding : les couleurs sont des variables CSS dans `src/app/globals.css`, le
   logo peut venir de `issuer.logo_url`.

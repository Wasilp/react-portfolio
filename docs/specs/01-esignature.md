# Spec 01 — Service de signature électronique (standalone)

## 1. Objectif

Permettre à un pro d'envoyer n'importe quel document (devis, offre d'achat…) à un particulier
qui le signe depuis un **portail public**, sans compte. Le service est **agnostique du métier**
et **standalone** : il a sa propre base, ses propres routes publiques, et notifie l'émetteur
par **webhook**.

Pourquoi standalone :
- le portail est **public** (pas d'auth) → surface d'attaque isolée de l'app pro ;
- réutilisable par n'importe quel émetteur (l'app principale n'est qu'un client de l'API) ;
- cycle de vie propre (expiration, relances, archivage des preuves).

## 2. Périmètre

**MVP (P0)**
- API privée : créer / lire / annuler une demande de signature.
- Lien public à token opaque, expirant.
- Portail : affichage du PDF, consentement, signature dessinée (ou nom tapé), refus avec motif.
- Génération du PDF signé + page de preuve (audit trail).
- Webhooks sortants signés HMAC, avec retries.

**Hors MVP (P2, à mentionner)** : OTP email/SMS avant signature, signataires multiples
ordonnés, relances automatiques, champs positionnés dans le PDF, signature qualifiée (QES).

## 3. Stack

- Projet Laravel séparé : `esign-service/` (même monorepo possible, base séparée).
- Portail : Blade + Tailwind + [`signature_pad`](https://github.com/szimek/signature_pad) (JS),
  affichage PDF via `<iframe>`/`pdf.js`. Pas de Next ici : moins de pièces mobiles, vraiment autonome.
- PDF : `setasign/fpdi` (+ `tcpdf` ou `fpdf`) pour **ajouter** une page de signature au PDF
  source sans le re-rendre. Alternative : `barryvdh/laravel-dompdf` pour la page de preuve
  puis fusion FPDI.
- Queue : `database` driver (suffisant pour la démo) pour les webhooks.
- Stockage : disque `local` privé (`storage/app/private`), jamais `public`.

## 4. Modèle de données

```
clients                      -- émetteurs autorisés (l'app principale = 1 client)
  id, name, api_key_hash, webhook_secret (encrypted), default_webhook_url, timestamps

signature_requests
  id (ulid), client_id, external_ref (string, ex "quote:42"), title,
  status enum[pending, viewed, signed, declined, expired, canceled],
  document_path, document_sha256,
  signed_document_path nullable, signed_document_sha256 nullable,
  callback_url nullable (sinon default_webhook_url),
  expires_at, signed_at, declined_at, decline_reason nullable,
  metadata json nullable,   -- renvoyé tel quel dans les webhooks
  timestamps

signers
  id, signature_request_id, name, email,
  token_hash (sha256, unique), token_last_used_at,
  signature_image_path nullable, typed_name nullable,
  status enum[pending, viewed, signed, declined], timestamps

audit_events                 -- append-only, jamais modifié
  id, signature_request_id, signer_id nullable,
  type (created, email_sent, viewed, consent_given, signed, declined, expired, canceled,
        webhook_delivered, webhook_failed),
  ip, user_agent, payload json, created_at

webhook_deliveries
  id (ulid = event id), signature_request_id, event, url, payload json,
  attempts, last_status_code, last_error, delivered_at nullable, next_attempt_at
```

Machine d'états (toute autre transition → 409) :
```
pending → viewed → signed
pending|viewed → declined | expired | canceled
```

## 5. API privée (émetteurs)

Auth : `Authorization: Bearer <api_key>` (clé générée par `php artisan esign:client:create`,
seul le hash est stocké). JSON partout. Idempotence : header `Idempotency-Key` sur la création.

### `POST /api/v1/signature-requests` (multipart)
| champ | type | note |
|---|---|---|
| `document` | file PDF | ≤ 10 Mo, mime vérifié |
| `title` | string | affiché sur le portail |
| `external_ref` | string | ex. `quote:42` — sert à l'émetteur pour retrouver son objet |
| `signers[0][name]`, `signers[0][email]` | string | MVP : 1 signataire |
| `expires_in_days` | int | défaut 14 |
| `callback_url` | url | optionnel |
| `send_email` | bool | défaut `true` ; `false` si l'émetteur envoie lui-même le lien (ex. via Odoo) |
| `metadata` | json | optionnel, renvoyé dans les webhooks |

Réponse `201` :
```json
{
  "id": "01J…",
  "status": "pending",
  "expires_at": "2026-10-21T10:00:00Z",
  "signers": [{ "id": 1, "email": "jean@ex.be", "signing_url": "https://sign.example.test/s/7mQ…" }]
}
```
> `signing_url` n'est renvoyé **qu'à la création** (le token clair n'est jamais stocké).

### `GET /api/v1/signature-requests/{id}` → statut + signers (sans token) + liens de téléchargement.
### `GET /api/v1/signature-requests/{id}/document?version=original|signed` → PDF.
### `POST /api/v1/signature-requests/{id}/cancel` → `canceled` + webhook.

## 6. URLs publiques & tokens (« encoder les URLs »)

- Token = `Str::random(48)` (ou `random_bytes(32)` en base64url) → **opaque**, non devinable,
  ne contient aucune donnée métier (pas d'id séquentiel, pas d'email).
- En base : `hash('sha256', $token)` uniquement. Lookup par hash → pas de timing attack sur l'id.
- URL : `https://<esign-host>/s/{token}`.
- Contrôles à chaque hit : request existe, non expirée (`expires_at`), statut ∈ {pending, viewed}.
  Sinon page « lien expiré / déjà signé » (pas de 404 bavard).
- Rate limit sur `/s/*` (ex. 30 req/min/IP), `noindex`, `Referrer-Policy: no-referrer`
  (évite la fuite du token via Referer), `Cache-Control: no-store`.
- Alternative envisagée et écartée : `URL::temporarySignedRoute` de Laravel — simple, mais le
  lien n'est pas révocable individuellement et embarque l'id. Le token haché est meilleur ici.

## 7. Portail public

Pages (Blade) :
1. `GET /s/{token}` — titre, émetteur, aperçu PDF, bouton « Télécharger ».
   1er affichage → `status=viewed`, audit `viewed`, webhook `signature_request.viewed`.
2. Formulaire de signature (même page) :
   - case obligatoire « J'ai lu et j'accepte le document ci-dessus » ;
   - nom complet (pré-rempli, modifiable) ;
   - canvas `signature_pad` (export PNG base64) **ou** onglet « taper mon nom » ;
   - `POST /s/{token}/sign` (CSRF).
3. `POST /s/{token}/decline` avec motif optionnel.
4. Page de confirmation + lien de téléchargement du PDF signé (valable tant que le token est valide).

À la signature (dans une transaction + lock `lockForUpdate` sur la request) :
1. Revérifier le statut (double-clic / deux onglets → un seul `signed`).
2. Vérifier que `sha256(document)` == `document_sha256` (le document n'a pas bougé).
3. Stocker l'image de signature, audit `consent_given` + `signed` (IP, UA, horodatage UTC).
4. Générer le PDF signé : PDF original + **page de preuve** contenant : titre, id de la demande,
   hash SHA-256 de l'original, nom/email du signataire, image de signature, date/heure UTC,
   IP, user-agent, chronologie des audit events.
5. Calculer `signed_document_sha256`, `status=signed`, `signed_at`.
6. Dispatcher le webhook `signature_request.signed` (après commit : `afterCommit()`).
7. Email de confirmation au signataire avec le PDF signé en PJ.

Accessibilité / mobile : le canvas doit fonctionner au doigt (la plupart des particuliers
signeront sur téléphone) ; bouton « Effacer » ; signature vide refusée côté serveur.

## 8. Webhooks sortants

Événements : `signature_request.viewed`, `.signed`, `.declined`, `.expired`, `.canceled`.

Payload :
```json
{
  "id": "01J…",                        // id de l'événement (= webhook_deliveries.id) → idempotence
  "type": "signature_request.signed",
  "created_at": "2026-10-07T14:03:11Z",
  "data": {
    "signature_request_id": "01J…",
    "external_ref": "quote:42",
    "status": "signed",
    "signed_at": "2026-10-07T14:03:10Z",
    "signer": { "name": "Jean Dupont", "email": "jean@ex.be" },
    "signed_document_sha256": "…",
    "metadata": { "company_id": 3 }
  }
}
```
Le PDF n'est **pas** dans le payload : l'émetteur le récupère via l'API (§5).

Signature HMAC (style Stripe) :
```
X-Esign-Signature: t=1760000000,v1=<hex(hmac_sha256(secret, t + "." + raw_body))>
X-Esign-Event-Id: 01J…
```
Côté récepteur : recalculer sur le **corps brut**, comparer avec `hash_equals`, rejeter si
`|now - t| > 300 s` (anti-rejeu), ignorer un `event id` déjà traité.

Livraison : job `DeliverWebhook` en queue, timeout 10 s, succès = 2xx. Retries :
`$backoff = [10, 60, 300, 1800, 7200]` (5 tentatives), puis `failed` + audit `webhook_failed`.
Commande `php artisan esign:webhooks:retry {id}` pour rejouer à la main.

Expiration : commande planifiée `esign:expire` (toutes les heures) → `expired` + webhook.

## 9. Côté app principale (client du service)

- `ESignClient` (Http facade) : `create(Signable $doc)`, `get($id)`, `download($id, $version)`.
- Table `signature_requests` locale : `id`, `signable_type`, `signable_id` (**morphTo**),
  `esign_id`, `status`, `signing_url` (chiffrée), `signed_pdf_path`, timestamps.
- Route `POST /webhooks/esign` (hors CSRF, hors auth) → middleware `VerifyEsignSignature`
  → job `HandleEsignEvent` :
  - retrouve la request locale via `esign_id` (ou `external_ref`) ;
  - met à jour le statut ; sur `signed` : télécharge le PDF signé, puis
    `$request->signable->onSigned($result)` → pour un `Quote` : `sale.order.action_confirm`
    dans Odoo + PDF signé attaché au devis (cf. spec 02 §7.3) ;
  - répond `200` vite (le traitement lourd est en queue).
- Front : badge de statut (Brouillon / Envoyé / Vu / Signé / Refusé / Expiré), polling léger
  ou refresh à l'ouverture du dossier (pas besoin de websockets pour la démo).

## 10. Sécurité & conformité (à savoir défendre à l'oral)

- Signature électronique **simple** (eIDAS art. 3.10) : valeur probante reposant sur l'audit
  trail (identification par email, horodatage, hash du document, intégrité). Suffisant pour
  un devis/une offre ; pour un compromis de vente immobilier, une SES reste admissible mais
  une AES/QES (itsme, eID) serait plus robuste → piste d'évolution.
- Intégrité : hash SHA-256 de l'original stocké à la création, recontrôlé à la signature,
  imprimé sur la page de preuve.
- Données perso : PDFs en stockage privé, téléchargement uniquement via API authentifiée ou
  token valide ; purge planifiable.
- Secrets : api keys hachées, webhook secret chiffré (`encrypted` cast).

## 11. Tests (Pest)

- Création : 201, token renvoyé une seule fois, hash stocké, PDF hash correct.
- Token invalide / expiré / déjà signé → page adéquate, aucune mutation.
- Double signature concurrente → un seul `signed`, un seul webhook.
- Signature vide / sans consentement → 422.
- Webhook : HMAC vérifiable avec le secret ; retries sur 500 (`Http::fake` séquence) ; idempotence côté récepteur.
- Transition interdite (signer une request `canceled`) → 409.

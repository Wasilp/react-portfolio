# Contrat d'intégration — portail de signature

Ce portail Next.js est **uniquement le front public** : il reçoit un **lien chiffré**, affiche le
document, et laisse le particulier **accepter et signer** ou **refuser**. Les données vivantes
(statut, audit, PDF signé, webhooks) sont dans le **backend** (Laravel). Pour intégrer, il suffit
que le backend :
1. génère le lien chiffré (§2) ;
2. expose 4 routes (§3) ;
3. envoie ses webhooks à l'app pro (§5).

Un mock complet tourne dans le projet (`MOCK_API=true`, base `/api/mock`) : c'est
l'implémentation de référence (`src/lib/mock/store.ts`), et `/dev` génère des liens de test.

```
Laravel ──1. génère le lien chiffré (clé partagée)──► e-mail au particulier
Particulier ──2. ouvre /sign/v1.…──► Portail Next ──3. déchiffre, vérifie, télécharge le PDF (URL dans le lien)
                                          │
                                          └──4. view / sign / decline (+ lien en en-tête)──► Laravel ──5. webhook
```

## 1. Routes du portail (Next)

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/sign/{lien}` | Page de signature. Déchiffre le lien, appelle `view`, affiche le document et le formulaire ou l'état final. « Lien invalide » si le lien est altéré, « Lien expiré » après `exp` |
| POST | `/sign/{lien}` (Server Action) | Signer → backend `sign` |
| POST | `/sign/{lien}` (Server Action) | Refuser → backend `decline` |
| GET | `/sign/{lien}/document` | PDF original : téléchargé côté serveur depuis `document.url`, hash vérifié, servi `inline` |
| GET | `/sign/{lien}/signed` | PDF signé, relayé depuis le backend (`attachment`) |
| GET | `/dev` | **Mock uniquement** : crée un lien de test, liste les webhooks émis |

Le navigateur ne parle **jamais** au backend ni au stockage : tout passe par le serveur Next.
En-têtes sur `/sign/*` : `Referrer-Policy: no-referrer`, `Cache-Control: no-store`,
`X-Robots-Tag: noindex`.

## 2. Le lien chiffré (« URL encodée »)

```
{PORTAL_URL}/sign/v1.<iv>.<ciphertext>.<tag>
```
- **AES-256-GCM**, clé de 32 octets partagée entre Laravel et le portail (`ESIGN_LINK_KEY`,
  en base64 ; générer avec `openssl rand -base64 32`).
- `iv` : 12 octets aléatoires ; `tag` : 16 octets ; AAD fixe : `esign.v1`. Chaque partie est
  en **base64url** sans `=` → le lien est utilisable tel quel dans une URL.
- **Confidentialité** : l'e-mail du signataire et l'URL du document ne sont pas lisibles.
- **Intégrité** : un seul caractère modifié → le tag ne correspond plus → « Lien invalide ».
- **Expiration** : champ `exp` dans le contenu, vérifié par le portail ET par le backend.

### Contenu (JSON avant chiffrement)
```json
{
  "v": 1,
  "rid": "9f1c2d4e-…",
  "iat": 1760000000,
  "exp": 1761209600,
  "title": "Devis D-2026-0012",
  "message": "Bonjour, voici le devis pour votre installation.",
  "issuer": { "name": "SolarPro SRL", "logo_url": null },
  "signer": { "name": "Jean Dupont", "email": "jean.dupont@example.com" },
  "document": {
    "url": "https://bucket.s3.eu-west-1.amazonaws.com/quotes/42.pdf?X-Amz-…",
    "filename": "devis-D-2026-0012.pdf",
    "sha256": "1f197e52e44633dc4606f3eff842f57b20576e68ec9a9964ab6264e1e39a8e05"
  }
}
```
| Champ | Règle |
|---|---|
| `rid` | id de la demande côté backend (≤ 100 car.) |
| `exp`, `iat` | secondes Unix |
| `document.url` | doit avoir une origine listée dans `DOCUMENT_ALLOWED_ORIGINS` du portail (anti-SSRF). Une URL S3 pré-signée doit rester valide **jusqu'à `exp`** |
| `document.sha256` | hash hexadécimal du PDF ; le portail refuse d'afficher un fichier différent |

### Côté Laravel (vérifié : un lien généré par ce code est bien lu par le portail)
```php
// app/Support/EsignLink.php
final class EsignLink
{
    private const AAD = 'esign.v1';

    public static function make(array $payload): string
    {
        $iv = random_bytes(12);
        $ct = openssl_encrypt(
            json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
            'aes-256-gcm', self::key(), OPENSSL_RAW_DATA, $iv, $tag, self::AAD, 16,
        );
        return 'v1.'.self::b64($iv).'.'.self::b64($ct).'.'.self::b64($tag);
    }

    /** Pour vérifier l'en-tête X-Signature-Link (§3). Null si altéré. */
    public static function decode(string $link): ?array
    {
        $parts = explode('.', $link);
        if (count($parts) !== 4 || $parts[0] !== 'v1') return null;
        [, $iv, $ct, $tag] = $parts;
        $json = openssl_decrypt(self::unb64($ct), 'aes-256-gcm', self::key(), OPENSSL_RAW_DATA,
            self::unb64($iv), self::unb64($tag), self::AAD);
        return $json === false ? null : json_decode($json, true);
    }

    private static function key(): string { return base64_decode(config('services.esign.link_key')); }
    private static function b64(string $s): string { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }
    private static function unb64(string $s): string { return base64_decode(strtr($s, '-_', '+/')); }
}

// Utilisation
$url = config('services.esign.portal_url').'/sign/'.EsignLink::make([
    'v' => 1, 'rid' => $request->id, 'iat' => now()->timestamp, 'exp' => now()->addDays(14)->timestamp,
    'title' => $quote->title, 'message' => null,
    'issuer' => ['name' => $company->name, 'logo_url' => null],
    'signer' => ['name' => $client->name, 'email' => $client->email],
    'document' => [
        'url' => Storage::temporaryUrl($path, now()->addDays(14)),
        'filename' => 'devis.pdf',
        'sha256' => hash('sha256', Storage::get($path)),
    ],
]);
```

## 3. API que le backend doit exposer (appelée par le portail)

Base : `SIGNATURE_API_URL`. Préfixe : `/v1/signature-requests/{rid}`.

En-têtes envoyés par le portail sur **chaque** appel :

| En-tête | Valeur | À faire côté backend |
|---|---|---|
| `Authorization` | `Bearer {SIGNATURE_API_KEY}` | vérifier → sinon **401** |
| `X-Signature-Link` | le lien chiffré complet | `EsignLink::decode()` et vérifier que `rid` = `{rid}` de l'URL → sinon **403 `link_mismatch`** |
| `X-Signer-Ip` | IP du particulier | stocker dans l'audit |
| `X-Signer-User-Agent` | user-agent du particulier | stocker dans l'audit |

La vérification du lien empêche quiconque possède la clé API mais pas le lien (ou le lien d'une
autre demande) d'agir sur une demande.

Réponse commune (état vivant de la demande) :
```json
{
  "id": "9f1c2d4e-…",
  "status": "viewed",
  "signed_at": null,
  "declined_at": null,
  "decline_reason": null
}
```
`status` ∈ `pending | viewed | signed | declined | expired | canceled`.

### `POST /v1/signature-requests/{rid}/view`
Appelé à chaque ouverture de la page. **Le premier appel passe `pending` → `viewed`** (audit +
webhook `signature_request.viewed`), les suivants ne changent rien. Renvoie l'état.

### `POST /v1/signature-requests/{rid}/sign`
```json
{
  "signer_name": "Jean Dupont",
  "signature_png": "data:image/png;base64,iVBOR…",
  "consent": true,
  "document_sha256": "1f19…e05"
}
```
`document_sha256` vient du lien authentifié (pas du formulaire). Règles :
1. Statut `pending` ou `viewed`, sinon **409 `already_<statut>`** ; **410 `expired`** si expiré.
2. `document_sha256` = hash stocké, sinon **409 `document_changed`**.
3. Verrou de ligne (`lockForUpdate`) : deux soumissions simultanées → une seule signature.
4. Audit (IP, user-agent, horodatage UTC, consentement), génération du PDF signé (original +
   signature apposée + page de certificat), statut `signed`.
5. Après le commit : webhook `signature_request.signed`.

Réponse **200** : l'état mis à jour.

### `POST /v1/signature-requests/{rid}/decline`
```json
{ "reason": "Prix trop élevé" }
```
`reason` peut être `null` (≤ 1000 car.). Mêmes règles de statut. **200** + webhook
`signature_request.declined`.

### `GET /v1/signature-requests/{rid}/signed-document`
Le PDF signé (`application/pdf`, `Content-Disposition: attachment; filename="…"`).
**404 `not_signed`** tant que la demande n'est pas signée. Accepté aussi avec un lien expiré
(le signataire doit pouvoir retélécharger sa copie).

### Erreurs
Toujours sous la forme :
```json
{ "error": { "code": "expired", "message": "Ce lien a expiré." } }
```

| HTTP | `code` | Quand | Affichage portail |
|---|---|---|---|
| 401 | `unauthorized` | mauvaise clé API | erreur générique |
| 403 | `link_mismatch` | lien absent, altéré ou d'une autre demande | « Lien invalide » |
| 404 | `not_found` | `rid` inconnu | « Lien invalide » |
| 410 | `expired` | demande expirée | « Lien expiré » |
| 409 | `already_signed`, `already_declined`, `already_canceled` | action sur une demande terminée | message du backend |
| 409 | `document_changed` | hash différent | « Le document a été modifié, rechargez » |
| 422 | `validation_failed` | payload invalide | « Vérifiez le formulaire » |

Les `message` des 403, 404, 409 et 410 sont montrés tels quels au particulier : à rédiger en français.

## 4. Création d'une demande (app pro → backend)

Hors portail, c'est interne à Laravel : créer la ligne `signature_requests`, stocker le PDF et
son hash, puis générer le lien (§2) et l'envoyer par e-mail. Le mock expose l'équivalent pour les
tests : `POST /api/mock/v1/signature-requests` (JSON ou multipart avec `document`), qui renvoie
```json
{ "id": "9f1c…", "token": "v1.…", "signing_url": "http://localhost:3000/sign/v1.…" }
```
Champs : `title`, `message`, `issuer_name`, `signer_name`, `signer_email`, `external_ref`
(ex. `quote:42`), `expires_in_days` (défaut 14), `document` (PDF, facultatif dans le mock).

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
Si le backend de signature et l'app pro sont la même application Laravel, ces « webhooks »
peuvent être de simples events/listeners internes : le format reste utile si le service est
séparé plus tard.

Dans le mock, chaque webhook est journalisé (console, `/dev`, `GET /api/mock/v1/events`) et
envoyé en vrai si `MOCK_WEBHOOK_URL` est défini (signé avec `MOCK_WEBHOOK_SECRET`).

## 6. Variables d'environnement du portail

| Variable | Rôle |
|---|---|
| `ESIGN_LINK_KEY` | Clé AES-256 partagée avec Laravel (32 octets en base64). **Différente en production** |
| `DOCUMENT_ALLOWED_ORIGINS` | Origines autorisées pour `document.url`, séparées par des virgules (ex. `https://bucket.s3.eu-west-1.amazonaws.com`) |
| `SIGNATURE_API_URL` | Base du backend (sans `/` final). Mock : `http://localhost:3000/api/mock` |
| `SIGNATURE_API_KEY` | Envoyée en `Bearer` au backend, côté serveur uniquement |
| `MOCK_API` | `true` active le mock et `/dev`. **Jamais en production** |
| `MOCK_WEBHOOK_URL` / `MOCK_WEBHOOK_SECRET` | Envoi réel des webhooks du mock |
| `PORTAL_URL` | Origine publique, utilisée par le mock pour construire les liens |

## 7. Checklist d'intégration

1. Partager `ESIGN_LINK_KEY` entre Laravel (`services.esign.link_key`) et le portail.
2. Laravel : `EsignLink` (§2), les 4 routes (§3) avec vérification clé API + lien, le PDF signé.
   Le mock et les tests e2e (`npm run test:e2e`) décrivent le comportement attendu.
3. Portail : `SIGNATURE_API_URL` → Laravel, `DOCUMENT_ALLOWED_ORIGINS` → stockage, `MOCK_API=false`.
4. Brancher les webhooks (§5) sur la mise à jour du devis (+ `action_confirm` Odoo, cf. spec 02).
5. Branding : variables CSS dans `src/app/globals.css`, logo via `issuer.logo_url`.

# Specs — Devis polymorphiques, e-signature & intégration Odoo

> Contexte : test technique. Front **Next.js**, back **Laravel** (+ Laravel AI SDK).
> Produit : outil de génération de leads. Un *dossier lead* contient des infos pré-remplies,
> l'utilisateur pro complète le reste, produit un document commercial (devis, offre…),
> l'enregistre dans Odoo, l'envoie, et le particulier le signe en ligne.

| Spec | Fichier | Rôle |
|---|---|---|
| 01 | [`01-esignature.md`](./01-esignature.md) | Service de signature électronique standalone (portail public, URLs à token, webhooks) |
| 02 | [`02-odoo-integration.md`](./02-odoo-integration.md) | Branchement Odoo : clients, inventaire/produits, devis, envoi |

---

## 1. Le « polymorphisme » métier

Le même produit doit servir des métiers très différents :

| Vertical | Document | Source des lignes | Passe par Odoo ? |
|---|---|---|---|
| Énergie (panneaux solaires, PAC…) | **Devis** simple (lignes produit × qté × prix, TVA) | Inventaire Odoo | ✅ `sale.order` |
| Immobilier | **Offre d'achat** (bien, prix offert, conditions suspensives, date de validité) | Champs libres | ❌ local uniquement |
| (futur) Travaux, services… | Devis / bon de commande | Odoo ou local | au choix |

Deux niveaux de polymorphisme, à ne pas mélanger :

1. **Polymorphisme de document (côté back)** — tout document signable implémente un contrat commun :
   ```php
   interface Signable {
       public function signableTitle(): string;          // "Devis D-2026-0012"
       public function signers(): array;                 // [{name, email}]
       public function renderPdf(): string;              // binaire PDF (vertical-specific)
       public function onSigned(SignatureResult $r): void; // ex: confirmer le sale.order dans Odoo
       public function onDeclined(SignatureResult $r): void;
   }
   ```
   Les modèles `Quote`, `RealEstateOffer`, … implémentent `Signable`, et la table
   `signature_requests` (côté app principale) pointe dessus via une relation `morphTo`
   (`signable_type`, `signable_id`).

2. **Polymorphisme de formulaire (côté front)** — chaque *vertical* déclare son schéma de champs
   (JSON : `key`, `label`, `type`, `required`, `prefilledFrom: "lead.xxx"`). Le front Next rend
   le formulaire du dossier lead à partir de ce schéma → pas un composant par métier.
   Le tenant (`companies.vertical`) détermine le schéma et le type de document créé.

Le **service de signature ne connaît aucun métier** : il reçoit un PDF + des signataires + une
URL de callback. C'est ce qui le rend réutilisable et standalone.

## 2. Architecture cible

```
┌────────────── Next.js (front pro) ──────────────┐
│ Dossier lead → formulaire (schéma du vertical)  │
│ [Enregistrer]  [Envoyer pour signature]         │
└──────────────┬──────────────────────────────────┘
               │ REST (Sanctum)
┌──────────────▼──────────── Laravel (app principale) ─────────────┐
│ Leads, Quotes/Offers (Signable), SignatureRequest (morphTo)      │
│ OdooClient ──────────────► Odoo (partners, products, sale.order) │
│ ESignClient ──────────┐                                          │
│ POST /webhooks/esign ◄┼──────────── (HMAC) ──────────┐           │
└───────────────────────┼──────────────────────────────┼───────────┘
                        │ API key                      │
┌───────────────────────▼──── Laravel (service e-sign standalone) ─┐
│ API: créer / lire / annuler une demande                          │
│ Portail public  /s/{token}  → voir PDF, signer, refuser          │
│ PDF final + page de preuve (audit trail), webhooks sortants      │
└──────────────────────────────────────────────────────────────────┘
                        ▲
                Particulier (lien reçu par email)
```

## 3. Faisabilité en une journée — mon avis

**Faisable en MVP, si on coupe intelligemment.** Ce qui fait peur, ce n'est pas le code,
c'est l'accès à l'API Odoo (voir §4 de la spec 02 : **l'API externe n'est pas incluse
dans les plans Odoo Online "One App Free"/"Standard"**). Plan B prévu : Odoo 19 Community
en Docker en local → gratuit, API complète, seedable, démo reproductible.

| Bloc | Estimation | Priorité |
|---|---|---|
| Odoo en Docker + seed (produits, stock, clients) | 1 h | P0 |
| `OdooClient` + Enregistrer (partner + sale.order) | 1 h 30 | P0 |
| Service e-sign : API + token + portail + signature canvas | 2 h 30 | P0 |
| PDF final + audit trail + webhook HMAC + retries | 1 h 30 | P0 |
| Réception webhook → statut devis + `action_confirm` Odoo | 45 min | P0 |
| Envoi via Odoo (mail du devis) | 45 min | P1 |
| Vertical immobilier (2e schéma, offre locale) pour démontrer le polymorphisme | 1 h | P1 |
| OTP email avant signature, relances, expiration auto | 1 h+ | P2 (à mentionner, pas à faire) |

≈ 8–9 h de P0+P1 → tenable en parallélisant 2–3 sessions Claude (cf. §5).
Si ça glisse : sacrifier P1 « envoi via Odoo » (on envoie le lien de signature nous-mêmes)
avant de sacrifier la qualité du webhook (c'est ce qu'un reviewer regardera).

## 4. Hypothèses (à corriger si faux)

- Le back est **multi-tenant léger** : une `company` = un client pro, avec son `vertical`
  et ses identifiants Odoo (chiffrés via `encrypted` cast).
- Une instance Odoo par company (en démo : une seule).
- Signature « simple » au sens eIDAS (SES) : suffisante pour un devis/offre ; pas de
  signature qualifiée ni de certificat.
- Emails en local via **Mailpit** (docker) pour voir les mails sans les envoyer.
- Le Laravel AI SDK est **optionnel** ici : bon candidat pour pré-remplir les lignes du devis
  à partir des notes du lead (« 12 panneaux, toiture sud, 6 kWc ») → suggestion de lignes
  produits Odoo. À garder en bonus si le reste est fini.

## 5. Découpage en sessions Claude (à lancer demain)

Chaque session reçoit la spec concernée en contexte. Ordre conseillé :

1. **Session A — Infra Odoo** : « Implémente §3 et §6 de `docs/specs/02-odoo-integration.md` :
   docker-compose Odoo 19 + Postgres + Mailpit, création de la base, commande
   `php artisan odoo:seed` idempotente. »
2. **Session B — Service e-sign** (en parallèle de A) : « Implémente `docs/specs/01-esignature.md`
   sections 3 à 7 dans un nouveau projet Laravel `esign-service/`, tests Pest inclus. »
3. **Session C — Wiring app principale** (après A) : « Implémente §5 et §7 de la spec 02
   (OdooClient, Enregistrer, Envoyer) puis §8 de la spec 01 (ESignClient + réception webhook). »
4. **Session D — Front** (après C, ou en parallèle avec des mocks) : formulaire piloté par
   schéma, boutons Enregistrer / Envoyer pour signature, badge de statut.

Definition of Done globale (= script de démo) :
1. Ouvrir un lead « panneaux solaires », compléter, ajouter 3 lignes depuis l'inventaire Odoo.
2. Enregistrer → le devis apparaît en *Quotation* dans Odoo avec le bon client.
3. Envoyer pour signature → mail visible dans Mailpit avec le lien.
4. Ouvrir le lien (navigation privée), signer.
5. Le devis passe *Signé* dans l'app et *Sales Order* (confirmé) dans Odoo ; PDF signé téléchargeable.
6. Refaire la même chose avec un lead « immobilier » → offre locale, même flux de signature.

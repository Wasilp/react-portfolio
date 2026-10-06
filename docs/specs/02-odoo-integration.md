# Spec 02 — Intégration Odoo (inventaire, clients, devis, envoi)

## 1. Objectif

L'outil de leads devient le **poste de saisie** ; **Odoo reste le système de référence**
pour le catalogue, le stock, les clients et les devis.

Flux cible :
1. Le pro ouvre un dossier lead (infos pré-remplies : nom, email, adresse, besoin…).
2. Il complète les champs manquants et ajoute des lignes en piochant dans **l'inventaire Odoo**
   (recherche produit, prix catalogue, stock disponible affiché).
3. **Enregistrer** → upsert du client (`res.partner`) + création/mise à jour du devis
   (`sale.order` en état *Quotation*) dans Odoo.
4. **Envoyer** → soit via notre service e-sign (spec 01), soit via l'email natif d'Odoo.
5. **Signé** (webhook e-sign) → le devis est confirmé dans Odoo (`action_confirm`) et le PDF
   signé est attaché au devis.

## 2. Réponses aux questions de départ

**« Odoo, c'est du MCP ? des API ? »**
- Odoo expose une **API externe** sur tous ses modèles (`res.partner`, `product.product`,
  `sale.order`…). Tout ce que tu vois dans l'UI est appelable : `search_read`, `create`,
  `write`, et les boutons métier (`action_confirm`, …).
- Depuis **Odoo 19**, l'API recommandée est **JSON-2** : `POST /json/2/<model>/<method>` avec
  une **API key** en `Authorization: bearer …`. L'ancien XML-RPC/JSON-RPC (`/xmlrpc/2/*`,
  `/jsonrpc`) marche encore mais est déprécié.
- **MCP** : Odoo n'est pas « un MCP » nativement. Il existe des serveurs MCP communautaires qui
  enveloppent cette même API. Utile **pour toi en dev** (laisser Claude explorer les modèles,
  vérifier un champ, seeder), **pas** pour l'app : le back Laravel doit appeler l'API
  directement (déterministe, testable, pas de LLM dans la boucle d'un enregistrement).

**« J'ai pris Inventaire et Facturation, c'est bon ? »**
- ⚠️ Il manque **Ventes** (`sale_management`) : c'est lui qui porte les **devis**
  (`sale.order`). La Facturation seule ne fait que des factures (`account.move`).
  Apps à installer : **Ventes**, **Inventaire**, **Facturation** (+ localisation belge/française
  pour la TVA).

## 3. ⚠️ Risque n°1 : accès API sur Odoo Online

La doc officielle indique que **l'API externe n'est disponible que sur les plans « Custom »**,
pas sur « One App Free » ni « Standard ». Un compte d'essai peut fonctionner temporairement,
mais il ne faut pas parier la démo dessus.

**Décision recommandée : Odoo 19 Community en Docker, en local.**
Gratuit, API complète, base jetable et reseedable, démo identique chez le recruteur.
Le compte Odoo Online reste utile pour montrer l'UI / explorer, et le code est le même
(seuls `ODOO_URL`, `ODOO_DB`, `ODOO_API_KEY` changent).

Test de 2 minutes à faire **en premier demain** sur ton compte Online :
```bash
curl -s -X POST "https://<ton-instance>.odoo.com/json/2/res.partner/search_read" \
  -H "Authorization: bearer $ODOO_API_KEY" \
  -H "X-Odoo-Database: <ton-instance>" \
  -H "Content-Type: application/json" \
  -d '{"domain": [], "fields": ["name"], "limit": 1}'
```
Réponse JSON avec un partenaire → l'Online est utilisable. Erreur d'accès → Docker.
(API key : avatar → *Mon profil / Préférences* → *Sécurité du compte* → *Nouvelle clé API*.)

### docker-compose (à ajouter au projet)
```yaml
services:
  odoo-db:
    image: postgres:16
    environment: { POSTGRES_USER: odoo, POSTGRES_PASSWORD: odoo, POSTGRES_DB: postgres }
    volumes: [odoo-db:/var/lib/postgresql/data]
  odoo:
    image: odoo:19
    depends_on: [odoo-db]
    ports: ["8069:8069"]
    environment: { HOST: odoo-db, USER: odoo, PASSWORD: odoo }
    volumes: [odoo-data:/var/lib/odoo]
  mailpit:
    image: axllent/mailpit
    ports: ["8025:8025", "1025:1025"]   # UI : http://localhost:8025
volumes: { odoo-db: {}, odoo-data: {} }
```
Initialisation (une fois) :
```bash
docker compose run --rm odoo odoo -d leads_demo \
  -i sale_management,stock,account,l10n_be --stop-after-init
```
Puis dans l'UI (`http://localhost:8069`, admin/admin) : générer une API key pour l'admin,
configurer le serveur SMTP sortant → `mailpit:1025` (Paramètres → Technique → Serveurs de messagerie
sortants ; activer le mode développeur). Vérifier le flag des données de démo avec
`odoo --help` (on n'en veut pas : on seed nous-mêmes).

## 4. Modèles Odoo utilisés

| Besoin | Modèle | Champs utiles |
|---|---|---|
| Client | `res.partner` | `name`, `email`, `phone`, `street`, `zip`, `city`, `country_id`, `vat`, `is_company` |
| Catalogue | `product.product` (variantes) / `product.template` | `name`, `default_code`, `list_price`, `taxes_id`, `uom_id`, `categ_id`, `type`, `is_storable`, `qty_available`, `virtual_available` |
| Stock | `stock.quant` | `product_id`, `location_id`, `inventory_quantity` |
| Devis | `sale.order` | `name` (S00012), `partner_id`, `order_line`, `validity_date`, `client_order_ref`, `note`, `state` (`draft`/`sent`/`sale`/`cancel`), `amount_untaxed`, `amount_tax`, `amount_total`, `require_signature` |
| Lignes | `sale.order.line` | `product_id`, `product_uom_qty`, `price_unit`, `discount`, `name`, `tax_id` |
| PJ | `ir.attachment` | `name`, `datas` (base64), `res_model`, `res_id`, `mimetype` |

Les lignes s'écrivent avec les *commands* Odoo dans `order_line` :
`[0, 0, {vals}]` créer · `[1, id, {vals}]` modifier · `[2, id, 0]` supprimer · `[5, 0, 0]` tout vider.

## 5. Client Laravel

Pas de dépendance nécessaire : la facade `Http` suffit.

```php
// app/Services/Odoo/OdooClient.php
final class OdooClient
{
    public function __construct(private string $url, private string $db, private string $apiKey) {}

    public static function forCompany(Company $c): self
    {
        return new self($c->odoo_url, $c->odoo_db, $c->odoo_api_key); // api key: cast 'encrypted'
    }

    /** @throws OdooException */
    public function call(string $model, string $method, array $params = []): mixed
    {
        $res = Http::baseUrl($this->url)
            ->withToken($this->apiKey, 'bearer')
            ->withHeaders(['X-Odoo-Database' => $this->db])
            ->acceptJson()->timeout(15)
            ->post("/json/2/{$model}/{$method}", $params + ['context' => ['lang' => 'fr_BE']]);

        if ($res->failed()) {
            throw OdooException::fromResponse($res); // body: {name, message, arguments, debug}
        }
        return $res->json();
    }

    public function searchRead(string $model, array $domain, array $fields, int $limit = 80): array
    {
        return $this->call($model, 'search_read', compact('domain', 'fields', 'limit'));
    }
    public function create(string $model, array $vals): int
    {
        return $this->call($model, 'create', ['vals_list' => [$vals]])[0];
    }
    public function write(string $model, array $ids, array $vals): bool
    {
        return $this->call($model, 'write', compact('ids', 'vals'));
    }
}
```

- Les noms de paramètres JSON-2 correspondent aux **arguments nommés** de la méthode Python
  (`domain`, `fields`, `vals_list`, `ids`, `vals`…). En cas de doute, regarder la signature
  dans le code Odoo ou la doc « External JSON-2 API ».
- Méthodes privées (préfixe `_`) **non appelables** de l'extérieur.
- Couche au-dessus : `OdooPartnerRepository`, `OdooProductRepository`, `OdooQuoteRepository`
  → le reste de l'app ne manipule jamais de tableaux Odoo bruts (DTOs).
- Tests : `Http::fake()` avec des réponses JSON enregistrées depuis l'instance Docker.
- Plan B si une instance < 19 : implémenter la même interface en JSON-RPC
  (`POST /jsonrpc`, `service: object`, `method: execute_kw`). Interface `OdooTransport`.

## 6. Seed (`php artisan odoo:seed`, idempotent via `default_code` / email)

Vertical **énergie** — prix fictifs, HTVA :

| Réf | Produit | Type | Prix | Stock |
|---|---|---|---|---|
| PV-430 | Panneau photovoltaïque 430 Wc monocristallin | stockable | 185 € | 240 |
| PV-FIX-T | Kit de fixation toiture tuiles (par panneau) | stockable | 42 € | 300 |
| INV-H6 | Onduleur hybride 6 kW | stockable | 1 450 € | 12 |
| INV-MICRO | Micro-onduleur 400 W | stockable | 155 € | 80 |
| BAT-5 | Batterie domestique 5 kWh | stockable | 2 300 € | 6 |
| EV-7 | Borne de recharge 7,4 kW | stockable | 890 € | 9 |
| ELEC-KIT | Câblage, protections AC/DC (forfait) | consommable | 350 € | — |
| SRV-POSE | Pose et mise en service (forfait) | service | 1 200 € | — |
| SRV-H | Main d'œuvre (heure) | service | 55 € | — |

+ catégorie `Énergie / Photovoltaïque`, 3 clients particuliers fictifs, 1 devis exemple.

Stock : créer un `stock.quant` (`product_id`, `location_id` = stock principal,
`inventory_quantity`) puis appeler `action_apply_inventory` sur ses ids
(contexte `inventory_mode: true`). **À valider sur l'instance** (le nom du champ
« stockable » a changé : `is_storable` depuis la v18).

## 7. Comportements de l'app

### 7.1 Modèle local
```
quotes  (implements Signable)
  id, company_id, lead_id, status enum[draft, saved, sent, viewed, signed, declined, expired],
  odoo_partner_id, odoo_order_id, odoo_order_name, lines json (cache),
  amount_untaxed, amount_total, last_synced_at, sync_error nullable, timestamps
```
Répartition des rôles : **Odoo = vérité** pour produits, prix, stock, numéro et totaux
(TVA calculée par Odoo). L'app = brouillon d'édition + statut de signature.

### 7.2 Endpoints (back → front Next)
- `GET  /api/odoo/products?q=` → `search_read` sur `product.product`
  (`sale_ok = true`, `name ilike q` ou `default_code ilike q`), cache 60 s,
  renvoie prix, unité, `qty_available`. Le front affiche un warning si qté > stock (pas bloquant).
- `POST /api/leads/{lead}/quote` (**Enregistrer**), dans un job synchrone court :
  1. Validation (schéma du vertical, ≥ 1 ligne, email client).
  2. Partner : recherche par `email` → `write` si trouvé, sinon `create`.
  3. Devis : si `odoo_order_id` null → `create` `sale.order` avec
     `order_line: [[0,0,{…}], …]`, `client_order_ref: "LEAD-{id}"`, `require_signature: false`
     (c'est notre service e-sign qui signe, pas le portail Odoo).
     Sinon, si `state` ∈ {draft, sent} → `write` avec `[[5,0,0], [0,0,{…}]…]`.
     Si `state = sale` → 409 « devis déjà confirmé ».
  4. Relire `name`, `amount_*`, `state` → mettre à jour le cache local.
  5. Erreur Odoo → rien n'est perdu localement, `sync_error` rempli, message clair au front.
- `POST /api/quotes/{quote}/send` (**Envoyer**) :
  - `channel=esign` (défaut, P0) : PDF → service e-sign (spec 01 §9).
    PDF : rendu par notre back (template Blade par vertical, à partir des données relues
    d'Odoo). Plus simple et plus maîtrisé que télécharger le rapport PDF d'Odoo, dont la
    route `/report/pdf/…` demande une session web et pas une API key.
  - `channel=odoo` (P1) : email natif Odoo. Appeler `action_quotation_send` sur le devis →
    renvoie une *action* dont le `context` contient les valeurs par défaut du wizard ;
    créer un `mail.compose.message` avec ce contexte puis appeler `action_send_mail`.
    Effets : mail avec PDF Odoo, trace dans le chatter, devis passe en `sent`.
    Fallback plus simple : `mail.template.send_mail` (template « Ventes : envoi de devis »)
    + marquer le devis envoyé. **À valider sur l'instance** (le MCP Odoo aide ici).

### 7.3 Retour de signature (déclenché par le webhook, spec 01 §9)
`Quote::onSigned()` :
1. `sale.order.action_confirm` (`ids: [odoo_order_id]`) → devis → bon de commande ; Odoo
   réserve le stock (livraison créée par Inventaire).
2. `ir.attachment.create` avec le PDF signé (base64) lié au `sale.order`, puis
   `message_post` sur le devis (« Signé électroniquement par X le … », `attachment_ids`).
3. Statut local `signed`.
Chaque appel est idempotent côté app (vérifier `state` avant `action_confirm`).
`Quote::onDeclined()` : note dans le chatter, statut local `declined` (on ne cancel pas).

### 7.4 Hors MVP
- Facture depuis le bon de commande (wizard `sale.advance.payment.inv`).
- Sync Odoo → app (devis modifié directement dans Odoo) : règle d'automatisation Odoo
  « Envoyer une notification webhook » vers notre back.
- Création d'un `crm.lead` Odoo en miroir du dossier lead.
- Laravel AI SDK : suggestion de lignes produits à partir des notes du lead
  (outil = `searchProducts`, sortie structurée = lignes proposées, validées par l'humain).

## 8. Erreurs & robustesse

- Timeout 15 s, retry uniquement sur lectures (`search_read`), jamais sur `create`
  (risque de doublon) → pour les créations, on retrouve l'existant par
  `client_order_ref` avant de recréer.
- Erreurs Odoo (`ValidationError`, `AccessError`, `MissingError`) mappées en messages
  lisibles ; log du `debug` côté serveur seulement.
- Credentials Odoo par company, chiffrés en base ; jamais exposés au front.

## 9. Tests

- Unit (`Http::fake`) : mapping lead → partner vals, lignes → commands, upsert partner
  (trouvé / pas trouvé), devis déjà confirmé → 409, erreur Odoo → `sync_error`.
- Intégration (optionnelle, `@group odoo`, contre le Docker seedé) : Enregistrer crée bien un
  `sale.order` lisible avec le bon total ; `onSigned` passe `state` à `sale`.

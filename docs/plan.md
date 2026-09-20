# plan.md — pi-jev-router : mesurer, borner, durcir

Source de la mission : `Obsidian/Nexus/dev/ia/jev/jev router improve 1.md`
État du dépôt au moment du plan : un seul `index.ts` (720 lignes), 2 commits, mode shadow par défaut.
Config utilisateur actuelle : **mode `act`**.

## Constat (mesuré, pas deviné)

Session réelle du 20/09, act mode, 62 tours (log `~/.pi/agent/jev-router/log.jsonl`) :

- Décisions : `pass: 61, handled_local: 1` → **1.6 % des tours évitaient le gros modèle**
- Routes : reasoning 27, clarify 24, small_task 8, no_llm 3 — les jugements étaient *corrects*
  (les small_task passés étaient des « oui / yep » ; les clarify de l'anaphore), mais il n'y avait
  presque rien à router.
- Latence Jev p50/p95 : 428/843 ms — ajoutée à ~98 % des tours sans bénéfice.
- Le `/jev:stats` affiché (104 routés) mélangeait la session de dev shadow de la veille (43
  entrées) avec la session réelle : sur-interprétation garantie. Le log ne distingue ni jour ni
  session, et `/jev:stats` n'agrège pas par mode.
- Trous vérifiés dans le code : garde `routing` qui **ignore silencieusement** les entrées pendant
  un appel Jev volant (biais de mesure sur la population visée) ; `cat ~/.pi/agent/auth.json`
  passe l'allowlist (fuite de clé possible) ; prose du petit modèle injectée jusqu'à 4 000 chars
  dans le contexte de session ; timeouts cumulés 8 s + 10 s en act.

## Plan (une étape = un commit, validation entre chaque)

### Étape 0 — Mesurer (priorité absolue)

1. **Garde `routing`** : ne bloque plus en mode shadow (les entrées pendant un appel volant sont
   routées et journalisées). En act : comportement à clarifier — *hypothèse non vérifiée* : pi
   sérialise déjà les `input` quand le handler `await` ; à confirmer avant de toucher au garde en act.
2. **Coût du tour suivant** : journaliser par décision ce que le tour qui suit a réellement coûté
   (tokens d'entrée, cache, sortie). *Hypothèse non vérifiée* : l'usage est lisible sur les
   entrées de branchement du `sessionManager` — à confirmer contre l'API pi avant de coder.
3. **`/jev:stats` refondu** (la demande directe de ce matin) :
   - filtre par jour (`--today`, ou dernier jour par défaut) et séparation shadow / act —
     aujourd'hui tout est mélangé ;
   - taux de tours traités localement vs passés (par mode) ;
   - histogramme des `route.confidence` et des `no_judgment` (buckets 0.1) ;
   - latence ajoutée p50/p95 ; coût cumulé Jev ;
   - mention du nombre d'entrées ignorées par le garde (désormais 0 en shadow).
4. Toute entrée `handled_local` par L0 (étape 2) sera tracée `tier: "l0"` pour ne pas perdre la mesure.

**Critère d'acceptation** : après une session réelle, les chiffres affichés viennent de cette
session, filtrables par jour/mode, avec histogrammes.

### Étape 1 — Borner la latence en act

- `deadlineMs` configurable (défaut 1200 ms) : course Jev+petit-modèle contre l'échéance,
  pass-through immédiat au-delà. Timeout Jev rendu cohérent/configurable.
- Budget de latence ajoutée mesuré et écrit dans le README.

**Critère** : aucune entrée n'ajoute plus que le budget ; p95 mesurée consignée.

### Étape 2 (devient 3) — Hygiène du routeur : fuites internes, pas guards externes

Reframe après discussion : le problème n'est pas l'absence de guard dans pi (choix de l'user,
déjà documenté) mais que le routeur crée un canal de fuite qu'**aucun guard ne peut voir**.
Chaîne vérifiée dans le code : `cat ~/.pi/agent/auth.json` passe l'allowlist → sortie injectée
via `injectTrace` (customType jev-router) → `recentMessages()` inclut les traces jev-router →
envoyées à TypeSafe au tour suivant (`recent_conversation`) et au petit modèle (mid tier).

Corrections, toutes internes au routeur :
1. **Denylist de chemins sensibles** dans `validateCommand` : `~/.ssh/**`,
   `~/.pi/agent/auth.json`, `*.env`, `/proc/*/environ`, `*credential*`, `id_rsa*`,
   `.git-credentials` (liste ouverte à discussion).
2. **Ne jamais renvoyer les sorties de commandes locales à Jev ni au petit modèle** :
   `recentMessages()` n'inclut des traces jev-router que la ligne commande (`$ …`), jamais
   l'output. Ferme le canal quelle que soit la commande exécutée.
3. **Ne rien exécuter localement** hors projet approuvé selon `~/.pi/agent/trust.json`
   (*non vérifié* : format exact de trust.json à confirmer).
4. **README** : (a) les exécutions du routeur ne passent pas par `tool_call` — invisibles aux
   guards de permissions ; (b) tout texte tapé part chez TypeSafe (~1 000 tokens/appel,
   `recent_conversation` inclus) — choix de l'user, mais explicite.

**Critère** : table de tests incluant `cat ~/.pi/agent/auth.json` et variantes de contournement ;
aucun output de commande locale ne part chez TypeSafe (vérifiable dans le log/le code).

### Étape 3 (devient 4) — L0 gratuit + honnêteté du README

- Avant tout appel Jev : `validateCommand()` sur le texte brut ; si ça passe → exécution directe,
  zéro appel modèle, trace `tier: "l0"`.
- Jamais d'interception des entrées `/`, `!`, `!!` (déjà partiellement le cas pour `/` ; `!`/`!!`
  à confirmer comme non délivrés aux extensions — *non vérifié*).
- README réécrit : la prémisse « `ls -la` coûte un tour » est fausse (pi a `!`). La vraie valeur :
  obtenir une commande locale depuis une intention en langage naturel, sous-seconde, hors du
  contexte du gros modèle.

**Critère** : `git status` tapé tel quel ne provoque aucun appel Jev ; README sans prémisse fausse.

### Étape 4 (devient 5) — Le mid tier ne peut plus mentir

Choix à trancher avec l'utilisateur : **option B retenue par défaut** — la réponse du petit
modèle est affichée avec la mention explicite « réponse d'un modèle local, non vérifiée » et
**jamais injectée** dans la session. (L'option A — restreindre le mid tier aux commandes — reste
possible ; elle supprime aussi la fonctionnalité.)

**Critère** : aucun contenu non vérifié n'entre dans le contexte de session.

### Étape 5 (devient 6) — Tests et packaging

- Table ~40 cas pour `validateCommand` (contournements : `--exec-path`, `git -c … status`,
  flags attachés, encodage) via `node --test` ; tests d'aiguillage avec Jev simulé, sans réseau.
- `package.json` avec manifeste `pi` + `engines` épinglée (le manifeste exact est *non vérifié*
  contre les docs pi — à confirmer avant ce commit).

**Critère** : `npm test` vert ; installation autre que symlink documentée (ou déclarée impossible).

### Étape 6 (devient 7) — Calibration des seuils

Depuis les histogrammes de l'étape 0 : seuils placés dans des creux, jamais sur un amas ; corpus
rejoué 3× avant tout taux cité ; seuil + date + mesure consignés en commentaire et README.

### Étape 7 (inchangée) — Criblage contenu non fiable (seulement après l'étape 0)

A (shadow, log seul) → B (corpus étiqueté 12–15 extraits, Noul injection/secret, 3 passes) →
C (action bornée) seulement si séparation nette. Règle d'arrêt stricte : détection mauvaise ou
volume externe marginal ⇒ stop, résultat négatif consigné dans le README. Pas de « valvet »
sémantique : le plafond natif 2000 lignes/50 Ko + `pi-output-limits` prennent déjà le gain.

## Hors périmètre (refusés)

Routage du modèle par tour (invalidation du cache de préfixe), éviction/compression maison de
l'historique, panel multi-modèles avec juge, toute abstraction ou option sans cas d'usage mesuré.

## Question finale

Après l'étape 0 : « ce routeur mérite-t-il ses lignes ? » — réponse chiffrée, écrite même si
c'est non.

---

## Results (2026-09-20 implementation, English as agreed for all new docs)

All steps implemented in one pass (user override of the step-by-step protocol).

- **Step 0** — shadow routing no longer drops in-flight inputs (guard kept in act only).
  `/jev:stats` filters by local date (default today; `all` | `YYYY-MM-DD`), reports shadow and
  act **separately**, shows route/decision distributions, confidence + noul histograms, latency
  p50/p95, Jev token cost, and — via the new `turn_end` hook — the **real measured cost**
  (input/cache/output tokens, actual dollars) of the turn following each pass decision.
  Shadow mode also simulates the L0 free tier (`simulated: true`) with zero model calls.
- **Step 1** — `deadlineMs` (default 1200): Jev and small-model formulation race the budget;
  losing → logged pass-through (`reason: "deadline"`). `jevTimeoutMs` (3000) caps the
  background call. p95 measured in-session and reported by stats.
- **Step 2 (hygiene)** — sensitive-path denylist in `validateCommand` (incl. the discovered
  `git -c core.fsmonitor=<cmd>` arbitrary-execution bypass); `recentMessages()` contributes
  router-trace **commands only, never output** to Jev/small-model context; trust.json explicit-deny
  gating (best-effort format, marked unverified); README documents both the tool_call bypass and
  that all typed input goes to TypeSafe.
- **Step 3 (was 4)** — mid-tier prose answers are displayed with an explicit
  `[unverified answer from local small model]` mention and are never injected into session
  context (option B).
- **Step 4 (was 2)** — L0 free tier implemented (raw text validated + executed, zero model
  calls); `/`- and `!`-prefixed inputs never intercepted; README premise rewritten honestly
  (pi has `!`/`!!` natively; the router's value is natural-language → validated local command).
- **Step 5 (was 4)** — logic extracted to dependency-free `lib.ts`; 17 tests (`npm test`,
  `node --test`) covering validateCommand (~50 assertions incl. bypass attempts), decide(), and
  stats aggregation. `package.json` with the verified pi manifest + `engines` + peerDependency;
  README documents `pi install git:`. Note: `node --test` discovery of `test/` dir arg failed on
  Node 26 — script uses plain `node --test`.
- **Step 6 (was 5)** — gates kept at 0.9/0.7/0.6; measured distributions (see below) too sparse
  to justify a move; justification recorded in `lib.ts` comment + README Calibration section.
- **Step 7** — only phase A implemented (log-only `tool_result` scan: tool, est. tokens,
  external-origin heuristic). B/C deliberately deferred until phase-A distribution data exists.
  The semantic valve is explicitly not built: native 2000-line/50 KB caps + pi-output-limits
  already take the token savings.

### Measured answer to the final question — does this router deserve its lines?

From the two real sessions logged so far: act-mode conversational session → **1.5% local rate**
(1/65 turns) at 446 ms added p50 latency on 98%+ of turns; the dev/calibration session hit 36.4%
but is not representative. The L0 free tier may move the conversational number (raw commands
cost nothing anymore), but nothing measured yet proves it. Verdict: **not yet proven for
conversational workloads** — re-measure after a shadow-mode week with the new stats (L0
simulation rate + paid-turn costs) before deciding to keep or uninstall. A negative answer is an
acceptable deliverable.

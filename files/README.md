# Métabolyse 🟢

Application web (HTML / CSS / JavaScript pur, sans backend) pour suivre ta nutrition, ton déficit calorique, ta composition corporelle et l'adaptation réelle de ton métabolisme dans le temps.

Toutes les données sont stockées **localement dans ton navigateur** (`localStorage`) — aucun serveur, aucune base de données, aucun compte requis. C'est ce qui permet de l'héberger gratuitement sur GitHub Pages et d'y accéder via une simple URL.

## ✨ Fonctionnalités

- Calcul automatique du métabolisme de base (Mifflin-St Jeor + Katch-McArdle combinés)
- Estimation de la masse grasse par mensurations (méthode Marine américaine) si non connue
- **Adaptation métabolique** : comparaison entre le métabolisme théorique et le métabolisme réellement observé (à partir de ton historique calories/poids)
- Tableau de bord quotidien (calories, déficit, poids, composition corporelle, scores)
- Calendrier d'historique coloré par statut (déficit / maintenance / surplus)
- Graphiques : poids (+ moyennes mobiles 7/30 j), composition corporelle, métabolisme théorique vs adapté, déficit cumulé
- Moteur d'analyse automatique (insights en français) et détection de plateau
- Prédictions de poids à 30/60/90 jours
- Objectifs avec barre de progression
- Journal (humeur, énergie, sommeil, notes, photo de progression)
- Mode sombre / clair, interface responsive, installable en PWA
- Export d'un rapport imprimable (PDF via l'impression navigateur)

## 🚀 Déploiement sur GitHub Pages

1. Crée un nouveau dépôt sur GitHub (par ex. `metabolyse`) et pousse ce dossier :

   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/TON-PSEUDO/metabolyse.git
   git push -u origin main
   ```

2. Dans le dépôt GitHub : **Settings → Pages**
   - Source : `Deploy from a branch`
   - Branch : `main` / dossier `/ (root)`
   - Sauvegarde.

3. Après 1–2 minutes, ton site sera disponible à :
   `https://TON-PSEUDO.github.io/metabolyse/`

Aucune étape de build n'est nécessaire : le projet est 100 % statique.

### Alternative : Vercel

```bash
npm i -g vercel
vercel
```
Choisis le dossier du projet comme racine ; Vercel détectera un site statique et le déploiera directement.

## 🛠️ Développement local

Aucune dépendance à installer. Ouvre simplement `index.html` dans un navigateur, ou lance un petit serveur local :

```bash
npx serve .
# ou
python3 -m http.server 8080
```

## 📁 Structure du projet

```
metabolyse/
├── index.html          # Structure de l'application (onboarding + dashboard)
├── css/style.css        # Design system (tokens, dark/light, responsive)
├── js/app.js            # Logique : calculs métaboliques, stockage, rendu, graphiques
├── manifest.json         # Manifeste PWA
├── sw.js                 # Service worker (cache offline)
├── icons/icon.svg        # Icône de l'app
└── README.md
```

## 🧮 Méthodologie des calculs

- **BMR théorique** : moyenne pondérée de Mifflin-St Jeor et Katch-McArdle (Katch-McArdle pesant davantage quand la masse grasse est connue, car plus précis).
- **BMR adapté** : à partir de tes 21 derniers jours de calories et de poids déclarés, l'app déduit ta dépense énergétique réelle (1 kg de variation de poids ≈ 7700 kcal), puis en déduit ton métabolisme de base réel — lissé avec le BMR théorique pour éviter le bruit.
- **Scores Fat Loss Efficiency / Muscle Preservation** : indicateurs relatifs basés sur la corrélation entre variation de poids, de masse grasse et de masse musculaire au fil du temps. Ce sont des indicateurs de tendance, pas des mesures cliniques.

## ⚠️ Limites

- Les données vivent dans le navigateur utilisé : pas de synchronisation multi-appareil native (tu peux exporter/réimporter manuellement en copiant la clé `localStorage` `metabolyse:data:v1`).
- Les estimations (métabolisme, masse grasse, prédictions) sont des approximations à but indicatif — elles ne remplacent pas un avis médical ou un suivi professionnel.

## 📄 Licence

Libre d'utilisation et de modification pour ton usage personnel.

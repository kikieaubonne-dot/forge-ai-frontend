# Forge AI — Frontend (déploiement Vercel, indépendant du backend)

Frontend React/Vite pur. Aucune trace d'Express, SQLite ou de code serveur —
uniquement le navigateur, React, et des appels `fetch()` vers ton backend
Render déjà déployé.

```
forge-ai-standalone/
├── index.html
├── package.json
├── vite.config.js
├── vercel.json
├── .gitignore
├── README.md
└── src/
    ├── main.jsx        # point d'entrée React
    └── ForgeAI.jsx      # toute l'application (UI + appels backend)
```

Backend URL déjà pré-configurée dans le code (`DEFAULT_BACKEND_URL` en haut
de `src/ForgeAI.jsx`) :

```
https://forge-ai-backend-aj9d.onrender.com/api
```

Modifiable à tout moment depuis l'écran **Settings** de l'app une fois
déployée (stocké en `localStorage`, ne nécessite pas de rebuild).

---

## 1. Pousser sur GitHub

```bash
cd forge-ai-standalone
git init
git add .
git commit -m "Forge AI frontend"
git branch -M main
git remote add origin https://github.com/TON_USER/forge-ai-frontend.git
git push -u origin main
```

(Crée d'abord le dépôt vide sur github.com si ce n'est pas déjà fait —
"New repository", sans README/gitignore générés automatiquement pour
éviter un conflit avec ce commit.)

---

## 2. Importer dans Vercel

1. Va sur **vercel.com** → **Add New** → **Project**.
2. Choisis **Import Git Repository**, sélectionne `forge-ai-frontend`.
3. Vercel détecte automatiquement Vite grâce à `vercel.json` et
   `package.json` (Build Command `npm run build`, Output Directory `dist`)
   — tu n'as rien à changer.
4. Clique **Deploy**. ~30 secondes plus tard tu as une URL du type
   `https://forge-ai-frontend-xxxx.vercel.app`.

Aucune variable d'environnement n'est requise côté Vercel : la clé
Anthropic reste sur ton backend Render (jamais dans ce frontend), et
l'URL du backend est déjà dans le code / modifiable en Settings.

---

## 3. Vérifier que ça marche

Ouvre ton URL Vercel, va dans **Roblox Studio** :

1. Le champ Backend URL est déjà pré-rempli avec ton URL Render.
2. Clique **Register project**. Comme ce frontend tourne maintenant sur un
   vrai domaine (pas l'aperçu Claude), plus de restriction réseau — la
   requête doit aboutir. Le bouton **Diagnose Connection** reste
   disponible si jamais ça échoue encore (CORS, cold start Render, etc.).
3. Statut, historique de builds, et **SEND TO ROBLOX STUDIO** utilisent
   tous la même URL backend et devraient fonctionner normalement.

---

## 4. Génération IA (AI Builder)

Cette build n'a pas le proxy Anthropic intégré à l'aperçu Claude — elle
appelle `POST {backend}/api/generate`, une route de ton backend qui doit
détenir une vraie clé Anthropic :

Sur Render → ton service backend → **Environment** → ajoute :

```
ANTHROPIC_API_KEY=sk-ant-...
```

Redéploie le backend. Sans cette clé, `/api/generate` renvoie une erreur
claire au lieu de simuler une génération.

(Si tu n'as pas encore ce fichier de route sur ton backend Render,
demande-le — c'est `server/routes/generate.js` dans le zip du backend
livré précédemment, à ajouter et redéployer.)

---

## 5. Dev local (optionnel avant de pousser)

```bash
npm install
npm run dev
```

Ouvre `http://localhost:5173`. Utile pour vérifier que tout marche avant
de pousser sur GitHub.

```bash
npm run build     # build de prod dans dist/
npm run preview   # teste ce build en local
```

# Ma cave à vins

Application web pour smartphone : bouteilles, plan des casiers, maturité (fenêtre d'apogée) et journal des entrées et sorties.

- Données partagées dans Supabase (tables `vins`, `mouvements`, `config`), accès réservé aux e-mails listés dans la table `membres`.
- `config.js` contient l'adresse du projet Supabase et sa clé publique (anon).
- Copie locale et file d'attente des modifications pour l'usage hors connexion (`remote.js`, `sw.js`).
- Sauvegarde et restauration par fichier JSON depuis l'onglet Journal.

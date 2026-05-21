## Pour les lib externes

## Database : 

1. Ajout des dependances 

- pnpm add prisma @prisma/client
- pnpm prisma init
- pnpm add @prisma/adapter-neon
- pnpm add dotenv

2. Ajout des variables env 

- DATABASE_URL : URL pooler utilisée par l’app
- DATABASE_MIGRATE_URL : URL unpooled utilisée par Prisma CLI pour les migrations

3. Creation de prisma.ts

- PrismaClient est l'instance prisma 
- Prisma neon est l'adapter neon et embarque aussi le driver 
- On connecte le driver neon avec l'url pooler de la db 
- La deuxieme partie evite de recreer des nouvelles instances a l'infini en dev, ce que permet l'url pooler en prod 

4. Config de prisma.config.ts

- Ajout de database_migrate_url qui est l'url unpooled pour les migrations

5. Migration DB

- pnpm prisma migrate dev --name init (puis le nom de la migration a la place d'init)
- pnpm prisma generate (apres chaque migration)

## Better Auth 

1. Ajout des dépendances

- `pnpm add better-auth`

2. Ajout des variables env

- BETTER_AUTH_SECRET
- BETTER_AUTH_URL
- NEXT_PUBLIC_BETTER_AUTH_URL

3. Création de `lib/auth.ts`

- `betterAuth()` crée l’instance principale d’authentification.
- `prismaAdapter(prisma)` connecte Better Auth à Prisma.
- `provider: "postgresql"` indique que la DB utilisée derrière Prisma est PostgreSQL.
- `emailAndPassword.enabled = true` active l’auth email/password.
- `plugin 2FA` active l'authentification à 2 facteurs
- `emailVerification` pour envoyer l’email de vérification.
- `sendResetPassword` pour reset password.
- `socialProviders` pour Google/Facebook.
- `account.accountLinking` pour lier email/password + OAuth.
- `session.expiresIn/updateAge` pour la durée de session.
- `advanced.cookiePrefix` pour préfixer les cookies.
- `user.additionalFields.role` pour ajouter le rôle.

4. Génération des modèles Prisma Better Auth

- `pnpm dlx auth@latest generate --config ./lib/auth.ts` Ou/et - `pnpm dlx auth@latest generate --adapter prisma` 
- `TwoFactor` si le plugin 2FA est activé.

Cette commande ajoute dans `schema.prisma` :

- `User`
- `Session`
- `Account`
- `Verification`

5. Migration DB

- `pnpm prisma migrate dev --name auth`
Cette commande crée les vraies tables dans Neon.
- `pnpm prisma generate`

6. Création de la route API auth

- `app/api/auth/[...all]/route.ts`

7. Création du client auth frontend

- `lib/auth-client.ts`
- Ajouter `twoFactorClient()` si le plugin 2FA est utilisé.

8. Création du middleware

- `/proxy.ts` a la racine du projet
- Les routes match sont à modifier en fonction du besoin 
- Le proxy sert à la redirection UX.
- Il ne remplace pas `auth.api.getSession()` côté serveur.
- `proxy.ts` est exécuté côté serveur/edge avant les routes/pages.

9. Fonction better auth

# Client
- authClient.signUp.email()
- authClient.signIn.email()
- authClient.signOut()
- authClient.useSession()
# 2FA Client
- authClient.twoFactor.enable()
- authClient.twoFactor.verifyTOTP()
- authClient.twoFactor.disable()
- authClient.twoFactor.getTotpUri()
- authClient.twoFactor.sendOtp()
# Serveur
- auth.api.getSession() avec { headers: await headers() } coté serveur
- auth.api.signOut()
- auth.api.linkSocial()
- auth.api.unlinkAccount()
- auth.api.sendVerificationEmail()
- auth.api.requestPasswordReset()
- auth.api.resetPassword()
# 2FA Serveur
- auth.api.enableTwoFactor()
- auth.api.disableTwoFactor()
- auth.api.verifyTOTP()
- auth.api.sendTwoFactorOTP()


## Resend 

1. Ajout des dependances

- pnpm add resend

2. Creation de l'instance dans resend.ts

- Utiliser un domaine vérifié en prod.
- Utiliser `onboarding@resend.dev` uniquement pour les tests. 

3. Ajout des variables env

- RESEND_API_KEY
- RESEND_FROM_EMAIL = onboarding@resend.dev en dev
- RESEND_FROM_EMAIL = "Nom App <noreply@domaine.com>" en prod


## Stripe

1. Installation des dependances

- pnpm add stripe @stripe/stripe-js

2. Creation de l'instance Stripe

- `lib/payment/stripe.ts`
- const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

3. Ajout des variables env

- STRIPE_SECRET_KEY=sk_test_...
- NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
- STRIPE_WEBHOOK_SECRET=whsec_...
- NEXT_PUBLIC_APP_URL=http://localhost:3000 en dev et domaine en prod 

4. Creation du checkout

- `app/api/stripe/checkout/route.ts``
- le checkout c'est la page de payement 
- Checkout = page de paiement hébergée par Stripe.
- La route reçoit le panier, vérifie les prix côté serveur, crée l’`Order`, crée la `Checkout Session`, puis retourne `session.url`.

5. Creation du webhook 

- `app/api/stripe/webhook/route.ts`
- un webhook est une route qui receptionne une confirmation puis la valide (avec le secret de stripe)
- Important : utiliser `await req.text()` et non `await req.json()` pour conserver le body brut nécessaire à la validation de signature.

6. Création des redirections

- app/stripe/checkout/success/page.tsx
- app/stripe/checkout/cancel/page.tsx

# Environnement Dev

1. Lignes de commandes 

- brew install stripe/stripe-cli/stripe - installation du CLI (une seule fois)
- stripe version (pour verifier la version de stripe)
- stripe login - connexion a Stripe (met en sauvegarde, pas besoin de relancer constamment)
- stripe listen --forward-to localhost:3000/api/stripe/webhook - Ecouter le webhook localement (cli affiche Ready! Your webhook signing secret is whsec_...)
- Mettre le secret dans le stripe_webhook_secret

2. Paiements de test

- Utiliser les cartes de test Stripe.
- Exemple classique : 4242 4242 4242 4242
- Date future
- CVC aléatoire

# Environnement Prod

1. Variables env

- Remplacer les clés `test` par les clés `live`.
- Ne jamais mélanger `sk_test` et `pk_live`.

2. Webhook Stripe

- Aller dans Stripe Dashboard > Webhooks
- Ajouter : `https://ton-domaine.com/api/stripe/webhook`
- Récupérer le `whsec_...`
- Le mettre dans `STRIPE_WEBHOOK_SECRET`

3. Vérifications importantes

- Vérifier que le webhook reçoit bien `checkout.session.completed`
- Vérifier que `Order` passe bien en `PAID`
- Vérifier les redirects success/cancel
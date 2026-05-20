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

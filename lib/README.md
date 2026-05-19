## Pour les lib externes

## Database : 

1. Ajout des dependances 

- pnpm add prisma @prisma/client
- pnpm prisma init
- pnpm add @prisma/adapter-neon
- pnpm add dotenv

2. Ajout des variables env 

- Database URL

3. Creation de prisma.ts

- PrismaClient est l'instance prisma 
- Prisma neon est l'adapter neon et embarque aussi le driver 
- On connecte le driver neon avec l'url de la db 
- La deuxieme partie evite de recreer des nouvelles instances a l'infini en dev, ce que permet l'url pooler en prod 

- pnpm prisma generate

## Better Auth 

1. Ajout des dépendances

- `pnpm add better-auth`

2. Création de `lib/auth.ts`

- `betterAuth()` crée l’instance principale d’authentification.
- `prismaAdapter(prisma)` connecte Better Auth à Prisma.
- `provider: "postgresql"` indique que la DB utilisée derrière Prisma est PostgreSQL.
- `emailAndPassword.enabled = true` active l’auth email/password.

3. Génération des modèles Prisma Better Auth

- `pnpm dlx auth@latest generate --adapter prisma`

Cette commande ajoute dans `schema.prisma` :

- `User`
- `Session`
- `Account`
- `Verification`

4. Migration DB

- `pnpm prisma migrate dev --name auth`
Cette commande crée les vraies tables dans Neon.

5. Création de la route API auth

- `app/api/auth/[...all]/route.ts`

6. Création du client auth frontend

- `lib/auth-client.ts`






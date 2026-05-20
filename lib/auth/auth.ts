import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { twoFactor } from "better-auth/plugins";
import { prisma } from "../database/prisma";
import { resend } from "../mail/resend";


export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL!,
  secret: process.env.BETTER_AUTH_SECRET!,

  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),

  trustedOrigins: [
    "http://localhost:3000",
    process.env.BETTER_AUTH_URL!,
  ],

  user: {
    additionalFields: {
      role: {
        type: "string",
        defaultValue: "CLIENT",
        input: false,
      },
    },
  },

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 8,
    maxPasswordLength: 120,
    sendResetPassword: async({user, url})=>{
      const {error} = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL!,
      to: user.email,
      subject: "Réinitialisez votre mot de passe",
      html: `
        <a href="${url}">
        Réinitialiser mon mot de passe
        </a>
      `,
    })
     if (error) {
        throw new Error(error.message);
      }
    }
  },

  emailVerification:{
    sendOnSignUp: true,
    autoSignInAfterVerification: true, 
    sendVerificationEmail: async({user, url})=>{
      const {error} = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL!,
      to: user.email,
      subject: "Vérifiez votre email",
      html: `
        <a href="${url}">
          Vérifier mon email
        </a>
      `,
    })
      if (error) {
        throw new Error(error.message);
      }
    }
  },

  advanced:{
    cookiePrefix: 'ecommerce'
  },

  socialProviders:{
    google:{
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!
    },
    facebook:{
      clientId: process.env.FACEBOOK_CLIENT_ID!,
      clientSecret: process.env.FACEBOOK_CLIENT_SECRET!
    },
  },

  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google", "facebook", "email-password"],
      allowDifferentEmails: false,
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 jours
    updateAge: 60 * 60 * 24,     // 1 jour
  },

  plugins: [
  twoFactor({
    issuer: "E-commerce", // Le nom de l'app
    otpOptions:{
      async sendOTP({user, otp}){
        const { error } = await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL!,
          to: user.email,
          subject: "Votre code de sécurité",
          html: `
            <p>Votre code de sécurité :</p>
            <strong>${otp}</strong>
          `,
        });
         if (error) {
          throw new Error(error.message);
        }
      }
    }
  }),
],
});


// pnpm dlx auth@latest generate --adapter prisma si jamais le generate auto ne marche pas pour config les tables auto ou // pnpm dlx auth@latest generate --config ./lib/auth.ts
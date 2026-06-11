import { stripe } from "@/lib/payment/stripe";
import Stripe from "stripe";
import { auth } from "@/lib/auth/auth";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/database/prisma";
import {itemsFromOrder,lockOrder,releaseStock,ReservedItem,} from "@/lib/payment/stock";
import { Prisma, Promotion, SHIPPING_METHOD } from "@/lib/database/prisma/client";
import * as Sentry from '@sentry/nextjs'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL;

type CheckoutItem = {
  variantId: string;
  quantity: number;
};

// Erreur métier : message exposable au client. Tout le reste -> 500 générique.
class CheckoutError extends Error {
  constructor(message: string, public status: number = 400) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Promotions (par produit, niveau ligne)
// ---------------------------------------------------------------------------
// On verifie si la promo est active
function isPromotionActive(promotion: Promotion, now = new Date()) {
  const hasStarted = !promotion.startsAt || promotion.startsAt <= now;
  const hasNotEnded = !promotion.endsAt || promotion.endsAt >= now;
  return hasStarted && hasNotEnded;
}

// On recupere la promo et on l'applique. si c'est un % on calcule differemment. 
// Math.min() donne la plus petite valeur des deux arg. Pour que si la promo excede le prix de l'article on reduise la promo au prix de l'article. 
function getPromotionDiscountAmount(unitPrice: number, promotion?: Promotion) {
  if (!promotion) return 0;
  if (promotion.type === "PERCENTAGE") {
    return Math.min(unitPrice, Math.round((unitPrice * promotion.value) / 100));
  }
  return Math.min(unitPrice, promotion.value);
}


// Erreur Stripe transitoire (réseau / rate-limit / 5xx) -> l'order reste retentable.
// NB : Stripe.errors est statique sur la CLASSE importée, pas sur l'instance `stripe`.
function isRetryable(e: unknown) {
  return (
    e instanceof Stripe.errors.StripeConnectionError ||
    e instanceof Stripe.errors.StripeAPIError ||
    e instanceof Stripe.errors.StripeRateLimitError
  );
}

type OrderWithItems = Prisma.OrderGetPayload<{ include: { items: true } }>;
type OrderResume = Prisma.OrderGetPayload<{
  include: { items: true; payments: true };
}>;

// ---------------------------------------------------------------------------
// Session Stripe : parité amount_total == order.totalAmount PAR CONSTRUCTION
// ---------------------------------------------------------------------------
const successUrl = (orderId: string) =>
  `${APP_URL}/checkout/success?order_id=${orderId}`;

// Construit et crée la session Stripe pour une Payment donnée.
// - line_items produits = finalUnitPrice (promo déjà appliquée)
// - livraison = une line_item dédiée (sinon Stripe ne facture jamais le port)
// - coupon = écart entre (lignes + livraison) et totalAmount, porté en amount_off Stripe
//   -> garantit session.amount_total === order.totalAmount, donc Payment.amount aussi.
// La clé d'idempotence est dérivée de payment.id : un retry (503 dont la réponse s'est
// perdue) renvoie LA MÊME session et LE MÊME coupon, jamais un doublon.
async function createSession(order: OrderWithItems, paymentId: string) {
  const lineItems: Stripe.Checkout.SessionCreateParams["line_items"] =
    order.items.map((it) => ({
      price_data: {
        currency: order.currency,
        product_data: {
          name: `${it.productName} - ${it.variantName}`,
          images: it.productImageUrl ? [it.productImageUrl] : [],
        },
        unit_amount: it.finalUnitPrice, // centimes, promo incluse
      },
      quantity: it.quantity,
    }));

  if (order.shippingAmount > 0) {
    lineItems.push({
      price_data: {
        currency: order.currency,
        product_data: { name: "Livraison" },
        unit_amount: order.shippingAmount,
      },
      quantity: 1,
    });
  }

  const linesTotal =
    order.items.reduce((s, it) => s + it.finalUnitPrice * it.quantity, 0) +
    Math.max(0, order.shippingAmount);
  const couponOff = linesTotal - order.totalAmount; // = part coupon (>= 0)

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    line_items: lineItems,
    success_url: `${APP_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}&order_id=${order.id}`,
    cancel_url: `${APP_URL}/checkout/cancel`,
    metadata: {
      orderId: order.id,
      ...(order.userId ? { userId: order.userId } : {}),
    },
    expires_at: Math.floor(Date.now() / 1000) + 15 * 60,
  };

  if (couponOff > 0) {
    // Coupon éphémère idempotent. À terme : pré-mapper un coupon Stripe par Coupon DB
    // (colonne stripeCouponId) plutôt qu'en créer un par checkout.
    const coupon = await stripe.coupons.create(
      {
        amount_off: couponOff,
        currency: order.currency,
        duration: "once",
        name: "Réduction",
      },
      { idempotencyKey: `coupon:${paymentId}` }
    );
    params.discounts = [{ coupon: coupon.id }];
  }

  return stripe.checkout.sessions.create(params, {
    idempotencyKey: `checkout:${paymentId}`,
  });
}

// Mappe une session (retrieve OU create) vers une URL client, ou throw.
// expired -> libération immédiate du stock (une seule session par order, morte) + 409.
async function sessionToUrl(
  order: OrderWithItems,
  cs: Stripe.Checkout.Session,
  items: ReservedItem[]
): Promise<string> {
  if (cs.status === "complete") return successUrl(order.id);
  if (cs.status === "open" && cs.url) return cs.url;
  if (cs.status === "expired") {
    await releaseStock(order.id, items, "EXPIRED");
  throw new CheckoutError("Session de paiement expirée, relancez le paiement", 409);
  }
  // open sans url, ou statut inattendu -> anomalie déterministe
  await releaseStock(order.id, items, "FAILED");
  throw new CheckoutError("Impossible de finaliser la session de paiement", 500);
}

// Première (et unique) tentative d'un order : crée la Payment + sa session.
async function startNewAttempt(
  order: OrderWithItems,
  items: ReservedItem[]
): Promise<string> {
  const payment = await prisma.payment.create({
    data: {
      orderId: order.id,
      provider: "stripe",
      status: "PENDING",
      amount: order.totalAmount, // == amount_total Stripe par construction
      currency: order.currency,
    },
  });

  let cs: Stripe.Checkout.Session;
  try {
    cs = await createSession(order, payment.id);
  } catch (e) {
    Sentry.captureException(e)
    if (isRetryable(e)) {
      // La session a peut-être été créée côté Stripe (réponse perdue). On laisse l'order
      // PENDING avec providerSessionId=null : la reprise la récupère via checkout:${payment.id}.
      throw new CheckoutError(
        "Service de paiement momentanément indisponible, réessayez.",
        503
      );
    }
    await releaseStock(order.id, items, "FAILED"); // déterministe -> terminal
    throw e; // -> 500 générique
  }

  await prisma.payment.update({
    where: { id: payment.id },
    data: { providerSessionId: cs.id },
  });
  return sessionToUrl(order, cs, items);
}

// Reprise de la dernière tentative SANS jamais créer de 2e session.
async function recoverAttempt(
  order: OrderWithItems,
  payment: { id: string; providerSessionId: string | null },
  items: ReservedItem[]
): Promise<string> {
  // Session connue -> on lit son état (open/complete/expired).
  if (payment.providerSessionId) {
    const cs = await stripe.checkout.sessions.retrieve(payment.providerSessionId);
    return sessionToUrl(order, cs, items);
  }

  // providerSessionId null (503 / crash avant persistance) : la session existe peut-être
  // côté Stripe. On la récupère via LA MÊME clé idempotente -> jamais de 2e session.
  let cs: Stripe.Checkout.Session;
  try {
    cs = await createSession(order, payment.id);
  } catch (e) {
    Sentry.captureException(e)
    if (isRetryable(e)) {
      throw new CheckoutError(
        "Service de paiement momentanément indisponible, réessayez.",
        503
      );
    }
    await releaseStock(order.id, items, "FAILED");
    throw e;
  }

  await prisma.payment.update({
    where: { id: payment.id },
    data: { providerSessionId: cs.id },
  });
  return sessionToUrl(order, cs, items);
}

// Reprise d'un order existant pour cette idempotencyKey.
async function resumeExistingOrder(order: OrderResume): Promise<string> {
  if (order.status === "PAID") return successUrl(order.id);

  // Terminal (FAILED/EXPIRED/CANCELLED) : la clé est consommée, le client repart sur une neuve.
  if (order.status !== "PENDING") {
    throw new CheckoutError("Cette commande n'est plus payable", 409);
  }

  const items = itemsFromOrder(order);
  const last = [...order.payments].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  )[0];

  // Order créé mais crash avant la 1re Payment -> on démarre la (seule) tentative.
  if (!last) return startNewAttempt(order, items);

  return recoverAttempt(order, last, items);
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) {
      return NextResponse.json({ error: "Accès interdit" }, { status: 401 });
    }

    const body = await req.json();
    const items: CheckoutItem[] = body.items;
    const shippingAddress = body.shippingAddress;
    const billingAddress = body.billingAddress;
    const shippingMethod: SHIPPING_METHOD | undefined = body.shippingMethod;
    const couponCode: unknown = body.couponCode;
    const idempotencyKey: string | undefined = body.idempotencyKey;

    if (!idempotencyKey) {
      return NextResponse.json(
        { error: "Idempotency key manquante" },
        { status: 400 }
      );
    }

    // --- REPRISE : un order existe déjà pour cette clé ? ---
    // Scopé au user via @@unique([userId, idempotencyKey]) -> pas de garde d'ownership.
    const existingOrder = await prisma.order.findUnique({
      where: {
        userId_idempotencyKey: { userId: session.user.id, idempotencyKey },
      },
      include: { items: true, payments: true },
    });
    if (existingOrder) {
      const url = await resumeExistingOrder(existingOrder);
      return NextResponse.json({ url });
    }

    // --- VALIDATION (à remplacer par Zod) ---
    if (!items || items.length === 0) {
      return NextResponse.json({ error: "Le panier est vide" }, { status: 400 });
    }
    if (!shippingAddress || !billingAddress) {
      return NextResponse.json({ error: "Adresse manquante" }, { status: 400 });
    }
    // Garde contre le footgun Prisma `where: { x: undefined }` (== pas de filtre).
    if (!shippingMethod) {
      return NextResponse.json({ error: "Méthode de livraison manquante" },{ status: 400 });
    }
    if (
      items.some(
        (item) =>
          !item.variantId ||
          !Number.isInteger(item.quantity) ||
          item.quantity < 1
      )
    ) {
      return NextResponse.json({ error: "Panier invalide" }, { status: 400 });
    }

    // On deduplique les items avec new set pour verifier les doublons. 
    const variantIds = items.map((item) => item.variantId);
    if (new Set(variantIds).size !== items.length) {
      return NextResponse.json({ error: "Variantes dupliquées" },{ status: 400 });
    }

    // On cree un array variants grace aux variantId recuperes grace aux items. 
    const variants = await prisma.productVariant.findMany({
      where: {
        id: { in: variantIds },
        isActive: true,
        product: { isActive: true },
      },
      include: {
        product: {
          include: { promotionProduct: { include: { promotion: true } } },
        },
      },
    });
    if (variants.length !== items.length) {
      return NextResponse.json(
        { error: "Variante manquante ou inactive" },
        { status: 400 }
      );
    }

    const variantsMap = new Map(variants.map((v) => [v.id, v]));
    const now = new Date();

    // On cree un nouvel array dans lequel on a les items du paniers avec toutes les propriétés de leur variant. 
    const enrichedItems = items.map((item) => {
      const variant = variantsMap.get(item.variantId);
      if (!variant) throw new CheckoutError("Variante introuvable");
      if (variant.price <= 0) {
        throw new CheckoutError(`Prix invalide pour ${variant.product.name}`);
      }
      const availableStock = variant.stockOnHand - variant.stockReserved;
      if (item.quantity > availableStock) {
        throw new CheckoutError(`Stock insuffisant pour ${variant.product.name}`);
      }

      // On recupere les promos de chaque variant. 
      const activePromotion = variant.product.promotionProduct
        .map((pp) => pp.promotion)
        .filter((p) => isPromotionActive(p, now))
        .sort(
          (a, b) =>
            getPromotionDiscountAmount(variant.price, b) -
            getPromotionDiscountAmount(variant.price, a)
        )[0];

      const unitPrice = variant.price;
      const discountAmount = getPromotionDiscountAmount(unitPrice, activePromotion);
      const finalUnitPrice = unitPrice - discountAmount;

      return {
        variant,
        quantity: item.quantity,
        unitPrice,
        discountAmount,
        finalUnitPrice,
        lineTotalAmount: finalUnitPrice * item.quantity,
      };
    });

    // --- Montants ---
    const subtotalAmount = enrichedItems.reduce(
      (t, { unitPrice, quantity }) => t + unitPrice * quantity,
      0
    );
    const promoDiscountTotal = enrichedItems.reduce(
      (t, { discountAmount, quantity }) => t + discountAmount * quantity,
      0
    );
    const discountedItemsSubtotal = subtotalAmount - promoDiscountTotal;

    const shipment = await prisma.shipment.findFirst({ where: { shippingMethod } });
    if (!shipment) throw new CheckoutError("Méthode de livraison invalide");
    const shippingAmount = shipment.shippingCost;

    // Coupon : on NE query QUE si un code non vide est fourni (sinon `where:{code:undefined}`
    // renvoie le 1er coupon de la table). Cap sur les produits, surface une erreur si invalide.
    let couponEffective = 0;
    if (typeof couponCode === "string" && couponCode.trim() !== "") {
      const coupon = await prisma.coupon.findFirst({ where: { code: couponCode } });
      // TODO: valider selon ton schéma Coupon -> fenêtre active, usage max, montant min, type.
      if (!coupon) throw new CheckoutError("Code promo invalide");
      // Hypothèse : coupon.value = montant fixe en centimes. Coupons en % -> à gérer ici.
      couponEffective = Math.min(coupon.value, discountedItemsSubtotal);
    }

    const discountAmount = promoDiscountTotal + couponEffective;
    const totalAmount = Math.max(
      0,
      subtotalAmount + shippingAmount - discountAmount
    );

    // --- Réservation atomique du stock + création de l'order ---
    let order: OrderWithItems;
    try {
      order = await prisma.$transaction(async (tx) => {
        for (const { variant, quantity } of lockOrder(enrichedItems)) {
          const updatedCount = await tx.$executeRaw`
            UPDATE "ProductVariant"
            SET "stockReserved" = "stockReserved" + ${quantity}
            WHERE "id" = ${variant.id}
            AND ("stockOnHand" - "stockReserved") >= ${quantity}
          `;
          if (updatedCount === 0) {
            throw new CheckoutError(
              `Stock insuffisant pour ${variant.product.name}`
            );
          }
        }

        return tx.order.create({
          data: {
            status: "PENDING",
            userId: session.user.id,
            email: session.user.email,
            currency: "eur",
            shippingAddress,
            billingAddress,
            shippingAmount,
            discountAmount,
            subtotalAmount,
            totalAmount,
            idempotencyKey,
            items: {
              create: enrichedItems.map(
                ({
                  variant,
                  quantity,
                  unitPrice,
                  discountAmount,
                  finalUnitPrice,
                  lineTotalAmount,
                }) => ({
                  quantity,
                  unitPrice,
                  discountAmount,
                  finalUnitPrice,
                  lineTotalAmount,
                  productName: variant.product.name,
                  variantName: variant.name,
                  productImageUrl: variant.imageUrl,
                  productId: variant.productId,
                  variantId: variant.id,
                })
              ),
            },
          },
          include: { items: true },
        });
      });
    } catch (e) {
      Sentry.captureException(e)
      // Course concurrente sur la clé d'idempotence : le stock réservé dans CETTE tx est
      // rollback automatiquement. On converge sur l'order gagnant.
      const target = e instanceof Prisma.PrismaClientKnownRequestError ? e.meta?.target : undefined;
      const isIdemRace =
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002" &&
        (Array.isArray(target)
          ? target.includes("idempotencyKey")
          : typeof target === "string"
          ? target.includes("idempotencyKey")
          : false);

      if (isIdemRace) {
        const winner = await prisma.order.findUnique({
          where: {
            userId_idempotencyKey: { userId: session.user.id, idempotencyKey },
          },
          include: { items: true, payments: true },
        });
        if (winner) {
          const url = await resumeExistingOrder(winner);
          return NextResponse.json({ url });
        }
      }
      throw e;
    }

    const reservedItems: ReservedItem[] = enrichedItems.map(
      ({ variant, quantity }) => ({ variant: { id: variant.id }, quantity })
    );
    const url = await startNewAttempt(order, reservedItems);
    return NextResponse.json({ url });
  } catch (error) {
    Sentry.captureException(error)
    if (error instanceof CheckoutError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error(error);
    return NextResponse.json(
      { error: "Erreur lors de la création du checkout" },
      { status: 500 }
    );
  }
}
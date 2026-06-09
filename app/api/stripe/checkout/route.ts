import { stripe } from "@/lib/payment/stripe";
import { auth } from "@/lib/auth/auth";
import { NextRequest, NextResponse } from "next/server";
// NOTE: ajuste le chemin du namespace `Prisma` vers ton client généré si besoin
// (avec le generator `prisma-client` à output custom, il est exporté depuis le dossier de sortie).
import { prisma } from "@/lib/database/prisma";
import { Prisma } from "@/lib/database/prisma/client";

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

type OrderWithItems = Prisma.OrderGetPayload<{ include: { items: true } }>;
type OrderResume = Prisma.OrderGetPayload<{
  include: { items: true; payments: true };
}>;
type EnrichedItem = { variant: { id: string }; quantity: number };

// Crée une NOUVELLE tentative de paiement (1 payment = 1 tentative) et la session Stripe.
// La clé d'idempotence Stripe est dérivée de payment.id -> jamais de collision avec une session expirée cachée.
async function startStripeSession(order: OrderWithItems) {
  const payment = await prisma.payment.create({
    data: {
      orderId: order.id,
      provider: "stripe",
      status: "PENDING",
      amount: order.totalAmount,
      currency: order.currency,
    },
  });

  // line_items reconstruits depuis le snapshot persisté dans order.items (pas depuis les variants).
  const lineItems = order.items.map((it) => ({
    price_data: {
      currency: order.currency,
      product_data: {
        name: `${it.productName} - ${it.variantName}`,
        images: it.productImageUrl ? [it.productImageUrl] : [],
      },
      unit_amount: it.finalUnitPrice, // centimes
    },
    quantity: it.quantity,
  }));

  const checkoutSession = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      line_items: lineItems,
      success_url: `${APP_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}&order_id=${order.id}`,
      cancel_url: `${APP_URL}/checkout/cancel`,
      metadata: {
        orderId: order.id,
        ...(order.userId ? { userId: order.userId } : {}),
      },
      expires_at: Math.floor(Date.now() / 1000) + 15 * 60,
    },
    { idempotencyKey: `checkout:${payment.id}` }
  );

  await prisma.payment.update({
    where: { id: payment.id },
    data: { providerSessionId: checkoutSession.id },
  });

  return checkoutSession;
}

// Reprise d'un order déjà existant pour ce idempotencyKey. Retourne une URL à renvoyer au client.
async function resumeExistingOrder(order: OrderResume): Promise<string> {
  if (order.status === "PAID") {
    return `${APP_URL}/checkout/success?order_id=${order.id}`;
  }

  // Order terminé (FAILED/EXPIRED/CANCELLED...) : la clé est consommée, le client doit repartir d'une nouvelle.
  if (order.status !== "PENDING") {
    throw new CheckoutError("Cette commande n'est plus payable", 409);
  }

  // order PENDING : on tente de reprendre la dernière session Stripe.
  const last = order.payments
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  if (last?.providerSessionId) {
    const cs = await stripe.checkout.sessions.retrieve(last.providerSessionId);
    if (cs.status === "complete") {
      // payée (ou en cours de confirmation par le webhook) -> ne pas recréer de session.
      return `${APP_URL}/checkout/success?order_id=${order.id}`;
    }
    if (cs.status === "open" && cs.url) {
      return cs.url;
    }
    // cs.status === "expired" (ou url null) -> on recrée plus bas.
  }

  // Soit aucune session exploitable (crash avant Stripe), soit session expirée -> nouvelle tentative.
  // Le stock est déjà réservé sur cet order PENDING, on ne le réserve donc pas à nouveau.
  const cs = await startStripeSession(order);
  if (!cs.url) {
    throw new CheckoutError("Impossible de créer la session Stripe", 500);
  }
  return cs.url;
}

// Libère le stock réservé et marque l'order + ses paiements en échec (post-commit Stripe échoué).
async function releaseStock(orderId: string, items: EnrichedItem[]) {
  await prisma.$transaction(async (tx) => {
    for (const { variant, quantity } of items) {
      await tx.productVariant.update({
        where: { id: variant.id },
        data: { stockReserved: { decrement: quantity } },
      });
    }
    await tx.order.update({
      where: { id: orderId },
      data: { status: "FAILED" },
    });
    // updateMany : ne throw pas si aucune ligne payment n'existe encore.
    await tx.payment.updateMany({
      where: { orderId },
      data: { status: "FAILED" },
    });
  });
}

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
    const idempotencyKey: string | undefined = body.idempotencyKey;

    if (!idempotencyKey) {
      return NextResponse.json(
        { error: "Idempotency key manquante" },
        { status: 400 }
      );
    }

    // --- REPRISE : un order existe déjà pour cette clé ? ---
    const existingOrder = await prisma.order.findUnique({
      where: { idempotencyKey }, // idempotencyKey est @unique ; userId servirait de filtre défensif optionnel.
      include: { items: true, payments: true },
    });
    if (existingOrder) {
      // Garde-fou : on ne reprend que les commandes du propriétaire.
      if (existingOrder.userId && existingOrder.userId !== session.user.id) {
        return NextResponse.json({ error: "Accès interdit" }, { status: 403 });
      }
      const url = await resumeExistingOrder(existingOrder);
      return NextResponse.json({ url });
    }

    // --- VALIDATION (à remplacer par Zod plus tard) ---
    if (!items || items.length === 0) {
      return NextResponse.json({ error: "Le panier est vide" }, { status: 400 });
    }
    if (!shippingAddress || !billingAddress) {
      return NextResponse.json({ error: "Adresse manquante" }, { status: 400 });
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

    const variantIds = items.map((item) => item.variantId);
    if (new Set(variantIds).size !== items.length) {
      return NextResponse.json(
        { error: "Variantes dupliquées" },
        { status: 400 }
      );
    }

    const variants = await prisma.productVariant.findMany({
      where: {
        id: { in: variantIds },
        isActive: true,
        product: { isActive: true },
      },
      include: { product: true },
    });
    if (variants.length !== items.length) {
      return NextResponse.json(
        { error: "Variante manquante ou inactive" },
        { status: 400 }
      );
    }

    const variantsMap = new Map(variants.map((v) => [v.id, v]));

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
      return { variant, quantity: item.quantity };
    });

    const subtotalAmount = enrichedItems.reduce(
      (total, { variant, quantity }) => total + variant.price * quantity,
      0
    );
    const shippingAmount = 0;
    const taxAmount = 0;
    const discountAmount = 0;
    const totalAmount =
      subtotalAmount + shippingAmount + taxAmount - discountAmount;

    // --- Réservation atomique du stock + création de l'order ---
    let order: OrderWithItems;
    try {
      order = await prisma.$transaction(async (tx) => {
        for (const { variant, quantity } of enrichedItems) {
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
            taxAmount,
            discountAmount,
            subtotalAmount,
            totalAmount,
            idempotencyKey,
            items: {
              create: enrichedItems.map(({ variant, quantity }) => ({
                quantity,
                unitPrice: variant.price,
                discountAmount: 0,
                finalUnitPrice: variant.price,
                lineTotalAmount: variant.price * quantity,
                productName: variant.product.name,
                variantName: variant.name,
                productImageUrl: variant.imageUrl,
                productId: variant.productId,
                variantId: variant.id,
              })),
            },
          },
          include: { items: true },
        });
      });
    } catch (e) {
      // Course concurrente : une autre requête a déjà créé l'order pour ce idempotencyKey.
      // Le stock réservé dans CETTE transaction a été rollback automatiquement.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      ) {
        const winner = await prisma.order.findUnique({
          where: { idempotencyKey },
          include: { items: true, payments: true },
        });
        if (winner) {
          const url = await resumeExistingOrder(winner);
          return NextResponse.json({ url });
        }
      }
      throw e;
    }

    // --- Création de la session Stripe (hors transaction DB) ---
    let checkoutSession;
    try {
      checkoutSession = await startStripeSession(order);
    } catch (error) {
      await releaseStock(order.id, enrichedItems);
      throw error;
    }

    if (!checkoutSession.url) {
      await releaseStock(order.id, enrichedItems);
      return NextResponse.json(
        { error: "Impossible de créer la session Stripe" },
        { status: 500 }
      );
    }

    return NextResponse.json({ url: checkoutSession.url });
  } catch (error) {
    if (error instanceof CheckoutError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(error);
    return NextResponse.json(
      { error: "Erreur lors de la création du checkout" },
      { status: 500 }
    );
  }
}
import Stripe from "stripe";
import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/payment/stripe";
import { prisma } from "@/lib/database/prisma";
import { itemsFromOrder, releaseStock } from "@/lib/payment/stock";
import * as Sentry from '@sentry/nextjs'

// app/api/webhooks/stripe/route.ts
// La vérif de signature + le SDK Stripe ont besoin du runtime Node (crypto), pas edge.
export const runtime = "nodejs";

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

export async function POST(req: NextRequest) {
  // body BRUT : obligatoire pour la signature. En App Router, req.text() n'est pas parsé.
  const body = await req.text();
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new NextResponse("Signature manquante", { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, WEBHOOK_SECRET);
  } catch(error) {
    Sentry.captureException(error)
    return new NextResponse("Signature invalide", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case "checkout.session.expired":
        await handleExpired(event.data.object as Stripe.Checkout.Session);
        break;
      // tout le reste : ignoré, 200
    }
  } catch (err) {
    Sentry.captureException(err)
    // 500 -> Stripe retente. Le claim conditionnel rend chaque retry idempotent.
    console.error("[stripe webhook]", event.type, err);
    return new NextResponse("handler error", { status: 500 });
  }

  return new NextResponse(null, { status: 200 });
}

// checkout.session.completed
// claim PENDING->PAID + conversion reserved->sold + update Payment.
async function handleCompleted(session: Stripe.Checkout.Session) {
  const payment = await prisma.payment.findFirst({
    where: { providerSessionId: session.id },
    include: { order: { include: { items: true } } },
  });
  if (!payment) return; // session inconnue (autre env, etc.) -> 200, ignore

  const order = payment.order;

  // Garde montant/devise : amount_total Stripe DOIT == Payment.amount (parité par construction
  // côté checkout). Un écart = invariant violé (bug de calcul). On NE fulfill PAS et on alerte ;
  // un retry Stripe ne corrigerait rien, donc 200.
  if (
    session.amount_total == null ||
    session.amount_total !== payment.amount ||
    (session.currency ?? "").toLowerCase() !== payment.currency.toLowerCase()
  ) {
    console.error("[stripe webhook] mismatch montant/devise", {
      orderId: order.id,
      expected: payment.amount,
      got: session.amount_total,
      currency: session.currency,
    });
    // await inngest.send({ name: "payment/amount-mismatch", data: { paymentId: payment.id } });
    return;
  }

  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id ?? null;

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.order.updateMany({
      where: { id: order.id, status: "PENDING" },
      data: { status: "PAID" },
    });

    if (claimed.count === 0) {
      // Order déjà non-PENDING.
      if (order.status !== "PAID") {
        // Pathologique : capture sur un order déjà mort (reaper/resume a libéré avant un
        // completed très en retard). Stock déjà relâché -> NE PAS convertir. Rembourser/alerter.
        console.error("[stripe webhook] completed sur order non-PAID", {
          orderId: order.id,
          status: order.status,
        });
        // await inngest.send({ name: "payment/orphan-capture",
        //   data: { paymentId: payment.id, paymentIntentId } });
      }
      // completed dupliqué -> on s'assure juste que la Payment est à jour (idempotent).
      await tx.payment.updateMany({
        where: { id: payment.id, status: "PENDING" },
        data: { status: 'SUCCEEDED', paidAt: new Date(), paymentIntentId },
      });
      return;
    }

    // Claim gagné : conversion reserved -> sold (les DEUX décréments).
    // Boucle triée par variantId (même ordre de lock que réservation/release) -> anti-deadlock.
    // Filtre défensif sur variantId null : on logue au lieu de wedger le webhook en retry infini.
    const items = order.items
      .filter((it) => {
        if (!it.variantId) {
          console.error("[stripe webhook] OrderItem sans variantId", {
            orderId: order.id,
          });
          return false;
        }
        return true;
      })
      .sort((a, b) => a.variantId!.localeCompare(b.variantId!));

    for (const it of items) {
      await tx.productVariant.update({
        where: { id: it.variantId! },
        data: {
          stockOnHand: { decrement: it.quantity },
          stockReserved: { decrement: it.quantity },
        },
      });
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: { status: "SUCCEEDED", paidAt: new Date(), paymentIntentId },
    });
  });
}

// checkout.session.expired
// Une seule session par order (recréation supprimée côté checkout) -> aucune tentative
// ultérieure à protéger : release direct. Le claim PENDING->EXPIRED dans releaseStock est
// idempotent (order déjà PAID/terminal -> count===0 -> no-op).
async function handleExpired(session: Stripe.Checkout.Session) {
  const payment = await prisma.payment.findFirst({
    where: { providerSessionId: session.id },
    include: { order: { include: { items: true } } },
  });
  // providerSessionId jamais persisté (session créée mais réponse perdue, 503) -> pas de match :
  // c'est le reaper qui couvre ce cas (zéro objet matché ici).
  if (!payment) return;

  await releaseStock(payment.orderId, itemsFromOrder(payment.order), "EXPIRED");
}
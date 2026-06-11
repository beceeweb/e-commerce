import { prisma } from "@/lib/database/prisma";

// lib/payment/stock.ts
// Helpers partagés par le checkout, le webhook Stripe et le reaper Inngest.
// L'ordre de lock (tri par variant.id) DOIT être identique partout où on verrouille
// plusieurs lignes ProductVariant, sinon deadlock entre transactions concurrentes.

export type ReservedItem = { variant: { id: string }; quantity: number };

type OrderItemsSnapshot = {
  items: { variantId: string | null; quantity: number }[];
};

export const lockOrder = <T extends { variant: { id: string } }>(items: T[]) =>
  [...items].sort((a, b) => a.variant.id.localeCompare(b.variant.id));

// Reconstruit les ReservedItem depuis le snapshot persisté d'un order.
// Throw si variantId null : pré-requis schéma OrderItem.variantId en onDelete: Restrict,
// sinon un variant supprimé rend la libération impossible -> dérive d'invariant.
export function itemsFromOrder(order: OrderItemsSnapshot): ReservedItem[] {
  return order.items.map((it) => {
    if (!it.variantId) {
      throw new Error("OrderItem sans variantId (attendu onDelete: Restrict)");
    }
    return { variant: { id: it.variantId }, quantity: it.quantity };
  });
}

// Libère le stock réservé et marque l'order + ses paiements terminaux.
// Le updateMany conditionnel sur status=PENDING est le claim atomique : si un autre acteur
// (webhook, reaper, resume) a déjà fait transitionner l'order, count===0 -> on ne touche à rien.
// C'est à la fois l'idempotence et la protection contre les races.
export async function releaseStock(
  orderId: string,
  items: ReservedItem[],
  terminalStatus: "FAILED" | "EXPIRED" = "FAILED"
) {
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.order.updateMany({
      where: { id: orderId, status: "PENDING" },
      data: { status: terminalStatus },
    });
    if (claimed.count === 0) return; // déjà PAID/EXPIRED/FAILED -> rien

    for (const { variant, quantity } of lockOrder(items)) {
      await tx.productVariant.update({
        where: { id: variant.id },
        data: { stockReserved: { decrement: quantity } },
      });
    }

    await tx.payment.updateMany({
      where: { orderId },
      data: { status: terminalStatus },
    });
  });
}
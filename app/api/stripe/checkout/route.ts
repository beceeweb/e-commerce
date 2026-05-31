import { stripe } from "@/lib/payment/stripe";
import { auth } from "@/lib/auth/auth";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/database/prisma";

type CheckoutItem = {
  variantId: string;
  quantity: number;
};

export async function POST(req: NextRequest) {
  try {
    const session = await auth.api.getSession({
      headers: req.headers,
    });

    if (!session) {
      return NextResponse.json({ error: "Accès interdit" }, { status: 401 });
    }

    const body = await req.json();

    const items: CheckoutItem[] = body.items;
    const shippingAddress = body.shippingAddress;
    const billingAddress = body.billingAddress;
    const idempotencyKey = body.idempotencyKey;

    if (!idempotencyKey) {
      return NextResponse.json(
        { error: "Idempotency key manquante" },
        { status: 400 }
      );
    }

    if (!items || items.length === 0) {
      return NextResponse.json(
        { error: "Le panier est vide" },
        { status: 400 }
      );
    }

    if (
      items.some(
        (item) => !item.variantId || !Number.isInteger(item.quantity) || item.quantity < 1
      )
    ) {
      return NextResponse.json({ error: "Panier invalide" },{ status: 400 });
    }

    const variantIds = items.map((item) => item.variantId);
    const uniqueVariantIds = new Set(variantIds);

    if (uniqueVariantIds.size !== items.length) {
      return NextResponse.json({ error: "Variantes dupliquées" },{ status: 400 }
      );
    }

    const variants = await prisma.productVariant.findMany({
      where: {
        id: {
          in: variantIds,
        },
        isActive: true,
        product: {
          isActive: true,
        },
      },
      include: {
        product: true,
      },
    });

    if (variants.length !== items.length) {
      return NextResponse.json({ error: "Variante manquante ou inactive" },{ status: 400 });
    }

    const variantsMap = new Map(variants.map((variant) => [variant.id, variant]));

    const enrichedItems = items.map((item) => {
      const variant = variantsMap.get(item.variantId);

      if (!variant) {
        throw new Error("Variante introuvable");
      }

      if (variant.price <= 0) {
        throw new Error(`Prix invalide pour ${variant.product.name}`);
      }

      const availableStock = variant.stockOnHand - variant.stockReserved;

      if (item.quantity > availableStock) {
        throw new Error(`Stock insuffisant pour ${variant.product.name}`);
      }

      return {
        variant,
        quantity: item.quantity,
      };
    });

    const subtotalAmount = enrichedItems.reduce((total, { variant, quantity }) => {
      return total + variant.price * quantity;
    }, 0);

    const shippingAmount = 0;
    const taxAmount = 0;
    const discountAmount = 0;
    const totalAmount =
      subtotalAmount + shippingAmount + taxAmount - discountAmount;

    const lineItems = enrichedItems.map(({ variant, quantity }) => ({
      price_data: {
        currency: variant.currency,
        product_data: {
          name: `${variant.product.name} - ${variant.name}`,
          images: variant.imageUrl ? [variant.imageUrl] : [],
        },
        unit_amount: variant.price,
      },
      quantity,
    }));

    const order = await prisma.$transaction(async (tx) => {
      for (const { variant, quantity } of enrichedItems) {
        const updatedStock = await tx.productVariant.updateMany({
          where: {
            id: variant.id,
            stockOnHand: {
              gte: quantity,
            },
          },
          data: {
            stockReserved: {
              increment: quantity,
            },
          },
        });

        if (updatedStock.count === 0) {
          throw new Error(`Stock insuffisant pour ${variant.product.name}`);
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
      });
    });

    const checkoutSession = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: lineItems,
        success_url: `${process.env.NEXT_PUBLIC_APP_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}&order_id=${order.id}`,
        cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/checkout/cancel`,
        metadata: {
          orderId: order.id,
          userId: session.user.id,
        },
        expires_at: Math.floor(Date.now() / 1000) + 15 * 60,
      },
      {
        idempotencyKey: `checkout:${idempotencyKey}`,
      }
    );

    if (!checkoutSession.url) {
      return NextResponse.json(
        { error: "Impossible de créer la session Stripe" },
        { status: 500 }
      );
    }

    await prisma.payment.create({
      data: {
        orderId: order.id,
        provider: "stripe",
        providerSessionId: checkoutSession.id,
        status: "PENDING",
        amount: totalAmount,
        currency: "eur",
      },
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (error) {
    console.error(error);

    if (error instanceof Error) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: "Erreur lors de la création du checkout" },
      { status: 500 }
    );
  }
}
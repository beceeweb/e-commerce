import { stripe } from "@/lib/payment/stripe";
import { auth } from "@/lib/auth/auth";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/database/prisma";


export async function POST (req: NextRequest){
    try{
        // Faire matcher la route avec le proxy 
        // Verifier la session si le proxy laisse passer 
        const session = await auth.api.getSession({
            headers: req.headers
        })

        if(!session){
            return NextResponse.json({ error: 'Accés interdit'}, {status:401})
        }

        // Recuperer les données envoyées du front 

        const body = await req.json()
        const items: {productId: string, quantity: number}[] = body.items

        if (!items || items.length === 0) {
        return NextResponse.json({ error: "Le panier est vide" }, { status: 400 });
        }
        if (items.some((item) => item.quantity < 1)) {
            return NextResponse.json({ error: "Quantité invalide" }, { status: 400 });
        }

        // On recupere les produits envoyés dans la db

        const productsId = items.map((item) => item.productId)
        const products = await prisma.product.findMany({
            where: {
                id: {in: productsId},
                isActive: true
            }
        })

        // on crée une map : on a products : [{..., ...}, {..., ...}] et on crée avec un array du style : [["a": {..., ...}], ["b": {..., ...}]] ou a, b sont des clés et {..., ...} sont des valeurs
        const productsMap = new Map(products.map (product=>[product.id, product]))
        const enrichedItems = items.map((item)=>{
            const product = productsMap.get(item.productId)

            if (!product) {
                throw new Error("Produit introuvable");
            }
            return {
                product, 
                quantity : item.quantity
            }
        })


        const lineItems = enrichedItems.map(({product, quantity})=>{
                return {
                    // On créé un nouvel objet price_data auquel on attribue toutes les données de product
                    price_data: {
                    currency: product.currency,
                    product_data: {
                        name: product.name,
                        images: product.imageUrl ? [product.imageUrl] : [],
                    },
                    unit_amount: product.price,
                    },
                    quantity
                };
            })

        const totalAmount = enrichedItems.reduce((total, {product, quantity}) => {
            return total + product.price * quantity
        }, 0)

        const order = await prisma.order.create({
            data:{
                userId: session.user.id, 
                email: session.user.email, 
                amountTotal : totalAmount, 
                currency: "eur",
                items: {
                    create: enrichedItems.map(({product, quantity})=>({
                    quantity, 
                    unitPrice: product.price, 
                    productName: product.name, 
                    productImageUrl: product.imageUrl,
                    productId: product.id, 
                    }))
                }
            }
        })
        const checkoutSession = await stripe.checkout.sessions.create({
            mode: "payment", 
            line_items: lineItems, 
            success_url: `${process.env.NEXT_PUBLIC_APP_URL}/checkout/success`,
            cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/checkout/cancel`,
            metadata: {
                orderId: order.id,
                userId: session.user.id
            }
        })
        if (!checkoutSession.url) {
            return NextResponse.json({ error: "Impossible de créer la session Stripe" },{ status: 500 });
        }
        return NextResponse.json({url: checkoutSession.url})
        }
    catch(error){
        console.error(error);
        return NextResponse.json({ error: "Erreur lors de la création du checkout" },{ status: 500 }
        );
    }
}
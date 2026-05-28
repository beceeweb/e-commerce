import { stripe } from "@/lib/payment/stripe";
import { auth } from "@/lib/auth/auth";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/database/prisma";
import { Product } from "@/lib/database/generated/prisma/client";


export async function POST (req: NextRequest){

    let order: Awaited<ReturnType<typeof prisma.order.create>> | null = null;
    let enrichedItems: { product: Product, quantity: number }[] = [];

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
        const items: { productId: string, quantity: number }[] = body.items
        const shippingAddress: string = body.shippingAddress
        const billingAddress: string = body.billingAddress 
        const idempotencyKey = body.idempotencyKey


        if(!idempotencyKey){
            return NextResponse.json({error : 'Idempotency Key manquante'}, {status:400})
        }
        const existingOrder = await prisma.order.findFirst({
            where: {
                userId: session.user.id,
                idempotencyKey,
                status: 'PENDING'
            }
        })
        if(existingOrder?.stripeSessionId){
            const existingStripeSession = await stripe.checkout.sessions.retrieve(
                existingOrder.stripeSessionId
            )
            if(existingStripeSession.url){
                return NextResponse.json({url : existingStripeSession.url})
            }
        }


        if (!items || items.length === 0) {
        return NextResponse.json({ error: "Le panier est vide" }, { status: 400 });
        }
        if (items.some((item) => item.quantity < 1)) {
            return NextResponse.json({ error: "Quantité invalide" }, { status: 400 });
        }

        // On recupere les produits envoyés dans la db

        const productsId = items.map((item) => item.productId)
        const uniqueIds = new Set(productsId) // new Set() permet de creer un tableau sans doublons
        if(uniqueIds.size !== items.length){
            return NextResponse.json({ error: "Produits dupliqués" }, { status: 400 })
        }

        const products = await prisma.product.findMany({
            where: {
                id: {in: productsId},
                isActive: true
            }
        })
        
        if(products.length !== items.length){
            return NextResponse.json({error: 'Produit manquant'}, {status:400})
        }
        
        // on crée une map : on a products : [{..., ...}, {..., ...}] et on crée avec un array du style : [["a": {..., ...}], ["b": {..., ...}]] ou a, b sont des clés et {..., ...} sont des valeurs
        const productsMap = new Map(products.map (product=>[product.id, product]))
        enrichedItems = items.map((item)=>{
            const product = productsMap.get(item.productId)

            if (!product) {
                throw new Error("Produit introuvable");
            }
            if(!Number.isInteger(item.quantity) || item.quantity < 1){
                throw new Error('Quantité invalide')
            }
            if(product.price <= 0){
                throw new Error(`Prix invalide pour ${product.name}`)
            }
            if(item.quantity > product.stockOnHand){
                throw new Error(`Stock insuffisant pour ${product.name}`)
            }
            return {
                product, 
                quantity : item.quantity
            }
        })


        const lineItems = enrichedItems.map(({product, quantity})=>{
            if(product.stockOnHand===0){
                throw new Error(`${product.name} n'est pas disponible`)
            }
                return {
                    // On créé un nouvel objet price_data auquel on attribue toutes les données de product
                    price_data: {
                    currency: 'eur',
                    product_data: {
                        name: product.name,
                        images: product.imageUrl ? [product.imageUrl] : [],
                    },
                    unit_amount: product.price,
                    },
                    quantity
                };
            })
        

        const amountCalcul = enrichedItems.reduce((total, {product, quantity}) => {
            const totalAmount = total + product.price * quantity
            const taxes = total + product.discount
        }, 0)


        order = await prisma.$transaction(async(tx)=>{
            // Verifier et decrementer le stock
            for(const {product, quantity} of enrichedItems){
                const updatedStock = await tx.product.updateMany({
                    where:{
                        id: product.id,
                        stock: {gte: quantity}
                    },
                    data:{
                        stock: {decrement: quantity}
                    }
                })
                if (updatedStock.count === 0) {
                    throw new Error(`Stock insuffisant pour ${product.name}`)
                }
            }
            return tx.order.create({
                data:{
                    status: "PENDING",
                    userId: session.user.id, 
                    email: session.user.email, 
                    currency: "eur",
                    shippingAmount,
                    taxAmount,
                    discountAmount,
                    subtotalAmount
                    shippingAddress, 
                    amountTotal : totalAmount, 
                    billingAddress,
                    idempotencyKey,
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
        
        })

        const checkoutSession = await stripe.checkout.sessions.create({
                mode: "payment", 
                line_items: lineItems, 
                success_url: `${process.env.NEXT_PUBLIC_APP_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}&order_id=${order.id}`,
                cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/checkout/cancel`,
                metadata: {
                    orderId: order.id,
                    userId: session.user.id
                },
                expires_at: Math.floor(Date.now()/1000)+15*60,
            },
            {
                idempotencyKey: `checkout:${idempotencyKey}`
            }
        )
        
        if (!checkoutSession.url) {
            return NextResponse.json({ error: "Impossible de créer la session Stripe" },{ status: 500 });
        }
        await prisma.order.update({
            where: {id: order.id}, 
            data:{
                stripeSessionId: checkoutSession.id
            }
        })
        return NextResponse.json({url: checkoutSession.url})
        }
    catch(error){
        console.error(error);
        if(order?.id){
            await prisma.$transaction(async(tx)=>{
                const updatedOrder = await tx.order.updateMany({
                where: {
                    id : order?.id,
                    status: 'PENDING'
                },
                data:{
                    status: 'FAILED'
                }
            })
            if(updatedOrder.count === 0) return
            for(const {product, quantity} of enrichedItems){
                await tx.product.update({
                    where: {
                        id: product.id,
                    },
                    data:{
                        stock: {increment: quantity}
                    }
                })
            }
           })
        }
        if (error instanceof Error && ["Produit introuvable", "n'est pas disponible", `Stock insuffisant`].some(m => error.message.includes(m))) {
            return NextResponse.json({ error: error.message }, { status: 400 })
        }
        return NextResponse.json({ error: "Erreur lors de la création du checkout" },{ status: 500 }
        );
    }
}
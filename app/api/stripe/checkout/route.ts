import { stripe } from "@/lib/payment/stripe";
import { auth } from "@/lib/auth/auth";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/database/prisma";
import { error } from "console";


export async function POST (req: NextRequest){

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

    // On recupere les produits envoyés dans la db

    const productsId = items.map((item) => item.productId)
    const products = await prisma.product.findMany({
        where: {
            id: {in: productsId},
            isActive: true
        }
    })
    if(!products){
        return NextResponse.json({error: 'Produits introuvables'}, {status: 400})
    }

    const lineItems = ()=>{
        items.map((item)=>{
            const product = products.find((p)=>p.id === item.productId)
            if(!product){
                throw new Error('Produit introuvable ')
            }
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
                quantity: item.quantity,
            };
        })
    }
}
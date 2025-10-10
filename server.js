import express from 'express';
import fetch from 'node-fetch'; // Necesitarás instalar node-fetch v2: npm install node-fetch@2
import dotenv from 'dotenv';
import path from 'path';
import checkoutNodeJssdk from '@paypal/checkout-server-sdk';

// Cargar variables de entorno desde el archivo .env
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// PASO CRÍTICO: El middleware para parsear JSON debe ir primero para procesar req.body.
// Middleware para parsear JSON (con un límite mayor para las imágenes). Debe ir ANTES de las rutas que lo usan.
app.use(express.json({ limit: '50mb' }));

const API_KEY = process.env.GEMINI_API_KEY;

// Stripe configuration (optional)
let stripe;
try {
    const Stripe = (await import('stripe')).default;
    if (process.env.STRIPE_SECRET_KEY) {
        stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
        console.log('✅ Stripe configurado correctamente');
    } else {
        console.log('⚠️ STRIPE_SECRET_KEY no encontrada - funciones de pago deshabilitadas');
    }
} catch (error) {
    console.log('⚠️ Stripe no instalado - funciones de pago deshabilitadas');
}

// PayPal configuration
let paypalClient;
try {
    console.log('🔵 Configurando PayPal...');
    console.log('PAYPAL_CLIENT_ID existe:', !!process.env.PAYPAL_CLIENT_ID);
    console.log('PAYPAL_CLIENT_SECRET existe:', !!process.env.PAYPAL_CLIENT_SECRET);
    console.log('PAYPAL_ENVIRONMENT:', process.env.PAYPAL_ENVIRONMENT);
    
    if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET) {
        // Configurar el entorno de PayPal
        let environment;
        if (process.env.PAYPAL_ENVIRONMENT === 'live') {
            environment = new checkoutNodeJssdk.core.LiveEnvironment(
                process.env.PAYPAL_CLIENT_ID, 
                process.env.PAYPAL_CLIENT_SECRET
            );
            console.log('🟢 Usando entorno LIVE de PayPal');
        } else {
            environment = new checkoutNodeJssdk.core.SandboxEnvironment(
                process.env.PAYPAL_CLIENT_ID, 
                process.env.PAYPAL_CLIENT_SECRET
            );
            console.log('🟡 Usando entorno SANDBOX de PayPal');
        }
        
        paypalClient = new checkoutNodeJssdk.core.PayPalHttpClient(environment);
        console.log('✅ PayPal configurado correctamente (' + (process.env.PAYPAL_ENVIRONMENT || 'sandbox') + ')');
    } else {
        console.log('⚠️ Credenciales de PayPal no encontradas - funciones de pago PayPal deshabilitadas');
        console.log('CLIENT_ID presente:', !!process.env.PAYPAL_CLIENT_ID);
        console.log('CLIENT_SECRET presente:', !!process.env.PAYPAL_CLIENT_SECRET);
    }
} catch (error) {
    console.log('❌ Error configurando PayPal:', error.message);
    console.log('Error stack:', error.stack);
}

// Endpoint que recibirá las peticiones desde tu página web
app.post('/api/generate', async (req, res) => {
    if (!API_KEY) {
        return res.status(500).json({ error: { message: 'La API Key de Gemini no está configurada en el servidor.' } });
    }

    // Lógica de Selección de Modelo (Ahora req.body está disponible)
    // Determinar si el payload contiene datos de imagen (para combinación/edición)
    const hasImage = req.body.contents?.[0]?.parts?.some(part => part.inlineData);
    let model;

    if (hasImage) {
        // Modelo multimodal para combinación y edición de imágenes
        model = 'gemini-2.5-flash-image-preview';
    } else {
        // Modelo de texto para tareas de prompt rewrite (rápido y económico)
        model = 'gemini-2.5-flash-preview-05-20';
    }

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
    console.log(`[PROXY] Generando contenido con el modelo: ${model}`);

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(req.body), // Reenviar el payload del cliente
        });

        // Reenviar Respuesta y Errores de Google
        const data = await response.json();

        if (!response.ok) {
            // Reenviar el error de Google al cliente con el código de estado correcto
            return res.status(response.status).json(data);
        }

        res.json(data);

    } catch (error) {
        console.error('Error al contactar con la API de Google o error interno:', error);
        res.status(500).json({ error: { message: 'Error interno del servidor proxy. Revisa los logs.' } });
    }
});

// Endpoint para crear sesiones de checkout de Stripe
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        if (!stripe) {
            return res.status(500).json({ error: 'Stripe no está configurado en el servidor' });
        }

        const { priceId, userId, plan } = req.body;

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price: priceId || 'price_1234567890', // Replace with your actual Stripe price ID
                quantity: 1,
            }],
            mode: 'subscription',
            success_url: `${req.headers.origin}?payment=success&plan=${plan}&userId=${userId}`,
            cancel_url: `${req.headers.origin}?payment=cancelled`,
            metadata: {
                userId: userId,
                plan: plan
            }
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Error creating checkout session:', error);
        res.status(500).json({ error: 'Error creando sesión de pago' });
    }
});

// Webhook para manejar eventos de Stripe
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), (req, res) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
        return res.status(400).send('Webhook not configured');
    }

    const sig = req.headers['stripe-signature'];
    
    try {
        const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
        
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            console.log('Payment successful for user:', session.metadata.userId);
            // Here you would update your database to mark the user as premium
        }
        
        res.json({ received: true });
    } catch (error) {
        console.error('Webhook signature verification failed:', error);
        res.status(400).send('Webhook Error');
    }
});

// PayPal endpoints
// Crear orden de PayPal
app.post('/api/paypal/create-order', async (req, res) => {
    console.log('🔵 PayPal create-order request received');
    console.log('Request body:', req.body);
    console.log('PayPal environment:', process.env.PAYPAL_ENVIRONMENT);
    console.log('PayPal client configured:', !!paypalClient);
    
    try {
        if (!paypalClient) {
            console.error('❌ PayPal client not configured');
            return res.status(500).json({ error: 'PayPal no está configurado en el servidor' });
        }

        const { amount, currency, userId, plan } = req.body;
        console.log('Order details:', { amount, currency, userId, plan });

        const request = new checkoutNodeJssdk.orders.OrdersCreateRequest();
        request.prefer("return=representation");
        
        const orderData = {
            intent: 'CAPTURE',
            purchase_units: [{
                amount: {
                    currency_code: currency || 'USD',
                    value: amount.toString()
                },
                description: `Suscripción ${plan} - Usuario ${userId}`
            }],
            application_context: {
                return_url: `${req.headers.origin}?payment=success&plan=${plan}&userId=${userId}`,
                cancel_url: `${req.headers.origin}?payment=cancelled`,
                user_action: 'PAY_NOW'
            }
        };
        
        console.log('PayPal order data:', JSON.stringify(orderData, null, 2));
        request.requestBody(orderData);

        console.log('⏳ Executing PayPal order creation...');
        const response = await paypalClient.execute(request);
        console.log('✅ PayPal order created successfully');
        console.log('Order response:', response.result);

        res.json({ 
            orderID: response.result.id,
            status: response.result.status
        });

    } catch (error) {
        console.error('❌ Error creating PayPal order:', error);
        console.error('Error details:', {
            message: error.message,
            stack: error.stack,
            statusCode: error.statusCode
        });
        res.status(500).json({ 
            error: 'Error creando orden de PayPal',
            details: error.message
        });
    }
});

// Capturar pago de PayPal
app.post('/api/paypal/capture-order', async (req, res) => {
    try {
        if (!paypalClient) {
            return res.status(500).json({ error: 'PayPal no está configurado en el servidor' });
        }

        const { orderID } = req.body;

        const request = new checkoutNodeJssdk.orders.OrdersCaptureRequest(orderID);
        request.prefer("return=representation");
        request.requestBody({});

        const response = await paypalClient.execute(request);

        if (response.result.status === 'COMPLETED') {
            const payerInfo = response.result.payer;
            console.log('PayPal payment successful for:', payerInfo.email_address);
            
            res.json({ 
                success: true,
                orderID: response.result.id,
                payerInfo: payerInfo
            });
        } else {
            res.status(400).json({ error: 'El pago no se pudo completar' });
        }

    } catch (error) {
        console.error('Error capturing PayPal payment:', error);
        res.status(500).json({ error: 'Error procesando pago de PayPal' });
    }
});

// Endpoint para obtener configuración de PayPal
app.get('/api/paypal/config', (req, res) => {
    res.json({
        clientId: process.env.PAYPAL_CLIENT_ID,
        environment: process.env.PAYPAL_ENVIRONMENT || 'sandbox'
    });
});

// Endpoint de diagnóstico para verificar configuración
app.get('/api/status', (req, res) => {
    res.json({
        paypal: {
            configured: !!paypalClient,
            environment: process.env.PAYPAL_ENVIRONMENT || 'sandbox',
            hasClientId: !!process.env.PAYPAL_CLIENT_ID,
            hasClientSecret: !!process.env.PAYPAL_CLIENT_SECRET,
            clientIdLength: process.env.PAYPAL_CLIENT_ID ? process.env.PAYPAL_CLIENT_ID.length : 0
        },
        server: {
            nodeVersion: process.version,
            timestamp: new Date().toISOString()
        }
    });
});

// Middleware para servir archivos estáticos (como tu index.html). Debe ir DESPUÉS de las rutas de la API.
app.use(express.static(path.resolve()));

app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
    console.log('Abre tu aplicación en esa dirección para probarla.');
});

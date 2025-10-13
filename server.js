import express from 'express';
import fetch from 'node-fetch'; // Necesitarás instalar node-fetch v2: npm install node-fetch@2
import dotenv from 'dotenv';
import path from 'path';
import checkoutNodeJssdk from '@paypal/checkout-server-sdk';
import { GoogleAuth } from 'google-auth-library';

// Cargar variables de entorno desde el archivo .env
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// PASO CRÍTICO: El middleware para parsear JSON debe ir primero para procesar req.body.
// Middleware para parsear JSON (con un límite mayor para las imágenes). Debe ir ANTES de las rutas que lo usan.
app.use(express.json({ limit: '50mb' }));

const GOOGLE_CLOUD_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID;

// Configurar autenticación de Google para Vertex AI
// En Render, usar Service Account Key desde variable de entorno
const auth = new GoogleAuth({
    scopes: 'https://www.googleapis.com/auth/cloud-platform',
    // En Render, configurar GOOGLE_APPLICATION_CREDENTIALS_JSON como variable de entorno
    credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ? 
        JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) : undefined
});


// Sistema de tracking de uso por usuario
const userUsage = new Map(); // Formato: userId -> { totalUsed: count, isPremium: boolean, registrationDate: date }

// Función para obtener límites TOTALES (no diarios)
function getUserLimits(userId, isPremium = false) {
    if (!userUsage.has(userId)) {
        userUsage.set(userId, {
            totalUsed: 0,
            isPremium: isPremium,
            registrationDate: new Date().toISOString()
        });
    }
    
    const userData = userUsage.get(userId);
    const freeLimitTotal = 10;       // 10 generaciones gratis TOTALES para siempre
    const premiumLimitDaily = 10;    // 10 generaciones diarias para usuarios premium
    
    if (isPremium) {
        // Para premium: límite diario que se resetea
        const today = new Date().toDateString();
        if (!userData.lastResetPremium || userData.lastResetPremium !== today) {
            userData.dailyPremiumUsed = 0;
            userData.lastResetPremium = today;
        }
        
        return {
            used: userData.dailyPremiumUsed || 0,
            limit: premiumLimitDaily,
            remaining: premiumLimitDaily - (userData.dailyPremiumUsed || 0),
            canGenerate: (userData.dailyPremiumUsed || 0) < premiumLimitDaily,
            isPremium: true,
            totalUsedEver: userData.totalUsed
        };
    } else {
        // Para gratuitos: límite total de por vida
        return {
            used: userData.totalUsed,
            limit: freeLimitTotal,
            remaining: freeLimitTotal - userData.totalUsed,
            canGenerate: userData.totalUsed < freeLimitTotal,
            isPremium: false,
            isFreeLimitExhausted: userData.totalUsed >= freeLimitTotal
        };
    }
}

// Función para incrementar el uso
function incrementUsage(userId, isPremium = false) {
    if (userUsage.has(userId)) {
        const userData = userUsage.get(userId);
        userData.totalUsed++; // Siempre incrementar total
        
        if (isPremium) {
            userData.dailyPremiumUsed = (userData.dailyPremiumUsed || 0) + 1;
        }
        
        userUsage.set(userId, userData);
    }
}

// Stripe configuration (optional)
let stripe;
try {
    const Stripe = (await import('stripe')).default;
    if (process.env.STRIPE_SECRET_KEY) {
        stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
        console.log('✅ Stripe configurado correctamente');
    } else {
        // Stripe no configurado: funciones de pago por Stripe deshabilitadas
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

// Presets de calidad para Vertex AI
const VERTEX_QUALITY_PRESETS = {
    fast: { guidanceScale: 6 },
    standard: { guidanceScale: 7.5 },
    ultra: { guidanceScale: 9 }
};

// Endpoint que recibirá las peticiones desde tu página web
app.post('/api/generate', async (req, res) => {
    // Requerimos al menos el ID de proyecto para usar Vertex AI
    if (!GOOGLE_CLOUD_PROJECT_ID) {
        return res.status(500).json({ error: { message: 'Falta GOOGLE_CLOUD_PROJECT_ID para usar Vertex AI.' } });
    }

    // Control de límites por usuario
    const userId = req.body.userId || 'anonymous';
    const isPremium = req.body.isPremium || false;
    const limits = getUserLimits(userId, isPremium);

    if (!limits.canGenerate) {
        return res.status(429).json({ 
            error: { 
                message: isPremium 
                    ? `Límite diario premium alcanzado (${limits.used}/${limits.limit}). Se resetea mañana a medianoche.`
                    : `🚫 ¡Se acabaron tus ${limits.limit} generaciones gratuitas! Para seguir creando increíbles imágenes con IA, actualiza a Premium por solo $9.99/mes y genera 10 imágenes diarias sin marca de agua.`,
                code: 'QUOTA_EXCEEDED',
                limits: limits,
                isPermanentLimit: !isPremium
            } 
        });
    }

    // Selección de calidad con tope de costo por generación (ahora $0.06 para permitir 'ultra')
    const hasQualityParam = typeof req.body.imageQuality === 'string';
    const requestedQuality = hasQualityParam ? String(req.body.imageQuality).toLowerCase() : 'standard';
    const priceByQuality = { fast: 0.02, standard: 0.04, ultra: 0.06 };
    const budgetPerGeneration = 0.06;
    let selectedQuality = requestedQuality;
    if (!priceByQuality[selectedQuality] || priceByQuality[selectedQuality] > budgetPerGeneration) {
        // Elegir la mejor calidad dentro del presupuesto (ultra si está ≤ presupuesto, si no standard, si no fast)
        if (priceByQuality.ultra <= budgetPerGeneration) selectedQuality = 'ultra';
        else if (priceByQuality.standard <= budgetPerGeneration) selectedQuality = 'standard';
        else selectedQuality = 'fast';
        console.log(`[QUALITY] Solicitada: ${requestedQuality} -> Aplicada: ${selectedQuality} (tope $${budgetPerGeneration.toFixed(2)})`);
    }

    // Forzar Vertex AI para toda generación (texto→imagen o edición)
    let model = 'imagen-3.0-generate-001';
    const location = 'us-central1';
    let apiUrl, headers;
    let isVertexAI = true;
    try {
        // Obtener el token de acceso para Vertex AI
        const client = await auth.getClient();
        const accessToken = (await client.getAccessToken()).token;

        apiUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${GOOGLE_CLOUD_PROJECT_ID}/locations/${location}/publishers/google/models/${model}:predict`;
        headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}` // Usar el token de acceso real
        };
        console.log(`[API] Usando Vertex AI para generación de imágenes: ${model}`);
    } catch (authError) {
        console.error('Error de autenticación con Vertex AI:', authError.message);
        return res.status(401).json({ 
            error: { 
                message: 'Error de autenticación con Vertex AI. Verifica las credenciales.',
                details: authError.message
            } 
        });
    }
    console.log(`[PROXY] Generando contenido con el modelo: ${model}`);

    try {
        let apiRequestBody;

        if (isVertexAI) {
            // Vertex AI tiene un formato de body específico para 'imagen-3.0-generate-001'
            let promptText = req.body.contents?.[0]?.parts?.find(p => p.text)?.text || '';
            // Mejorar calidad según la selección aplicada con presupuesto (por defecto 'standard')
            const qualityLevel = selectedQuality || 'standard';

            // Detección simple de retratos/personas para activar refuerzos anti-deformaciones faciales
            const faceKeywords = /(cara|rostro|retrato|selfie|headshot|perfil|primer\s*plano|persona|hombre|mujer|niñ[oa]|face|portrait|head\s*shot)/i;
            const isPortraitLike = faceKeywords.test(promptText);

            // Contexto base (ES) para mejorar coherencia/calidad general
            const baseContext = `Eres un generador de imágenes enfocado en calidad fotográfica, realismo anatómico y consistencia visual.
Mantén los rasgos faciales, ropa y entorno iguales entre generaciones.
Evita deformaciones, duplicación de extremidades o inconsistencias.
Cuando se edite una imagen, toma como base la versión más reciente.
Integra overlays o imágenes flotantes con luz y perspectiva naturales.
Usa composición profesional, iluminación realista y fondo limpio.
Prohíbe texto visible, logos o marcas.
Preserva proporciones humanas reales y evita artefactos visuales.`;

            // Refuerzo de retrato para evitar deformaciones en rostro y ojos
            const portraitContext = isPortraitLike ? `
Enfócate en un rostro simétrico y natural: ojos bien alineados y centrados, iris y pupilas redondas, mirada realista, dientes naturales sin exceso, boca proporcionada, nariz y orejas con forma correcta. Piel con textura natural (sin efecto plástico o encerado), poros sutiles, tonos realistas y sin sobrealisado. Mantén proporciones faciales correctas (tercios faciales) y evita cualquier distorsión de ojos o boca. Iluminación suave de retrato tipo estudio (lente equivalente 85mm).` : '';

            const qualitySuffixMap = {
                fast: '',
                standard: ' Renderiza con alto nivel de detalle, enfoque nítido, iluminación realista, texturas naturales, anatomía correcta y composición limpia.',
                ultra: ' Ultra detallada, alta resolución, fotorrealista, iluminación cinematográfica, textura de piel natural, anatomía correcta, enfoque nítido, alto rango dinámico y composición limpia.'
            };
            const qualitySuffix = qualitySuffixMap[qualityLevel] || '';

            // Construir prompt mejorado
            const mergedContext = [baseContext, portraitContext].filter(Boolean).join('\n\n');
            if (qualitySuffix || mergedContext) {
                promptText = `${mergedContext}\n\n${promptText}\n${qualitySuffix}`.trim();
            }
            // Detectar si viene una imagen inline desde el frontend
            const inlineImagePart = req.body.contents?.[0]?.parts?.find(p => p.inlineData);
            const imageBase64 = inlineImagePart?.inlineData?.data;

            // Construir instancia dinámicamente: sólo incluir 'image' si hay datos válidos
            const instance = { prompt: promptText };
            if (typeof imageBase64 === 'string' && imageBase64.trim().length > 0) {
                instance.image = { bytesBase64Encoded: imageBase64 };
            } else {
                // No incluir campo 'image' cuando no se envía una imagen (texto a imagen)
                console.log('[VertexAI] Generación sin imagen adjunta (texto → imagen)');
            }

            // Validar y aplicar relación de aspecto. Para retratos, por defecto 3:4 si no viene uno válido.
            const allowedRatios = new Set(['1:1','3:4','4:3','16:9','9:16']);
            const defaultRatio = isPortraitLike ? '3:4' : '1:1';
            const requestedRatio = (req.body.aspectRatio || defaultRatio);
            const appliedRatio = allowedRatios.has(requestedRatio) ? requestedRatio : defaultRatio;

            const vertexPreset = VERTEX_QUALITY_PRESETS[qualityLevel] || VERTEX_QUALITY_PRESETS.standard;

            apiRequestBody = {
                instances: [instance],
                parameters: {
                    sampleCount: 1,
                    aspectRatio: appliedRatio,
                    safetyFilterLevel: 'block_some',
                    personGeneration: 'allow_adult',
                    guidanceScale: vertexPreset.guidanceScale,
                    negativePrompt: (function(){
                        const baseNeg = [
                            'blurry, low quality, lowres, artifacts, jpeg artifacts, watermark, text, logo, cropped, out of frame',
                            'deformed, distorted, bad anatomy, wrong proportions, extra limbs, extra fingers',
                            'borroso, baja calidad, baja resolución, artefactos, marca de agua, texto, logotipo, recortado, fuera de cuadro',
                            'deformado, distorsionado, mala anatomía, proporciones incorrectas, extremidades extra, dedos extra'
                        ];
                        const faceNeg = [
                            'deformed face, melted face, disfigured, misshapen face, wrong facial proportions, lopsided face',
                            'asymmetrical eyes, crossed eyes, wonky eyes, misaligned eyes, lazy eye, extra eyes, missing eyes, bad eyes, bad pupils, bad iris',
                            'distorted mouth, extra teeth, bad teeth, fused lips, malformed nose, deformed ears, waxy skin, plastic skin, over-smoothed skin',
                            'rostro deformado, cara deformada, desfigurado, proporciones faciales incorrectas, rostro torcido',
                            'ojos asimétricos, ojos bizcos, ojos desalineados, ojo perezoso, ojos extra, ojos faltantes, pupilas mal formadas, iris mal formados',
                            'boca deformada, dientes extra, dientes mal formados, labios fusionados, nariz malformada, orejas deformes, piel de cera, piel plástica, piel sobrealisada'
                        ];
                        return (isPortraitLike ? baseNeg.concat(faceNeg) : baseNeg).join(', ');
                    })()
                }
            };
        }
        console.log(`[DEBUG] Enviando request a: ${apiUrl}`);

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(apiRequestBody),
        });

        // Reenviar Respuesta y Errores de Google
        const data = await response.json();

        if (!response.ok) {
            console.error('Error de la API de Google:', data);
            // Reenviar el error de Google al cliente con el código de estado correcto
            return res.status(response.status).json(data);
        }

        // Incrementar contador solo si la generación fue exitosa
        incrementUsage(userId, isPremium);
        
        // Adaptar la respuesta de Vertex AI al formato esperado por el frontend
        let finalResponseData = data;
        if (isVertexAI) {
            if (data.predictions && data.predictions[0]) {
                // Para imagen-3.0-generate-001, la respuesta puede tener diferentes estructuras
                const prediction = data.predictions[0];
                let imageData = null;
                
                if (prediction.bytesBase64Encoded) {
                    imageData = prediction.bytesBase64Encoded;
                } else if (prediction.image && prediction.image.bytesBase64Encoded) {
                    imageData = prediction.image.bytesBase64Encoded;
                } else if (prediction.generatedImage) {
                    imageData = prediction.generatedImage;
                }
                
                if (imageData) {
                    finalResponseData = {
                        candidates: [{
                            content: {
                                parts: [{
                                    inlineData: {
                                        mimeType: 'image/png',
                                        data: imageData
                                    }
                                }]
                            },
                            finishReason: 'STOP'
                        }]
                    };
                }
            }
        }

        // Agregar información de límites a la respuesta
        const updatedLimits = getUserLimits(userId, isPremium);
        const responseWithLimits = {
            ...finalResponseData,
            usage: {
                used: updatedLimits.used,
                remaining: updatedLimits.remaining,
                limit: updatedLimits.limit,
                isPremium: isPremium,
                effectiveQuality: selectedQuality,
                pricePerGeneration: selectedQuality ? (priceByQuality[selectedQuality] || null) : null
            }
        };

        res.json(responseWithLimits);

    } catch (error) {
        console.error('Error al contactar con la API de Google o error interno:', error);
        res.status(500).json({ error: { message: 'Error interno del servidor proxy. Revisa los logs.' } });
    }
});

// Endpoint para consultar límites de usuario
app.get('/api/limits/:userId', (req, res) => {
    const { userId } = req.params;
    const isPremium = req.query.premium === 'true';
    const limits = getUserLimits(userId, isPremium);
    
    res.json({
        success: true,
        limits: limits,
        resetTime: new Date(new Date().setHours(24, 0, 0, 0)).toISOString() // Medianoche del próximo día
    });
});
// Endpoint para resetear límites de usuario (desarrollo/testing)
app.post('/api/reset-limits/:userId', (req, res) => {
    const { userId } = req.params;
    
    // Eliminar del mapa para forzar reinicio
    if (userUsage.has(userId)) {
        userUsage.delete(userId);
    }
    
    // Obtener nuevos límites
    const isPremium = req.body.isPremium || false;
    const newLimits = getUserLimits(userId, isPremium);
    
    res.json({
        success: true,
        message: `Límites reseteados para usuario ${userId}`,
        limits: newLimits
    });
});

// Endpoint para limpiar TODOS los datos (testing)
app.post('/api/debug/clear-all', (req, res) => {
    userUsage.clear(); // Limpiar todo el mapa de usuarios
    res.json({
        success: true,
        message: 'Todos los datos de usuarios han sido limpiados'
    });
});

// Endpoint para obtener información de todos los usuarios (debugging)
app.get('/api/debug/users', (req, res) => {
    const allUsers = [];
    userUsage.forEach((userData, userId) => {
        allUsers.push({
            userId: userId,
            data: userData
        });
    });
    
    res.json({
        success: true,
        totalUsers: allUsers.length,
        users: allUsers,
        serverTime: new Date().toISOString()
    });
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

import express from 'express';
import fetch from 'node-fetch'; // Necesitarás instalar node-fetch v2: npm install node-fetch@2
import dotenv from 'dotenv';
import path from 'path';

// Cargar variables de entorno desde el archivo .env
dotenv.config();

const app = express();
const port = 3000;

// PASO CRÍTICO: El middleware para parsear JSON debe ir primero para procesar req.body.
// Middleware para parsear JSON (con un límite mayor para las imágenes). Debe ir ANTES de las rutas que lo usan.
app.use(express.json({ limit: '50mb' }));

const API_KEY = process.env.GEMINI_API_KEY;

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

// Middleware para servir archivos estáticos (como tu index.html). Debe ir DESPUÉS de las rutas de la API.
app.use(express.static(path.resolve()));

app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
    console.log('Abre tu aplicación en esa dirección para probarla.');
});

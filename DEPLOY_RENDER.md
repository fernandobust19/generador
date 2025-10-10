# 🚀 Desplegar en Render - Guía Completa

## 📋 Variables de Entorno Requeridas

### **OBLIGATORIAS:**
```
GEMINI_API_KEY=tu_api_key_de_gemini
```

### **PAYPAL (Requeridas para pagos):**
```
PAYPAL_CLIENT_ID=tu_client_id_de_paypal
PAYPAL_CLIENT_SECRET=tu_client_secret_de_paypal
PAYPAL_ENVIRONMENT=live
```

### **STRIPE (Opcional - para pagos con tarjeta):**
```
STRIPE_SECRET_KEY=tu_stripe_secret_key
STRIPE_WEBHOOK_SECRET=tu_stripe_webhook_secret
```

---

## 🛠️ Pasos para Desplegar en Render

### 1. **Preparar el Repositorio**
- Asegúrate de que todos los archivos estén subidos a GitHub
- Verifica que `render.yaml` esté en la raíz del proyecto

### 2. **Crear Servicio en Render**
1. Ve a [render.com](https://render.com)
2. Conecta tu cuenta de GitHub
3. Haz clic en "New +" → "Web Service"
4. Selecciona tu repositorio `generador`
5. Configura:
   - **Name:** `generador-ia`
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`

### 3. **Configurar Variables de Entorno**
En el dashboard de Render, ve a "Environment" y agrega:

```
NODE_ENV=production
GEMINI_API_KEY=tu_gemini_api_key_aqui
PAYPAL_CLIENT_ID=tu_paypal_client_id_de_produccion
PAYPAL_CLIENT_SECRET=tu_paypal_client_secret_de_produccion  
PAYPAL_ENVIRONMENT=live
```

### 4. **Cambiar PayPal a Producción**
⚠️ **IMPORTANTE:** Para producción necesitas:
1. Crear una cuenta de negocio en PayPal
2. Obtener credenciales de LIVE (no sandbox)
3. Cambiar `PAYPAL_ENVIRONMENT=live`

---

## 🔧 Configuración Post-Despliegue

### **URL de tu aplicación:**
```
https://tu-servicio.onrender.com
```

### **Endpoints disponibles:**
- `GET /` - Aplicación principal
- `POST /api/generate` - Generar imágenes con IA
- `POST /api/paypal/create-order` - Crear órdenes PayPal
- `POST /api/paypal/capture-order` - Capturar pagos PayPal
- `GET /api/paypal/config` - Configuración PayPal

---

## ⚡ Verificación Rápida

Después del despliegue, verifica:

1. **✅ Aplicación carga:** Ve a tu URL de Render
2. **✅ IA funciona:** Prueba generar una imagen
3. **✅ PayPal carga:** Haz clic en "Actualizar" y verifica que aparezcan los botones azules de PayPal

---

## 🐛 Solución de Problemas

### **App no carga:**
- Revisa los logs en Render Dashboard
- Verifica que `GEMINI_API_KEY` esté configurada

### **PayPal no aparece:**
- Verifica `PAYPAL_CLIENT_ID` y `PAYPAL_CLIENT_SECRET`
- Asegúrate de que `PAYPAL_ENVIRONMENT` esté configurado

### **Errores de CORS:**
- Render maneja esto automáticamente, no debería haber problemas

---

## 📈 Monitoreo

- **Logs:** Render Dashboard → tu servicio → Logs
- **Métricas:** Render Dashboard → tu servicio → Metrics
- **Estado:** El servicio debe mostrar "Live" en verde

---

## 💰 Costos en Render

- **Plan Gratuito:** 750 horas/mes (suficiente para empezar)
- **Plan Starter:** $7/mes (recomendado para producción)
- **Sin sleep:** El plan pago mantiene tu app siempre activa

---

¡Tu aplicación estará lista para recibir pagos reales con PayPal! 🎉
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

const app = express();
app.use(cors());
app.use(express.json());

// Servir la carpeta actual
app.use(express.static(path.join(__dirname)));

// Carga de credenciales
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    serviceAccount = require('./serviceAccountKey.json');
  }
} catch (err) {
  console.error("❌ Error al cargar credenciales de Firebase:", err.message);
  process.exit(1);
}

initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();
const messaging = getMessaging();

let estadoActualGlobal = {
  ppm: 0,
  estado: "DESCONOCIDO",
  timestamp: new Date()
};

let temporizadorConfirmacion = null;
const TIEMPO_CONFIRMACION_MS = 30000;
let historialNotificaciones = [];

// Endpoint POST: Suscribir tokens FCM al tópico 'calidad_aire'
app.post('/api/subscribe-topic', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, error: "Token no proporcionado" });
    }

    await messaging.subscribeToTopic(token, 'calidad_aire');
    console.log(`📱 Token suscrito con éxito al tema 'calidad_aire'`);
    return res.status(200).json({ success: true, message: "Suscrito exitosamente" });
  } catch (error) {
    console.error("❌ Error suscribiendo token:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint POST: Recepción de lecturas desde ESP32 o Curl
app.post('/api/air-quality', async (req, res) => {
  try {
    const { ppm, estado } = req.body;
    
    if (ppm === undefined || !estado) {
      return res.status(400).json({ error: "Faltan datos requeridos" });
    }

    const estadoPrevio = estadoActualGlobal.estado;
    const nuevoRegistro = {
      ppm: parseFloat(ppm),
      estado: estado,
      timestamp: new Date(),
      fecha: new Date().toISOString()
    };

    estadoActualGlobal = nuevoRegistro;

    try {
      await db.collection('lecturas').add(nuevoRegistro);
    } catch (dbError) {
      console.error("Error guardando en Firestore:", dbError.message);
    }

    if (estado !== estadoPrevio) {
      if (temporizadorConfirmacion) {
        clearTimeout(temporizadorConfirmacion);
      }

      temporizadorConfirmacion = setTimeout(async () => {
        if (estadoActualGlobal.estado === estado) {
          const payloadPush = {
            notification: {
              title: '⚠️ Alerta de Calidad del Aire',
              body: `El estado cambió de ${estadoPrevio} a ${estado} (${ppm} PPM)`
            },
            webpush: {
              notification: {
                title: '⚠️ Alerta de Calidad del Aire',
                body: `El estado cambió de ${estadoPrevio} a ${estado} (${ppm} PPM)`,
                requireInteraction: true
              }
            },
            topic: 'calidad_aire'
          };

          try {
            const resp = await messaging.send(payloadPush);
            console.log("✅ Notificación push enviada con éxito:", resp);
          } catch (pushError) {
            console.error('❌ Error enviando PUSH:', pushError.message);
          }
        }
        temporizadorConfirmacion = null;
      }, TIEMPO_CONFIRMACION_MS);
    }

    res.status(200).json({ status: "OK", message: "Lectura procesada correctamente" });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoints GET
app.get('/api/air-quality/current', (req, res) => {
  res.json({
    success: true,
    datos: {
      ppm: estadoActualGlobal.ppm,
      estado: estadoActualGlobal.estado,
      timestamp: estadoActualGlobal.timestamp,
      fecha: estadoActualGlobal.fecha || new Date().toISOString()
    }
  });
});

app.get('/api/air-quality/history', async (req, res) => {
  try {
    const hace24Horas = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const snapshot = await db.collection('lecturas')
      .where('timestamp', '>=', hace24Horas)
      .limit(100)
      .get();

    const historial = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      historial.push({
        ppm: data.ppm,
        estado: data.estado,
        timestamp: data.timestamp.toDate ? data.timestamp.toDate() : data.timestamp
      });
    });

    historial.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    res.json({ success: true, historial });
  } catch (error) {
    res.json({ success: true, historial: [] });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor activo en puerto ${PORT}`);
});

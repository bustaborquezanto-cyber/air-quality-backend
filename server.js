const express = require('express');
const cors = require('cors');
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// SERVIR EL FRONTEND (index.html) Y SERVICE WORKER
// ============================================================
app.use(express.static(__dirname));

// Esta es la ÚNICA ruta para la raíz
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
// CONFIGURACIÓN DE FIREBASE ADMIN SDK
// ============================================================
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

// ============================================================
// VARIABLES DE ESTADO Y CONTROL
// ============================================================
let estadoActualGlobal = {
  ppm: 0,
  estado: "DESCONOCIDO",
  timestamp: new Date()
};

let estadoPendiente = null;
let temporizadorConfirmacion = null;
const TIEMPO_CONFIRMACION_MS = 30000;
let historialNotificaciones = [];

// ============================================================
// ENDPOINT POST - Recibir datos de la ESP32 / Arduino
// ============================================================
app.post('/api/air-quality', async (req, res) => {
  try {
    const { ppm, estado } = req.body;
    
    if (ppm === undefined || !estado) {
      return res.status(400).json({ error: "Faltan datos: ppm y estado son requeridos" });
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
      console.error("Error guardando lectura:", dbError.message);
    }

    if (estado !== estadoPrevio) {
      if (temporizadorConfirmacion) {
        clearTimeout(temporizadorConfirmacion);
      }

      estadoPendiente = { nuevoEstado: estado, tiempoDetectado: Date.now() };

      temporizadorConfirmacion = setTimeout(async () => {
        if (estadoActualGlobal.estado === estado) {
          const notificacion = {
            id: Date.now(),
            mensaje: `🔔 La calidad del aire cambió a ${estado}`,
            estadoPrevio: estadoPrevio,
            nuevoEstado: estado,
            ppm: ppm,
            fecha: new Date().toISOString(),
            timestamp: Date.now()
          };

          historialNotificaciones.unshift(notificacion);
          if (historialNotificaciones.length > 50) historialNotificaciones.pop();

          try {
            await db.collection('notificaciones').add(notificacion);
          } catch (e) {
            console.error("Error guardando notificación:", e.message);
          }

          const payloadPush = {
            notification: {
              title: '⚠️ Alerta de Calidad del Aire',
              body: `El estado cambió de ${estadoPrevio} a ${estado} (${ppm} PPM)`
            },
            topic: 'calidad_aire'
          };

          try {
            await messaging.send(payloadPush);
          } catch (pushError) {
            console.error('Error enviando PUSH:', pushError.message);
          }
        }
        
        estadoPendiente = null;
        temporizadorConfirmacion = null;
      }, TIEMPO_CONFIRMACION_MS);
    }

    res.status(200).json({ status: "OK", message: "Lectura procesada" });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ENDPOINTS GET - Consultas para la App Web
// ============================================================
app.get('/api/air-quality/current', (req, res) => {
  res.json({
    success: true,
    datos: {
      ppm: estadoActualGlobal.ppm,
      estado: estadoActualGlobal.estado,
      timestamp: estadoActualGlobal.timestamp,
      fecha: estadoActualGlobal.fecha || new Date().toISOString()
    },
    notificaciones: historialNotificaciones.slice(0, 10)
  });
});

app.get('/api/air-quality/history', async (req, res) => {
  try {
    const hace24Horas = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const snapshot = await db.collection('lecturas')
      .where('timestamp', '>=', hace24Horas)
      .limit(1000)
      .get();

    const historial = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      historial.push({
        ppm: data.ppm,
        estado: data.estado,
        timestamp: data.timestamp.toDate ? data.timestamp.toDate() : data.timestamp,
        fecha: data.fecha || new Date(data.timestamp).toISOString()
      });
    });

    historial.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    res.json({ success: true, historial });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor activo en puerto ${PORT}`);
});

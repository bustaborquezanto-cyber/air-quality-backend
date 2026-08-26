const express = require('express');
const cors = require('cors');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = express();
app.use(cors());
app.use(express.json());

// Cargar credencial desde la Variable de Entorno de Render
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    serviceAccount = require('./serviceAccountKey.json');
  }
} catch (err) {
  console.error("Error al parsear la clave de Firebase:", err.message);
  process.exit(1);
}

// Inicializar Firebase Admin
initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();

// Estado actual en memoria
let estadoActualGlobal = {
  ppm: 0,
  estado: "BUENA",
  timestamp: new Date()
};

let estadoPendiente = null;
let temporizadorConfirmacion = null;
const TIEMPO_CONFIRMACION_MS = 30000;
let historialNotificaciones = [];

// Endpoint POST: Recibir lecturas del ESP32
app.post('/api/air-quality', async (req, res) => {
  try {
    const { ppm, estado } = req.body;
    const estadoPrevio = estadoActualGlobal.estado;

    const nuevoRegistro = {
      ppm: parseFloat(ppm),
      estado: estado,
      timestamp: new Date()
    };

    estadoActualGlobal = nuevoRegistro;

    // Guardar en Firestore
    await db.collection('lecturas').add(nuevoRegistro);

    // Lógica de notificaciones
    if (estado !== estadoPrevio) {
      if (!estadoPendiente || estadoPendiente.nuevoEstado !== estado) {
        if (temporizadorConfirmacion) clearTimeout(temporizadorConfirmacion);

        estadoPendiente = { nuevoEstado: estado, tiempoDetectado: Date.now() };

        temporizadorConfirmacion = setTimeout(() => {
          const notificacion = {
            id: Date.now(),
            mensaje: `Alerta: La calidad del aire ha cambiado a ${estado}`,
            estadoPrevio: estadoPrevio,
            nuevoEstado: estado,
            fecha: new Date().toISOString()
          };

          historialNotificaciones.unshift(notificacion);
          if (historialNotificaciones.length > 20) historialNotificaciones.pop();

          estadoActualGlobal.estado = estado;
          estadoPendiente = null;
        }, TIEMPO_CONFIRMACION_MS);
      }
    } else {
      if (temporizadorConfirmacion && estadoPendiente && estadoPendiente.nuevoEstado !== estado) {
        clearTimeout(temporizadorConfirmacion);
        estadoPendiente = null;
      }
    }

    return res.status(200).json({ status: "OK", message: "Lectura guardada correctamente." });
  } catch (error) {
    console.error("Error al procesar datos:", error);
    return res.status(500).json({ error: error.message });
  }
});

// Endpoint GET: Consultar estado actual
app.get('/api/air-quality/current', (req, res) => {
  res.json({
    actual: estadoActualGlobal,
    notificaciones: historialNotificaciones
  });
});

// Endpoint GET: Consultar historial de las últimas 24h
app.get('/api/air-quality/history', async (req, res) => {
  try {
    const hace24Horas = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const snapshot = await db.collection('lecturas')
      .where('timestamp', '>=', hace24Horas)
      .orderBy('timestamp', 'asc')
      .get();

    const historial = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      historial.push({
        ppm: data.ppm,
        estado: data.estado,
        timestamp: data.timestamp.toDate()
      });
    });

    res.json(historial);
  } catch (error) {
    console.error("Error consultando historial:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de monitoreo IoT activo en http://localhost:${PORT}`);
});

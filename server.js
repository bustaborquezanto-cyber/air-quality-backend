const express = require('express');
const cors = require('cors');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// CONFIGURACIÓN DE FIREBASE - VERSIÓN PARA RENDER
// ============================================================
let serviceAccount;
try {
  // PRIMERO: Intentar usar la variable de entorno de Render
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.log("📦 Usando credenciales desde Variable de Entorno");
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    // SEGUNDO: Si no existe variable, buscar el archivo local (para desarrollo)
    console.log("📁 Buscando archivo local serviceAccountKey.json");
    serviceAccount = require('./serviceAccountKey.json');
  }
} catch (err) {
  console.error("❌ Error al cargar las credenciales de Firebase:", err.message);
  console.error("💡 Asegúrate de configurar FIREBASE_SERVICE_ACCOUNT en Render");
  process.exit(1);
}

// Inicializar Firebase Admin
initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();
console.log("✅ Firebase conectado correctamente");

// ============================================================
// VARIABLES DE ESTADO
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
// ENDPOINT POST - Recibir datos del ESP32
// ============================================================
app.post('/api/air-quality', async (req, res) => {
  try {
    const { ppm, estado } = req.body;
    
    // Validar datos
    if (ppm === undefined || !estado) {
      return res.status(400).json({ 
        error: "Faltan datos: ppm y estado son requeridos" 
      });
    }

    const estadoPrevio = estadoActualGlobal.estado;
    console.log(`📨 Recibido: ${ppm} PPM - ${estado}`);

    const nuevoRegistro = {
      ppm: parseFloat(ppm),
      estado: estado,
      timestamp: new Date(),
      fecha: new Date().toISOString()
    };

    estadoActualGlobal = nuevoRegistro;

    // Guardar en Firestore
    try {
      await db.collection('lecturas').add(nuevoRegistro);
      console.log("💾 Datos guardados en Firestore");
    } catch (dbError) {
      console.error("⚠️ Error guardando en Firestore:", dbError.message);
    }

    // ============================================================
    // LÓGICA DE NOTIFICACIONES (CON RETRASO DE 30 SEGUNDOS)
    // ============================================================
    if (estado !== estadoPrevio) {
      console.log(`🔄 Cambio detectado: ${estadoPrevio} → ${estado}`);
      
      // Cancelar notificación pendiente anterior
      if (temporizadorConfirmacion) {
        clearTimeout(temporizadorConfirmacion);
        temporizadorConfirmacion = null;
      }

      // Guardar estado pendiente
      estadoPendiente = { 
        nuevoEstado: estado, 
        tiempoDetectado: Date.now() 
      };

      // Programar notificación en 30 segundos
      temporizadorConfirmacion = setTimeout(() => {
        if (estadoActualGlobal.estado === estado) {
          const notificacion = {
            id: Date.now(),
            mensaje: `🔔 Calidad del aire cambió a ${estado}`,
            estadoPrevio: estadoPrevio,
            nuevoEstado: estado,
            ppm: ppm,
            fecha: new Date().toISOString(),
            timestamp: Date.now()
          };

          historialNotificaciones.unshift(notificacion);
          if (historialNotificaciones.length > 50) historialNotificaciones.pop();

          console.log(`✅ NOTIFICACIÓN ENVIADA: ${estado} (${ppm} PPM)`);
          
          try {
            db.collection('notificaciones').add(notificacion);
          } catch (e) {
            console.error("Error guardando notificación:", e.message);
          }
        } else {
          console.log(`⏭️ Notificación cancelada: el estado cambió nuevamente`);
        }
        
        estadoPendiente = null;
        temporizadorConfirmacion = null;
      }, TIEMPO_CONFIRMACION_MS);
      
      console.log(`⏰ Notificación programada en ${TIEMPO_CONFIRMACION_MS/1000} segundos`);
    }

    res.status(200).json({ 
      status: "OK", 
      message: "Lectura guardada correctamente",
      notificacion_programada: estadoPendiente !== null
    });

  } catch (error) {
    console.error("❌ Error al procesar datos:", error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ENDPOINT GET - Estado actual
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

// ============================================================
// ENDPOINT GET - Historial (últimas 24 horas)
// ============================================================
app.get('/api/air-quality/history', async (req, res) => {
  try {
    const hace24Horas = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    // Se elimina el .orderBy para evitar pedir índices compuestos a Firestore
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

    // Ordenar de forma ascendente en memoria
    historial.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    res.json({
      success: true,
      historial: historial
    });
  } catch (error) {
    console.error("❌ Error consultando historial:", error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ENDPOINT GET - Notificaciones
// ============================================================
app.get('/api/air-quality/notifications', (req, res) => {
  res.json({
    success: true,
    notificaciones: historialNotificaciones
  });
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor de monitoreo IoT activo en puerto ${PORT}`);
  console.log(`📡 Endpoints:`);
  console.log(`   POST /api/air-quality`);
  console.log(`   GET  /api/air-quality/current`);
  console.log(`   GET  /api/air-quality/history`);
  console.log(`   GET  /api/air-quality/notifications`);
});

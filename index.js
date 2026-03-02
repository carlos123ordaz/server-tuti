const express = require('express');
const cors = require('cors');
const app = express();
const server = require('http').createServer(app);
const { instrument } = require('@socket.io/admin-ui');

const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://admin.socket.io',
  'https://tutifruti-game.vercel.app'
];

const io = require('socket.io')(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    credentials: true
  }
});

const port = process.env.PORT || 4000;
instrument(io, { auth: false });

// ═══════════════════════════════════════════════════════════════
//  FIX #1: CORS para endpoints REST de Express
//  (Socket.IO tiene su propio CORS, pero Express no lo hereda)
// ═══════════════════════════════════════════════════════════════

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json());

// ═══════════════════════════════════════════════════════════════
//  DATA STORE
// ═══════════════════════════════════════════════════════════════

const salas = new Map();
const namespacesCreados = new Set();

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

function generarCodigo() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (salas.has(code));
  return code;
}

function crearSalaObj(codigo, categorias, letras, maxJugadores, tiempoRonda) {
  return {
    codigo,
    categorias: categorias || ['Nombre', 'Apellido', 'Animal', 'País', 'Color', 'Fruta', 'Capital'],
    letras: letras || 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
    letrasUsadas: [],
    maxJugadores: maxJugadores || 10,
    tiempoRonda: tiempoRonda || 60,
    usuarios: [],
    estado: 'esperando',
    letraActual: null,
    rondaActual: 0,
    juegos: [],
    timerInterval: null,
    tiempoRestante: 0,
    creadoEn: Date.now(),
  };
}

function obtenerAdmin(sala) {
  return sala.usuarios.length > 0 ? sala.usuarios[0] : null;
}

function transferirAdmin(sala, nsp) {
  const nuevoAdmin = obtenerAdmin(sala);
  if (nuevoAdmin) {
    nsp.emit('admin-cambio', { adminId: nuevoAdmin.id, adminNombre: nuevoAdmin.nombre });
  }
}

function limpiarTimer(sala) {
  if (sala.timerInterval) {
    clearInterval(sala.timerInterval);
    sala.timerInterval = null;
  }
}

function elegirLetraServidor(sala) {
  const disponibles = sala.letras.filter(l => !sala.letrasUsadas.includes(l));
  if (disponibles.length === 0) {
    sala.letrasUsadas = [];
    return sala.letras[Math.floor(Math.random() * sala.letras.length)];
  }
  return disponibles[Math.floor(Math.random() * disponibles.length)];
}

function iniciarTimer(sala, nsp) {
  limpiarTimer(sala);
  sala.tiempoRestante = sala.tiempoRonda;
  nsp.emit('timer-tick', { tiempo: sala.tiempoRestante });

  sala.timerInterval = setInterval(() => {
    sala.tiempoRestante--;
    nsp.emit('timer-tick', { tiempo: sala.tiempoRestante });

    if (sala.tiempoRestante <= 0) {
      limpiarTimer(sala);
      nsp.emit('detener-juego', { razon: 'tiempo' });
      sala.estado = 'resultados';
    }
  }, 1000);
}

// ═══════════════════════════════════════════════════════════════
//  REST ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({ status: 'ok', version: 'v11', port, salasActivas: salas.size });
});

// FIX #2: puedeUnirse permite late-join (solo bloquea si está llena)
app.get('/sala/:codigo', (req, res) => {
  const sala = salas.get(req.params.codigo);
  if (!sala) {
    return res.status(404).json({ existe: false, error: 'Sala no encontrada' });
  }

  const llena = sala.usuarios.length >= sala.maxJugadores;

  res.json({
    existe: true,
    jugadores: sala.usuarios.length,
    maxJugadores: sala.maxJugadores,
    estado: sala.estado,
    categorias: sala.categorias,
    puedeUnirse: !llena,
    llena,
  });
});

// ═══════════════════════════════════════════════════════════════
//  SOCKET PRINCIPAL
// ═══════════════════════════════════════════════════════════════

io.on('connection', (socket) => {

  socket.on('crear-sala', (data, callback) => {
    const codigo = data.codigo && !salas.has(data.codigo)
      ? data.codigo
      : generarCodigo();

    const sala = crearSalaObj(
      codigo,
      data.categorias,
      data.letras,
      data.maxJugadores || 10,
      data.tiempoRonda || 60,
    );
    salas.set(codigo, sala);

    if (!namespacesCreados.has(codigo)) {
      namespacesCreados.add(codigo);
      registrarNamespace(codigo);
    }

    const resp = { ok: true, codigo };
    if (typeof callback === 'function') callback(resp);
    socket.emit('sala-creada', resp);
    console.log(`[SALA CREADA] ${codigo}`);
  });

  // Verificar sala vía socket (fallback si REST falla)
  socket.on('verificar-sala', (codigo, callback) => {
    const sala = salas.get(codigo);
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!sala) return cb({ existe: false });
    cb({
      existe: true,
      jugadores: sala.usuarios.length,
      maxJugadores: sala.maxJugadores,
      estado: sala.estado,
      puedeUnirse: sala.usuarios.length < sala.maxJugadores,
    });
  });
});

// ═══════════════════════════════════════════════════════════════
//  NAMESPACE POR SALA
// ═══════════════════════════════════════════════════════════════

function registrarNamespace(codigo) {
  const nsp = io.of('/' + codigo);

  nsp.on('connection', (salaSocket) => {
    const getSala = () => salas.get(codigo);

    // ── UNIRSE ──
    salaSocket.on('enviar-nombre', (nombre, callback) => {
      const sala = getSala();
      const cb = typeof callback === 'function' ? callback : () => {};

      if (!sala) return cb({ ok: false, error: 'La sala ya no existe' });

      const nombreLimpio = String(nombre).trim();
      if (nombreLimpio.length < 2 || nombreLimpio.length > 20) {
        return cb({ ok: false, error: 'Nombre: entre 2 y 20 caracteres' });
      }

      if (sala.usuarios.some(u => u.nombre.toLowerCase() === nombreLimpio.toLowerCase())) {
        return cb({ ok: false, error: 'Ese nombre ya está en uso' });
      }

      if (sala.usuarios.length >= sala.maxJugadores) {
        return cb({ ok: false, error: 'La sala está llena' });
      }

      if (sala.usuarios.find(u => u.id === salaSocket.id)) {
        return cb({ ok: true, yaConectado: true });
      }

      sala.usuarios.push({ id: salaSocket.id, nombre: nombreLimpio, puntaje: 0 });

      const esAdmin = sala.usuarios[0].id === salaSocket.id;
      cb({ ok: true, esAdmin });

      // Broadcast completo
      nsp.emit('enviar-usuarios', {
        usuarios: sala.usuarios,
        categorias: sala.categorias,
        letras: sala.letras,
        estado: sala.estado,
        letraActual: sala.letraActual,
        tiempoRonda: sala.tiempoRonda,
        adminId: obtenerAdmin(sala)?.id || null,
      });

      // Late-join sync
      if (sala.estado === 'jugando' && sala.letraActual) {
        salaSocket.emit('sync-juego', {
          letra: sala.letraActual,
          tiempoRestante: sala.tiempoRestante,
        });
      }

      console.log(`[JOIN] ${nombreLimpio} → ${codigo} (${sala.usuarios.length}/${sala.maxJugadores})`);
    });

    // ── GIRAR LETRA ──
    salaSocket.on('girar-letra', (_, callback) => {
      const sala = getSala();
      const cb = typeof callback === 'function' ? callback : () => {};
      if (!sala) return cb({ ok: false, error: 'Sala no encontrada' });
      if (sala.estado !== 'esperando') return cb({ ok: false, error: 'No se puede girar ahora' });

      const admin = obtenerAdmin(sala);
      if (!admin || admin.id !== salaSocket.id) return cb({ ok: false, error: 'Solo el admin' });

      const letraElegida = elegirLetraServidor(sala);
      sala.letraActual = letraElegida;
      cb({ ok: true, letra: letraElegida });

      nsp.emit('letra-elegida', { letra: letraElegida, animacion: true });
      console.log(`[LETRA] ${codigo} → ${letraElegida}`);
    });

    // ── EMPEZAR ──
    salaSocket.on('empezar-juego', (_, callback) => {
      const sala = getSala();
      const cb = typeof callback === 'function' ? callback : () => {};
      if (!sala) return cb({ ok: false, error: 'Sala no encontrada' });

      const admin = obtenerAdmin(sala);
      if (!admin || admin.id !== salaSocket.id) return cb({ ok: false, error: 'Solo el admin' });
      if (sala.estado !== 'esperando') return cb({ ok: false, error: 'Ya hay juego en curso' });
      if (!sala.letraActual) return cb({ ok: false, error: 'Primero gira la letra' });
      if (sala.usuarios.length < 2) return cb({ ok: false, error: 'Mínimo 2 jugadores' });

      sala.estado = 'jugando';
      sala.rondaActual++;
      sala.juegos = [];
      cb({ ok: true });

      nsp.emit('start', { letra: sala.letraActual, ronda: sala.rondaActual, tiempo: sala.tiempoRonda });
      iniciarTimer(sala, nsp);
      console.log(`[START] ${codigo} — R${sala.rondaActual} L:${sala.letraActual}`);
    });

    // ── DETENER ──
    salaSocket.on('detener', () => {
      const sala = getSala();
      if (!sala || sala.estado !== 'jugando') return;
      limpiarTimer(sala);
      sala.estado = 'resultados';
      const quien = sala.usuarios.find(u => u.id === salaSocket.id);
      nsp.emit('detener-juego', { razon: 'manual', detenidoPor: quien?.nombre || '?' });
    });

    // ── RESULTADOS ──
    salaSocket.on('enviar-resultados', (data) => {
      const sala = getSala();
      if (!sala) return;
      if (sala.juegos.find(j => j._socketId === salaSocket.id)) return;

      data._socketId = salaSocket.id;

      // Auto-validar letra
      if (sala.letraActual) {
        for (const cat of sala.categorias) {
          if (data[cat]?.respuesta) {
            const r = data[cat].respuesta.trim();
            if (r.length > 0 && r[0].toUpperCase() !== sala.letraActual.toUpperCase()) {
              data[cat].correcto = false;
            }
          }
        }
      }

      sala.juegos.push(data);
      nsp.emit('progreso-resultados', { recibidos: sala.juegos.length, total: sala.usuarios.length });

      if (sala.juegos.length >= sala.usuarios.length) {
        const resultados = sala.juegos.map(({ _socketId, ...rest }) => rest);
        nsp.emit('enviar-respuestas', resultados);
      }
    });

    // ── CORRECCIÓN ──
    salaSocket.on('correccion', (data) => {
      if (!getSala()) return;
      nsp.emit('corregir-respuesta', data);
    });

    // ── REINICIAR ──
    salaSocket.on('reiniciar', (puntajes) => {
      const sala = getSala();
      if (!sala) return;
      const admin = obtenerAdmin(sala);
      if (!admin || admin.id !== salaSocket.id) return;

      if (Array.isArray(puntajes)) {
        for (const p of puntajes) {
          const user = sala.usuarios.find(u => u.id === p.id || u.nombre === p.nombre);
          if (user) user.puntaje = p.puntaje;
        }
      }

      if (sala.letraActual) sala.letrasUsadas.push(sala.letraActual);
      sala.estado = 'esperando';
      sala.letraActual = null;
      sala.juegos = [];
      limpiarTimer(sala);

      nsp.emit('reiniciar-juego', {
        usuarios: sala.usuarios,
        adminId: admin.id,
        letrasUsadas: sala.letrasUsadas,
      });
    });

    // ── CHAT ──
    salaSocket.on('chat-message', (data) => {
      const sala = getSala();
      if (!sala) return;
      const user = sala.usuarios.find(u => u.id === salaSocket.id);
      if (!user) return;
      const mensaje = String(data.mensaje).trim();
      if (mensaje.length === 0 || mensaje.length > 200) return;
      nsp.emit('chat-message', { nombre: user.nombre, id: salaSocket.id, mensaje, timestamp: Date.now() });
    });

    // ── DISCONNECT ──
    salaSocket.on('disconnect', () => {
      const sala = getSala();
      if (!sala) return;

      const usuario = sala.usuarios.find(u => u.id === salaSocket.id);
      const eraAdmin = sala.usuarios.length > 0 && sala.usuarios[0].id === salaSocket.id;
      sala.usuarios = sala.usuarios.filter(u => u.id !== salaSocket.id);

      if (eraAdmin && sala.usuarios.length > 0) transferirAdmin(sala, nsp);

      if (sala.usuarios.length === 0) {
        limpiarTimer(sala);
        sala.estado = 'esperando';
        sala.juegos = [];
      }

      nsp.emit('actualizar-usuarios', {
        usuarios: sala.usuarios,
        adminId: obtenerAdmin(sala)?.id || null,
        desconectado: usuario?.nombre || null,
      });

      if (sala.estado === 'resultados' && sala.usuarios.length > 0 && sala.juegos.length >= sala.usuarios.length) {
        const resultados = sala.juegos.map(({ _socketId, ...rest }) => rest);
        nsp.emit('enviar-respuestas', resultados);
      }

      if (usuario) console.log(`[LEAVE] ${usuario.nombre} → ${codigo} (${sala.usuarios.length})`);
    });
  });
}

// ═══════════════════════════════════════════════════════════════
//  LIMPIEZA (cada 5 min)
// ═══════════════════════════════════════════════════════════════

setInterval(() => {
  const ahora = Date.now();
  for (const [codigo, sala] of salas.entries()) {
    const nsp = io.of('/' + codigo);
    const conectados = nsp.sockets ? nsp.sockets.size : 0;
    if (conectados === 0 && sala.usuarios.length === 0 && (ahora - sala.creadoEn) > 30 * 60 * 1000) {
      limpiarTimer(sala);
      salas.delete(codigo);
      namespacesCreados.delete(codigo);
      nsp.removeAllListeners();
      console.log(`[CLEANUP] ${codigo}`);
    }
  }
}, 5 * 60 * 1000);

server.listen(port, () => {
  console.log(`🎮 Tutti Frutti Server v11 — Puerto ${port}`);
});
require('dotenv').config();
// Empty PORT= in .env must not override cPanel's injected PORT or fall back to 3001.
if (!String(process.env.PORT || '').trim()) {
  delete process.env.PORT;
}
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const http = require('http');
const socketIO = require('socket.io');
const connectDB = require('./config/db');
const errorHandler = require('./middleware/errorHandler');
const authenticate = require('./middleware/auth');
const { requireApproved, requireTenantAdmin, requireSuperAdmin } = require('./middleware/auth');
const { resolveBusinessOwner, resolveBusinessOwnerAllowMissing } = require('./utils/access');

// Import routes
const collectionsRouter = require('./routes/collections');
const authRouter = require('./routes/auth');
const partiesRouter = require('./routes/parties');
const ghausiaLotsRouter = require('./routes/ghausiaLots');
const paymentsRouter = require('./routes/payments');
const partyLedgerRouter = require('./routes/partyLedger');
const partyEditsRouter = require('./routes/partyEdits');
const rateCalculationsRouter = require('./routes/rateCalculations');
const savedDesignsRouter = require('./routes/savedDesigns');
const dashboardRouter = require('./routes/dashboard');
const usersRouter = require('./routes/users');
const superAdminRouter = require('./routes/superAdmin');
const businessOwnersRouter = require('./routes/businessOwners');
const personalKhataRouter = require('./routes/personalKhata');
const bootstrapRouter = require('./routes/bootstrap');

const app = express();
const server = http.createServer(app);


// ✅ Allowed origins (FIXED)
const getAllowedOrigins = () => {
  const corsOrigin =
    process.env.CORS_ORIGIN || 'https://seamandgrace.com';

  const origins = corsOrigin.includes(',')
    ? corsOrigin.split(',').map((origin) => origin.trim())
    : [corsOrigin.trim()];

  const frontend = process.env.FRONTEND_URL?.trim();
  if (frontend) origins.push(frontend);

  // Allow both www and apex when one is configured (e.g. seamandgrace.com ↔ www.seamandgrace.com).
  for (const origin of [...origins]) {
    if (origin.startsWith('https://www.')) {
      origins.push(origin.replace('https://www.', 'https://'));
    } else if (/^https:\/\/[^/]+$/.test(origin) && !origin.includes('://www.')) {
      origins.push(origin.replace('https://', 'https://www.'));
    }
  }

  return [...new Set(origins.filter(Boolean))];
};

const allowedOrigins = getAllowedOrigins();


// ✅ Socket.io setup (FIXED)
const io = socketIO(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    credentials: true
  }
});


app.use(compression());

// ✅ CORS Middleware (IMPORTANT)
app.use(cors({
  origin: function (origin, callback) {
    // allow requests without origin (Postman, mobile apps)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    if (process.env.NODE_ENV !== 'production') {
      console.warn('CORS allow (dev):', origin);
      return callback(null, true);
    }

    console.warn('Blocked by CORS:', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true
}));


// ✅ Handle preflight requests
app.options('*', cors());


/** Party ledger receipts are stored as base64 in JSON; default 100kb limit causes HTTP 413. */
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '3mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.JSON_BODY_LIMIT || '3mb' }));


// ✅ Socket.io auth — verify the JWT from the handshake and resolve the org room to join.
const jwt = require('jsonwebtoken');
const User = require('./models/User');
const { getDataOwnerId } = require('./utils/access');
const { orgRoom } = require('./utils/realtime');

const getSocketJwtSecret = () =>
  process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'development-jwt-secret-change-me');

io.use(async (socket, next) => {
  // Auth is best-effort: an unauthenticated socket simply joins no room (receives nothing).
  try {
    const token = socket.handshake?.auth?.token || socket.handshake?.query?.token;
    const secret = getSocketJwtSecret();
    if (!token || !secret) return next();
    const decoded = jwt.verify(String(token), secret);
    const user = await User.findById(decoded.id).select('role ownerId approvedBy status').lean();
    if (user && user.status === 'approved') {
      socket.data.ownerId = String(getDataOwnerId(user) || '');
    }
  } catch {
    /* ignore — connect without a room */
  }
  next();
});

// ✅ Socket.io connection handler
io.on('connection', (socket) => {
  if (socket.data.ownerId) {
    socket.join(orgRoom(socket.data.ownerId));
  }

  socket.on('disconnect', () => {
    /* room membership is cleaned up automatically */
  });
});


// ✅ Make io accessible in routes
app.use((req, res, next) => {
  req.io = io;
  next();
});


// ✅ Routes
// app.use('/api/auth', authRouter);
app.use('/api', authRouter);
app.use('/api/users', authenticate, requireApproved, usersRouter);
app.use('/api/approval-users', authenticate, requireApproved, usersRouter);
app.use('/api/approvals/users', authenticate, requireApproved, usersRouter);
app.use('/api/super-admin', authenticate, requireApproved, requireSuperAdmin, superAdminRouter);
app.use('/api/businessOwners', authenticate, requireApproved, requireTenantAdmin, businessOwnersRouter);
app.use('/api/collections', authenticate, requireApproved, resolveBusinessOwner, collectionsRouter);
app.use('/api/parties', authenticate, requireApproved, resolveBusinessOwnerAllowMissing, partiesRouter);
app.use('/api/ghausiaLots', authenticate, requireApproved, resolveBusinessOwner, ghausiaLotsRouter);
app.use('/api/payments', authenticate, requireApproved, resolveBusinessOwner, paymentsRouter);
app.use('/api/partyLedger', authenticate, requireApproved, resolveBusinessOwner, partyLedgerRouter);
app.use('/api/partyEdits', authenticate, requireApproved, resolveBusinessOwner, partyEditsRouter);
app.use('/api/rateCalculations', authenticate, requireApproved, resolveBusinessOwner, rateCalculationsRouter);
app.use('/api/savedDesigns', authenticate, requireApproved, resolveBusinessOwner, savedDesignsRouter);
app.use('/api/dashboard', authenticate, requireApproved, resolveBusinessOwner, dashboardRouter);
app.use('/api/personal-khata', authenticate, requireApproved, personalKhataRouter);
app.use('/api/bootstrap', authenticate, requireApproved, resolveBusinessOwnerAllowMissing, bootstrapRouter);


// ✅ Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'Server is running' });
});


// ✅ 404 handler
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});


// ✅ Error handler
app.use(errorHandler);


// cPanel / Namecheap: Phusion Passenger serves module.exports — do not require PORT in production.
const isPassenger =
  typeof PhusionPassenger !== 'undefined'
  || Boolean(process.env.PASSENGER_APP_ENV)
  || Boolean(process.env.PASSENGER_BASE_URI);

const startServer = async () => {
  await connectDB();

  const isProduction = process.env.NODE_ENV === 'production';
  const explicitPort = process.env.PORT?.trim();

  // Shared hosting (cPanel): Passenger binds the port — never listen(3001) here.
  if (isProduction && !explicitPort) {
    if (isPassenger) {
      server.listen('passenger', () => {
        console.log('✅ Server running via Phusion Passenger (cPanel)');
        console.log('Environment: production');
      });
    } else {
      console.log('✅ App ready for cPanel Passenger (export-only — no port bind)');
      console.log('   Do not use "npm start" on shared hosting.');
      console.log('   Use cPanel → Setup Node.js App → Restart App.');
    }
    return;
  }

  const PORT = explicitPort ? Number(explicitPort) : 3001;
  if (!Number.isInteger(PORT) || PORT <= 0) {
    console.error(`❌ Invalid PORT="${explicitPort}"`);
    process.exit(1);
  }

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Port ${PORT} already in use (EADDRINUSE).`);
      console.error('   cPanel: Stop App → wait 15s → Restart App (one instance only).');
    } else {
      console.error('❌ Server failed to start:', err.message);
    }
    process.exit(1);
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
};

// Required for cPanel / Phusion Passenger.
module.exports = app;

startServer().catch(() => {
  process.exit(1);
});


// ✅ Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
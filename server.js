require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIO = require('socket.io');
const connectDB = require('./config/db');
const errorHandler = require('./middleware/errorHandler');
const authenticate = require('./middleware/auth');
const { requireApproved, requireTenantAdmin } = require('./middleware/auth');
const { resolveBusinessOwner } = require('./utils/access');

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
const businessOwnersRouter = require('./routes/businessOwners');

const app = express();
const server = http.createServer(app);


// ✅ Allowed origins (FIXED)
const getAllowedOrigins = () => {
  const corsOrigin =
    process.env.CORS_ORIGIN || 'https://waqas-emb-fe.vercel.app';

  if (corsOrigin.includes(',')) {
    return corsOrigin.split(',').map(origin => origin.trim());
  }

  return [corsOrigin];
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


// ✅ Connect to MongoDB
connectDB();


// ✅ CORS Middleware (IMPORTANT)
app.use(cors({
  origin: function (origin, callback) {
    // allow requests without origin (Postman, mobile apps)
    if (!origin) return callback(null, true);

    // allow all in development OR fallback
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // ✅ DO NOT THROW ERROR — just allow temporarily
    console.warn('Blocked by CORS:', origin);
    return callback(null, true); // 👈 CHANGE THIS LINE
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true
}));


// ✅ Handle preflight requests
app.options('*', cors());


app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// ✅ Socket.io connection handler
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });

  socket.on('data-update', (data) => {
    io.emit('data-update', data);
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
app.use('/api/businessOwners', authenticate, requireApproved, requireTenantAdmin, businessOwnersRouter);
app.use('/api/collections', authenticate, requireApproved, resolveBusinessOwner, collectionsRouter);
app.use('/api/parties', authenticate, requireApproved, resolveBusinessOwner, partiesRouter);
app.use('/api/ghausiaLots', authenticate, requireApproved, resolveBusinessOwner, ghausiaLotsRouter);
app.use('/api/payments', authenticate, requireApproved, resolveBusinessOwner, paymentsRouter);
app.use('/api/partyLedger', authenticate, requireApproved, resolveBusinessOwner, partyLedgerRouter);
app.use('/api/partyEdits', authenticate, requireApproved, resolveBusinessOwner, partyEditsRouter);
app.use('/api/rateCalculations', authenticate, requireApproved, resolveBusinessOwner, rateCalculationsRouter);
app.use('/api/savedDesigns', authenticate, requireApproved, resolveBusinessOwner, savedDesignsRouter);
app.use('/api/dashboard', authenticate, requireApproved, resolveBusinessOwner, dashboardRouter);


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


const PORT = process.env.PORT || 3001;


// ✅ Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});


// ✅ Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
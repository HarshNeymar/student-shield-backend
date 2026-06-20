import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import { requireAuth } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import onboardingRoutes from './routes/onboarding.js';
import companyRoutes from './routes/company.js';
import schoolRoutes from './routes/school.js';
import studentRoutes from './routes/student.js';
import teacherRoutes from './routes/teacher.js';
import smartBuddyRoutes from './routes/smartBuddy.js';

const app = express();

const normalizeOrigin = (value) =>
  String(value || '')
    .trim()
    .replace(/\/+$/, '');

const allowedOrigins = new Set(
  [
    'http://localhost:5173',
    'http://localhost:8080',
    'https://sheild-kappa.vercel.app',
    'https://student-shield-frontend.vercel.app',

    ...(process.env.CORS_ORIGIN || '')
      .split(',')
      .map(normalizeOrigin)
      .filter(Boolean),
  ].map(normalizeOrigin)
);

const corsOptions = {
  origin(origin, callback) {
    // Allows Postman, Render health checks, server-to-server requests.
    if (!origin) {
      return callback(null, true);
    }

    const normalizedOrigin = normalizeOrigin(origin);

    if (allowedOrigins.has(normalizedOrigin)) {
      return callback(null, true);
    }

    console.warn(`CORS blocked for origin: ${origin}`);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },

  credentials: true,

  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],

  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
  ],

  exposedHeaders: ['Content-Type'],
  maxAge: 86400,
};

// Must stay before helmet, JSON parsing, authentication, and all API routes.
app.use(cors(corsOptions));

// Explicit preflight handler. Regex works with Express 4 and Express 5.
app.options(/.*/, cors(corsOptions));

app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);

app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api/auth', requireAuth, authRoutes);
app.use('/api/onboarding', requireAuth, onboardingRoutes);
app.use('/api/company', requireAuth, companyRoutes);
app.use('/api/school', requireAuth, schoolRoutes);
app.use('/api/student', requireAuth, studentRoutes);
app.use('/api/teacher', requireAuth, teacherRoutes);

// Smart Buddy has its own scoped launch/session-token authentication.
app.use('/api/smart-buddy', smartBuddyRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);

  const message = err?.message ?? 'Internal server error';

  const status = message.toLowerCase().startsWith('forbidden')
    ? 403
    : message.toLowerCase().includes('cors blocked')
      ? 403
      : 500;

  res.status(status).json({ error: message });
});

const port = Number(process.env.PORT ?? 4000);

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
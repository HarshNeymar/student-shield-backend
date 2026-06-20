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

/*
  TEMPORARY: Allow every frontend origin.
  Uses reflected origin instead of "*" so Authorization/cookies can work.
*/
const allowAllCors = cors({
  origin(origin, callback) {
    callback(null, true);
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
});

// Keep CORS before helmet, JSON middleware, authentication, and API routes.
app.use(allowAllCors);
app.options(/.*/, allowAllCors);

app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);

app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    cors: 'allow-all',
  });
});

app.use('/api/auth', requireAuth, authRoutes);
app.use('/api/onboarding', requireAuth, onboardingRoutes);
app.use('/api/company', requireAuth, companyRoutes);
app.use('/api/school', requireAuth, schoolRoutes);
app.use('/api/student', requireAuth, studentRoutes);
app.use('/api/teacher', requireAuth, teacherRoutes);

// Smart Buddy uses its own scoped launch/session token.
app.use('/api/smart-buddy', smartBuddyRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);

  const message = err?.message ?? 'Internal server error';

  const status = message.toLowerCase().startsWith('forbidden')
    ? 403
    : 500;

  res.status(status).json({ error: message });
});

const port = Number(process.env.PORT ?? 4000);

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
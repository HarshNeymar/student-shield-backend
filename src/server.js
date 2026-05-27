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

const app = express();
const allowedOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(',').map((v) => v.trim());

app.use(helmet());
// app.use(cors({
//   origin(origin, cb) {
//     if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
//     cb(new Error(`CORS blocked for origin ${origin}`));
//   },
//   credentials: true,
// }));

app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', requireAuth, authRoutes);
app.use('/api/onboarding', requireAuth, onboardingRoutes);
app.use('/api/company', requireAuth, companyRoutes);
app.use('/api/school', requireAuth, schoolRoutes);
app.use('/api/student', requireAuth, studentRoutes);
app.use('/api/teacher', requireAuth, teacherRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  const message = err?.message ?? 'Internal server error';
  const status = message.toLowerCase().startsWith('forbidden') ? 403 : 500;
  res.status(status).json({ error: message });
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`Backend listening on http://localhost:${port}`));

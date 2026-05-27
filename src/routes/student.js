import { Router } from 'express';
import { asyncHandler } from '../utils.js';
import { adminClient } from '../supabase.js';

const router = Router();

router.get('/dashboard', asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { data: profile, error: pErr } = await req.supabase
    .from('profiles')
    .select('id, full_name, school_id, class_assigned')
    .eq('id', userId)
    .maybeSingle();
  if (pErr) throw new Error(pErr.message);
  if (!profile?.school_id) return res.json({ profile, enrollment: null, reports: [], sessions: [], benefits: [] });

  const [{ data: enrollment, error: eErr }, { data: reports, error: rErr }, { data: sessions, error: sErr }] = await Promise.all([
    req.supabase.from('enrollments').select('*').eq('student_id', userId).maybeSingle(),
    req.supabase.from('wellness_reports').select('*, teacher:profiles!wellness_reports_teacher_id_fkey(full_name)').eq('student_id', userId).order('created_at', { ascending: false }),
    adminClient
      .from('sessions')
      .select('*')
      .eq('target_school_id', profile.school_id)
      .order('scheduled_at', { ascending: false })
      .limit(25),
  ]);
  if (eErr) throw new Error(eErr.message);
  if (rErr) throw new Error(rErr.message);
  if (sErr) throw new Error(sErr.message);

  const benefits = enrollment ? [
    { name: 'Accidental Protection', status: 'Activated' },
    { name: 'Future Financial Security', status: 'Activated' },
    { name: 'Student Protection', status: 'Activated' },
  ] : [];

  const visibleSessions = (sessions ?? []).filter((s) => !s.target_class || s.target_class === profile.class_assigned).slice(0, 10);

  res.json({ profile, enrollment, reports: reports ?? [], sessions: visibleSessions, benefits });
}));

export default router;

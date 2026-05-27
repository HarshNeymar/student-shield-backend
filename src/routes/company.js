import { Router } from 'express';
import multer from 'multer';
import { asyncHandler, emptyUuid } from '../utils.js';
import { adminClient } from '../supabase.js';
import { createSchoolAdmin } from '../services/userProvisioning.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.get('/dashboard', asyncHandler(async (req, res) => {
  const [schools, students, enrolls, payments, recent, schoolList, planRows] = await Promise.all([
    req.supabase.from('schools').select('*', { count: 'exact', head: true }),
    req.supabase.from('user_roles').select('*', { count: 'exact', head: true }).eq('role', 'student'),
    req.supabase.from('enrollments').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    req.supabase.from('payments').select('amount').eq('status', 'paid'),
    req.supabase.from('enrollments').select('id, plan, enrolled_at, student:profiles!enrollments_student_id_fkey(full_name), school:schools(name)').order('enrolled_at', { ascending: false }).limit(5),
    req.supabase.from('schools').select('id, name').limit(6),
    req.supabase.from('enrollments').select('plan'),
  ]);
  for (const r of [schools, students, enrolls, payments, recent, schoolList, planRows]) if (r.error) throw new Error(r.error.message);
  const revenue = (payments.data ?? []).reduce((s, p) => s + Number(p.amount), 0);
  const counts = { basic: 0, standard: 0, premium: 0 };
  (planRows.data ?? []).forEach((e) => { if (counts[e.plan] !== undefined) counts[e.plan]++; });
  const total = counts.basic + counts.standard + counts.premium || 1;
  res.json({
    stats: { schools: schools.count ?? 0, students: students.count ?? 0, active: enrolls.count ?? 0, revenue },
    recent: recent.data ?? [],
    schools: schoolList.data ?? [],
    planDist: { ...counts, total },
  });
}));

router.get('/schools', asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase.from('schools').select('*').order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  res.json(data ?? []);
}));

router.post('/schools', asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase.from('schools').insert(req.body).select().single();
  if (error) throw new Error(error.message);
  res.status(201).json(data);
}));

router.post('/schools/:schoolId/admin', asyncHandler(async (req, res) => {
  const result = await createSchoolAdmin(req.user.id, { ...req.body, school_id: req.params.schoolId });
  res.status(201).json(result);
}));

router.get('/payments', asyncHandler(async (req, res) => {
  const { data: payments, error } = await req.supabase.from('payments').select('id, amount, status, paid_at, due_date, installment_no, enrollment_id, created_at').order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  const enrollIds = [...new Set((payments ?? []).map((p) => p.enrollment_id))];
  if (!enrollIds.length) return res.json({ rows: [], paid: 0, pending: 0 });
  const { data: enrolls, error: eErr } = await req.supabase.from('enrollments').select('id, plan, student_id, school_id').in('id', enrollIds);
  if (eErr) throw new Error(eErr.message);
  const eMap = new Map((enrolls ?? []).map((e) => [e.id, e]));
  const studentIds = [...new Set((enrolls ?? []).map((e) => e.student_id))];
  const schoolIds = [...new Set((enrolls ?? []).map((e) => e.school_id))];
  const [{ data: profs, error: pErr }, { data: schools, error: sErr }] = await Promise.all([
    req.supabase.from('profiles').select('id, full_name').in('id', studentIds.length ? studentIds : [emptyUuid()]),
    req.supabase.from('schools').select('id, name').in('id', schoolIds.length ? schoolIds : [emptyUuid()]),
  ]);
  if (pErr) throw new Error(pErr.message);
  if (sErr) throw new Error(sErr.message);
  const pMap = new Map((profs ?? []).map((p) => [p.id, p.full_name]));
  const sMap = new Map((schools ?? []).map((s) => [s.id, s.name]));
  const rows = (payments ?? []).map((p) => {
    const e = eMap.get(p.enrollment_id);
    return { ...p, plan: e?.plan ?? '—', student: pMap.get(e?.student_id) ?? '—', school: sMap.get(e?.school_id) ?? '—' };
  });
  const paid = rows.filter((r) => r.status === 'paid').reduce((s, r) => s + Number(r.amount), 0);
  const pending = rows.filter((r) => r.status !== 'paid').reduce((s, r) => s + Number(r.amount), 0);
  res.json({ rows, paid, pending });
}));

router.get('/students', asyncHandler(async (req, res) => {
  const { data: roles, error } = await req.supabase.from('user_roles').select('user_id, school_id').eq('role', 'student');
  if (error) throw new Error(error.message);
  const ids = (roles ?? []).map((r) => r.user_id);
  if (!ids.length) return res.json([]);
  const [{ data: profs, error: pErr }, { data: schools, error: sErr }] = await Promise.all([
    req.supabase.from('profiles').select('id, full_name, email, class_assigned, school_id, parent_phone').in('id', ids),
    req.supabase.from('schools').select('id, name'),
  ]);
  if (pErr) throw new Error(pErr.message);
  if (sErr) throw new Error(sErr.message);
  const sMap = new Map((schools ?? []).map((s) => [s.id, s.name]));
  res.json((profs ?? []).map((p) => ({ ...p, school_name: sMap.get(p.school_id) ?? '—' })));
}));

router.get('/teachers', asyncHandler(async (req, res) => {
  const { data: roles, error } = await req.supabase.from('user_roles').select('user_id, school_id').eq('role', 'teacher');
  if (error) throw new Error(error.message);
  const ids = (roles ?? []).map((r) => r.user_id);
  if (!ids.length) return res.json([]);
  const [{ data: profs, error: pErr }, { data: schools, error: sErr }] = await Promise.all([
    req.supabase.from('profiles').select('id, full_name, email, class_assigned, school_id, phone').in('id', ids),
    req.supabase.from('schools').select('id, name'),
  ]);
  if (pErr) throw new Error(pErr.message);
  if (sErr) throw new Error(sErr.message);
  const sMap = new Map((schools ?? []).map((s) => [s.id, s.name]));
  res.json((profs ?? []).map((p) => ({ ...p, school_name: sMap.get(p.school_id) ?? '—' })));
}));

router.get('/sessions/schools', asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase.from('schools').select('id, name').order('name');
  if (error) throw new Error(error.message);
  res.json(data ?? []);
}));

router.get('/sessions', asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase.from('sessions').select('*').order('scheduled_at', { ascending: false });
  if (error) throw new Error(error.message);
  const sIds = [...new Set((data ?? []).map((s) => s.target_school_id).filter(Boolean))];
  const { data: schoolsData, error: sErr } = sIds.length ? await req.supabase.from('schools').select('id, name').in('id', sIds) : { data: [], error: null };
  if (sErr) throw new Error(sErr.message);
  const sMap = new Map((schoolsData ?? []).map((s) => [s.id, s.name]));
  res.json((data ?? []).map((s) => ({ ...s, school_name: s.target_school_id ? sMap.get(s.target_school_id) : 'All schools' })));
}));

router.post('/sessions', upload.single('file'), asyncHandler(async (req, res) => {
  const form = req.body;
  let recording_url = null;
  if (req.file) {
    const path = `${form.target_school_id || 'global'}/${Date.now()}-${req.file.originalname}`;
    const { error } = await adminClient.storage.from('session-recordings').upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (error) throw new Error(error.message);
    recording_url = path;
  }
  const { data, error } = await req.supabase.from('sessions').insert({
    title: form.title,
    description: form.description || null,
    target_school_id: form.target_school_id || null,
    target_class: form.target_class || null,
    scheduled_at: form.scheduled_at,
    duration_minutes: Number(form.duration_minutes || 30),
    recording_url,
    created_by: req.user.id,
  }).select().single();
  if (error) throw new Error(error.message);
  res.status(201).json(data);
}));

router.get('/sessions/recording-url', asyncHandler(async (req, res) => {
  const path = String(req.query.path || '');
  if (!path) return res.status(400).json({ error: 'Missing path' });
  const { data, error } = await adminClient.storage.from('session-recordings').createSignedUrl(path, 3600);
  if (error) throw new Error(error.message);
  res.json({ signedUrl: data.signedUrl });
}));

export default router;

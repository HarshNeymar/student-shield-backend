import { Router } from 'express';
import { asyncHandler } from '../utils.js';
import { adminClient } from '../supabase.js';
import { createTeacher, getCallerRoles } from '../services/userProvisioning.js';

const router = Router();


async function assertCanAccessSchool(req, schoolId) {
  const roles = await getCallerRoles(req.user.id);
  const canAccess = roles.some((r) => r.role === 'company_admin' || (r.role === 'school_admin' && r.school_id === schoolId));
  if (!canAccess) {
    const err = new Error('Forbidden — school admin can access only own school');
    err.status = 403;
    throw err;
  }
}

function countBy(rows, keyFn) {
  return rows.reduce((acc, row) => {
    const key = keyFn(row) || 'Unassigned';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

router.get('/dashboard', asyncHandler(async (req, res) => {
  const schoolId = req.query.schoolId;
  if (!schoolId) return res.status(400).json({ error: 'Missing schoolId' });
  await assertCanAccessSchool(req, schoolId);

  const [school, teacherRoles, studentRoles, enrollments, enrollIdsResp] = await Promise.all([
    adminClient.from('schools').select('*').eq('id', schoolId).maybeSingle(),
    adminClient.from('user_roles').select('user_id').eq('school_id', schoolId).eq('role', 'teacher'),
    adminClient.from('user_roles').select('user_id').eq('school_id', schoolId).eq('role', 'student'),
    adminClient.from('enrollments').select('id, amount, payment_status, plan, student_id, teacher_id').eq('school_id', schoolId),
    adminClient.from('enrollments').select('id').eq('school_id', schoolId),
  ]);
  for (const r of [school, teacherRoles, studentRoles, enrollments, enrollIdsResp]) if (r.error) throw new Error(r.error.message);

  const teacherIds = (teacherRoles.data ?? []).map((r) => r.user_id);
  const studentIds = (studentRoles.data ?? []).map((r) => r.user_id);
  const [teacherList, studentList] = await Promise.all([
    teacherIds.length ? adminClient.from('profiles').select('id, full_name, email, class_assigned').in('id', teacherIds) : { data: [], error: null },
    studentIds.length ? adminClient.from('profiles').select('id, full_name, email, class_assigned, parent_phone, age, created_by').in('id', studentIds) : { data: [], error: null },
  ]);
  if (teacherList.error) throw new Error(teacherList.error.message);
  if (studentList.error) throw new Error(studentList.error.message);

  const teacherMap = new Map((teacherList.data ?? []).map((t) => [t.id, t]));
  const enrollByStudent = new Map((enrollments.data ?? []).map((e) => [e.student_id, e]));
  const studentsWithTeacher = (studentList.data ?? []).map((student) => {
    const enrollment = enrollByStudent.get(student.id);
    const teacher = teacherMap.get(enrollment?.teacher_id ?? student.created_by);
    return { ...student, plan: enrollment?.plan ?? null, payment_status: enrollment?.payment_status ?? null, teacher_name: teacher?.full_name ?? '—' };
  });

  const revenue = (enrollments.data ?? []).filter((e) => e.payment_status !== 'failed').reduce((s, e) => s + Number(e.amount), 0);
  const ids = (enrollIdsResp.data ?? []).map((e) => e.id);
  let paid = 0; let pending = 0;
  if (ids.length) {
    const { data, error } = await adminClient.from('payments').select('amount, status').in('enrollment_id', ids);
    if (error) throw new Error(error.message);
    paid = (data ?? []).filter((p) => p.status === 'paid').reduce((s, p) => s + Number(p.amount), 0);
    pending = (data ?? []).filter((p) => p.status === 'pending').reduce((s, p) => s + Number(p.amount), 0);
  }

  res.json({
    school: school.data,
    stats: { teachers: teacherIds.length, students: studentIds.length, revenue },
    teachers: teacherList.data ?? [],
    students: studentsWithTeacher,
    classWiseStudentCount: countBy(studentsWithTeacher, (s) => s.class_assigned),
    planWiseStudentDistribution: countBy(enrollments.data ?? [], (e) => e.plan),
    teacherStudentMap: countBy(studentsWithTeacher, (s) => s.teacher_name),
    payments: { paid, pending },
  });
}));

router.get('/students', asyncHandler(async (req, res) => {
  const schoolId = req.query.schoolId;
  if (!schoolId) return res.status(400).json({ error: 'Missing schoolId' });
  await assertCanAccessSchool(req, schoolId);
  const { data: roles, error } = await adminClient.from('user_roles').select('user_id').eq('school_id', schoolId).eq('role', 'student');
  if (error) throw new Error(error.message);
  const ids = (roles ?? []).map((r) => r.user_id);
  if (!ids.length) return res.json([]);
  const { data, error: pErr } = await adminClient.from('profiles').select('id, full_name, email, class_assigned, parent_phone, age, created_by').in('id', ids);
  if (pErr) throw new Error(pErr.message);
  res.json(data ?? []);
}));

router.get('/teachers', asyncHandler(async (req, res) => {
  const schoolId = req.query.schoolId;
  if (!schoolId) return res.status(400).json({ error: 'Missing schoolId' });
  await assertCanAccessSchool(req, schoolId);
  const { data: roles, error } = await adminClient.from('user_roles').select('user_id').eq('school_id', schoolId).eq('role', 'teacher');
  if (error) throw new Error(error.message);
  const ids = (roles ?? []).map((r) => r.user_id);
  if (!ids.length) return res.json([]);
  const { data, error: pErr } = await adminClient
    .from('profiles')
    .select('id, full_name, email, phone, class_assigned, school_id, created_at')
    .in('id', ids)
    .order('created_at', { ascending: false });
  if (pErr) throw new Error(pErr.message);
  res.json(data ?? []);
}));

router.post('/teachers', asyncHandler(async (req, res) => {
  const result = await createTeacher(req.user.id, req.body);
  res.status(201).json(result);
}));

router.get('/payments', asyncHandler(async (req, res) => {
  const schoolId = req.query.schoolId;
  if (!schoolId) return res.status(400).json({ error: 'Missing schoolId' });
  await assertCanAccessSchool(req, schoolId);
  const { data: enrolls, error } = await adminClient.from('enrollments').select('id, amount, payment_status, plan, student_id').eq('school_id', schoolId);
  if (error) throw new Error(error.message);
  const ids = (enrolls ?? []).map((e) => e.id);
  let payments = [];
  if (ids.length) {
    const { data, error: pErr } = await adminClient.from('payments').select('amount, status, paid_at, due_date, enrollment_id, installment_no').in('enrollment_id', ids);
    if (pErr) throw new Error(pErr.message);
    payments = data ?? [];
  }
  const paid = payments.filter((p) => p.status === 'paid').reduce((s, p) => s + Number(p.amount), 0);
  const pending = payments.filter((p) => p.status === 'pending').reduce((s, p) => s + Number(p.amount), 0);
  res.json({ enrollments: enrolls ?? [], payments, paid, pending });
}));

export default router;

import { Router } from 'express';
import { asyncHandler } from '../utils.js';
import { adminClient } from '../supabase.js';
import { createStudent } from '../services/userProvisioning.js';
import { listClaimsForTeacher, raiseTeacherClaim } from './claims.js';

const router = Router();

async function getTeacherProfile(userId) {
  const { data, error } = await adminClient
    .from('profiles')
    .select('id, full_name, email, phone, school_id, class_assigned')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  return data;
}

async function getTeacherStudents(userId) {
  const { data: enrollments, error: enrollmentError } = await adminClient
    .from('enrollments')
    .select(`
      id,
      student_id,
      teacher_id,
      school_id,
      plan,
      amount,
      payment_mode,
      payment_status,
      enrolled_at,
      expires_at
    `)
    .eq('teacher_id', userId)
    .order('enrolled_at', { ascending: false });

  if (enrollmentError) throw new Error(enrollmentError.message);

  const rows = enrollments ?? [];

  if (!rows.length) {
    return [];
  }

  const studentIds = rows
    .map((item) => item.student_id)
    .filter(Boolean);

  if (!studentIds.length) {
    return rows.map((item) => ({
      ...item,
      student: null,
    }));
  }

  const { data: students, error: studentError } = await adminClient
    .from('profiles')
    .select(`
      id,
      full_name,
      email,
      parent_phone,
      age,
      class_assigned,
      school_id
    `)
    .in('id', studentIds);

  if (studentError) throw new Error(studentError.message);

  const studentMap = new Map(
    (students ?? []).map((student) => [student.id, student])
  );

  return rows.map((item) => ({
    ...item,
    student: studentMap.get(item.student_id) ?? null,
  }));
}

router.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const [profile, students, reports, claims] = await Promise.all([
      getTeacherProfile(userId),
      getTeacherStudents(userId),
      adminClient
        .from('wellness_reports')
        .select('*', { count: 'exact', head: true })
        .eq('teacher_id', userId),
      adminClient
        .from('claims')
        .select('*', { count: 'exact', head: true })
        .eq('teacher_id', userId)
        .eq('status', 'pending'),
    ]);

    for (const result of [reports, claims]) {
      if (result.error) throw new Error(result.error.message);
    }

    res.json({
      profile,
      students,
      counts: {
        students: students.length,
        reports: reports.count ?? 0,
        pendingClaims: claims.count ?? 0,
      },
    });
  })
);

router.get(
  '/students',
  asyncHandler(async (req, res) => {
    const students = await getTeacherStudents(req.user.id);

    res.json(students);
  })
);

router.post(
  '/students',
  asyncHandler(async (req, res) => {
    const result = await createStudent(req.user.id, req.body);

    res.status(201).json(result);
  })
);

router.get(
  '/claims',
  asyncHandler(async (req, res) => {
    const { data, error } = await adminClient
      .from('claims')
      .select('*')
      .eq('teacher_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);

    res.json(data ?? []);
  })
);

router.post(
  '/claims',
  asyncHandler(async (req, res) => {
    const profile = await getTeacherProfile(req.user.id);

    if (!profile?.school_id) {
      return res.status(400).json({ error: 'Missing school assignment' });
    }

    const title = String(req.body.title ?? '').trim();
    const description = String(req.body.description ?? '').trim();
    const amount = Number(req.body.amount ?? 0);

    if (!title || !description) {
      return res.status(400).json({
        error: 'Title and description are required',
      });
    }

    const { data, error } = await adminClient
      .from('claims')
      .insert({
        teacher_id: req.user.id,
        school_id: profile.school_id,
        title,
        description,
        amount,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    res.status(201).json(data);
  })
);

router.get(
  '/wellness/students',
  asyncHandler(async (req, res) => {
    const students = await getTeacherStudents(req.user.id);

    res.json(students.map((item) => item.student).filter(Boolean));
  })
);

router.post(
  '/wellness',
  asyncHandler(async (req, res) => {
    const profile = await getTeacherProfile(req.user.id);

    if (!profile?.school_id) {
      return res.status(400).json({ error: 'Missing school assignment' });
    }

    const studentId = req.body.student_id;

    if (!studentId) {
      return res.status(400).json({ error: 'Student is required' });
    }

    const { data: enrollment, error: enrollmentError } = await adminClient
      .from('enrollments')
      .select('id')
      .eq('teacher_id', req.user.id)
      .eq('student_id', studentId)
      .maybeSingle();

    if (enrollmentError) throw new Error(enrollmentError.message);

    if (!enrollment) {
      return res.status(403).json({
        error: 'Student is not assigned to this teacher',
      });
    }

    const { data, error } = await adminClient
      .from('wellness_reports')
      .insert({
        student_id: studentId,
        teacher_id: req.user.id,
        school_id: profile.school_id,
        behavioral: req.body.behavioral,
        emotional: req.body.emotional,
        academic: req.body.academic,
        participation: req.body.participation,
        health: req.body.health,
        notes: req.body.notes ?? null,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    res.status(201).json(data);
  })
);

router.post(
  '/contact',
  asyncHandler(async (req, res) => {
    const profile = await getTeacherProfile(req.user.id);

    if (!profile?.school_id) {
      return res.status(400).json({ error: 'Missing school assignment' });
    }

    const subject = String(req.body.subject ?? '').trim();
    const message = String(req.body.message ?? '').trim();
    const priority = String(req.body.priority ?? 'normal').trim();

    if (!subject || !message) {
      return res.status(400).json({
        error: 'Subject and message are required',
      });
    }

    const { data, error } = await adminClient
      .from('claims')
      .insert({
        teacher_id: req.user.id,
        school_id: profile.school_id,
        title: `Contact Us: ${subject}`,
        description: `[Priority: ${priority}]\n\n${message}`,
        amount: 0,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    res.status(201).json({
      success: true,
      ticket: data,
      message: 'Your message has been submitted to support.',
    });
  })
);

router.get(
  '/claims',
  asyncHandler(async (req, res) => {
    const claims = await listClaimsForTeacher(req.user.id);
    res.json(claims);
  })
);

router.post(
  '/claims',
  asyncHandler(async (req, res) => {
    const claim = await raiseTeacherClaim(req.user.id, req.body);
    res.status(201).json(claim);
  })
);

export default router;
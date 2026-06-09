import { Router } from 'express';
import multer from 'multer';
import { asyncHandler } from '../utils.js';
import { adminClient } from '../supabase.js';
import { createStudent, payPendingStudentFees } from '../services/userProvisioning.js';
import { listClaimsForTeacher, raiseTeacherClaim } from './claims.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 5,
  },
});
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

 const enrollmentIds = rows.map((item) => item.id).filter(Boolean);

const { data: pendingPayments, error: pendingPaymentError } = enrollmentIds.length
  ? await adminClient
      .from('payments')
      .select('id, enrollment_id, amount, status, due_date, installment_no')
      .in('enrollment_id', enrollmentIds)
      .eq('status', 'pending')
  : { data: [], error: null };

if (pendingPaymentError) {
  throw new Error(pendingPaymentError.message);
}

const pendingPaymentMap = new Map(
  (pendingPayments ?? []).map((payment) => [payment.enrollment_id, payment])
);

return rows.map((item) => ({
  ...item,
  student: studentMap.get(item.student_id) ?? null,
  pending_payment: pendingPaymentMap.get(item.id) ?? null,
  pending_amount: pendingPaymentMap.get(item.id)?.amount ?? null,
  pending_due_date: pendingPaymentMap.get(item.id)?.due_date ?? null,
}));
}

function getPlanLabel(plan) {
  const labels = {
    basic: 'Basic Plan',
    standard: 'Standard Plan',
    premium: 'Premium Plan',
  };

  return labels[plan] ?? 'Basic Plan';
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

    let school = null;

    if (profile?.school_id) {
      const { data: schoolData, error: schoolError } = await adminClient
        .from('schools')
        .select('id, name, selected_plan_tier')
        .eq('id', profile.school_id)
        .maybeSingle();

      if (schoolError) {
        throw new Error(schoolError.message);
      }

      school = schoolData;
    }

    const selectedPlanTier = school?.selected_plan_tier ?? 'basic';

    res.json({
      profile,
      school,
      plan: {
        tier: selectedPlanTier,
        name: getPlanLabel(selectedPlanTier),
      },
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
  '/students/:studentId/pay-pending-fees',
  asyncHandler(async (req, res) => {
    const result = await payPendingStudentFees(
      req.user.id,
      req.params.studentId
    );

    res.json(result);
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
  upload.array('documents', 5),
  asyncHandler(async (req, res) => {
    console.log('CLAIM BODY:', req.body);
    console.log('CLAIM FILES:', req.files?.length ?? 0);

    const claim = await raiseTeacherClaim(
      req.user.id,
      req.body,
      req.files ?? []
    );

    res.status(201).json(claim);
  })
);

router.get(
  '/plan',
  asyncHandler(async (req, res) => {
    const { data: profile, error: profileError } = await adminClient
      .from('profiles')
      .select('school_id')
      .eq('id', req.user.id)
      .maybeSingle();

    if (profileError) {
      throw new Error(profileError.message);
    }

    if (!profile?.school_id) {
      return res.status(400).json({
        error: 'School assignment missing',
      });
    }

    const { data: school, error: schoolError } = await adminClient
      .from('schools')
      .select('id, name, selected_plan_tier')
      .eq('id', profile.school_id)
      .maybeSingle();

    if (schoolError) {
      throw new Error(schoolError.message);
    }

    if (!school) {
      return res.status(404).json({
        error: 'School not found',
      });
    }

    res.json({
      school_id: school.id,
      school_name: school.name,
      selected_plan_tier: school.selected_plan_tier ?? 'basic',
    });
  })
);
export default router;
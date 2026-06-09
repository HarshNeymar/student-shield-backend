import { Router } from 'express';
import { asyncHandler } from '../utils.js';
import { adminClient } from '../supabase.js';
import { createTeacher, getCallerRoles, payPendingStudentFees } from '../services/userProvisioning.js';
import { listClaimsForSchoolAdmin, raiseSchoolAdminClaim } from './claims.js';
import { createStudent } from '../services/userProvisioning.js';
import multer from 'multer';
const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 5,
  },
});

async function assertCanAccessSchool(req, schoolId) {
  const roles = await getCallerRoles(req.user.id);
  const canAccess = roles.some((r) => r.role === 'company_admin' || (r.role === 'school_admin' && r.school_id === schoolId));
  if (!canAccess) {
    const err = new Error('Forbidden — school admin can access only own school');
    err.status = 403;
    throw err;
  }
}
function getPlanLabel(plan) {
  const labels = {
    basic: 'Basic Plan',
    standard: 'Standard Plan',
    premium: 'Premium Plan',
  };

  return labels[plan] ?? 'Basic Plan';
}
function countBy(rows, keyFn) {
  return rows.reduce((acc, row) => {
    const key = keyFn(row) || 'Unassigned';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

router.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const schoolId = req.query.schoolId;

    if (!schoolId) {
      return res.status(400).json({ error: 'Missing schoolId' });
    }

    await assertCanAccessSchool(req, schoolId);

    const [
      school,
      teacherRoles,
      studentRoles,
      enrollments,
      enrollIdsResp,
      claimsCountResp,
    ] = await Promise.all([
      adminClient
        .from('schools')
        .select('*, selected_plan_tier')
        .eq('id', schoolId)
        .maybeSingle(),

      adminClient
        .from('user_roles')
        .select('user_id')
        .eq('school_id', schoolId)
        .eq('role', 'teacher'),

      adminClient
        .from('user_roles')
        .select('user_id')
        .eq('school_id', schoolId)
        .eq('role', 'student'),

      adminClient
        .from('enrollments')
        .select(
          'id, amount, payment_status, plan, plan_tier, student_id, teacher_id'
        )
        .eq('school_id', schoolId),

      adminClient
        .from('enrollments')
        .select('id')
        .eq('school_id', schoolId),

      adminClient
        .from('claims')
        .select('id', {
          count: 'exact',
          head: true,
        })
        .eq('school_id', schoolId),
    ]);

    for (const r of [
      school,
      teacherRoles,
      studentRoles,
      enrollments,
      enrollIdsResp,
    ]) {
      if (r.error) {
        throw new Error(r.error.message);
      }
    }

    if (claimsCountResp.error) {
      console.warn(
        'School dashboard claims count failed:',
        claimsCountResp.error.message
      );
    }

    const teacherIds = (teacherRoles.data ?? []).map((r) => r.user_id);
    const studentIds = (studentRoles.data ?? []).map((r) => r.user_id);

    const [teacherList, studentList] = await Promise.all([
      teacherIds.length
        ? adminClient
            .from('profiles')
            .select('id, full_name, email, class_assigned')
            .in('id', teacherIds)
        : { data: [], error: null },

      studentIds.length
        ? adminClient
            .from('profiles')
            .select(
              'id, full_name, email, class_assigned, parent_phone, age, created_by'
            )
            .in('id', studentIds)
        : { data: [], error: null },
    ]);

    if (teacherList.error) {
      throw new Error(teacherList.error.message);
    }

    if (studentList.error) {
      throw new Error(studentList.error.message);
    }

    const teacherMap = new Map(
      (teacherList.data ?? []).map((teacher) => [teacher.id, teacher])
    );

    const enrollByStudent = new Map(
      (enrollments.data ?? []).map((enrollment) => [
        enrollment.student_id,
        enrollment,
      ])
    );

    const studentsWithTeacher = (studentList.data ?? []).map((student) => {
      const enrollment = enrollByStudent.get(student.id);

      const teacher = teacherMap.get(
        enrollment?.teacher_id ?? student.created_by
      );

      return {
        ...student,
        plan: enrollment?.plan_tier ?? enrollment?.plan ?? null,
        payment_status: enrollment?.payment_status ?? null,
        teacher_name: teacher?.full_name ?? '—',
      };
    });

    const revenue = (enrollments.data ?? [])
      .filter((enrollment) => enrollment.payment_status !== 'failed')
      .reduce((sum, enrollment) => sum + Number(enrollment.amount ?? 0), 0);

    const ids = (enrollIdsResp.data ?? []).map((enrollment) => enrollment.id);

    let paid = 0;
    let pending = 0;

    if (ids.length) {
      const { data, error } = await adminClient
        .from('payments')
        .select('amount, status')
        .in('enrollment_id', ids);

      if (error) {
        throw new Error(error.message);
      }

      paid = (data ?? [])
        .filter((payment) => payment.status === 'paid')
        .reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0);

      pending = (data ?? [])
        .filter((payment) => payment.status === 'pending')
        .reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0);
    }

    const planLabels = {
      basic: 'Basic Plan',
      standard: 'Standard Plan',
      premium: 'Premium Plan',
    };

    const selectedPlanTier = school.data?.selected_plan_tier ?? 'basic';

    res.json({
      school: school.data,

      plan: {
        tier: selectedPlanTier,
        name: planLabels[selectedPlanTier] ?? 'Basic Plan',
      },

      stats: {
        teachers: teacherIds.length,
        students: studentIds.length,
        revenue,
        claims: claimsCountResp.count ?? 0,
      },

      teachers: teacherList.data ?? [],
      students: studentsWithTeacher,

      classWiseStudentCount: countBy(
        studentsWithTeacher,
        (student) => student.class_assigned
      ),

      planWiseStudentDistribution: countBy(
        enrollments.data ?? [],
        (enrollment) => enrollment.plan_tier ?? enrollment.plan
      ),

      teacherStudentMap: countBy(
        studentsWithTeacher,
        (student) => student.teacher_name
      ),

      payments: {
        paid,
        pending,
      },
    });
  })
);

router.get(
  '/students',
  asyncHandler(async (req, res) => {
    const schoolId = req.query.schoolId;

    if (!schoolId) {
      return res.status(400).json({ error: 'Missing schoolId' });
    }

    await assertCanAccessSchool(req, schoolId);

    const { data: roles, error: roleError } = await adminClient
      .from('user_roles')
      .select('user_id')
      .eq('school_id', schoolId)
      .eq('role', 'student');

    if (roleError) {
      throw new Error(roleError.message);
    }

    const studentIds = (roles ?? []).map((r) => r.user_id).filter(Boolean);

    if (!studentIds.length) {
      return res.json([]);
    }

    const { data: students, error: profileError } = await adminClient
      .from('profiles')
      .select(
        `
        id,
        full_name,
        email,
        class_assigned,
        parent_phone,
        age,
        created_by,
        school_id
      `
      )
      .in('id', studentIds)
      .order('full_name');

    if (profileError) {
      throw new Error(profileError.message);
    }

    const enrollmentWithNewColumns = await adminClient
      .from('enrollments')
      .select(
        `
        id,
        student_id,
        teacher_id,
        school_id,
        plan,
        plan_tier,
        plan_duration,
        amount,
        payment_mode,
        payment_type,
        payment_status,
        enrolled_at,
        expires_at,
        created_at
      `
      )
      .eq('school_id', schoolId)
      .in('student_id', studentIds);

    let enrollments = [];

    if (!enrollmentWithNewColumns.error) {
      enrollments = enrollmentWithNewColumns.data ?? [];
    } else {
      console.warn(
        'School students enrollment fallback:',
        enrollmentWithNewColumns.error.message
      );

      const fallback = await adminClient
        .from('enrollments')
        .select(
          `
          id,
          student_id,
          teacher_id,
          school_id,
          plan,
          amount,
          payment_status,
          enrolled_at,
          expires_at,
          created_at
        `
        )
        .eq('school_id', schoolId)
        .in('student_id', studentIds);

      if (fallback.error) {
        throw new Error(fallback.error.message);
      }

      enrollments = fallback.data ?? [];
    }

    const enrollmentIds = enrollments.map((item) => item.id).filter(Boolean);

    const { data: pendingPayments, error: pendingPaymentError } =
      enrollmentIds.length
        ? await adminClient
            .from('payments')
            .select(
              `
              id,
              enrollment_id,
              amount,
              status,
              due_date,
              installment_no,
              paid_at,
              payment_type,
              payment_mode
            `
            )
            .in('enrollment_id', enrollmentIds)
            .eq('status', 'pending')
            .order('installment_no', { ascending: true })
        : { data: [], error: null };

    if (pendingPaymentError) {
      throw new Error(pendingPaymentError.message);
    }

    const pendingPaymentMap = new Map();

    for (const payment of pendingPayments ?? []) {
      if (!pendingPaymentMap.has(payment.enrollment_id)) {
        pendingPaymentMap.set(payment.enrollment_id, payment);
      }
    }

    const teacherIds = [
      ...new Set(
        enrollments
          .map((enrollment) => enrollment.teacher_id)
          .filter(Boolean)
      ),
    ];

    const { data: teachers, error: teacherError } = teacherIds.length
      ? await adminClient
          .from('profiles')
          .select('id, full_name, email, class_assigned')
          .in('id', teacherIds)
      : { data: [], error: null };

    if (teacherError) {
      throw new Error(teacherError.message);
    }

    const teacherMap = new Map(
      (teachers ?? []).map((teacher) => [teacher.id, teacher])
    );

    const enrollmentMap = new Map(
      enrollments.map((enrollment) => [enrollment.student_id, enrollment])
    );

    const rows = (students ?? []).map((student) => {
      const enrollment = enrollmentMap.get(student.id);

      const teacher = enrollment?.teacher_id
        ? teacherMap.get(enrollment.teacher_id)
        : null;

      const pendingPayment = enrollment?.id
        ? pendingPaymentMap.get(enrollment.id) ?? null
        : null;

      return {
        id: student.id,
        full_name: student.full_name,
        email: student.email,
        class_assigned: student.class_assigned,
        parent_phone: student.parent_phone,
        age: student.age,
        school_id: student.school_id,

        enrollment_id: enrollment?.id ?? null,
        teacher_id: enrollment?.teacher_id ?? null,
        teacher_name: teacher?.full_name ?? '—',

        plan: enrollment?.plan ?? null,
        plan_tier: enrollment?.plan_tier ?? null,
        plan_duration: enrollment?.plan_duration ?? null,
        amount: enrollment?.amount ?? null,
        payment_mode: enrollment?.payment_mode ?? null,
        payment_type: enrollment?.payment_type ?? null,
        payment_status: enrollment?.payment_status ?? null,
        enrolled_at: enrollment?.enrolled_at ?? enrollment?.created_at ?? null,
        expires_at: enrollment?.expires_at ?? null,

        pending_payment: pendingPayment,
        pending_amount: pendingPayment?.amount ?? null,
        pending_due_date: pendingPayment?.due_date ?? null,
        pending_installment_no: pendingPayment?.installment_no ?? null,
      };
    });

    res.json(rows);
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


router.get(
  '/claims',
  asyncHandler(async (req, res) => {
    const claims = await listClaimsForSchoolAdmin(req.user.id);
    res.json(claims);
  })
);

router.post(
  '/claims',
  upload.array('documents', 5),
  asyncHandler(async (req, res) => {
    const claim = await raiseSchoolAdminClaim(
      req.user.id,
      req.body,
      req.files ?? []
    );

    res.status(201).json(claim);
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

    const selectedPlan = school.selected_plan_tier ?? 'basic';

    const planLabels = {
      basic: 'Basic Plan',
      standard: 'Standard Plan',
      premium: 'Premium Plan',
    };

    res.json({
      school_id: school.id,
      school_name: school.name,
      selected_plan_tier: selectedPlan,
      plan_name: planLabels[selectedPlan] ?? 'Basic Plan',
    });
  })
);

export default router;

import { Router } from 'express';
import multer from 'multer';
import { asyncHandler, emptyUuid } from '../utils.js';
import { adminClient } from '../supabase.js';
import {
  createSchoolAdmin,
  getCallerRoles,
} from '../services/userProvisioning.js';
import { listAllClaimsForCompany, updateClaimStatus } from './claims.js';
import { deleteSchoolWithAllData } from '../services/schoolDeletion.js';
const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

async function assertCompanyAdmin(req) {
  const roles = await getCallerRoles(req.user.id);
  const isCompanyAdmin = roles.some((r) => r.role === 'company_admin');

  if (!isCompanyAdmin) {
    const err = new Error('Forbidden — company admin only');
    err.status = 403;
    throw err;
  }
}

function sumAmount(rows = []) {
  return rows.reduce((total, row) => total + Number(row.amount ?? 0), 0);
}

function normalizeClassName(value) {
  return String(value ?? '').trim();
}

function parseTargetClasses(value) {
  let rawValues = [];

  if (Array.isArray(value)) {
    rawValues = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();

    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        rawValues = Array.isArray(parsed) ? parsed : [];
      } catch {
        rawValues = trimmed.split(',');
      }
    } else if (trimmed) {
      rawValues = trimmed.split(',');
    }
  }

  return [
    ...new Set(
      rawValues
        .map(normalizeClassName)
        .filter(Boolean)
    ),
  ];
}

function sessionTargetClasses(session) {
  const fromNewColumn = parseTargetClasses(session?.target_classes);

  if (fromNewColumn.length) {
    return fromNewColumn;
  }

  const legacyClass = normalizeClassName(session?.target_class);

  return legacyClass ? [legacyClass] : [];
}

function parseBoolean(value) {
  return ['true', '1', 'yes', 'all'].includes(
    String(value ?? '').trim().toLowerCase()
  );
}

function normalizeMeetingUrl(value) {
  const rawUrl = String(value ?? '').trim();

  if (!rawUrl) {
    return null;
  }

  const urlWithProtocol = /^https?:\/\//i.test(rawUrl)
    ? rawUrl
    : `https://${rawUrl}`;

  let parsedUrl;

  try {
    parsedUrl = new URL(urlWithProtocol);
  } catch {
    const err = new Error(
      'Meeting URL must be a valid http:// or https:// link'
    );
    err.status = 400;
    throw err;
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    const err = new Error(
      'Meeting URL must start with http:// or https://'
    );
    err.status = 400;
    throw err;
  }

  return parsedUrl.toString();
}

async function prepareSessionPayload(form) {
  const schoolId = String(form.target_school_id ?? '').trim();
  const title = String(form.title ?? '').trim();
  const scheduledAt = String(form.scheduled_at ?? '').trim();
  const durationMinutes = Number(form.duration_minutes ?? 30);

  if (!title) {
    const err = new Error('Session title is required');
    err.status = 400;
    throw err;
  }

  if (!schoolId) {
    const err = new Error(
      'Please select a school for this counseling session'
    );
    err.status = 400;
    throw err;
  }

  if (!scheduledAt || Number.isNaN(new Date(scheduledAt).getTime())) {
    const err = new Error('Please provide a valid session date and time');
    err.status = 400;
    throw err;
  }

  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    const err = new Error('Duration must be greater than 0 minutes');
    err.status = 400;
    throw err;
  }

  const { data: school, error: schoolError } = await adminClient
    .from('schools')
    .select('id')
    .eq('id', schoolId)
    .maybeSingle();

  if (schoolError) {
    throw new Error(schoolError.message);
  }

  if (!school) {
    const err = new Error('Selected school was not found');
    err.status = 404;
    throw err;
  }

  const classesForSchool = await getSchoolClassOptions(schoolId);

  if (!classesForSchool.length) {
    const err = new Error(
      'No classes are available for this school. Create a teacher or student with a class first.'
    );
    err.status = 400;
    throw err;
  }

  const selectAllClasses = parseBoolean(form.target_all_classes);

  let selectedClasses = parseTargetClasses(form.target_classes);

  if (!selectAllClasses && !selectedClasses.length) {
    selectedClasses = parseTargetClasses(form.target_class);
  }

  if (!selectAllClasses && !selectedClasses.length) {
    const err = new Error(
      'Select one or more classes, or choose All classes'
    );
    err.status = 400;
    throw err;
  }

  const invalidClasses = selectedClasses.filter(
    (className) => !classesForSchool.includes(className)
  );

  if (invalidClasses.length) {
    const err = new Error(
      `These classes do not belong to the selected school: ${invalidClasses.join(', ')}`
    );
    err.status = 400;
    throw err;
  }

  // Empty array means all classes of the selected school.
  const targetClasses = selectAllClasses ? [] : selectedClasses;

  return {
    title,
    description: String(form.description ?? '').trim() || null,
    target_school_id: schoolId,
    target_class: targetClasses.length === 1 ? targetClasses[0] : null,
    target_classes: targetClasses,
    scheduled_at: scheduledAt,
    duration_minutes: Math.round(durationMinutes),
    meeting_url: normalizeMeetingUrl(form.meeting_url),
  };
}

async function uploadSessionRecording(schoolId, file) {
  if (!file) {
    return null;
  }

  const mimeType = String(file.mimetype ?? '');

  if (
    !mimeType.startsWith('video/') &&
    !mimeType.startsWith('audio/')
  ) {
    const err = new Error(
      'Recording file must be an audio or video file'
    );
    err.status = 400;
    throw err;
  }

  const fileName = String(file.originalname ?? 'recording')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(-120);

  const storagePath = `${schoolId}/${Date.now()}-${
    fileName || 'recording'
  }`;

  const { error } = await adminClient.storage
    .from('session-recordings')
    .upload(storagePath, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });

  if (error) {
    throw new Error(error.message);
  }

  return storagePath;
}

async function getSchoolClassOptions(schoolId) {
  const { data, error } = await adminClient
    .from('profiles')
    .select('class_assigned')
    .eq('school_id', schoolId)
    .not('class_assigned', 'is', null)
    .order('class_assigned', { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return [
    ...new Set(
      (data ?? [])
        .map((row) => normalizeClassName(row.class_assigned))
        .filter(Boolean)
    ),
  ].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true })
  );
}

function countPlanDistribution(enrollments = []) {
  const counts = {
    basic: 0,
    standard: 0,
    premium: 0,
  };

  for (const item of enrollments) {
    const plan = String(item.plan_tier ?? item.plan ?? '').toLowerCase();

    if (counts[plan] !== undefined) {
      counts[plan] += 1;
    }
  }

  return {
    ...counts,
    total: counts.basic + counts.standard + counts.premium,
  };
}

async function getProfilesByRole(role, schoolId = null) {
  let roleQuery = adminClient
    .from('user_roles')
    .select('user_id, school_id')
    .eq('role', role);

  if (schoolId) {
    roleQuery = roleQuery.eq('school_id', schoolId);
  }

  const { data: roles, error: roleError } = await roleQuery;

  if (roleError) {
    throw new Error(roleError.message);
  }

  const userIds = (roles ?? []).map((r) => r.user_id).filter(Boolean);

  if (!userIds.length) {
    return [];
  }

  const { data: profiles, error: profileError } = await adminClient
    .from('profiles')
    .select(
      'id, full_name, email, phone, parent_phone, age, class_assigned, school_id, created_at'
    )
    .in('id', userIds);

  if (profileError) {
    throw new Error(profileError.message);
  }

  const roleSchoolMap = new Map(
    (roles ?? []).map((r) => [r.user_id, r.school_id])
  );

  return (profiles ?? []).map((profile) => ({
    ...profile,
    school_id: profile.school_id ?? roleSchoolMap.get(profile.id) ?? null,
  }));
}

async function getSchoolEnrollments(schoolId) {
  const selectWithNewColumns = `
    id,
    student_id,
    school_id,
    teacher_id,
    plan,
    plan_tier,
    plan_duration,
    amount,
    payment_mode,
    payment_type,
    payment_status,
    installment_dates,
    enrolled_at,
    expires_at,
    created_at
  `;

  const selectFallback = `
    id,
    student_id,
    school_id,
    teacher_id,
    plan,
    amount,
    payment_status,
    enrolled_at,
    expires_at,
    created_at
  `;

  let result = await adminClient
    .from('enrollments')
    .select(selectWithNewColumns)
    .eq('school_id', schoolId)
    .order('enrolled_at', { ascending: false });

  if (!result.error) {
    return result.data ?? [];
  }

  console.warn(
    'School overview enrollment query fallback:',
    result.error.message
  );

  result = await adminClient
    .from('enrollments')
    .select(selectFallback)
    .eq('school_id', schoolId)
    .order('enrolled_at', { ascending: false });

  if (result.error) {
    throw new Error(result.error.message);
  }

  return result.data ?? [];
}

async function getSchoolPayments(schoolId) {
  const { data: enrollments, error: enrollError } = await adminClient
    .from('enrollments')
    .select('id, school_id')
    .eq('school_id', schoolId);

  if (enrollError) {
    console.warn('School payments enrollment lookup failed:', enrollError.message);
    return [];
  }

  const enrollmentIds = (enrollments ?? []).map((e) => e.id).filter(Boolean);

  if (!enrollmentIds.length) {
    return [];
  }

  const { data: payments, error: paymentError } = await adminClient
    .from('payments')
    .select(
      'id, amount, status, paid_at, due_date, installment_no, enrollment_id, created_at'
    )
    .in('enrollment_id', enrollmentIds)
    .order('created_at', { ascending: false });

  if (paymentError) {
    console.warn('School payments query failed:', paymentError.message);
    return [];
  }

  return payments ?? [];
}

async function getSchoolOverview(schoolId) {
  const { data: school, error: schoolError } = await adminClient
    .from('schools')
    .select('*')
    .eq('id', schoolId)
    .maybeSingle();

  if (schoolError) {
    throw new Error(schoolError.message);
  }

  if (!school) {
    const err = new Error('School not found');
    err.status = 404;
    throw err;
  }

  const [schoolAdmins, teachers, students, enrollments, payments] =
    await Promise.all([
      getProfilesByRole('school_admin', schoolId),
      getProfilesByRole('teacher', schoolId),
      getProfilesByRole('student', schoolId),
      getSchoolEnrollments(schoolId),
      getSchoolPayments(schoolId),
    ]);

  const teacherMap = new Map(teachers.map((teacher) => [teacher.id, teacher]));

  const enrollmentsByStudent = new Map(
    enrollments.map((enrollment) => [enrollment.student_id, enrollment])
  );

  const studentsWithEnrollment = students.map((student) => {
    const enrollment = enrollmentsByStudent.get(student.id);

    const teacher = enrollment?.teacher_id
      ? teacherMap.get(enrollment.teacher_id)
      : null;

    return {
      ...student,
      enrollment_id: enrollment?.id ?? null,
      plan: enrollment?.plan ?? null,
      plan_tier: enrollment?.plan_tier ?? null,
      plan_duration: enrollment?.plan_duration ?? null,
      amount: enrollment?.amount ?? null,
      payment_mode: enrollment?.payment_mode ?? null,
      payment_type: enrollment?.payment_type ?? null,
      payment_status: enrollment?.payment_status ?? null,
      teacher_id: enrollment?.teacher_id ?? null,
      teacher_name: teacher?.full_name ?? '—',
      enrolled_at: enrollment?.enrolled_at ?? enrollment?.created_at ?? null,
    };
  });

  const teacherStudentCounts = new Map();

  for (const enrollment of enrollments) {
    if (!enrollment.teacher_id) continue;

    teacherStudentCounts.set(
      enrollment.teacher_id,
      (teacherStudentCounts.get(enrollment.teacher_id) ?? 0) + 1
    );
  }

  const teachersWithCounts = teachers.map((teacher) => ({
    ...teacher,
    student_count: teacherStudentCounts.get(teacher.id) ?? 0,
  }));

  const paidPayments = payments.filter((payment) => payment.status === 'paid');
  const pendingPayments = payments.filter(
    (payment) => payment.status !== 'paid'
  );

  return {
    school,
    school_admins: schoolAdmins,
    school_admin: schoolAdmins[0] ?? null,
    teachers: teachersWithCounts,
    students: studentsWithEnrollment,
    enrollments,
    paymentsSummary: {
      paid: sumAmount(paidPayments),
      pending: sumAmount(pendingPayments),
      total: sumAmount(payments),
      count: payments.length,
    },
    counts: {
      schoolAdmins: schoolAdmins.length,
      teachers: teachers.length,
      students: students.length,
      enrollments: enrollments.length,
      paidStudents: enrollments.filter((e) => e.payment_status === 'paid')
        .length,
      partialStudents: enrollments.filter((e) => e.payment_status === 'partial')
        .length,
    },
    planDist: countPlanDistribution(enrollments),
  };
}

async function getEnrollmentsForDashboard() {
  const withNewColumns = await adminClient
    .from('enrollments')
    .select(
      `
      id,
      student_id,
      school_id,
      teacher_id,
      plan,
      plan_tier,
      plan_duration,
      amount,
      payment_status,
      enrolled_at,
      created_at
    `
    )
    .order('enrolled_at', { ascending: false });

  if (!withNewColumns.error) {
    return withNewColumns.data ?? [];
  }

  console.warn(
    'Company dashboard enrollment query fallback:',
    withNewColumns.error.message
  );

  const fallback = await adminClient
    .from('enrollments')
    .select(
      `
      id,
      student_id,
      school_id,
      teacher_id,
      plan,
      amount,
      payment_status,
      enrolled_at,
      created_at
    `
    )
    .order('enrolled_at', { ascending: false });

  if (fallback.error) {
    throw new Error(fallback.error.message);
  }

  return fallback.data ?? [];
}

async function getPaymentsForDashboard() {
  const { data, error } = await adminClient
    .from('payments')
    .select(
      'id, amount, status, paid_at, due_date, enrollment_id, installment_no, created_at'
    )
    .order('created_at', { ascending: false });

  if (error) {
    console.warn('Company dashboard payments query failed:', error.message);
    return [];
  }

  return data ?? [];
}

router.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    await assertCompanyAdmin(req);

    const [
      schoolCountResp,
      studentRoleCountResp,
      schoolsResp,
      enrollments,
      payments,
      sessionCountResp,
      claimsCountResp,
    ] = await Promise.all([
      adminClient.from('schools').select('id', {
        count: 'exact',
        head: true,
      }),

      adminClient
        .from('user_roles')
        .select('id', {
          count: 'exact',
          head: true,
        })
        .eq('role', 'student'),

      adminClient
        .from('schools')
        .select('id, name, city, contact_email, contact_phone, created_at')
        .order('created_at', { ascending: false })
        .limit(6),

      getEnrollmentsForDashboard(),

      getPaymentsForDashboard(),

      adminClient.from('sessions').select('id', {
        count: 'exact',
        head: true,
      }),

      adminClient.from('claims').select('id', {
        count: 'exact',
        head: true,
      }),
    ]);

    if (schoolCountResp.error) {
      throw new Error(schoolCountResp.error.message);
    }

    if (studentRoleCountResp.error) {
      throw new Error(studentRoleCountResp.error.message);
    }

    if (schoolsResp.error) {
      throw new Error(schoolsResp.error.message);
    }

    if (sessionCountResp.error) {
      console.warn(
        'Company dashboard session count failed:',
        sessionCountResp.error.message
      );
    }

    if (claimsCountResp.error) {
      console.warn(
        'Company dashboard claims count failed:',
        claimsCountResp.error.message
      );
    }

    const paidPayments = payments.filter((item) => item.status === 'paid');
    const pendingPayments = payments.filter((item) => item.status !== 'paid');

    const recentEnrollments = enrollments.slice(0, 5);

    const studentIds = [
      ...new Set(
        recentEnrollments.map((item) => item.student_id).filter(Boolean)
      ),
    ];

    const schoolIds = [
      ...new Set(
        recentEnrollments.map((item) => item.school_id).filter(Boolean)
      ),
    ];

    const [studentProfilesResp, recentSchoolsResp] = await Promise.all([
      studentIds.length
        ? adminClient
            .from('profiles')
            .select('id, full_name, email, class_assigned')
            .in('id', studentIds)
        : { data: [], error: null },

      schoolIds.length
        ? adminClient.from('schools').select('id, name').in('id', schoolIds)
        : { data: [], error: null },
    ]);

    if (studentProfilesResp.error) {
      throw new Error(studentProfilesResp.error.message);
    }

    if (recentSchoolsResp.error) {
      throw new Error(recentSchoolsResp.error.message);
    }

    const studentMap = new Map(
      (studentProfilesResp.data ?? []).map((student) => [student.id, student])
    );

    const schoolMap = new Map(
      (recentSchoolsResp.data ?? []).map((school) => [school.id, school])
    );

    const recent = recentEnrollments.map((item) => {
      const student = studentMap.get(item.student_id);
      const school = schoolMap.get(item.school_id);

      return {
        ...item,
        student,
        school,
        student_name: student?.full_name ?? '—',
        school_name: school?.name ?? '—',
        plan_name: item.plan_tier ?? item.plan ?? '—',
      };
    });

    res.json({
      stats: {
        schools: schoolCountResp.count ?? 0,
        students: studentRoleCountResp.count ?? 0,
        active: enrollments.length,
        revenue: sumAmount(paidPayments),
        pendingAmount: sumAmount(pendingPayments),
        sessions: sessionCountResp.count ?? 0,
        claims: claimsCountResp.count ?? 0,
      },
      recent,
      schools: schoolsResp.data ?? [],
      planDist: countPlanDistribution(enrollments),
    });
  })
);

router.get(
  '/schools',
  asyncHandler(async (req, res) => {
    await assertCompanyAdmin(req);

    const { data: schools, error } = await adminClient
      .from('schools')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    const [teachers, students] = await Promise.all([
      getProfilesByRole('teacher'),
      getProfilesByRole('student'),
    ]);

    const teacherCountBySchool = new Map();
    const studentCountBySchool = new Map();

    for (const teacher of teachers) {
      if (!teacher.school_id) continue;

      teacherCountBySchool.set(
        teacher.school_id,
        (teacherCountBySchool.get(teacher.school_id) ?? 0) + 1
      );
    }

    for (const student of students) {
      if (!student.school_id) continue;

      studentCountBySchool.set(
        student.school_id,
        (studentCountBySchool.get(student.school_id) ?? 0) + 1
      );
    }

    res.json(
      (schools ?? []).map((school) => ({
        ...school,
        teacher_count: teacherCountBySchool.get(school.id) ?? 0,
        student_count: studentCountBySchool.get(school.id) ?? 0,
      }))
    );
  })
);

router.post(
  '/schools',
  asyncHandler(async (req, res) => {
    await assertCompanyAdmin(req);

    const { data, error } = await adminClient
      .from('schools')
      .insert(req.body)
      .select()
      .single();

    if (error) {
      throw new Error(error.message);
    }

    res.status(201).json(data);
  })
);

router.get(
  '/schools/:schoolId/overview',
  asyncHandler(async (req, res) => {
    await assertCompanyAdmin(req);

    const overview = await getSchoolOverview(req.params.schoolId);

    res.json(overview);
  })
);

router.post(
  '/schools/:schoolId/admin',
  asyncHandler(async (req, res) => {
    await assertCompanyAdmin(req);

    const result = await createSchoolAdmin(req.user.id, {
      ...req.body,
      school_id: req.params.schoolId,
    });

    res.status(201).json(result);
  })
);

router.get(
  '/payments',
  asyncHandler(async (req, res) => {
    await assertCompanyAdmin(req);

    const { data: payments, error } = await adminClient
      .from('payments')
      .select(
        'id, amount, status, paid_at, due_date, installment_no, enrollment_id, created_at'
      )
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    const enrollIds = [
      ...new Set((payments ?? []).map((p) => p.enrollment_id).filter(Boolean)),
    ];

    if (!enrollIds.length) {
      return res.json({
        rows: [],
        paid: 0,
        pending: 0,
      });
    }

    const { data: enrolls, error: eErr } = await adminClient
      .from('enrollments')
      .select('id, plan, plan_tier, student_id, school_id')
      .in('id', enrollIds);

    if (eErr) {
      throw new Error(eErr.message);
    }

    const eMap = new Map((enrolls ?? []).map((e) => [e.id, e]));

    const studentIds = [
      ...new Set((enrolls ?? []).map((e) => e.student_id).filter(Boolean)),
    ];

    const schoolIds = [
      ...new Set((enrolls ?? []).map((e) => e.school_id).filter(Boolean)),
    ];

    const [{ data: profs, error: pErr }, { data: schools, error: sErr }] =
      await Promise.all([
        adminClient
          .from('profiles')
          .select('id, full_name')
          .in('id', studentIds.length ? studentIds : [emptyUuid()]),

        adminClient
          .from('schools')
          .select('id, name')
          .in('id', schoolIds.length ? schoolIds : [emptyUuid()]),
      ]);

    if (pErr) {
      throw new Error(pErr.message);
    }

    if (sErr) {
      throw new Error(sErr.message);
    }

    const pMap = new Map((profs ?? []).map((p) => [p.id, p.full_name]));
    const sMap = new Map((schools ?? []).map((s) => [s.id, s.name]));

    const rows = (payments ?? []).map((payment) => {
      const enrollment = eMap.get(payment.enrollment_id);

      return {
        ...payment,
        plan: enrollment?.plan_tier ?? enrollment?.plan ?? '—',
        student: pMap.get(enrollment?.student_id) ?? '—',
        school: sMap.get(enrollment?.school_id) ?? '—',
      };
    });

    const paid = rows
      .filter((row) => row.status === 'paid')
      .reduce((total, row) => total + Number(row.amount ?? 0), 0);

    const pending = rows
      .filter((row) => row.status !== 'paid')
      .reduce((total, row) => total + Number(row.amount ?? 0), 0);

    res.json({
      rows,
      paid,
      pending,
    });
  })
);

router.get(
  '/students',
  asyncHandler(async (req, res) => {
    await assertCompanyAdmin(req);

    const students = await getProfilesByRole('student');

    const schoolIds = [
      ...new Set(students.map((student) => student.school_id).filter(Boolean)),
    ];

    const { data: schools, error: schoolError } = schoolIds.length
      ? await adminClient.from('schools').select('id, name').in('id', schoolIds)
      : { data: [], error: null };

    if (schoolError) {
      throw new Error(schoolError.message);
    }

    const sMap = new Map((schools ?? []).map((s) => [s.id, s.name]));

    res.json(
      students.map((profile) => ({
        ...profile,
        school_name: sMap.get(profile.school_id) ?? '—',
      }))
    );
  })
);

router.get(
  '/teachers',
  asyncHandler(async (req, res) => {
    await assertCompanyAdmin(req);

    const teachers = await getProfilesByRole('teacher');

    const schoolIds = [
      ...new Set(students.map((teacher) => teacher.school_id).filter(Boolean)),
    ];

    const { data: schools, error: schoolError } = schoolIds.length
      ? await adminClient.from('schools').select('id, name').in('id', schoolIds)
      : { data: [], error: null };

    if (schoolError) {
      throw new Error(schoolError.message);
    }

    const sMap = new Map((schools ?? []).map((s) => [s.id, s.name]));

    res.json(
      teachers.map((profile) => ({
        ...profile,
        school_name: sMap.get(profile.school_id) ?? '—',
      }))
    );
  })
);

router.get(
  '/sessions/schools',
  asyncHandler(async (req, res) => {
    await assertCompanyAdmin(req);

    const { data, error } = await adminClient
      .from('schools')
      .select('id, name')
      .order('name');

    if (error) {
      throw new Error(error.message);
    }

    res.json(data ?? []);
  })
);
router.get(
  '/sessions/schools/:schoolId/classes',
  asyncHandler(async (req, res) => {
    await assertCompanyAdmin(req);

    const schoolId = String(req.params.schoolId ?? '').trim();

    if (!schoolId) {
      return res.status(400).json({ error: 'Missing schoolId' });
    }

    const { data: school, error: schoolError } = await adminClient
      .from('schools')
      .select('id, name')
      .eq('id', schoolId)
      .maybeSingle();

    if (schoolError) {
      throw new Error(schoolError.message);
    }

    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }

    const classes = await getSchoolClassOptions(schoolId);

    res.json({
      school_id: school.id,
      school_name: school.name,
      classes,
    });
  })
);

router.get(
  '/sessions',
  asyncHandler(async (req, res) => {
    await assertCompanyAdmin(req);

    const { data, error } = await adminClient
      .from('sessions')
      .select('*')
      .order('scheduled_at', { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    const schoolIds = [
      ...new Set((data ?? []).map((s) => s.target_school_id).filter(Boolean)),
    ];

    const { data: schoolsData, error: schoolError } = schoolIds.length
      ? await adminClient.from('schools').select('id, name').in('id', schoolIds)
      : { data: [], error: null };

    if (schoolError) {
      throw new Error(schoolError.message);
    }

    const schoolMap = new Map(
      (schoolsData ?? []).map((school) => [school.id, school.name])
    );

    res.json(
      (data ?? []).map((session) => {
        const targetClasses = sessionTargetClasses(session);

        return {
          ...session,
          target_classes: targetClasses,
          target_class_scope:
            targetClasses.length === 0 ? 'all' : 'selected',
          school_name: session.target_school_id
            ? schoolMap.get(session.target_school_id) ?? '—'
            : 'All schools',
        };
      })
    );
  })
);

router.post(
  '/sessions',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    await assertCompanyAdmin(req);

    const payload = await prepareSessionPayload(req.body);

    const recordingUrl = await uploadSessionRecording(
      payload.target_school_id,
      req.file
    );

    const { data, error } = await adminClient
      .from('sessions')
      .insert({
        ...payload,
        recording_url: recordingUrl,
        created_by: req.user.id,
      })
      .select()
      .single();

    if (error) {
      if (recordingUrl) {
        await adminClient.storage
          .from('session-recordings')
          .remove([recordingUrl]);
      }

      throw new Error(error.message);
    }

    const targetClasses = sessionTargetClasses(data);

    res.status(201).json({
      ...data,
      target_classes: targetClasses,
      target_class_scope:
        targetClasses.length === 0 ? 'all' : 'selected',
    });
  })
);

router.patch(
  '/sessions/:sessionId',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    await assertCompanyAdmin(req);

    const sessionId = String(req.params.sessionId ?? '').trim();

    if (!sessionId) {
      return res.status(400).json({
        error: 'Missing session id',
      });
    }

    const { data: existingSession, error: existingError } =
      await adminClient
        .from('sessions')
        .select('id, recording_url')
        .eq('id', sessionId)
        .maybeSingle();

    if (existingError) {
      throw new Error(existingError.message);
    }

    if (!existingSession) {
      return res.status(404).json({
        error: 'Session not found',
      });
    }

    const payload = await prepareSessionPayload(req.body);

    const uploadedRecordingPath = await uploadSessionRecording(
      payload.target_school_id,
      req.file
    );

    // If no new file is selected, keep the existing recording.
    const recordingUrl =
      uploadedRecordingPath ?? existingSession.recording_url;

    const { data, error } = await adminClient
      .from('sessions')
      .update({
        ...payload,
        recording_url: recordingUrl,
      })
      .eq('id', sessionId)
      .select()
      .single();

    if (error) {
      if (uploadedRecordingPath) {
        await adminClient.storage
          .from('session-recordings')
          .remove([uploadedRecordingPath]);
      }

      throw new Error(error.message);
    }

    // Remove the old recording only after DB update succeeds.
    if (
      uploadedRecordingPath &&
      existingSession.recording_url &&
      existingSession.recording_url !== uploadedRecordingPath
    ) {
      const { error: removeError } = await adminClient.storage
        .from('session-recordings')
        .remove([existingSession.recording_url]);

      if (removeError) {
        console.warn(
          `Could not remove replaced session recording ${existingSession.recording_url}:`,
          removeError.message
        );
      }
    }

    const targetClasses = sessionTargetClasses(data);

    res.json({
      ...data,
      target_classes: targetClasses,
      target_class_scope:
        targetClasses.length === 0 ? 'all' : 'selected',
    });
  })
);

router.get(
  '/sessions/recording-url',
  asyncHandler(async (req, res) => {
    await assertCompanyAdmin(req);

    const path = String(req.query.path || '');

    if (!path) {
      return res.status(400).json({
        error: 'Missing path',
      });
    }

    const { data, error } = await adminClient.storage
      .from('session-recordings')
      .createSignedUrl(path, 3600);

    if (error) {
      throw new Error(error.message);
    }

    res.json({
      signedUrl: data.signedUrl,
    });
  })
);

router.get(
  '/claims',
  asyncHandler(async (req, res) => {
    await assertCompanyAdmin(req);

    const claims = await listAllClaimsForCompany();

    res.json(claims);
  })
);

router.patch(
  '/claims/:claimId/status',
  asyncHandler(async (req, res) => {
    await assertCompanyAdmin(req);

    const claim = await updateClaimStatus(req.params.claimId, req.body.status);

    res.json(claim);
  })
);


router.put(
  '/schools/:schoolId/plan',
  asyncHandler(async (req, res) => {
    await assertCompanyAdmin(req);

    const selectedPlan = String(req.body.selected_plan_tier ?? '').trim();

    const allowedPlans = ['basic', 'standard', 'premium'];

    if (!allowedPlans.includes(selectedPlan)) {
      return res.status(400).json({
        error: 'Invalid plan. Allowed values are basic, standard, premium',
      });
    }

    const { data, error } = await adminClient
      .from('schools')
      .update({
        selected_plan_tier: selectedPlan,
      })
      .eq('id', req.params.schoolId)
      .select('id, name, selected_plan_tier')
      .single();

    if (error) {
      throw new Error(error.message);
    }

    res.json(data);
  })
);

router.delete(
  '/schools/:schoolId',
  asyncHandler(async (req, res) => {
    await assertCompanyAdmin(req);

    const schoolId = String(req.params.schoolId || '').trim();

    if (!schoolId) {
      return res.status(400).json({
        error: 'Missing schoolId',
      });
    }

    const result = await deleteSchoolWithAllData(schoolId);

    res.json({
      success: true,
      message:
        'School, school admins, teachers, students, payments, claims, reports, sessions and private files were deleted successfully.',
      ...result,
    });
  })
);
export default router;
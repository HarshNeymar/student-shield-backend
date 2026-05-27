import { Router } from 'express';
import multer from 'multer';
import { asyncHandler, emptyUuid } from '../utils.js';
import { adminClient } from '../supabase.js';
import {
  createSchoolAdmin,
  getCallerRoles,
} from '../services/userProvisioning.js';

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

function countPlanDistribution(enrollments = []) {
  const counts = {
    basic: 0,
    standard: 0,
    premium: 0,
  };

  for (const item of enrollments) {
    const planValue = String(
      item.plan_tier ?? item.plan ?? ''
    ).toLowerCase();

    if (counts[planValue] !== undefined) {
      counts[planValue] += 1;
    }
  }

  const total = counts.basic + counts.standard + counts.premium;

  return {
    ...counts,
    total,
  };
}

async function getEnrollmentsForDashboard() {
  // First try with new proper columns.
  const withNewColumns = await adminClient
    .from('enrollments')
    .select(`
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
    `)
    .order('enrolled_at', { ascending: false });

  if (!withNewColumns.error) {
    return withNewColumns.data ?? [];
  }

  console.warn(
    'Company dashboard enrollment query fallback:',
    withNewColumns.error.message
  );

  // Fallback for old DB schema without plan_tier/plan_duration.
  const fallback = await adminClient
    .from('enrollments')
    .select(`
      id,
      student_id,
      school_id,
      teacher_id,
      plan,
      amount,
      payment_status,
      enrolled_at,
      created_at
    `)
    .order('enrolled_at', { ascending: false });

  if (fallback.error) {
    throw new Error(fallback.error.message);
  }

  return fallback.data ?? [];
}

async function getPaymentsForDashboard() {
  const { data, error } = await adminClient
    .from('payments')
    .select('id, amount, status, paid_at, due_date, enrollment_id, installment_no, created_at')
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
    ] = await Promise.all([
      adminClient
        .from('schools')
        .select('id', { count: 'exact', head: true }),

      adminClient
        .from('user_roles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'student'),

      adminClient
        .from('schools')
        .select('id, name, city, contact_email, contact_phone, created_at')
        .order('created_at', { ascending: false })
        .limit(6),

      getEnrollmentsForDashboard(),

      getPaymentsForDashboard(),

      adminClient
        .from('sessions')
        .select('id', { count: 'exact', head: true }),
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

    const activeEnrollments = enrollments.filter((item) => {
      if (item.status) return item.status === 'active';
      return true;
    });

    const paidPayments = payments.filter((item) => item.status === 'paid');
    const pendingPayments = payments.filter((item) => item.status !== 'paid');

    const revenue = sumAmount(paidPayments);
    const pendingAmount = sumAmount(pendingPayments);

    const recentEnrollments = enrollments.slice(0, 5);

    const studentIds = [
      ...new Set(recentEnrollments.map((item) => item.student_id).filter(Boolean)),
    ];

    const schoolIds = [
      ...new Set(recentEnrollments.map((item) => item.school_id).filter(Boolean)),
    ];

    const [studentProfilesResp, recentSchoolsResp] = await Promise.all([
      studentIds.length
        ? adminClient
            .from('profiles')
            .select('id, full_name, email, class_assigned')
            .in('id', studentIds)
        : { data: [], error: null },

      schoolIds.length
        ? adminClient
            .from('schools')
            .select('id, name')
            .in('id', schoolIds)
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
        active: activeEnrollments.length,
        revenue,
        pendingAmount,
        sessions: sessionCountResp.count ?? 0,
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

    const { data, error } = await adminClient
      .from('schools')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);

    res.json(data ?? []);
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

    if (error) throw new Error(error.message);

    res.status(201).json(data);
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
      .select('id, amount, status, paid_at, due_date, installment_no, enrollment_id, created_at')
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);

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
      .select('id, plan, student_id, school_id')
      .in('id', enrollIds);

    if (eErr) throw new Error(eErr.message);

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

    if (pErr) throw new Error(pErr.message);
    if (sErr) throw new Error(sErr.message);

    const pMap = new Map((profs ?? []).map((p) => [p.id, p.full_name]));
    const sMap = new Map((schools ?? []).map((s) => [s.id, s.name]));

    const rows = (payments ?? []).map((payment) => {
      const enrollment = eMap.get(payment.enrollment_id);

      return {
        ...payment,
        plan: enrollment?.plan ?? '—',
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

    const { data: roles, error } = await adminClient
      .from('user_roles')
      .select('user_id, school_id')
      .eq('role', 'student');

    if (error) throw new Error(error.message);

    const ids = (roles ?? []).map((r) => r.user_id);

    if (!ids.length) return res.json([]);

    const [{ data: profs, error: pErr }, { data: schools, error: sErr }] =
      await Promise.all([
        adminClient
          .from('profiles')
          .select('id, full_name, email, class_assigned, school_id, parent_phone')
          .in('id', ids),

        adminClient.from('schools').select('id, name'),
      ]);

    if (pErr) throw new Error(pErr.message);
    if (sErr) throw new Error(sErr.message);

    const sMap = new Map((schools ?? []).map((s) => [s.id, s.name]));

    res.json(
      (profs ?? []).map((profile) => ({
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

    const { data: roles, error } = await adminClient
      .from('user_roles')
      .select('user_id, school_id')
      .eq('role', 'teacher');

    if (error) throw new Error(error.message);

    const ids = (roles ?? []).map((r) => r.user_id);

    if (!ids.length) return res.json([]);

    const [{ data: profs, error: pErr }, { data: schools, error: sErr }] =
      await Promise.all([
        adminClient
          .from('profiles')
          .select('id, full_name, email, class_assigned, school_id, phone')
          .in('id', ids),

        adminClient.from('schools').select('id, name'),
      ]);

    if (pErr) throw new Error(pErr.message);
    if (sErr) throw new Error(sErr.message);

    const sMap = new Map((schools ?? []).map((s) => [s.id, s.name]));

    res.json(
      (profs ?? []).map((profile) => ({
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

    if (error) throw new Error(error.message);

    res.json(data ?? []);
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

    if (error) throw new Error(error.message);

    const sIds = [
      ...new Set((data ?? []).map((s) => s.target_school_id).filter(Boolean)),
    ];

    const { data: schoolsData, error: sErr } = sIds.length
      ? await adminClient.from('schools').select('id, name').in('id', sIds)
      : { data: [], error: null };

    if (sErr) throw new Error(sErr.message);

    const sMap = new Map((schoolsData ?? []).map((s) => [s.id, s.name]));

    res.json(
      (data ?? []).map((session) => ({
        ...session,
        school_name: session.target_school_id
          ? sMap.get(session.target_school_id) ?? '—'
          : 'All schools',
      }))
    );
  })
);

router.post(
  '/sessions',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    await assertCompanyAdmin(req);

    const form = req.body;
    let recording_url = null;

    if (req.file) {
      const path = `${
        form.target_school_id || 'global'
      }/${Date.now()}-${req.file.originalname}`;

      const { error } = await adminClient.storage
        .from('session-recordings')
        .upload(path, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false,
        });

      if (error) throw new Error(error.message);

      recording_url = path;
    }

    const { data, error } = await adminClient
      .from('sessions')
      .insert({
        title: form.title,
        description: form.description || null,
        target_school_id: form.target_school_id || null,
        target_class: form.target_class || null,
        scheduled_at: form.scheduled_at,
        duration_minutes: Number(form.duration_minutes || 30),
        recording_url,
        created_by: req.user.id,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    res.status(201).json(data);
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

    if (error) throw new Error(error.message);

    res.json({
      signedUrl: data.signedUrl,
    });
  })
);

export default router;
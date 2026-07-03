import { Router } from 'express';
import multer from 'multer';
import { asyncHandler } from '../utils.js';
import { adminClient } from '../supabase.js';
import {
  raiseStudentClaim,
  listClaimsForStudent,
  listClaimsRaisedByUser,
} from './claims.js';
import {
  createSmartBuddyLaunch,
  getSmartBuddyProfile,
  getSmartBuddyReportDownload,
  getSmartBuddyReportQuota,
  listSmartBuddyReports,
  saveSmartBuddyProfile,
  uploadSmartBuddyReport,
} from '../services/smartBuddy.js';
const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 5,
  },
});

const smartBuddyReportUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024,
    files: 1,
  },
});
function getPlanLabel(plan) {
  const labels = {
    basic: 'Basic Plan',
    standard: 'Standard Plan',
    premium: 'Premium Plan',
  };

  return labels[plan] ?? 'Basic Plan';
}

async function getStudentProfile(userId) {
  const { data, error } = await adminClient
    .from('profiles')
    .select(
      'id, full_name, email, school_id, class_assigned, parent_phone, age'
    )
    .eq('id', userId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  return data;
}

async function getStudentEnrollment(userId) {
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
      payment_mode,
      payment_type,
      payment_status,
      installment_dates,
      enrolled_at,
      expires_at,
      created_at
    `
    )
    .eq('student_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!withNewColumns.error) {
    return withNewColumns.data;
  }

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
      expires_at,
      created_at
    `
    )
    .eq('student_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (fallback.error) {
    throw new Error(fallback.error.message);
  }

  return fallback.data;
}

async function getSchoolById(schoolId) {
  if (!schoolId) return null;

  const { data, error } = await adminClient
    .from('schools')
    .select('id, name, selected_plan_tier')
    .eq('id', schoolId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  return data;
}

async function getTeacherById(teacherId) {
  if (!teacherId) return null;

  const { data, error } = await adminClient
    .from('profiles')
    .select('id, full_name, email')
    .eq('id', teacherId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  return data;
}

router.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const profile = await getStudentProfile(userId);

    if (!profile) {
      return res.status(404).json({
        error: 'Student profile not found',
      });
    }

    const enrollment = await getStudentEnrollment(userId);
    const school = await getSchoolById(profile.school_id);
    const teacher = await getTeacherById(enrollment?.teacher_id);

    const planTier =
      enrollment?.plan_tier ?? school?.selected_plan_tier ?? 'basic';

    let pendingInstallment = null;
    let payments = [];

    if (enrollment?.id) {
      const { data: paymentRows, error: paymentsError } = await adminClient
        .from('payments')
        .select(
          `
          id,
          enrollment_id,
          amount,
          status,
          paid_at,
          due_date,
          installment_no,
          payment_mode,
          payment_type,
          created_at
        `
        )
        .eq('enrollment_id', enrollment.id)
        .order('installment_no', { ascending: true });

      if (paymentsError) {
        console.warn('Student payments lookup error:', paymentsError.message);
      }

      payments = paymentRows ?? [];

      pendingInstallment =
        payments.find(
          (payment) =>
            payment.status === 'pending' &&
            Number(payment.installment_no) === 2
        ) ??
        payments.find((payment) => payment.status === 'pending') ??
        null;
    }

    const { count: reportsCount, error: reportsCountError } =
      await adminClient
        .from('wellness_reports')
        .select('id', { count: 'exact', head: true })
        .eq('student_id', userId);

    if (reportsCountError) {
      console.warn('Student reports count error:', reportsCountError.message);
    }

    const { count: claimsCount, error: claimsCountError } = await adminClient
      .from('claims')
      .select('id', { count: 'exact', head: true })
      .eq('student_id', userId);

    if (claimsCountError) {
      console.warn('Student claims count error:', claimsCountError.message);
    }

    res.json({
      profile,
      school,
      teacher,
      enrollment,
      payments,
      pendingInstallment,
      secondInstallment: pendingInstallment
        ? {
            amount: pendingInstallment.amount,
            due_date: pendingInstallment.due_date,
            status: pendingInstallment.status,
            installment_no: pendingInstallment.installment_no,
          }
        : null,
      plan: {
        tier: planTier,
        name: getPlanLabel(planTier),
      },
      benefits: {
        accidental_protection: 'Activated',
        future_financial_security: 'Activated',
        student_protection: 'Activated',
      },
      counts: {
        wellnessReports: reportsCount ?? 0,
        claims: claimsCount ?? 0,
      },
    });
  })
);

router.get(
  '/wellness-reports',
  asyncHandler(async (req, res) => {
    const { data: reports, error } = await adminClient
      .from('wellness_reports')
      .select('*')
      .eq('student_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);

    const teacherIds = [
      ...new Set((reports ?? []).map((r) => r.teacher_id).filter(Boolean)),
    ];

    const { data: teachers, error: teacherError } = teacherIds.length
      ? await adminClient
          .from('profiles')
          .select('id, full_name, email')
          .in('id', teacherIds)
      : { data: [], error: null };

    if (teacherError) throw new Error(teacherError.message);

    const teacherMap = new Map(
      (teachers ?? []).map((teacher) => [teacher.id, teacher])
    );

    res.json(
      (reports ?? []).map((report) => ({
        ...report,
        teacher: teacherMap.get(report.teacher_id) ?? null,
        teacher_name:
          teacherMap.get(report.teacher_id)?.full_name ?? 'Teacher',
      }))
    );
  })
);

router.get(
  '/sessions',
  asyncHandler(async (req, res) => {
    const profile = await getStudentProfile(req.user.id);

    if (!profile?.school_id || !profile?.class_assigned) {
      return res.json([]);
    }

    const { data, error } = await adminClient
      .from('sessions')
      .select('*')
      .eq('target_school_id', profile.school_id)
      .or(
        `target_class.eq.${profile.class_assigned},target_class.is.null,target_class.eq.`
      )
      .order('scheduled_at', { ascending: false });

    if (error) throw new Error(error.message);

    res.json(data ?? []);
  })
);

router.get(
  '/sessions/:sessionId/recording-url',
  asyncHandler(async (req, res) => {
    const profile = await getStudentProfile(req.user.id);

    if (!profile?.school_id || !profile?.class_assigned) {
      return res.status(403).json({
        error: 'Student school/class mapping missing',
      });
    }

    const { data: session, error } = await adminClient
      .from('sessions')
      .select('*')
      .eq('id', req.params.sessionId)
      .maybeSingle();

    if (error) throw new Error(error.message);

    if (!session) {
      return res.status(404).json({
        error: 'Session not found',
      });
    }

    const sameSchool = session.target_school_id === profile.school_id;
    const sameClass =
      !session.target_class || session.target_class === profile.class_assigned;

    if (!sameSchool || !sameClass) {
      return res.status(403).json({
        error: 'Session not available for this student',
      });
    }

    if (!session.recording_url) {
      return res.status(404).json({
        error: 'Recording not available',
      });
    }

    const { data, error: signedError } = await adminClient.storage
      .from('session-recordings')
      .createSignedUrl(session.recording_url, 60 * 30);

    if (signedError) throw new Error(signedError.message);

    res.json({
      signedUrl: data.signedUrl,
    });
  })
);

router.get(
  '/claims',
  asyncHandler(async (req, res) => {
    const claims = await listClaimsForStudent(req.user.id);
    res.json(claims);
  })
);

router.get(
  '/my-claims',
  asyncHandler(async (req, res) => {
    const claims = await listClaimsRaisedByUser(req.user.id);
    res.json(claims);
  })
);

router.post(
  '/claims',
  upload.array('documents', 5),
  asyncHandler(async (req, res) => {
    const claim = await raiseStudentClaim(
      req.user.id,
      req.body,
      req.files ?? []
    );

    res.status(201).json(claim);
  })
);


// Main Student Shield portal routes.
// These use the student's normal Supabase login token.
router.post(
  '/smart-buddy/launch',
  asyncHandler(async (req, res) => {
    const launch = await createSmartBuddyLaunch(req.user.id);
    res.status(201).json(launch);
  })
);

router.get(
  '/smart-buddy/profile',
  asyncHandler(async (req, res) => {
    const profile = await getSmartBuddyProfile(req.user.id);
    res.json(profile);
  })
);

router.put(
  '/smart-buddy/profile',
  asyncHandler(async (req, res) => {
    const saved = await saveSmartBuddyProfile(req.user.id, req.body);

    res.json({
      success: true,
      saved_profile: saved,
    });
  })
);

router.post(
  '/smart-buddy/reports',
  smartBuddyReportUpload.single('file'),
  asyncHandler(async (req, res) => {
    const report = await uploadSmartBuddyReport(
      req.user.id,
      req.file,
      req.body
    );

    res.status(201).json({
      success: true,
      report,
    });
  })
);

router.get(
  '/smart-buddy/reports',
  asyncHandler(async (req, res) => {
    const reports = await listSmartBuddyReports(req.user.id);
    res.json(reports);
  })
);

router.get(
  '/smart-buddy/reports/quota',
  asyncHandler(async (req, res) => {
    const quota = await getSmartBuddyReportQuota(
      req.user.id,
      req.query.report_type
    );

    res.json(quota);
  })
);

router.get(
  '/smart-buddy/reports/:reportId/download',
  asyncHandler(async (req, res) => {
    const report = await getSmartBuddyReportDownload(
      req.user.id,
      req.params.reportId
    );

    res.json(report);
  })
);

export default router;
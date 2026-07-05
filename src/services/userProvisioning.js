import { adminClient } from '../supabase.js';
import {
  buildStudentEnrollmentSmsMessage,
  sendSmsTextMessage,
} from './sms.js';
export async function getCallerRoles(callerId) {
  const { data, error } = await adminClient
    .from('user_roles')
    .select('role, school_id')
    .eq('user_id', callerId);

  if (error) throw new Error(error.message);

  return data ?? [];
}

const normalizePlanTier = (value) => {
  const plan = String(value ?? '').trim().toLowerCase();

  if (plan === 'basic') return 'basic';
  if (plan === 'standard') return 'standard';
  if (plan === 'premium') return 'premium';

  throw new Error('Invalid plan tier');
};

const normalizePaymentType = (value) => {
  const type = String(value ?? '').trim().toLowerCase();

  if (type === 'one_time' || type === 'one-time' || type === 'onetime') {
    return 'one_time';
  }

  if (type === 'installment' || type === 'installments') {
    return 'installment';
  }

  if (
    type === 'paid_with_fees' ||
    type === 'paid-with-fees' ||
    type === 'paidwithfees' ||
    type === 'fees'
  ) {
    return 'paid_with_fees';
  }

  return 'one_time';
};

const normalizePaymentMode = (value) => {
  const mode = String(value ?? '').trim().toLowerCase();

  const allowed = [
    'cash',
    'card',
    'upi',
    'bank_transfer',
    'cheque',
    'online',
  ];

  if (allowed.includes(mode)) return mode;

  return 'online';
};

const getPlanAmount = (planTier, fallbackAmount) => {
  const planAmounts = {
    basic: 400,
    standard: 800,
    premium: 1200,
  };

  const amount = Number(fallbackAmount ?? planAmounts[planTier]);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid amount');
  }

  return amount;
};

const getExpiryDate = () => {
  const date = new Date();
  date.setFullYear(date.getFullYear() + 1);
  return date.toISOString();
};

export async function createSchoolAdmin(callerId, body) {
  const roles = await getCallerRoles(callerId);

  if (!roles.some((r) => r.role === 'company_admin')) {
    throw new Error('Forbidden — company admin only');
  }

  if (!body.school_id || !body.email || !body.password || !body.full_name) {
    throw new Error('Missing required fields');
  }

  const { data: created, error: createError } =
    await adminClient.auth.admin.createUser({
      email: body.email,
      password: body.password,
      email_confirm: true,
      user_metadata: {
        full_name: body.full_name,
      },
    });

  if (createError || !created.user) {
    throw new Error(createError?.message ?? 'Failed to create user');
  }

  const userId = created.user.id;

  let { error } = await adminClient
    .from('profiles')
    .update({
      full_name: body.full_name,
      email: body.email,
      phone: body.phone ?? null,
      school_id: body.school_id,
      created_by: callerId,
    })
    .eq('id', userId);

  if (error) throw new Error(error.message);

  ({ error } = await adminClient.from('user_roles').insert({
    user_id: userId,
    role: 'school_admin',
    school_id: body.school_id,
  }));

  if (error) throw new Error(error.message);

  ({ error } = await adminClient
    .from('schools')
    .update({
      admin_user_id: userId,
    })
    .eq('id', body.school_id));

  if (error) throw new Error(error.message);

  return {
    success: true,
    user_id: userId,
    email: body.email,
  };
}

export async function createTeacher(callerId, body) {
  const assignedClass =
    body.class_assigned ?? body.assigned_class ?? body.className;

  const roles = await getCallerRoles(callerId);
  const isCompanyAdmin = roles.some((r) => r.role === 'company_admin');
  const schoolAdminRow = roles.find((r) => r.role === 'school_admin');

  if (!isCompanyAdmin && !schoolAdminRow) {
    throw new Error('Forbidden');
  }

  if (!body.email || !body.password || !body.full_name || !assignedClass) {
    throw new Error('Missing required fields');
  }

  let targetSchool = null;

  if (schoolAdminRow) {
    const { data: prof, error: profileError } = await adminClient
      .from('profiles')
      .select('school_id')
      .eq('id', callerId)
      .maybeSingle();

    if (profileError) throw new Error(profileError.message);

    targetSchool = prof?.school_id ?? schoolAdminRow.school_id ?? null;
  } else {
    targetSchool = body.school_id ?? null;
  }

  if (!targetSchool) {
    throw new Error('School not resolved for caller');
  }

  const { data: created, error: createError } =
    await adminClient.auth.admin.createUser({
      email: body.email,
      password: body.password,
      email_confirm: true,
      user_metadata: {
        full_name: body.full_name,
      },
    });

  if (createError || !created.user) {
    throw new Error(createError?.message ?? 'Failed to create user');
  }

  const userId = created.user.id;

  let { error } = await adminClient
    .from('profiles')
    .update({
      full_name: body.full_name,
      email: body.email,
      phone: body.phone ?? null,
      school_id: targetSchool,
      class_assigned: assignedClass,
      created_by: callerId,
    })
    .eq('id', userId);

  if (error) throw new Error(error.message);

  ({ error } = await adminClient.from('user_roles').insert({
    user_id: userId,
    role: 'teacher',
    school_id: targetSchool,
  }));

  if (error) throw new Error(error.message);

  return {
    success: true,
    teacher: {
      id: userId,
      full_name: body.full_name,
      email: body.email,
      phone: body.phone ?? null,
      school_id: targetSchool,
      class_assigned: assignedClass,
    },
  };
}

function buildReceipt({
  receiptNo,
  studentName,
  schoolName,
  planTier,
  planDuration,
  amount,
  paymentMode,
  paymentType,
  paidAmount,
  remainingAmount,
  installmentDates,
}) {
  const benefitStartDate = new Date().toISOString().slice(0, 10);

  const planLabelMap = {
    basic: 'Basic Plan',
    standard: 'Standard Plan',
    premium: 'Premium Plan',
  };

const paymentTypeLabelMap = {
  one_time: 'One-Time Payment',
  installment: 'Installment Payment',
  paid_with_fees: 'Paid with Fees',
};

  return {
    receipt_no: receiptNo,
    student_name: studentName,
    school_name: schoolName,
    plan_name: planLabelMap[planTier] ?? planTier,
    plan_tier: planTier,
    plan_duration: planDuration,
    amount: Number(amount),
    payment_mode: paymentMode,
    payment_type: paymentType,
    payment_type_label: paymentTypeLabelMap[paymentType] ?? paymentType,
    paid_amount: Number(paidAmount),
    remaining_amount: Number(remainingAmount),
    installment_dates: installmentDates,
    benefit_activation_date: benefitStartDate,
    authorized_signature: 'Student Shield Digital Authorization',
  };
}

function buildWhatsAppPayload({
  parentPhone,
  schoolName,
  studentName,
  planTier,
  amount,
  paymentMode,
  paymentType,
  paidAmount,
  remainingAmount,
  receipt,
  loginEmail,
  rawUsername,
  password,
}) {
  const planLabelMap = {
    basic: 'Basic Plan',
    standard: 'Standard Plan',
    premium: 'Premium Plan',
  };

  const paymentTypeLabelMap = {
    one_time: 'One-Time Payment',
    installment: 'Installment Payment',
  };

  return {
    provider: process.env.WHATSAPP_PROVIDER || 'mock',
    to: parentPhone,
    status: process.env.WHATSAPP_PROVIDER ? 'queued' : 'mock-prepared',
    message:
      `Student Shield Enrollment\n` +
      `School: ${schoolName}\n` +
      `Student: ${studentName}\n` +
      `Plan: ${planLabelMap[planTier] ?? planTier}\n` +
      `Total Amount: ₹${amount}\n` +
      `Payment Type: ${paymentTypeLabelMap[paymentType] ?? paymentType}\n` +
      `Payment Mode: ${paymentMode}\n` +
      `Paid: ₹${paidAmount}\n` +
      `Remaining: ₹${remainingAmount}\n` +
      `Benefit Start Date: ${receipt.benefit_activation_date}\n` +
      `App: ${
        process.env.APP_DOWNLOAD_LINK || 'https://studentshield.app/download'
      }\n` +
      `Login: ${rawUsername || loginEmail}\n` +
      `Password: ${password}`,
    receipt,
  };
}

const normalizeInstallmentDates = (value) => {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value.map(String).map((v) => v.trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);

      if (Array.isArray(parsed)) {
        return parsed.map(String).map((v) => v.trim()).filter(Boolean);
      }
    } catch {
      return value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    }
  }

  return [];
};

const isValidDateOnly = (value) => {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
};

export async function createStudent(callerId, body) {
  const { data: teacherProfile, error: teacherProfileError } =
    await adminClient
      .from('profiles')
      .select('school_id, class_assigned, full_name')
      .eq('id', callerId)
      .maybeSingle();

  if (teacherProfileError) {
    throw new Error(teacherProfileError.message);
  }

  const roles = await getCallerRoles(callerId);

  const allowed = roles.some((r) =>
    ['teacher', 'school_admin', 'company_admin'].includes(r.role)
  );

  if (!allowed || !teacherProfile?.school_id) {
    throw new Error('Forbidden — must be teacher/admin assigned to a school');
  }

  if (!body.username || !body.password || !body.full_name) {
    throw new Error('Missing required fields');
  }

  const isTeacher = roles.some((r) => r.role === 'teacher');
  const isSchoolAdmin = roles.some((r) => r.role === 'school_admin');
  const isCompanyAdmin = roles.some((r) => r.role === 'company_admin');

  const classAssigned = isTeacher
    ? teacherProfile.class_assigned
    : body.class_assigned;

  if (isTeacher && !teacherProfile.class_assigned) {
    throw new Error('Teacher assigned class is missing');
  }

  if ((isSchoolAdmin || isCompanyAdmin) && !body.class_assigned) {
    throw new Error('Class is required');
  }

  if (!classAssigned) {
    throw new Error('Assigned class is required');
  }

  const schoolResp = await adminClient
    .from('schools')
    .select(
      `
      id,
      name,
      selected_plan_tier,
      benefits_started_at,
      benefits_expires_at
    `
    )
    .eq('id', teacherProfile.school_id)
    .maybeSingle();

  if (schoolResp.error) {
    throw new Error(schoolResp.error.message);
  }

  const school = schoolResp.data;

  if (!school) {
    throw new Error('School not found');
  }

  if (!school.benefits_expires_at) {
    throw new Error('School benefits expiry date is not configured');
  }

  const today = new Date().toISOString().slice(0, 10);
  const benefitExpiryDateOnly = String(school.benefits_expires_at).slice(0, 10);

  if (benefitExpiryDateOnly < today) {
    throw new Error(
      'School benefits plan has expired. Please renew school plan before enrolling students.'
    );
  }

  const schoolName = school.name ?? 'School';
  const schoolBenefitsExpiresAt = `${benefitExpiryDateOnly}T23:59:59.999Z`;

  const planTier = normalizePlanTier(body.plan_tier ?? body.plan);
  const selectedSchoolPlan = school.selected_plan_tier ?? 'basic';

  if (planTier !== selectedSchoolPlan) {
    throw new Error(
      `Selected plan does not match school assigned plan. School plan is ${selectedSchoolPlan}.`
    );
  }

  const planDuration = 'yearly';
  const paymentType = normalizePaymentType(body.payment_type);

  const paymentMode =
    paymentType === 'paid_with_fees'
      ? 'online'
      : normalizePaymentMode(body.payment_mode);

  const amount = getPlanAmount(planTier, body.amount);

  let installmentDates = normalizeInstallmentDates(body.installment_dates);

  if (paymentType === 'installment') {
    if (installmentDates.length < 2) {
      throw new Error('Please select both installment dates');
    }

    if (
      !isValidDateOnly(installmentDates[0]) ||
      !isValidDateOnly(installmentDates[1])
    ) {
      throw new Error('Invalid installment date format. Use YYYY-MM-DD');
    }
  } else {
    installmentDates = [];
  }

  const finalPaidAmount =
    paymentType === 'installment' ? Math.ceil(amount / 2) : amount;

  const finalRemainingAmount =
    paymentType === 'installment' ? amount - finalPaidAmount : 0;

  if (!Number.isFinite(finalPaidAmount) || finalPaidAmount < 0) {
    throw new Error('Invalid paid amount');
  }

  if (!Number.isFinite(finalRemainingAmount) || finalRemainingAmount < 0) {
    throw new Error('Invalid remaining amount');
  }

  console.log('CREATE STUDENT PAYMENT DEBUG:', {
    planTier,
    paymentType,
    amount,
    finalPaidAmount,
    finalRemainingAmount,
    installmentDates,
    schoolBenefitsExpiresAt,
  });

  const email = body.username.includes('@')
    ? body.username
    : `${body.username}@students.studentshield.app`;

  const { data: created, error: createError } =
    await adminClient.auth.admin.createUser({
      email,
      password: body.password,
      email_confirm: true,
      user_metadata: {
        full_name: body.full_name,
        requested_role: 'student',
      },
    });

  if (createError || !created.user) {
    throw new Error(createError?.message ?? 'Failed to create user');
  }

  const studentId = created.user.id;

  const { error: profileError } = await adminClient
    .from('profiles')
    .update({
      full_name: body.full_name,
      email,
      school_id: teacherProfile.school_id,
      class_assigned: classAssigned,
      age: body.age ?? null,
      parent_phone: body.parent_phone ?? null,
      created_by: callerId,
    })
    .eq('id', studentId);

  if (profileError) {
    throw new Error(profileError.message);
  }

  const { error: roleError } = await adminClient.from('user_roles').upsert(
    {
      user_id: studentId,
      role: 'student',
      school_id: teacherProfile.school_id,
    },
    {
      onConflict: 'user_id,role',
    }
  );

  if (roleError) {
    throw new Error(roleError.message);
  }

  const { data: enroll, error: enrollmentError } = await adminClient
    .from('enrollments')
    .insert({
      student_id: studentId,
      school_id: teacherProfile.school_id,
      teacher_id: isTeacher ? callerId : body.teacher_id ?? null,

      plan: planDuration,
      plan_tier: planTier,
      plan_duration: planDuration,

      amount,
      payment_mode: paymentMode,
      payment_type: paymentType,
      payment_status: finalRemainingAmount > 0 ? 'pending' : 'paid',
      installment_dates: installmentDates,

      enrolled_at: new Date().toISOString(),
      expires_at: schoolBenefitsExpiresAt,
    })
    .select()
    .single();

  if (enrollmentError) {
    throw new Error(enrollmentError.message);
  }

  const paymentRows =
    paymentType === 'installment'
      ? [
          {
            enrollment_id: enroll.id,
            amount: finalPaidAmount,
            status: 'paid',
            paid_at: new Date().toISOString(),
            installment_no: 1,
            due_date: installmentDates[0],
            plan_tier: planTier,
            payment_mode: paymentMode,
            payment_type: paymentType,
            installment_dates: installmentDates,
          },
          {
            enrollment_id: enroll.id,
            amount: finalRemainingAmount,
            status: 'pending',
            paid_at: null,
            installment_no: 2,
            due_date: installmentDates[1],
            plan_tier: planTier,
            payment_mode: paymentMode,
            payment_type: paymentType,
            installment_dates: installmentDates,
          },
        ]
      : [
          {
            enrollment_id: enroll.id,
            amount: finalPaidAmount,
            status: 'paid',
            paid_at: new Date().toISOString(),
            installment_no: 1,
            due_date: null,
            plan_tier: planTier,
            payment_mode: paymentMode,
            payment_type: paymentType,
            installment_dates: [],
          },
        ];

  const { error: paymentError } = await adminClient
    .from('payments')
    .insert(paymentRows);

  if (paymentError) {
    throw new Error(paymentError.message);
  }

  const receipt = buildReceipt({
    receiptNo: `SSR-${new Date()
      .toISOString()
      .slice(0, 10)
      .replaceAll('-', '')}-${studentId.slice(0, 6).toUpperCase()}`,
    studentName: body.full_name,
    schoolName,
    planTier,
    planDuration,
    amount,
    paymentMode,
    paymentType,
    paidAmount: finalPaidAmount,
    remainingAmount: finalRemainingAmount,
    installmentDates,
    benefitExpiryDate: benefitExpiryDateOnly,
  });

  // const whatsappPayload = buildStudentEnrollmentWhatsAppMessage({
  //   parentPhone: body.parent_phone,
  //   schoolName,
  //   studentName: body.full_name,
  //   classAssigned,
  //   planTier,
  //   planDuration,
  //   amount,
  //   paymentMode,
  //   paymentType,
  //   paidAmount: finalPaidAmount,
  //   remainingAmount: finalRemainingAmount,
  //   installmentDates,
  //   receipt,
  //   loginEmail: email,
  //   password: body.password,
  // });

  // const whatsappSendResult = await sendWhatsAppTextMessage({
  //   to: whatsappPayload.to,
  //   message: whatsappPayload.message,
  // });

  // const whatsapp = {
  //   status: whatsappSendResult.sent ? 'sent' : 'failed',
  //   to: whatsappPayload.to,
  //   message: whatsappPayload.message,
  //   provider_response: whatsappSendResult,
  // };


  const smsPayload = buildStudentEnrollmentSmsMessage({
  parentPhone: body.parent_phone,
  schoolName,
  studentName: body.full_name,
  planTier,
  planDuration,
  amount,
  paidAmount: finalPaidAmount,
  remainingAmount: finalRemainingAmount,
  loginEmail: email,
});

const smsSendResult = await sendSmsTextMessage({
  to: smsPayload.to,
  message: smsPayload.message,
});

const sms = {
  channel: 'sms',
  status: smsSendResult.sent
    ? 'sent'
    : smsSendResult.skipped
      ? 'skipped'
      : 'failed',
  to: smsPayload.to,
  message: smsPayload.message,
  provider_response: smsSendResult,
};

return {
  success: true,
  student_id: studentId,
  email,
  receipt,
  sms,
};
}

export async function payPendingStudentFees(callerId, studentId) {
  if (!studentId) {
    throw new Error('Student is required');
  }

  const roles = await getCallerRoles(callerId);

  const isTeacher = roles.some((r) => r.role === 'teacher');
  const isSchoolAdmin = roles.some((r) => r.role === 'school_admin');
  const isCompanyAdmin = roles.some((r) => r.role === 'company_admin');

  if (!isTeacher && !isSchoolAdmin && !isCompanyAdmin) {
    throw new Error('Forbidden');
  }

  const { data: callerProfile, error: callerProfileError } = await adminClient
    .from('profiles')
    .select('id, school_id')
    .eq('id', callerId)
    .maybeSingle();

  if (callerProfileError) {
    throw new Error(callerProfileError.message);
  }

  if (!callerProfile?.school_id && !isCompanyAdmin) {
    throw new Error('School assignment missing');
  }

  let enrollmentQuery = adminClient
    .from('enrollments')
    .select(
      `
      id,
      student_id,
      school_id,
      teacher_id,
      amount,
      payment_status,
      payment_type,
      created_at
    `
    )
    .eq('student_id', studentId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (isTeacher) {
    enrollmentQuery = enrollmentQuery.eq('teacher_id', callerId);
  }

  if (isSchoolAdmin) {
    enrollmentQuery = enrollmentQuery.eq('school_id', callerProfile.school_id);
  }

  const { data: enrollment, error: enrollmentError } =
    await enrollmentQuery.maybeSingle();

  if (enrollmentError) {
    throw new Error(enrollmentError.message);
  }

  if (!enrollment) {
    throw new Error('Student enrollment not found or not allowed');
  }

  const { data: pendingPayment, error: pendingPaymentError } = await adminClient
    .from('payments')
    .select(
      `
      id,
      enrollment_id,
      amount,
      status,
      installment_no,
      due_date,
      payment_type,
      payment_mode
    `
    )
    .eq('enrollment_id', enrollment.id)
    .eq('status', 'pending')
    .order('installment_no', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (pendingPaymentError) {
    throw new Error(pendingPaymentError.message);
  }

  if (!pendingPayment) {
    throw new Error('No pending payment found for this student');
  }

  const { data: updatedPayment, error: updatePaymentError } = await adminClient
    .from('payments')
    .update({
      status: 'paid',
      paid_at: new Date().toISOString(),
    })
    .eq('id', pendingPayment.id)
    .select()
    .single();

  if (updatePaymentError) {
    throw new Error(updatePaymentError.message);
  }

  const { data: remainingPendingPayments, error: remainingError } =
    await adminClient
      .from('payments')
      .select('id')
      .eq('enrollment_id', enrollment.id)
      .eq('status', 'pending');

  if (remainingError) {
    throw new Error(remainingError.message);
  }

  const newEnrollmentStatus =
    (remainingPendingPayments ?? []).length > 0 ? 'pending' : 'paid';

  const { data: updatedEnrollment, error: updateEnrollmentError } =
    await adminClient
      .from('enrollments')
      .update({
        payment_status: newEnrollmentStatus,
      })
      .eq('id', enrollment.id)
      .select()
      .single();

  if (updateEnrollmentError) {
    throw new Error(updateEnrollmentError.message);
  }

  return {
    success: true,
    message: 'Pending fees paid successfully',
    payment: updatedPayment,
    enrollment: updatedEnrollment,
  };
}
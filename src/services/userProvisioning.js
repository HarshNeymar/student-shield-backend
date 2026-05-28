import { adminClient } from '../supabase.js';

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

  const planTier = normalizePlanTier(body.plan_tier ?? body.plan);
  const planDuration = 'yearly';
  const paymentType = normalizePaymentType(body.payment_type);
  const paymentMode = normalizePaymentMode(body.payment_mode);
  const amount = getPlanAmount(planTier, body.amount);

  const paidAmount = Number(
    body.paid_amount ?? (paymentType === 'installment' ? amount / 2 : amount)
  );

  if (!Number.isFinite(paidAmount) || paidAmount < 0) {
    throw new Error('Invalid paid amount');
  }

  const remainingAmount = Math.max(
    0,
    Number(body.remaining_amount ?? amount - paidAmount)
  );

  const installmentDates =
    paymentType === 'installment' ? body.installment_dates ?? [] : [];

  const schoolResp = await adminClient
    .from('schools')
    .select('id, name')
    .eq('id', teacherProfile.school_id)
    .maybeSingle();

  if (schoolResp.error) {
    throw new Error(schoolResp.error.message);
  }

  const schoolName = schoolResp.data?.name ?? 'School';

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

      // Existing DB enum column: monthly / quarterly / half_yearly / yearly
      plan: planDuration,

      // Correct Student Shield fields
      plan_tier: planTier,
      plan_duration: planDuration,

      amount,

      // DB payment method enum: cash/card/upi/bank_transfer/cheque/online
      payment_mode: paymentMode,

      // Business payment flow: one_time/installment
      payment_type: paymentType,

      payment_status: remainingAmount > 0 ? 'partial' : 'paid',
      installment_dates: installmentDates,

      expires_at: getExpiryDate(),
    })
    .select()
    .single();

  if (enrollmentError) {
    throw new Error(enrollmentError.message);
  }

  if (paymentType === 'one_time') {
    const { error } = await adminClient.from('payments').insert({
      enrollment_id: enroll.id,
      amount: paidAmount,
      status: 'paid',
      paid_at: new Date().toISOString(),
      installment_no: 1,
      plan_tier: planTier,
      payment_mode: paymentMode,
      payment_type: paymentType,
      installment_dates: [],
    });

    if (error) throw new Error(error.message);
  } else {
    const { error } = await adminClient.from('payments').insert([
      {
        enrollment_id: enroll.id,
        amount: paidAmount,
        status: 'paid',
        paid_at: new Date().toISOString(),
        installment_no: 1,
        due_date: installmentDates[0] ?? null,
        plan_tier: planTier,
        payment_mode: paymentMode,
        payment_type: paymentType,
        installment_dates: installmentDates,
      },
      {
        enrollment_id: enroll.id,
        amount: remainingAmount,
        status: 'pending',
        installment_no: 2,
        due_date: installmentDates[1] ?? null,
        plan_tier: planTier,
        payment_mode: paymentMode,
        payment_type: paymentType,
        installment_dates: installmentDates,
      },
    ]);

    if (error) throw new Error(error.message);
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
    paidAmount,
    remainingAmount,
    installmentDates,
  });

  const whatsapp = buildWhatsAppPayload({
    parentPhone: body.parent_phone,
    schoolName,
    studentName: body.full_name,
    planTier,
    amount,
    paymentMode,
    paymentType,
    paidAmount,
    remainingAmount,
    receipt,
    loginEmail: email,
    rawUsername: body.username,
    password: body.password,
  });

  return {
    success: true,
    student_id: studentId,
    email,
    receipt,
    whatsapp,
  };
}
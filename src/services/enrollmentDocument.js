import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { adminClient } from '../supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOGO_PATH = path.resolve(
  __dirname,
  '../assets/student-shield-logo.png'
);

const PLAN_LABELS = {
  basic: 'Basic Plan',
  standard: 'Standard Plan',
  premium: 'Premium Plan',
};

const PAYMENT_TYPE_LABELS = {
  one_time: 'One-Time Payment',
  installment: 'Installment Payment',
  paid_with_fees: 'Paid with School Fees',
};

function textOrDash(value) {
  const text = String(value ?? '').trim();
  return text || '-';
}

function amount(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shortText(value, maxLength = 58) {
  const text = textOrDash(value);
  return text.length > maxLength
    ? `${text.slice(0, maxLength - 3)}...`
    : text;
}

function displayDate(value) {
  if (!value) return '-';

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return textOrDash(value);
  }

  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function displayCurrency(value) {
  return `INR ${new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 2,
  }).format(amount(value))}`;
}

function titleCase(value) {
  return textOrDash(value)
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function planLabel(value) {
  return PLAN_LABELS[value] ?? titleCase(value);
}

function paymentTypeLabel(value) {
  return PAYMENT_TYPE_LABELS[value] ?? titleCase(value);
}

function normalizeInstallmentDates(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);

      if (Array.isArray(parsed)) {
        return parsed.filter(Boolean);
      }
    } catch {
      return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }

  return [];
}

function receiptNumber(studentId, enrolledAt) {
  const date = enrolledAt ? new Date(enrolledAt) : new Date();

  const datePart = Number.isNaN(date.getTime())
    ? new Date().toISOString().slice(0, 10).replaceAll('-', '')
    : date.toISOString().slice(0, 10).replaceAll('-', '');

  return `SSR-${datePart}-${String(studentId ?? '')
    .slice(0, 6)
    .toUpperCase()}`;
}

export function buildEnrollmentReceiptSummary({
  student,
  school,
  enrollment,
  payments = [],
}) {
  const totalAmount = amount(enrollment?.amount);

  const paidFromPayments = payments
    .filter((payment) => payment.status === 'paid')
    .reduce((sum, payment) => sum + amount(payment.amount), 0);

  const paidAmount =
    payments.length > 0
      ? paidFromPayments
      : enrollment?.payment_status === 'paid'
        ? totalAmount
        : 0;

  return {
    receipt_no: receiptNumber(student?.id, enrollment?.enrolled_at),

    student_name: student?.full_name ?? '-',
    student_email: student?.email ?? '-',
    parent_phone: student?.parent_phone ?? '-',
    student_age: student?.age ?? null,
    class_assigned: student?.class_assigned ?? '-',

    school_name: school?.name ?? '-',

    plan_name: planLabel(
      enrollment?.plan_tier ?? school?.selected_plan_tier
    ),
    plan_duration: titleCase(
      enrollment?.plan_duration ?? enrollment?.plan
    ),

    payment_type: paymentTypeLabel(enrollment?.payment_type),
    payment_mode: titleCase(enrollment?.payment_mode),
    payment_status: titleCase(enrollment?.payment_status),

    total_amount: totalAmount,
    paid_amount: paidAmount,
    remaining_amount: Math.max(totalAmount - paidAmount, 0),

    installment_dates: normalizeInstallmentDates(
      enrollment?.installment_dates
    ),

    enrollment_date:
      enrollment?.enrolled_at ?? enrollment?.created_at ?? null,

    benefit_activation_date:
      enrollment?.enrolled_at ?? enrollment?.created_at ?? null,

    benefit_expiry_date: enrollment?.expires_at ?? null,
  };
}

export async function getEnrollmentDocumentData(studentId) {
  const { data: student, error: studentError } = await adminClient
    .from('profiles')
    .select(
      'id, full_name, email, parent_phone, age, class_assigned, school_id'
    )
    .eq('id', studentId)
    .maybeSingle();

  if (studentError) {
    throw new Error(studentError.message);
  }

  if (!student) {
    const error = new Error('Student profile not found');
    error.status = 404;
    throw error;
  }

  const { data: enrollment, error: enrollmentError } = await adminClient
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
      payment_mode,
      payment_type,
      payment_status,
      installment_dates,
      enrolled_at,
      expires_at,
      created_at
    `)
    .eq('student_id', studentId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (enrollmentError) {
    throw new Error(enrollmentError.message);
  }

  if (!enrollment) {
    const error = new Error('Student enrollment not found');
    error.status = 404;
    throw error;
  }

  const [{ data: school, error: schoolError }, paymentsResponse] =
    await Promise.all([
      adminClient
        .from('schools')
        .select('id, name, selected_plan_tier')
        .eq('id', enrollment.school_id ?? student.school_id)
        .maybeSingle(),

      adminClient
        .from('payments')
        .select(`
          id,
          enrollment_id,
          amount,
          status,
          paid_at,
          due_date,
          installment_no,
          created_at
        `)
        .eq('enrollment_id', enrollment.id)
        .order('installment_no', { ascending: true }),
    ]);

  if (schoolError) {
    throw new Error(schoolError.message);
  }

  if (paymentsResponse.error) {
    throw new Error(paymentsResponse.error.message);
  }

  const payments = paymentsResponse.data ?? [];

  return {
    student,
    school: school ?? {
      id: enrollment.school_id,
      name: 'School',
      selected_plan_tier: enrollment.plan_tier,
    },
    enrollment,
    payments,
    receipt: buildEnrollmentReceiptSummary({
      student,
      school,
      enrollment,
      payments,
    }),
  };
}

export async function getAuthorizedEnrollmentDocument(callerId, studentId) {
  const documentData = await getEnrollmentDocumentData(studentId);

  const { data: roles, error: roleError } = await adminClient
    .from('user_roles')
    .select('role, school_id')
    .eq('user_id', callerId);

  if (roleError) {
    throw new Error(roleError.message);
  }

  const callerRoles = roles ?? [];

  const isCompanyAdmin = callerRoles.some(
    (item) => item.role === 'company_admin'
  );

  const isStudentSelf =
    callerId === studentId &&
    callerRoles.some((item) => item.role === 'student');

  const isAssignedTeacher =
    documentData.enrollment.teacher_id === callerId &&
    callerRoles.some((item) => item.role === 'teacher');

  const isSchoolAdmin = callerRoles.some(
    (item) =>
      item.role === 'school_admin' &&
      item.school_id === documentData.enrollment.school_id
  );

  if (
    !isCompanyAdmin &&
    !isStudentSelf &&
    !isAssignedTeacher &&
    !isSchoolAdmin
  ) {
    const error = new Error(
      'Forbidden - you cannot access this enrollment document'
    );
    error.status = 403;
    throw error;
  }

  return documentData;
}

function drawSectionHeading(doc, title, y) {
  doc
    .fillColor('#0F766E')
    .font('Helvetica-Bold')
    .fontSize(12)
    .text(title.toUpperCase(), 56, y);

  doc
    .moveTo(56, y + 18)
    .lineTo(539, y + 18)
    .lineWidth(1)
    .strokeColor('#D7E9E5')
    .stroke();
}

function drawField(doc, { label, value, x, y, width = 220 }) {
  doc
    .fillColor('#64748B')
    .font('Helvetica-Bold')
    .fontSize(8)
    .text(label.toUpperCase(), x, y, { width });

  doc
    .fillColor('#0F172A')
    .font('Helvetica')
    .fontSize(10.5)
    .text(shortText(value), x, y + 13, {
      width,
      lineGap: 1,
    });
}

function drawTwoColumnRow(doc, left, right, y) {
  drawField(doc, {
    ...left,
    x: 56,
    y,
    width: 218,
  });

  drawField(doc, {
    ...right,
    x: 312,
    y,
    width: 227,
  });
}

export async function createEnrollmentPdfBuffer(documentData) {
  const { student, school, receipt } = documentData;

  const doc = new PDFDocument({
    size: 'A4',
    margins: {
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    },
    info: {
      Title: `Student Shield Enrollment - ${student.full_name}`,
      Author: 'Student Shield',
      Subject: 'Student enrollment receipt',
    },
  });

  const chunks = [];

  const completed = new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // Green top header.
  doc.rect(0, 0, 595.28, 112).fill('#10B981');

  // Main white school card.
  doc
    .roundedRect(42, 42, 511, 144, 17)
    .fillAndStroke('#FFFFFF', '#DDE6E4');

  // Student Shield logo.
  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, 455, 58, {
      fit: [78, 20],
    });
  } else {
    doc
      .fillColor('#0F766E')
      .font('Helvetica-Bold')
      .fontSize(8)
      .text("Student's Shield", 443, 62, {
        width: 90,
        align: 'right',
      });
  }

  // School name.
  doc
    .fillColor('#10213A')
    .font('Helvetica-Bold')
    .fontSize(27)
    .text(shortText(school?.name, 38).toUpperCase(), 76, 89, {
      width: 444,
      align: 'center',
    });

  doc
    .fillColor('#059669')
    .font('Helvetica-Bold')
    .fontSize(8)
    .text(
      'STUDENT SHIELD SMART BUDDY: ULTRA-CORE SUCCESS ECOSYSTEM',
      76,
      145,
      {
        width: 444,
        align: 'center',
      }
    );

  doc
    .fillColor('#64748B')
    .font('Helvetica')
    .fontSize(9)
    .text('Student Enrollment and Payment Record', 76, 163, {
      width: 444,
      align: 'center',
    });

  // Student quick summary strip.
  doc.rect(42, 212, 511, 50).fill('#F4F8FA');

  doc
    .moveTo(42, 212)
    .lineTo(553, 212)
    .lineWidth(1)
    .strokeColor('#D7E0E6')
    .stroke();

  doc
    .moveTo(42, 262)
    .lineTo(553, 262)
    .lineWidth(1)
    .strokeColor('#D7E0E6')
    .stroke();

  const studentSummary = [
    `STUDENT: ${shortText(student.full_name, 27).toUpperCase()}`,
    `CLASS: ${shortText(student.class_assigned, 15).toUpperCase()}`,
    `AGE: ${student.age ? `${student.age} YEARS` : '-'}`,
  ].join('  |  ');

  doc
    .fillColor('#1E293B')
    .font('Helvetica-Bold')
    .fontSize(10.5)
    .text(studentSummary, 57, 232, {
      width: 481,
      align: 'center',
    });

  let y = 282;

  drawSectionHeading(doc, 'Student Information', y);
  y += 30;

  drawTwoColumnRow(
    doc,
    {
      label: 'Student Name',
      value: student.full_name,
    },
    {
      label: 'School',
      value: school.name,
    },
    y
  );

  y += 32;

  drawTwoColumnRow(
    doc,
    {
      label: 'Class',
      value: student.class_assigned,
    },
    {
      label: 'Age',
      value: student.age ? `${student.age} years` : '-',
    },
    y
  );

  y += 32;

  drawTwoColumnRow(
    doc,
    {
      label: 'Student Login Email',
      value: student.email,
    },
    {
      label: 'Parent Contact',
      value: student.parent_phone,
    },
    y
  );

  y += 42;

  drawSectionHeading(doc, 'Enrollment and Payment', y);
  y += 30;

  drawTwoColumnRow(
    doc,
    {
      label: 'Plan',
      value: receipt.plan_name,
    },
    {
      label: 'Plan Duration',
      value: receipt.plan_duration,
    },
    y
  );

  y += 32;

  drawTwoColumnRow(
    doc,
    {
      label: 'Payment Type',
      value: receipt.payment_type,
    },
    {
      label: 'Payment Mode',
      value: receipt.payment_mode,
    },
    y
  );

  y += 32;

  drawTwoColumnRow(
    doc,
    {
      label: 'Total Amount',
      value: displayCurrency(receipt.total_amount),
    },
    {
      label: 'Payment Status',
      value: receipt.payment_status,
    },
    y
  );

  y += 32;

  drawTwoColumnRow(
    doc,
    {
      label: 'Amount Paid',
      value: displayCurrency(receipt.paid_amount),
    },
    {
      label: 'Amount Remaining',
      value: displayCurrency(receipt.remaining_amount),
    },
    y
  );

  const installmentDates = receipt.installment_dates
    .map((item) => displayDate(item))
    .join(' and ');

  if (installmentDates) {
    y += 32;

    drawTwoColumnRow(
      doc,
      {
        label: 'Installment Due Dates',
        value: installmentDates,
      },
      {
        label: 'Enrollment Date',
        value: displayDate(receipt.enrollment_date),
      },
      y
    );
  }

  y += 42;

  drawSectionHeading(doc, 'Receipt Summary', y);
  y += 30;

  drawTwoColumnRow(
    doc,
    {
      label: 'Receipt Number',
      value: receipt.receipt_no,
    },
    {
      label: 'Enrollment Date',
      value: displayDate(receipt.enrollment_date),
    },
    y
  );

  y += 32;

  drawTwoColumnRow(
    doc,
    {
      label: 'Benefits Activated From',
      value: displayDate(receipt.benefit_activation_date),
    },
    {
      label: 'Benefits Valid Until',
      value: displayDate(receipt.benefit_expiry_date),
    },
    y
  );

  doc
    .moveTo(56, 750)
    .lineTo(539, 750)
    .lineWidth(1)
    .strokeColor('#D7E0E6')
    .stroke();

  doc
    .fillColor('#64748B')
    .font('Helvetica')
    .fontSize(8.5)
    .text(
      'This is a computer-generated Student Shield enrollment document. It does not contain the student password.',
      56,
      764,
      {
        width: 483,
        align: 'center',
      }
    );

  doc
    .fillColor('#0F766E')
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .text('Student Shield Digital Authorization', 56, 790, {
      width: 483,
      align: 'center',
    });

  doc.end();

  return completed;
}
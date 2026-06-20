import crypto from 'crypto';
import { adminClient } from '../supabase.js';

export const SMART_BUDDY_REPORTS_BUCKET =
  process.env.SMART_BUDDY_REPORTS_BUCKET || 'student-buddy-reports';

const MAX_PROFILE_JSON_BYTES = 1024 * 1024; // 1 MB per saved object
const MAX_REPORT_JSON_BYTES = 1024 * 1024; // 1 MB report snapshot
const MAX_PDF_BYTES = 15 * 1024 * 1024; // 15 MB
const DEFAULT_LAUNCH_TTL_MINUTES = 5;
const DEFAULT_SESSION_TTL_HOURS = 8;

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function toIsoDate(date) {
  return date.toISOString();
}

function addMinutes(date, minutes) {
  const next = new Date(date);
  next.setMinutes(next.getMinutes() + minutes);
  return next;
}

function addHours(date, hours) {
  const next = new Date(date);
  next.setHours(next.getHours() + hours);
  return next;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createOpaqueToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function sanitizeTitle(value) {
  const title = String(value || 'Smart Buddy Report')
    .replace(/[\r\n]+/g, ' ')
    .trim();

  return (title || 'Smart Buddy Report').slice(0, 160);
}

function sanitizeFileName(value) {
  const source = String(value || 'smart-buddy-report.pdf');
  const safe = source
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');

  return (safe || 'smart-buddy-report.pdf').slice(0, 180);
}

function parseJsonField(value, fieldName, maxBytes) {
  if (value === undefined) return undefined;

  let parsed = value;

  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`${fieldName} must be valid JSON`);
    }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${fieldName} must be a JSON object`);
  }

  let serialized;
  try {
    serialized = JSON.stringify(parsed);
  } catch {
    throw new Error(`${fieldName} cannot be serialized`);
  }

  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new Error(`${fieldName} is too large`);
  }

  return parsed;
}

function assertPdfFile(file) {
  if (!file) {
    throw new Error('PDF file is required');
  }

  if (!Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw new Error('Uploaded PDF is empty');
  }

  if (file.buffer.length > MAX_PDF_BYTES) {
    throw new Error('PDF is too large. Maximum supported size is 15 MB');
  }

  const startsWithPdf = file.buffer.subarray(0, 4).toString('utf8') === '%PDF';
  const looksLikePdf =
    file.mimetype === 'application/pdf' ||
    String(file.originalname || '').toLowerCase().endsWith('.pdf');

  if (!looksLikePdf || !startsWithPdf) {
    throw new Error('Only valid PDF files are supported');
  }
}

export async function assertStudentContext(studentId) {
  const [profileResponse, roleResponse] = await Promise.all([
    adminClient
      .from('profiles')
      .select('id, full_name, email, school_id, class_assigned, parent_phone, age')
      .eq('id', studentId)
      .maybeSingle(),
    adminClient
      .from('user_roles')
      .select('role, school_id')
      .eq('user_id', studentId)
      .eq('role', 'student')
      .maybeSingle(),
  ]);

  if (profileResponse.error) throw new Error(profileResponse.error.message);
  if (roleResponse.error) throw new Error(roleResponse.error.message);

  const profile = profileResponse.data;
  const role = roleResponse.data;

  if (!profile || !role) {
    throw new Error('Student access is required');
  }

  if (!profile.school_id) {
    throw new Error('Student school assignment is missing');
  }

  return {
    profile,
    schoolId: profile.school_id,
  };
}

async function getSchoolSummary(schoolId) {
  if (!schoolId) return null;

  const { data, error } = await adminClient
    .from('schools')
    .select('id, name, selected_plan_tier')
    .eq('id', schoolId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

export async function getSmartBuddyProfile(studentId) {
  const { profile, schoolId } = await assertStudentContext(studentId);

  const [savedProfileResponse, school] = await Promise.all([
    adminClient
      .from('student_buddy_profiles')
      .select('student_id, school_id, form_data, assessment_data, created_at, updated_at')
      .eq('student_id', studentId)
      .maybeSingle(),
    getSchoolSummary(schoolId),
  ]);

  if (savedProfileResponse.error) {
    throw new Error(savedProfileResponse.error.message);
  }

  const savedProfile = savedProfileResponse.data;

  return {
    student: profile,
    school,
    saved_profile: {
      form_data: savedProfile?.form_data ?? {},
      assessment_data: savedProfile?.assessment_data ?? {},
      created_at: savedProfile?.created_at ?? null,
      updated_at: savedProfile?.updated_at ?? null,
    },
  };
}

export async function saveSmartBuddyProfile(studentId, payload = {}) {
  const { schoolId } = await assertStudentContext(studentId);

  const formData = parseJsonField(
    payload.form_data,
    'form_data',
    MAX_PROFILE_JSON_BYTES
  );
  const assessmentData = parseJsonField(
    payload.assessment_data,
    'assessment_data',
    MAX_PROFILE_JSON_BYTES
  );

  if (formData === undefined && assessmentData === undefined) {
    throw new Error('Provide form_data or assessment_data to save');
  }

  const { data: existing, error: existingError } = await adminClient
    .from('student_buddy_profiles')
    .select('form_data, assessment_data')
    .eq('student_id', studentId)
    .maybeSingle();

  if (existingError) throw new Error(existingError.message);

  const { data, error } = await adminClient
    .from('student_buddy_profiles')
    .upsert(
      {
        student_id: studentId,
        school_id: schoolId,
        form_data: formData ?? existing?.form_data ?? {},
        assessment_data: assessmentData ?? existing?.assessment_data ?? {},
      },
      { onConflict: 'student_id' }
    )
    .select('student_id, school_id, form_data, assessment_data, created_at, updated_at')
    .single();

  if (error) throw new Error(error.message);

  return data;
}

async function createReportSignedUrl(report, expiresIn = 60 * 30) {
  const { data, error } = await adminClient.storage
    .from(report.storage_bucket || SMART_BUDDY_REPORTS_BUCKET)
    .createSignedUrl(report.storage_path, expiresIn);

  if (error) {
    console.warn('Smart Buddy report signed URL failed:', error.message);
    return null;
  }

  return data?.signedUrl ?? null;
}

function reportResponse(report, signedUrl = null) {
  return {
    id: report.id,
    report_title: report.report_title,
    file_name: report.file_name,
    mime_type: report.mime_type,
    file_size: report.file_size,
    generated_at: report.generated_at,
    created_at: report.created_at,
    download_url: signedUrl,
  };
}

export async function uploadSmartBuddyReport(studentId, file, payload = {}) {
  assertPdfFile(file);

  const { schoolId } = await assertStudentContext(studentId);
  const reportData =
    parseJsonField(payload.report_data, 'report_data', MAX_REPORT_JSON_BYTES) ?? {};

  const reportId = crypto.randomUUID();
  const now = new Date();
  const fileName = sanitizeFileName(payload.file_name || file.originalname);
  const reportTitle = sanitizeTitle(payload.report_title);
  const storagePath = [
    studentId,
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    `${reportId}.pdf`,
  ].join('/');

  const { error: storageError } = await adminClient.storage
    .from(SMART_BUDDY_REPORTS_BUCKET)
    .upload(storagePath, file.buffer, {
      contentType: 'application/pdf',
      cacheControl: 'private, max-age=0, no-store',
      upsert: false,
    });

  if (storageError) {
    throw new Error(
      `Failed to store Smart Buddy PDF. Ensure bucket "${SMART_BUDDY_REPORTS_BUCKET}" exists and is private. ${storageError.message}`
    );
  }

  const { data: report, error: reportError } = await adminClient
    .from('student_buddy_reports')
    .insert({
      id: reportId,
      student_id: studentId,
      school_id: schoolId,
      report_title: reportTitle,
      report_data: reportData,
      storage_bucket: SMART_BUDDY_REPORTS_BUCKET,
      storage_path: storagePath,
      file_name: fileName,
      mime_type: 'application/pdf',
      file_size: file.size ?? file.buffer.length,
      generated_at: payload.generated_at
        ? new Date(payload.generated_at).toISOString()
        : toIsoDate(now),
    })
    .select(
      'id, report_title, report_data, storage_bucket, storage_path, file_name, mime_type, file_size, generated_at, created_at'
    )
    .single();

  if (reportError) {
    await adminClient.storage
      .from(SMART_BUDDY_REPORTS_BUCKET)
      .remove([storagePath]);

    throw new Error(reportError.message);
  }

  const signedUrl = await createReportSignedUrl(report);
  return reportResponse(report, signedUrl);
}

export async function listSmartBuddyReports(studentId) {
  await assertStudentContext(studentId);

  const { data: reports, error } = await adminClient
    .from('student_buddy_reports')
    .select(
      'id, report_title, storage_bucket, storage_path, file_name, mime_type, file_size, generated_at, created_at'
    )
    .eq('student_id', studentId)
    .order('generated_at', { ascending: false });

  if (error) throw new Error(error.message);

  const items = await Promise.all(
    (reports ?? []).map(async (report) =>
      reportResponse(report, await createReportSignedUrl(report))
    )
  );

  return items;
}

export async function getSmartBuddyReportDownload(studentId, reportId) {
  await assertStudentContext(studentId);

  const { data: report, error } = await adminClient
    .from('student_buddy_reports')
    .select(
      'id, report_title, storage_bucket, storage_path, file_name, mime_type, file_size, generated_at, created_at'
    )
    .eq('id', reportId)
    .eq('student_id', studentId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!report) throw new Error('Smart Buddy report not found');

  const signedUrl = await createReportSignedUrl(report, 60 * 30);

  if (!signedUrl) {
    throw new Error('Unable to create a download URL for this report');
  }

  return reportResponse(report, signedUrl);
}

export async function createSmartBuddyLaunch(studentId) {
  const { schoolId, profile } = await assertStudentContext(studentId);

  const now = new Date();
  const launchTtlMinutes = clampNumber(
    process.env.SMART_BUDDY_LAUNCH_TTL_MINUTES,
    DEFAULT_LAUNCH_TTL_MINUTES,
    1,
    15
  );

  const rawToken = createOpaqueToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = addMinutes(now, launchTtlMinutes);

  const { error } = await adminClient
    .from('student_buddy_launch_tokens')
    .insert({
      student_id: studentId,
      school_id: schoolId,
      token_hash: tokenHash,
      expires_at: toIsoDate(expiresAt),
    });

  if (error) throw new Error(error.message);

  const configuredAppUrl = process.env.SMART_BUDDY_APP_URL || '';
  const url = configuredAppUrl
    ? `${configuredAppUrl}${configuredAppUrl.includes('?') ? '&' : '?'}launch_token=${encodeURIComponent(rawToken)}`
    : null;

  return {
    launch_token: rawToken,
    expires_at: toIsoDate(expiresAt),
    launch_url: url,
    student: {
      id: profile.id,
      full_name: profile.full_name,
      school_id: schoolId,
    },
  };
}

export async function exchangeSmartBuddyLaunchToken(launchToken) {
  if (!launchToken || typeof launchToken !== 'string') {
    throw new Error('launch_token is required');
  }

  const tokenHash = hashToken(launchToken);
  const now = new Date();

  const { data: launchRecord, error: launchError } = await adminClient
    .from('student_buddy_launch_tokens')
    .select('id, student_id, school_id, expires_at, used_at')
    .eq('token_hash', tokenHash)
    .is('used_at', null)
    .gt('expires_at', toIsoDate(now))
    .maybeSingle();

  if (launchError) throw new Error(launchError.message);
  if (!launchRecord) {
    throw new Error('Smart Buddy launch token is invalid or expired');
  }

  const { data: claimedLaunch, error: claimError } = await adminClient
    .from('student_buddy_launch_tokens')
    .update({ used_at: toIsoDate(now) })
    .eq('id', launchRecord.id)
    .is('used_at', null)
    .select('id')
    .maybeSingle();

  if (claimError) throw new Error(claimError.message);
  if (!claimedLaunch) {
    throw new Error('Smart Buddy launch token was already used');
  }

  const sessionTtlHours = clampNumber(
    process.env.SMART_BUDDY_SESSION_TTL_HOURS,
    DEFAULT_SESSION_TTL_HOURS,
    1,
    24
  );

  const sessionToken = createOpaqueToken();
  const sessionExpiresAt = addHours(now, sessionTtlHours);

  const { data: session, error: sessionError } = await adminClient
    .from('student_buddy_sessions')
    .insert({
      student_id: launchRecord.student_id,
      school_id: launchRecord.school_id,
      token_hash: hashToken(sessionToken),
      expires_at: toIsoDate(sessionExpiresAt),
      last_seen_at: toIsoDate(now),
    })
    .select('id, student_id, school_id, expires_at')
    .single();

  if (sessionError) throw new Error(sessionError.message);

  const profile = await getSmartBuddyProfile(session.student_id);

  return {
    session_token: sessionToken,
    expires_at: session.expires_at,
    profile,
  };
}

export async function authenticateSmartBuddySession(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') {
    throw new Error('Unauthorized');
  }

  const now = new Date();

  const { data: session, error } = await adminClient
    .from('student_buddy_sessions')
    .select('id, student_id, school_id, expires_at')
    .eq('token_hash', hashToken(rawToken))
    .is('revoked_at', null)
    .gt('expires_at', toIsoDate(now))
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!session) throw new Error('Unauthorized');

  adminClient
    .from('student_buddy_sessions')
    .update({ last_seen_at: toIsoDate(now) })
    .eq('id', session.id)
    .then(({ error: updateError }) => {
      if (updateError) {
        console.warn('Unable to update Smart Buddy session activity:', updateError.message);
      }
    });

  return session;
}

export async function revokeSmartBuddySession(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') {
    return;
  }

  const { error } = await adminClient
    .from('student_buddy_sessions')
    .update({ revoked_at: toIsoDate(new Date()) })
    .eq('token_hash', hashToken(rawToken))
    .is('revoked_at', null);

  if (error) throw new Error(error.message);
}

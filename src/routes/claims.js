import { adminClient } from '../supabase.js';

async function getProfile(userId) {
  const { data, error } = await adminClient
    .from('profiles')
    .select('id, full_name, email, school_id, class_assigned')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

async function getStudentProfile(studentId) {
  const { data, error } = await adminClient
    .from('profiles')
    .select('id, full_name, email, school_id, class_assigned, parent_phone')
    .eq('id', studentId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

async function checkExistingActiveClaim(studentId) {
  const { data, error } = await adminClient
    .from('claims')
    .select('id, status, title, created_at, raised_by_role')
    .eq('student_id', studentId)
    .in('status', ['pending', 'approved'])
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

async function verifyTeacherCanRaiseForStudent(teacherId, studentId) {
  const { data, error } = await adminClient
    .from('enrollments')
    .select('id')
    .eq('teacher_id', teacherId)
    .eq('student_id', studentId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  if (!data) {
    const err = new Error('Forbidden — student is not assigned to this teacher');
    err.status = 403;
    throw err;
  }
}

async function verifySchoolAdminCanRaiseForStudent(schoolAdminId, studentId) {
  const adminProfile = await getProfile(schoolAdminId);
  const studentProfile = await getStudentProfile(studentId);

  if (!adminProfile?.school_id || !studentProfile?.school_id) {
    throw new Error('School mapping missing');
  }

  if (adminProfile.school_id !== studentProfile.school_id) {
    const err = new Error('Forbidden — student does not belong to your school');
    err.status = 403;
    throw err;
  }

  return { adminProfile, studentProfile };
}

function safeFileName(fileName = 'document') {
  return String(fileName)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_');
}

async function uploadClaimDocuments({ claimId, studentId, uploadedBy, files = [] }) {
  if (!files.length) return [];

  const uploadedRows = [];

  for (const file of files) {
    const fileName = safeFileName(file.originalname);
    const path = `${studentId}/${claimId}/${Date.now()}-${fileName}`;

    const { error: uploadError } = await adminClient.storage
      .from('claim-documents')
      .upload(path, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      throw new Error(uploadError.message);
    }

    const { data, error } = await adminClient
      .from('claim_documents')
      .insert({
        claim_id: claimId,
        file_name: file.originalname,
        file_path: path,
        mime_type: file.mimetype,
        file_size: file.size,
        uploaded_by: uploadedBy,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    uploadedRows.push(data);
  }

  return uploadedRows;
}

async function addSignedUrlsToDocuments(documents = []) {
  if (!documents.length) return [];

  const signedDocs = [];

  for (const document of documents) {
    const { data, error } = await adminClient.storage
      .from('claim-documents')
      .createSignedUrl(document.file_path, 60 * 30);

    signedDocs.push({
      ...document,
      signed_url: error ? null : data?.signedUrl ?? null,
    });
  }

  return signedDocs;
}

async function attachDocumentsToClaims(claims = []) {
  if (!claims.length) return [];

  const claimIds = claims.map((claim) => claim.id).filter(Boolean);

  const { data: docs, error } = await adminClient
    .from('claim_documents')
    .select('*')
    .in('claim_id', claimIds)
    .order('created_at', { ascending: false });

  if (error) {
    console.warn('claim_documents lookup failed:', error.message);
    return claims.map((claim) => ({
      ...claim,
      documents: [],
    }));
  }

  const docsWithUrls = await addSignedUrlsToDocuments(docs ?? []);

  const docsMap = new Map();

  for (const doc of docsWithUrls) {
    const list = docsMap.get(doc.claim_id) ?? [];
    list.push(doc);
    docsMap.set(doc.claim_id, list);
  }

  return claims.map((claim) => ({
    ...claim,
    documents: docsMap.get(claim.id) ?? [],
  }));
}

export async function raiseClaim({
  callerId,
  studentId,
  body,
  raisedByRole,
  files = [],
}) {
  if (!studentId) {
    throw new Error('Student is required');
  }

  const callerProfile = await getProfile(callerId);
  const studentProfile = await getStudentProfile(studentId);

  if (!callerProfile) {
    throw new Error('Caller profile not found');
  }

  if (!studentProfile) {
    throw new Error('Student profile not found');
  }

  const existingClaim = await checkExistingActiveClaim(studentId);

  if (existingClaim) {
    const err = new Error(
      `Claim already exists for this student with status "${existingClaim.status}"`
    );
    err.status = 409;
    throw err;
  }

  const title = String(body.title ?? body.claim_title ?? '').trim();
  const description = String(
    body.description ?? body.claim_description ?? ''
  ).trim();
  const claimReason = String(body.claim_reason ?? body.reason ?? '').trim();
  const amount = Number(body.amount ?? 0);

  if (!title || !description) {
    throw new Error('Title and description are required');
  }

  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error('Invalid claim amount');
  }

  const { data: claim, error } = await adminClient
    .from('claims')
    .insert({
      student_id: studentId,
      teacher_id:
        raisedByRole === 'teacher' ? callerId : body.teacher_id ?? null,
      school_id: studentProfile.school_id,
      raised_by_user_id: callerId,
      raised_by_role: raisedByRole,
      title,
      description,
      claim_reason: claimReason || null,
      claim_notes: body.claim_notes ?? null,
      amount,
      status: 'pending',
    })
    .select()
    .single();

  if (error) {
    if (
      error.message?.includes('one_active_claim_per_student') ||
      error.message?.includes('duplicate key')
    ) {
      const err = new Error('An active claim already exists for this student');
      err.status = 409;
      throw err;
    }

    throw new Error(error.message);
  }

  const documents = await uploadClaimDocuments({
    claimId: claim.id,
    studentId,
    uploadedBy: callerId,
    files,
  });

  return {
    ...claim,
    documents: await addSignedUrlsToDocuments(documents),
  };
}

export async function raiseStudentClaim(callerId, body, files = []) {
  return raiseClaim({
    callerId,
    studentId: callerId,
    body,
    raisedByRole: 'student',
    files,
  });
}

export async function raiseTeacherClaim(callerId, body, files = []) {
  const studentId = body.student_id;

  await verifyTeacherCanRaiseForStudent(callerId, studentId);

  return raiseClaim({
    callerId,
    studentId,
    body,
    raisedByRole: 'teacher',
    files,
  });
}

export async function raiseSchoolAdminClaim(callerId, body, files = []) {
  const studentId = body.student_id;

  await verifySchoolAdminCanRaiseForStudent(callerId, studentId);

  return raiseClaim({
    callerId,
    studentId,
    body,
    raisedByRole: 'school_admin',
    files,
  });
}

export async function listClaimsForStudent(studentId) {
  const { data, error } = await adminClient
    .from('claims')
    .select('*')
    .eq('student_id', studentId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);

  return attachDocumentsToClaims(data ?? []);
}

export async function listClaimsForTeacher(teacherId) {
  const { data: enrollments, error: enrollmentError } = await adminClient
    .from('enrollments')
    .select('student_id')
    .eq('teacher_id', teacherId);

  if (enrollmentError) throw new Error(enrollmentError.message);

  const studentIds = (enrollments ?? [])
    .map((e) => e.student_id)
    .filter(Boolean);

  if (!studentIds.length) return [];

  const { data, error } = await adminClient
    .from('claims')
    .select('*')
    .in('student_id', studentIds)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);

  return attachDocumentsToClaims(data ?? []);
}

export async function listClaimsForSchoolAdmin(schoolAdminId) {
  const profile = await getProfile(schoolAdminId);

  if (!profile?.school_id) {
    throw new Error('School assignment missing');
  }

  const { data, error } = await adminClient
    .from('claims')
    .select('*')
    .eq('school_id', profile.school_id)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);

  return attachDocumentsToClaims(data ?? []);
}

export async function listAllClaimsForCompany() {
  const { data: claims, error } = await adminClient
    .from('claims')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);

  const studentIds = [
    ...new Set((claims ?? []).map((c) => c.student_id).filter(Boolean)),
  ];

  const schoolIds = [
    ...new Set((claims ?? []).map((c) => c.school_id).filter(Boolean)),
  ];

  const raisedByIds = [
    ...new Set((claims ?? []).map((c) => c.raised_by_user_id).filter(Boolean)),
  ];

  const [studentsResp, schoolsResp, raisedByResp] = await Promise.all([
    studentIds.length
      ? adminClient
          .from('profiles')
          .select('id, full_name, email, class_assigned, parent_phone')
          .in('id', studentIds)
      : { data: [], error: null },

    schoolIds.length
      ? adminClient.from('schools').select('id, name').in('id', schoolIds)
      : { data: [], error: null },

    raisedByIds.length
      ? adminClient
          .from('profiles')
          .select('id, full_name, email')
          .in('id', raisedByIds)
      : { data: [], error: null },
  ]);

  if (studentsResp.error) throw new Error(studentsResp.error.message);
  if (schoolsResp.error) throw new Error(schoolsResp.error.message);
  if (raisedByResp.error) throw new Error(raisedByResp.error.message);

  const studentMap = new Map(
    (studentsResp.data ?? []).map((student) => [student.id, student])
  );

  const schoolMap = new Map(
    (schoolsResp.data ?? []).map((school) => [school.id, school])
  );

  const raisedByMap = new Map(
    (raisedByResp.data ?? []).map((profile) => [profile.id, profile])
  );

  const claimsWithRelations = (claims ?? []).map((claim) => ({
    ...claim,
    student: studentMap.get(claim.student_id) ?? null,
    school: schoolMap.get(claim.school_id) ?? null,
    raised_by: raisedByMap.get(claim.raised_by_user_id) ?? null,
  }));

  return attachDocumentsToClaims(claimsWithRelations);
}

export async function updateClaimStatus(claimId, status) {
  const allowed = ['pending', 'approved', 'rejected', 'paid'];

  if (!allowed.includes(status)) {
    throw new Error('Invalid claim status');
  }

  const { data, error } = await adminClient
    .from('claims')
    .update({
      status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', claimId)
    .select()
    .single();

  if (error) throw new Error(error.message);

  return data;
}
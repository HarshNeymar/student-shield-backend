import { adminClient } from '../supabase.js';

const SCHOOL_MEMBER_ROLES = new Set([
  'school_admin',
  'teacher',
  'student',
]);

const QUERY_BATCH_SIZE = 200;
const STORAGE_BATCH_SIZE = 100;

function createHttpError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function chunk(values = [], size = QUERY_BATCH_SIZE) {
  const output = [];

  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }

  return output;
}

function isMissingOptionalSchema(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');

  return (
    code === '42P01' ||
    code === '42703' ||
    code === 'PGRST205' ||
    code === 'PGRST204' ||
    /relation .* does not exist/i.test(message) ||
    /column .* does not exist/i.test(message) ||
    /could not find .* in the schema cache/i.test(message)
  );
}

async function selectRows(query, label, { optional = false } = {}) {
  const { data, error } = await query;

  if (error) {
    if (optional && isMissingOptionalSchema(error)) {
      return [];
    }

    throw createHttpError(`Unable to read ${label}: ${error.message}`);
  }

  return data ?? [];
}

async function deleteQuery(query, label, { optional = false } = {}) {
  const { error } = await query;

  if (error) {
    if (optional && isMissingOptionalSchema(error)) {
      return;
    }

    throw createHttpError(`Unable to delete ${label}: ${error.message}`);
  }
}

async function updateQuery(query, label, { optional = false } = {}) {
  const { error } = await query;

  if (error) {
    if (optional && isMissingOptionalSchema(error)) {
      return;
    }

    throw createHttpError(`Unable to update ${label}: ${error.message}`);
  }
}

async function deleteWhereIn({
  table,
  column,
  values,
  label,
  optional = false,
}) {
  for (const ids of chunk(unique(values))) {
    if (!ids.length) continue;

    await deleteQuery(
      adminClient.from(table).delete().in(column, ids),
      label,
      { optional }
    );
  }
}

async function updateWhereIn({
  table,
  column,
  values,
  patch,
  label,
  optional = false,
}) {
  for (const ids of chunk(unique(values))) {
    if (!ids.length) continue;

    await updateQuery(
      adminClient.from(table).update(patch).in(column, ids),
      label,
      { optional }
    );
  }
}

async function removeStorageFiles(bucket, paths = []) {
  let removed = 0;

  for (const batch of chunk(unique(paths), STORAGE_BATCH_SIZE)) {
    if (!batch.length) continue;

    const { error } = await adminClient.storage.from(bucket).remove(batch);

    if (error) {
      throw createHttpError(
        `Unable to delete files from storage bucket "${bucket}": ${error.message}`
      );
    }

    removed += batch.length;
  }

  return removed;
}

async function getDeleteSnapshot(schoolId) {
  const { data: school, error: schoolError } = await adminClient
    .from('schools')
    .select('id, name, admin_user_id')
    .eq('id', schoolId)
    .maybeSingle();

  if (schoolError) {
    throw createHttpError(`Unable to read school: ${schoolError.message}`);
  }

  if (!school) {
    throw createHttpError('School not found', 404);
  }

  const [
    schoolRoles,
    schoolProfiles,
    enrollments,
    claims,
    wellnessReports,
    sessions,
  ] = await Promise.all([
    selectRows(
      adminClient
        .from('user_roles')
        .select('user_id, role, school_id')
        .eq('school_id', schoolId),
      'school roles'
    ),

    selectRows(
      adminClient
        .from('profiles')
        .select('id, school_id')
        .eq('school_id', schoolId),
      'school profiles'
    ),

    selectRows(
      adminClient
        .from('enrollments')
        .select('id, student_id, teacher_id')
        .eq('school_id', schoolId),
      'school enrollments'
    ),

    selectRows(
      adminClient.from('claims').select('id').eq('school_id', schoolId),
      'school claims'
    ),

    selectRows(
      adminClient
        .from('wellness_reports')
        .select('id')
        .eq('school_id', schoolId),
      'school wellness reports'
    ),

    selectRows(
      adminClient
        .from('sessions')
        .select('id, recording_url')
        .eq('target_school_id', schoolId),
      'school sessions'
    ),
  ]);

  const possibleMemberIds = unique([
    ...schoolProfiles.map((row) => row.id),

    ...schoolRoles
      .filter((row) => SCHOOL_MEMBER_ROLES.has(row.role))
      .map((row) => row.user_id),

    ...enrollments.map((row) => row.student_id),
    ...enrollments.map((row) => row.teacher_id),

    school.admin_user_id,
  ]);

  const allRolesForPossibleMembers = possibleMemberIds.length
    ? await selectRows(
        adminClient
          .from('user_roles')
          .select('user_id, role, school_id')
          .in('user_id', possibleMemberIds),
        'member role mappings'
      )
    : [];

  const protectedCompanyAdminIds = new Set(
    allRolesForPossibleMembers
      .filter((row) => row.role === 'company_admin')
      .map((row) => row.user_id)
  );

  // Company admins are never deleted even if wrongly linked to a school.
  const memberUserIds = possibleMemberIds.filter(
    (id) => !protectedCompanyAdminIds.has(id)
  );

  const enrollmentIds = unique(enrollments.map((row) => row.id));
  const claimIds = unique(claims.map((row) => row.id));

  const [payments, claimDocuments, smartBuddyReports] = await Promise.all([
    enrollmentIds.length
      ? selectRows(
          adminClient
            .from('payments')
            .select('id, enrollment_id')
            .in('enrollment_id', enrollmentIds),
          'school payments'
        )
      : [],

    claimIds.length
      ? selectRows(
          adminClient
            .from('claim_documents')
            .select('id, claim_id, file_path')
            .in('claim_id', claimIds),
          'school claim documents',
          { optional: true }
        )
      : [],

    selectRows(
      adminClient
        .from('student_buddy_reports')
        .select('id, storage_bucket, storage_path')
        .eq('school_id', schoolId),
      'Smart Buddy reports',
      { optional: true }
    ),
  ]);

  return {
    school,
    schoolRoles,
    memberUserIds,
    protectedCompanyAdminIds: [...protectedCompanyAdminIds],
    enrollmentIds,
    claimIds,
    wellnessReportIds: unique(wellnessReports.map((row) => row.id)),
    paymentIds: unique(payments.map((row) => row.id)),
    claimDocuments,
    smartBuddyReports,
    sessions,
  };
}

async function deleteSchoolStorage(snapshot) {
  let removedFiles = 0;

  const smartBuddyPathsByBucket = new Map();

  for (const report of snapshot.smartBuddyReports) {
    if (!report.storage_path) continue;

    const bucket = report.storage_bucket || 'student-buddy-reports';
    const paths = smartBuddyPathsByBucket.get(bucket) ?? [];

    paths.push(report.storage_path);
    smartBuddyPathsByBucket.set(bucket, paths);
  }

  for (const [bucket, paths] of smartBuddyPathsByBucket.entries()) {
    removedFiles += await removeStorageFiles(bucket, paths);
  }

  removedFiles += await removeStorageFiles(
    'claim-documents',
    snapshot.claimDocuments.map((row) => row.file_path)
  );

  removedFiles += await removeStorageFiles(
    'session-recordings',
    snapshot.sessions.map((row) => row.recording_url)
  );

  return removedFiles;
}

async function deleteSchoolDatabaseData(snapshot) {
  const schoolId = snapshot.school.id;

  await deleteWhereIn({
    table: 'claim_documents',
    column: 'claim_id',
    values: snapshot.claimIds,
    label: 'claim documents',
    optional: true,
  });

  await deleteWhereIn({
    table: 'payments',
    column: 'enrollment_id',
    values: snapshot.enrollmentIds,
    label: 'payments',
  });

  // Exists only after the Smart Buddy report quota migration.
  await deleteWhereIn({
    table: 'student_buddy_report_slots',
    column: 'student_id',
    values: snapshot.memberUserIds,
    label: 'Smart Buddy report slots',
    optional: true,
  });

  await deleteQuery(
    adminClient
      .from('student_buddy_reports')
      .delete()
      .eq('school_id', schoolId),
    'Smart Buddy reports',
    { optional: true }
  );

  await deleteQuery(
    adminClient
      .from('student_buddy_profiles')
      .delete()
      .eq('school_id', schoolId),
    'Smart Buddy profiles',
    { optional: true }
  );

  await deleteQuery(
    adminClient
      .from('student_buddy_launch_tokens')
      .delete()
      .eq('school_id', schoolId),
    'Smart Buddy launch tokens',
    { optional: true }
  );

  await deleteQuery(
    adminClient
      .from('student_buddy_sessions')
      .delete()
      .eq('school_id', schoolId),
    'Smart Buddy sessions',
    { optional: true }
  );

  await deleteQuery(
    adminClient
      .from('wellness_reports')
      .delete()
      .eq('school_id', schoolId),
    'wellness reports'
  );

  await deleteQuery(
    adminClient
      .from('claims')
      .delete()
      .eq('school_id', schoolId),
    'claims'
  );

  await deleteQuery(
    adminClient
      .from('sessions')
      .delete()
      .eq('target_school_id', schoolId),
    'school sessions'
  );

  await deleteQuery(
    adminClient
      .from('enrollments')
      .delete()
      .eq('school_id', schoolId),
    'enrollments'
  );

  // Remove references from records outside this school.
  await updateWhereIn({
    table: 'profiles',
    column: 'created_by',
    values: snapshot.memberUserIds,
    patch: { created_by: null },
    label: 'profile creator references',
  });

  await updateWhereIn({
    table: 'sessions',
    column: 'created_by',
    values: snapshot.memberUserIds,
    patch: { created_by: null },
    label: 'session creator references',
  });

  await updateWhereIn({
    table: 'claims',
    column: 'raised_by_user_id',
    values: snapshot.memberUserIds,
    patch: { raised_by_user_id: null },
    label: 'claim creator references',
    optional: true,
  });

  if (
    snapshot.school.admin_user_id &&
    snapshot.memberUserIds.includes(snapshot.school.admin_user_id)
  ) {
    await updateQuery(
      adminClient
        .from('schools')
        .update({ admin_user_id: null })
        .eq('id', schoolId),
      'school admin reference'
    );
  }

  await deleteWhereIn({
    table: 'user_roles',
    column: 'user_id',
    values: snapshot.memberUserIds,
    label: 'school member roles',
  });

  await deleteWhereIn({
    table: 'profiles',
    column: 'id',
    values: snapshot.memberUserIds,
    label: 'school member profiles',
  });
}

async function deleteAuthUsers(userIds = []) {
  const deletedIds = [];

  for (const userId of unique(userIds)) {
    const { error } = await adminClient.auth.admin.deleteUser(userId);

    if (error) {
      throw createHttpError(
        `Unable to delete school user ${userId}: ${error.message}`
      );
    }

    deletedIds.push(userId);
  }

  return deletedIds;
}

export async function deleteSchoolWithAllData(schoolId) {
  const snapshot = await getDeleteSnapshot(schoolId);

  // Storage first. If file removal fails, database records are untouched.
  const storageFilesDeleted = await deleteSchoolStorage(snapshot);

  await deleteSchoolDatabaseData(snapshot);

  const deletedUserIds = await deleteAuthUsers(snapshot.memberUserIds);

  const { error: schoolError } = await adminClient
    .from('schools')
    .delete()
    .eq('id', snapshot.school.id);

  if (schoolError) {
    throw createHttpError(`Unable to delete school: ${schoolError.message}`);
  }

  return {
    deleted_school: snapshot.school,

    deletion_summary: {
      school_admin_accounts: snapshot.schoolRoles.filter(
        (row) => row.role === 'school_admin'
      ).length,

      teacher_accounts: snapshot.schoolRoles.filter(
        (row) => row.role === 'teacher'
      ).length,

      student_accounts: snapshot.schoolRoles.filter(
        (row) => row.role === 'student'
      ).length,

      user_accounts: deletedUserIds.length,
      enrollments: snapshot.enrollmentIds.length,
      payments: snapshot.paymentIds.length,
      wellness_reports: snapshot.wellnessReportIds.length,
      claims: snapshot.claimIds.length,
      claim_documents: snapshot.claimDocuments.length,
      smart_buddy_reports: snapshot.smartBuddyReports.length,
      sessions: snapshot.sessions.length,
      storage_files: storageFilesDeleted,

      protected_company_admin_accounts:
        snapshot.protectedCompanyAdminIds.length,
    },
  };
}
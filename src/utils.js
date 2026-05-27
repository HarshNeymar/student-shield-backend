export function must(data, error) {
  if (error) throw new Error(error.message);
  return data;
}

export function emptyUuid() {
  return '00000000-0000-0000-0000-000000000000';
}

export function rolePriority(rows = []) {
  const priority = ['company_admin', 'school_admin', 'teacher', 'student'];
  return priority.find((role) => rows.some((r) => r.role === role)) ?? null;
}

export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

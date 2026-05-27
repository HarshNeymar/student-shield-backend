import { Router } from 'express';
import { asyncHandler, rolePriority } from '../utils.js';

const router = Router();

router.get('/me', asyncHandler(async (req, res) => {
  const uid = req.user.id;
  const [{ data: profile, error: profileError }, { data: roles, error: roleError }] = await Promise.all([
    req.supabase.from('profiles').select('id, full_name, email, school_id, class_assigned').eq('id', uid).maybeSingle(),
    req.supabase.from('user_roles').select('role').eq('user_id', uid),
  ]);
  if (profileError) throw new Error(profileError.message);
  if (roleError) throw new Error(roleError.message);
  res.json({ profile, role: rolePriority(roles ?? []) });
}));

export default router;

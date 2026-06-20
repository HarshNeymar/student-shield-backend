import { authenticateSmartBuddySession } from '../services/smartBuddy.js';

export async function requireSmartBuddySession(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';

    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.slice('Bearer '.length).trim();
    const session = await authenticateSmartBuddySession(token);

    req.smartBuddy = {
      token,
      session,
      studentId: session.student_id,
      schoolId: session.school_id,
    };

    next();
  } catch (error) {
    return res.status(401).json({ error: error.message || 'Unauthorized' });
  }
}

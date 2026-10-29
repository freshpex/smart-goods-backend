export async function adminUser(db, config, user) {
  if (!user) return null;
  const { data, error } = await db
    .from(config.SUPABASE_USERS_TABLE)
    .select("id,store_admin,disabled,is_active")
    .eq("id", user.id)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.store_admin !== true || data.disabled || !data.is_active)
    return null;
  return { id: user.id, email: user.email, role: "admin" };
}

export function requireAdmin(db, config) {
  return async (req, res, next) => {
    try {
      const match = /^Bearer (\S+)$/.exec(req.headers.authorization || "");
      if (!match)
        return res
          .status(401)
          .json({ error: "Please sign in as an administrator." });
      const { data, error } = await db.auth.getUser(match[1]);
      if (error || !data.user)
        return res
          .status(401)
          .json({ error: "Your session has expired. Please sign in again." });
      const user = await adminUser(db, config, data.user);
      if (!user)
        return res
          .status(403)
          .json({ error: "Administrator access is required." });
      req.admin = user;
      req.accessToken = match[1];
      next();
    } catch (error) {
      next(error);
    }
  };
}

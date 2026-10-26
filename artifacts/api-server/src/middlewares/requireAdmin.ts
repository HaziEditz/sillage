import { clerkClient, getAuth } from "@clerk/express";
import type { NextFunction, Request, Response } from "express";

const adminEmails = new Set(
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }

  if (adminEmails.size === 0) {
    res.status(403).json({
      error: "Admin access has not been configured for this store.",
    });
    return;
  }

  try {
    const user = await clerkClient.users.getUser(userId);
    const primary = user.emailAddresses.find(
      (address) => address.id === user.primaryEmailAddressId,
    );
    const email = primary?.emailAddress.toLowerCase();
    if (!email || !adminEmails.has(email)) {
      res.status(403).json({ error: "Administrator access required." });
      return;
    }
    next();
  } catch (error) {
    req.log.error({ error, userId }, "Failed to verify admin identity");
    res.status(503).json({ error: "Could not verify admin access." });
  }
}

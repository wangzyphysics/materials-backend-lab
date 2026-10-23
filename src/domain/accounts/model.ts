import { z } from "zod";

export const careerStages = {
  "": "Prefer not to say",
  undergraduate: "Undergraduate student",
  masters: "Master’s student",
  doctoral: "Doctoral student",
  postdoc: "Postdoctoral researcher",
  faculty: "Faculty / principal investigator",
  researcher: "Researcher / research staff",
  industry: "Industry professional",
  other: "Other",
} as const;
const text = z.string().trim().max(200);
export const emailSchema = z.string().trim().toLowerCase().max(254).email("Enter a valid email address.");
// Existing identities can be read without inventing missing research information.
// Registration and every profile write use the stricter shared schema below.
export const storedProfileSchema = z.object({
  displayName: z.string().trim().min(1, "Enter a display name.").max(100),
  contactEmail: z
    .string()
    .trim()
    .max(254)
    .refine(
      (v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
      "Enter a valid contact email.",
    ),
  institution: text,
  department: text,
  researchGroup: text,
  careerStage: z.enum([
    "",
    "undergraduate",
    "masters",
    "doctoral",
    "postdoc",
    "faculty",
    "researcher",
    "industry",
    "other",
  ]),
  orcid: z
    .string()
    .trim()
    .refine(
      (v) => !v || /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(v),
      "Use the ORCID format 0000-0000-0000-000X.",
    ),
  countryRegion: z.string().trim().max(100),
  publicProfile: z.boolean(),
});
export const profileSchema = storedProfileSchema.extend({
  contactEmail: emailSchema,
  institution: text.min(1, "Enter your institution."),
  researchGroup: text.min(1, "Enter your research group."),
  careerStage: storedProfileSchema.shape.careerStage.refine(value => value !== "", "Choose your career stage."),
  countryRegion: z.string().trim().min(1, "Enter your country / region.").max(100),
});
export type Profile = z.infer<typeof storedProfileSchema>;
export const roleSchema = z.enum(["member", "admin"]);
export type Role = z.infer<typeof roleSchema>;
export const userSchema = z.object({
  id: z.string().min(1).max(200),
  email: z.string().email().nullable(),
  loginLabel: z.string().min(1).max(200).optional(),
  username: z.string().min(3).max(32).optional(),
  emailVerified: z.boolean(),
  role: roleSchema,
  profile: storedProfileSchema,
  version: z.string().min(1),
  passwordChangeRequired: z.boolean().optional(),
  status: z.enum(["active", "suspended", "deleted"]).optional(),
  statusReason: z.string().optional(),
  demoAccount: z.boolean().optional(),
  createdAt: z.string().datetime().optional(),
});
export type AccountUser = z.infer<typeof userSchema>;
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(32)
  .regex(
    /^[a-z][a-z0-9_.-]{2,31}$/,
    "Use 3–32 letters, numbers, dots, underscores or hyphens, starting with a letter.",
  );
export const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters for your password.")
  .max(128, "Use no more than 128 characters for your password.");
export const registrationProfileSchema = profileSchema.extend({
  // The registration email is authoritative and copied to the research profile.
  contactEmail: storedProfileSchema.shape.contactEmail,
  publicProfile: z.literal(false),
}).strict();
export const registrationSchema = z
  .object({
    username: usernameSchema,
    password: passwordSchema,
    email: emailSchema,
    profile: registrationProfileSchema,
  })
  .strict()
  .transform(value => ({ ...value, profile: { ...value.profile, contactEmail: value.email } }));
export type Registration = z.infer<typeof registrationSchema>;
export const loginMethods = [
  "password",
  "wechat",
  "qq",
  "sms",
  "email",
  "google",
] as const;
export type LoginMethod = (typeof loginMethods)[number];
export const providersSchema = z
  .array(
    z.object({
      id: z.enum(loginMethods),
      enabled: z.boolean(),
    }),
  )
  .refine((items) => new Set(items.map((i) => i.id)).size === items.length);
export const sessionSchema = z.object({
  user: userSchema.nullable(),
  csrfToken: z.string().min(1),
  expiresAt: z.string().datetime(),
});
export const auditSchema = z.object({
  id: z.string(),
  actorId: z.string(),
  targetId: z.string(),
  previousRole: roleSchema,
  role: roleSchema,
  reason: z.string().trim().min(3).max(500),
  at: z.string().datetime(),
});
export type RoleAudit = z.infer<typeof auditSchema>;
export const accountAuditSchema = z.object({
  id: z.string(), actorId: z.string(), targetId: z.string(),
  action: z.enum(["profile-updated", "password-reset", "password-changed", "account-suspended", "account-reactivated", "account-deleted", "account-restored", "sessions-revoked"]),
  reason: z.string(), at: z.string().datetime(),
});
export type AccountAudit = z.infer<typeof accountAuditSchema>;

export function emptyProfile(displayName: string, contactEmail = ""): Profile {
  return {
    displayName,
    contactEmail,
    institution: "",
    department: "",
    researchGroup: "",
    careerStage: "",
    orcid: "",
    countryRegion: "China",
    publicProfile: false,
  };
}
/** Return only internal product routes, never provider URLs or an API endpoint. */
export function safeReturnTo(value: string | null | undefined) {
  if (
    !value ||
    value.length > 2000 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u001f]/.test(value)
  )
    return "/explore";
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith("//") || /[\\\u0000-\u001f]/.test(decoded))
      return "/explore";
    const url = new URL(value, "https://calypso.invalid");
    if (
      url.origin !== "https://calypso.invalid" ||
      !/^\/materials\/[A-Za-z0-9_-]{1,200}$/.test(url.pathname) && ![
        "/",
        "/explore",
        "/contribute",
        "/workspace",
        "/account",
        "/admin",
        "/docs",
        "/about",
      ].includes(url.pathname)
    )
      return "/explore";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/explore";
  }
}
export function loginHref(returnTo: string) {
  return "/login?returnTo=" + encodeURIComponent(safeReturnTo(returnTo));
}
export function signupHref(returnTo: string) {
  return "/signup?returnTo=" + encodeURIComponent(safeReturnTo(returnTo));
}
export function canChangeRole(
  actor: AccountUser,
  target: AccountUser,
  next: Role,
  users: AccountUser[],
) {
  if (actor.status && actor.status !== "active") throw new Error("Active administrator access is required.");
  if (target.demoAccount) throw new Error("Demo identities cannot be granted administrative access.");
  if (target.status && target.status !== "active") throw new Error("Reactivate this account before changing its role.");
  if (actor.role !== "admin")
    throw new Error("Administrator access is required.");
  if (target.role === next)
    throw new Error("This account already has that role.");
  if (actor.id === target.id)
    throw new Error("Ask another administrator to change your role.");
  if (
    target.role === "admin" &&
    next === "member" &&
    users.filter((u) => u.role === "admin" && (!u.status || u.status === "active") && !u.demoAccount).length <= 1
  )
    throw new Error("The last administrator cannot be removed.");
}
export function contributionAttribution(profile: Profile) {
  return {
    name: profile.displayName,
    email: profile.contactEmail,
    institution: profile.institution,
    department: profile.department,
    researchGroup: profile.researchGroup,
    careerStage: profile.careerStage ? careerStages[profile.careerStage] : "",
    orcid: profile.orcid,
  };
}

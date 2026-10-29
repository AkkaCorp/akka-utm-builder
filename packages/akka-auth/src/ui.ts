import type { ComponentType, CSSProperties, ReactNode } from "react";

/**
 * Optional design-system components an app hands to the login screen. With
 * them, the screen is built from the app's own components (shadcn/ui in
 * practice: pass Card, Alert… straight from `@/components/ui`). Without them,
 * it falls back to the module's own CSS (auth.css).
 *
 * The module imports none of these itself, so it builds in an app that has
 * no shadcn. Layout uses inline styles only: no Tailwind class lives in here,
 * because a Tailwind build does not scan a package once it sits in
 * node_modules.
 *
 * The sign-in button is a client component and a component cannot cross the
 * server/client boundary, so the button comes in as a class string:
 * `buttonVariants({ size: "lg" })` from shadcn.
 */
type Part = ComponentType<{ className?: string; style?: CSSProperties; children?: ReactNode }>;

export type AuthUi = {
  Card: Part;
  CardHeader: Part;
  CardTitle: Part;
  CardDescription: Part;
  CardContent: Part;
  Alert: ComponentType<{ variant?: "destructive"; role?: string; children?: ReactNode }>;
  AlertDescription: Part;
  buttonClassName: string;
  /** Optional (0.2): text inputs of the partner and MFA forms, e.g. shadcn Input's classes. */
  inputClassName?: string;
};

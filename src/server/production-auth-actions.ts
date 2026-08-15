"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { revokeSession, SESSION_COOKIE, sessionCookieOptions } from "./auth";
import { getDb } from "./db";
import {
  bootstrapProductionWorkspace,
  loginProductionAccount,
  ProductionAuthError,
} from "./production-auth";

export interface ProductionAuthActionState {
  readonly ok: boolean;
  readonly code?: string;
  readonly message: string;
}

function field(formData: FormData, name: string, maximumLength: number): string {
  const value = formData.get(name);
  if (typeof value !== "string" || value.length > maximumLength) throw new Error("INVALID_FORM");
  return value;
}

function authFailure(error: unknown, bootstrap: boolean): ProductionAuthActionState {
  if (error instanceof ProductionAuthError) {
    if (
      error.code === "PRODUCTION_LOGIN_RATE_LIMITED" ||
      error.code === "PRODUCTION_BOOTSTRAP_RATE_LIMITED"
    ) {
      return {
        ok: false,
        code: error.code,
        message: bootstrap
          ? "Production bootstrap is temporarily unavailable. Try again later."
          : "Sign-in is temporarily unavailable. Try again later.",
      };
    }
    if (bootstrap && error.code === "PRODUCTION_BOOTSTRAP_EXPIRED") {
      return { ok: false, code: error.code, message: "The one-time bootstrap window has expired." };
    }
    if (bootstrap && error.code === "PRODUCTION_BOOTSTRAP_REPLAYED") {
      return { ok: false, code: error.code, message: "Production bootstrap is no longer available." };
    }
  }
  return bootstrap
    ? { ok: false, code: "PRODUCTION_BOOTSTRAP_FAILED", message: "Production bootstrap could not be completed." }
    : { ok: false, code: "PRODUCTION_LOGIN_FAILED", message: "Workspace, email, or password was not accepted." };
}

async function publishSessionCookie(token: string): Promise<boolean> {
  const store = await cookies();
  try {
    store.set(SESSION_COOKIE, token, sessionCookieOptions());
    return true;
  } catch {
    try {
      revokeSession(getDb(), token);
    } catch {
      // The bounded database session will expire even if best-effort cleanup fails.
    }
    return false;
  }
}

export async function productionBootstrapAction(
  _state: ProductionAuthActionState | null,
  formData: FormData,
): Promise<ProductionAuthActionState | never> {
  try {
    const result = bootstrapProductionWorkspace(getDb(), {
      token: field(formData, "bootstrapToken", 512),
      workspaceName: field(formData, "workspaceName", 160),
      workspaceSlug: field(formData, "workspaceSlug", 64),
      displayName: field(formData, "displayName", 160),
      email: field(formData, "email", 254),
      password: field(formData, "password", 128),
    });
    if (!(await publishSessionCookie(result.token))) {
      return { ok: false, code: "PRODUCTION_SESSION_FAILED", message: "Owner created. Sign in with the new credentials." };
    }
    redirect(`/w/${result.session.workspaceSlug}/dashboard`);
  } catch (error) {
    const digest = error && typeof error === "object" ? (error as { readonly digest?: unknown }).digest : null;
    if (typeof digest === "string" && digest.startsWith("NEXT_")) throw error;
    return authFailure(error, true);
  }
}

export async function productionLoginAction(
  _state: ProductionAuthActionState | null,
  formData: FormData,
): Promise<ProductionAuthActionState | never> {
  try {
    const store = await cookies();
    const result = loginProductionAccount(
      getDb(),
      store.get(SESSION_COOKIE)?.value,
      {
        workspaceSlug: field(formData, "workspaceSlug", 64),
        email: field(formData, "email", 254),
        password: field(formData, "password", 128),
      },
    );
    if (!(await publishSessionCookie(result.token))) {
      return { ok: false, code: "PRODUCTION_SESSION_FAILED", message: "Sign-in could not be completed." };
    }
    redirect(`/w/${result.session.workspaceSlug}/dashboard`);
  } catch (error) {
    const digest = error && typeof error === "object" ? (error as { readonly digest?: unknown }).digest : null;
    if (typeof digest === "string" && digest.startsWith("NEXT_")) throw error;
    return authFailure(error, false);
  }
}

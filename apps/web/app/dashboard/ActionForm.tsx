"use client";

import type { ReactNode } from "react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "./actions";

export function Submit({ children, className = "primary" }: { children: ReactNode; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button className={className} disabled={pending}>
      {pending ? "Working…" : children}
    </button>
  );
}

/** A form bound to a server action, showing the action's error or success message in place. */
export function ActionForm({
  action,
  children,
  className = "stack",
}: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  children: ReactNode;
  className?: string;
}) {
  const [state, run] = useActionState(action, {});
  return (
    <form action={run} className={className}>
      {children}
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p className="success" role="status">
          {state.ok}
        </p>
      )}
    </form>
  );
}

import type { InputHTMLAttributes, ReactNode } from "react";

export function Alert({
  kind,
  children,
}: {
  kind: "error" | "success" | "info";
  children: ReactNode;
}) {
  // Erros são anunciados na hora (role=alert); avisos e confirmações de forma educada (role=status).
  return (
    <div
      className={`alert alert-${kind}`}
      role={kind === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

export function Field({
  id,
  label,
  error,
  hint,
  ...input
}: {
  id: string;
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "id">) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...input}
      />
      {hint && (
        <p id={hintId} className="hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function SubmitButton({
  pending,
  children,
  pendingText = "Aguarde…",
}: {
  pending: boolean;
  children: ReactNode;
  pendingText?: string;
}) {
  return (
    <button
      type="submit"
      className="button primary"
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? pendingText : children}
    </button>
  );
}

export function Loading({ label = "Carregando…" }: { label?: string }) {
  return (
    <p className="loading" role="status">
      {label}
    </p>
  );
}

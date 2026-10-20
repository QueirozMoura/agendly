import { useState } from "react";

/** Remoção em dois passos, sem `window.confirm` (acessível e testável): "Remover" ⇒ "Confirmar remoção" / "Cancelar". */
export function ConfirmRemove({
  label,
  onConfirm,
  disabled,
}: {
  label: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <button
        type="button"
        className="button danger"
        disabled={disabled}
        onClick={() => setAsking(true)}
        aria-label={`Remover ${label}`}
      >
        Remover
      </button>
    );
  return (
    <span
      className="confirm"
      role="group"
      aria-label={`Confirmar remoção de ${label}`}
    >
      <button
        type="button"
        className="button danger"
        disabled={disabled}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        Confirmar remoção
      </button>
      <button type="button" className="button" onClick={() => setAsking(false)}>
        Cancelar
      </button>
    </span>
  );
}

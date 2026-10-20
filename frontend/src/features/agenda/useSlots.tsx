import { useApi } from "../../api/ApiContext";
import { useResource } from "../../hooks/useResource";
import { isLocalDate, localTimeOf, todayIn } from "../../lib/agenda";

/**
 * Horários livres de `GET /api/availability/slots` para profissional + serviço + dia LOCAL da empresa. Sem os três
 * (ou com dia passado/inválido) nada é pedido. R7: instantes que já passaram nunca são oferecidos, mesmo que a API
 * os devolva; o servidor valida de novo ao criar/remarcar.
 */
export function useSlots(
  professionalId: string,
  serviceId: string,
  date: string,
  timeZone: string,
) {
  const api = useApi();
  const enabled =
    professionalId !== "" &&
    serviceId !== "" &&
    isLocalDate(date) &&
    date >= todayIn(timeZone);
  const { resource, reload } = useResource(
    async (signal) => {
      if (!enabled) return [];
      const query = new URLSearchParams({ professionalId, serviceId, date });
      const res = await api.request<{ slots: string[] }>(
        "GET",
        `/api/availability/slots?${query.toString()}`,
        { signal },
      );
      const now = Date.now();
      return res.slots.filter((s) => new Date(s).getTime() > now);
    },
    [api, professionalId, serviceId, date, enabled],
  );
  return { resource, reload, enabled };
}

export function SlotPicker({
  name,
  slots,
  value,
  onChange,
  timeZone,
}: {
  name: string;
  slots: string[];
  value: string;
  onChange: (slot: string) => void;
  timeZone: string;
}) {
  return (
    <fieldset className="slots">
      <legend>Horários disponíveis</legend>
      <div className="slot-list">
        {slots.map((s) => (
          <label key={s} className="slot">
            <input
              type="radio"
              name={name}
              value={s}
              checked={value === s}
              onChange={() => onChange(s)}
            />
            <span>{localTimeOf(s, timeZone)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

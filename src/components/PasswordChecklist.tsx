import { PASSWORD_RULES, type PasswordRuleResult } from "@/lib/password/policy";

export function PasswordChecklist({ results, pending }: { results: PasswordRuleResult[]; pending: boolean }) {
  const byId = new Map(results.map((r) => [r.id, r]));
  return (
    <ul className="grid gap-1.5 text-sm sm:grid-cols-2" aria-label="Password requirements">
      {PASSWORD_RULES.map((rule) => {
        const result = byId.get(rule.id);
        const state = result?.ok === true ? "ok" : result?.ok === false ? "bad" : "pending";
        const icon = state === "ok" ? "✓" : state === "bad" ? "✗" : pending ? "…" : "•";
        return (
          <li
            key={rule.id}
            data-rule={rule.id}
            data-state={state}
            className={`flex gap-2 ${state === "ok" ? "text-success" : state === "bad" ? "text-danger" : "text-muted"}`}
          >
            <span aria-hidden className="w-4 shrink-0 text-center font-bold">
              {icon}
            </span>
            <span>
              {rule.label}
              {result?.detail && state !== "ok" && <span className="block text-xs opacity-80">{result.detail}</span>}
              <span className="sr-only">{state === "ok" ? " (met)" : state === "bad" ? " (not met)" : " (checking)"}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

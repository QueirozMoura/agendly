import { Outlet } from "react-router";

export function PublicLayout() {
  return (
    <div className="public">
      <header className="public-header">
        <span className="brand">Agendly</span>
      </header>
      <main className="card">
        <Outlet />
      </main>
    </div>
  );
}

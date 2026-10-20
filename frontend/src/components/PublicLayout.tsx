import { Link, Outlet } from "react-router";
import { BrandMark } from "./icons";

export function PublicLayout() {
  return (
    <div className="public">
      <header className="public-header">
        <Link to="/" className="brand">
          <BrandMark />
          <span>Agendly</span>
        </Link>
      </header>
      <main className="card">
        <Outlet />
      </main>
    </div>
  );
}

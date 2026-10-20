import { Route, Routes } from "react-router";
import { AppLayout } from "../components/AppLayout";
import {
  PublicOnly,
  RequireAuth,
  RequireOrganization,
} from "../components/guards";
import { PublicLayout } from "../components/PublicLayout";
import { ForgotPasswordPage } from "../features/auth/ForgotPasswordPage";
import { LoginPage } from "../features/auth/LoginPage";
import { RegisterPage } from "../features/auth/RegisterPage";
import { ResetPasswordPage } from "../features/auth/ResetPasswordPage";
import { VerifyEmailPage } from "../features/auth/VerifyEmailPage";
import { OrganizationSelectPage } from "../features/organizations/OrganizationSelectPage";
import { ProfessionalDetailPage } from "../features/professionals/ProfessionalDetailPage";
import { ProfessionalsPage } from "../features/professionals/ProfessionalsPage";
import { ServicesPage } from "../features/services/ServicesPage";
import { HomePage } from "./HomePage";
import { NotFoundPage } from "./NotFoundPage";

// Os caminhos /verificar-email e /redefinir-senha são os que os e-mails já usam (Etapa 5): não renomear.
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route element={<PublicOnly />}>
          <Route path="/entrar" element={<LoginPage />} />
          <Route path="/cadastro" element={<RegisterPage />} />
          <Route path="/esqueci-senha" element={<ForgotPasswordPage />} />
        </Route>
        <Route path="/redefinir-senha" element={<ResetPasswordPage />} />
        <Route path="/verificar-email" element={<VerifyEmailPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route element={<AppLayout />}>
          <Route path="/empresas" element={<OrganizationSelectPage />} />
          <Route element={<RequireOrganization />}>
            <Route index element={<HomePage />} />
            <Route path="/servicos" element={<ServicesPage />} />
            <Route path="/profissionais" element={<ProfessionalsPage />} />
            <Route
              path="/profissionais/:id"
              element={<ProfessionalDetailPage />}
            />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
